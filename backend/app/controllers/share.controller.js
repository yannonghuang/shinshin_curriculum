const db = require("../models");
const { authJwt } = require("../middleware");
const Op = db.Sequelize.Op;
const Share = db.share;
const ShareTopic = db.shareTopic;
const Plan = db.plan;
const { canEditShare, loadEditableShare, deleteShareRecord } = require("../services/teacherShare");

const mustConfirm = (value) => value === true || value === "true" || value === "1";
const normalizeText = (value) => (typeof value === "string" ? value.trim() : "");

const SHARE_INCLUDE = [
  {
    model: db.user,
    as: "Author",
    attributes: ["id", "username", "chineseName"],
    include: [{ model: db.school, as: "School", attributes: ["code", "name"] }],
  },
  // Plans are paranoid: a related plan moved to 回收站 just comes back null.
  { model: Plan, as: "RelatedPlan", attributes: ["id", "title"], required: false },
  { model: ShareTopic, as: "Topic", attributes: ["id", "title"] },
];

// Undefined -> leave as-is; null/"" -> no related plan; else must be a plan.
const resolveRelatedPlanId = async (value) => {
  if (value === undefined) return { value: undefined };
  if (value === null || value === "") return { value: null };
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return { error: "关联课程 ID 无效。" };
  if (!(await Plan.findByPk(id, { attributes: ["id"] }))) return { error: "关联课程不存在。" };
  return { value: id };
};

const withCanEdit = async (req, share) => ({ ...share.toJSON(), canEdit: await canEditShare(req, share) });

const TEACHER_ROLE_INCLUDE = { model: db.role, where: { name: "teacher" }, attributes: [], through: { attributes: [] } };

// An admin may file a share under any teacher (authorId) -- e.g. uploading
// one a teacher sent in. Returns { value } (undefined = not given) or
// { status, message }.
const resolveAuthorId = async (req) => {
  if (req.body.authorId === undefined || req.body.authorId === null || req.body.authorId === "") return { value: undefined };
  if (!(await authJwt.hasAdminRole(req))) return { status: 403, message: "只有管理员可以指定分享的作者。" };
  const id = Number(req.body.authorId);
  const teacher = Number.isInteger(id) && id > 0 ? await db.user.findByPk(id, { include: [TEACHER_ROLE_INCLUDE] }) : null;
  if (!teacher) return { status: 422, message: "作者必须是系统中的教师。" };
  return { value: id };
};

// GET /api/shares/teachers?keyword= -- admin-only; teachers to pick as a
// share's author (by name or username), up to 30.
exports.findTeachers = async (req, res) => {
  try {
    const keyword = normalizeText(req.query.keyword);
    const where = keyword
      ? { [Op.or]: [{ chineseName: { [Op.like]: `%${keyword}%` } }, { username: { [Op.like]: `%${keyword}%` } }] }
      : {};
    const teachers = await db.user.findAll({
      where,
      attributes: ["id", "username", "chineseName"],
      include: [TEACHER_ROLE_INCLUDE, { model: db.school, as: "School", attributes: ["code", "name"] }],
      order: [["chineseName", "ASC"]],
      limit: 30,
    });
    return res.send(teachers);
  } catch (err) {
    return res.status(500).send({ message: err.message || "查询教师时发生错误。" });
  }
};

// GET /api/shares?topicId=&authorId= -- every logged-in user. Newest first.
exports.findAll = async (req, res) => {
  try {
    const where = {};
    if (req.query.topicId) where.shareTopicId = Number(req.query.topicId);
    if (req.query.authorId) where.authorId = Number(req.query.authorId);
    const shares = await Share.findAll({ where, include: SHARE_INCLUDE, order: [["id", "DESC"]] });
    return res.send(shares);
  } catch (err) {
    return res.status(500).send({ message: err.message || "查询教师分享时发生错误。" });
  }
};

// GET /api/shares/:id -- every logged-in user; canEdit says whether the
// caller is its author or an admin.
exports.findOne = async (req, res) => {
  try {
    const share = await Share.findByPk(req.params.id, { include: SHARE_INCLUDE });
    if (!share) return res.status(404).send({ message: "分享不存在。" });
    return res.send(await withCanEdit(req, share));
  } catch (err) {
    return res.status(500).send({ message: err.message || "查询教师分享时发生错误。" });
  }
};

// POST /api/shares -- teacher or admin. A teacher is always the author; an
// admin must name the teacher author (authorId).
// Body: shareTopicId, title, summary, relatedPlanId (optional), authorId (admin only).
exports.create = async (req, res) => {
  try {
    const title = normalizeText(req.body.title);
    if (!title) return res.status(422).send({ message: "分享标题不能为空。" });
    const topic = await ShareTopic.findByPk(req.body.shareTopicId);
    if (!topic) return res.status(422).send({ message: "请选择有效的分享话题。" });
    const plan = await resolveRelatedPlanId(req.body.relatedPlanId);
    if (plan.error) return res.status(422).send({ message: plan.error });
    const author = await resolveAuthorId(req);
    if (author.status) return res.status(author.status).send({ message: author.message });
    if (author.value === undefined && (await authJwt.hasAdminRole(req))) {
      return res.status(422).send({ message: "请选择分享的作者教师。" });
    }

    const created = await Share.create({
      shareTopicId: topic.id,
      authorId: author.value || req.userId,
      relatedPlanId: plan.value || null,
      title,
      summary: normalizeText(req.body.summary) || null,
    });
    const share = await Share.findByPk(created.id, { include: SHARE_INCLUDE });
    return res.send(await withCanEdit(req, share));
  } catch (err) {
    return res.status(500).send({ message: err.message || "创建教师分享时发生错误。" });
  }
};

// PUT /api/shares/:id -- the share's author or an admin. Body: title,
// summary, relatedPlanId, shareTopicId, authorId (admin only) -- each optional.
exports.update = async (req, res) => {
  try {
    const { share, status, message } = await loadEditableShare(req, req.params.id);
    if (!share) return res.status(status).send({ message });

    const payload = {};
    if (req.body.title !== undefined) {
      const title = normalizeText(req.body.title);
      if (!title) return res.status(422).send({ message: "分享标题不能为空。" });
      payload.title = title;
    }
    if (req.body.summary !== undefined) payload.summary = normalizeText(req.body.summary) || null;
    if (req.body.shareTopicId !== undefined) {
      const topic = await ShareTopic.findByPk(req.body.shareTopicId);
      if (!topic) return res.status(422).send({ message: "请选择有效的分享话题。" });
      payload.shareTopicId = topic.id;
    }
    const plan = await resolveRelatedPlanId(req.body.relatedPlanId);
    if (plan.error) return res.status(422).send({ message: plan.error });
    if (plan.value !== undefined) payload.relatedPlanId = plan.value;
    const author = await resolveAuthorId(req);
    if (author.status) return res.status(author.status).send({ message: author.message });
    if (author.value !== undefined) payload.authorId = author.value;

    await share.update(payload);
    return res.send({ message: "分享已更新。" });
  } catch (err) {
    return res.status(500).send({ message: err.message || "更新教师分享时发生错误。" });
  }
};

// DELETE /api/shares/:id?confirmDelete=true -- the share's author or an
// admin; removes the share with every file in it.
exports.delete = async (req, res) => {
  if (!mustConfirm(req.query.confirmDelete)) {
    return res.status(400).send({
      message: "危险操作：将永久删除该分享及其所有文件。请使用 confirmDelete=true 重新提交。",
    });
  }
  try {
    const { share, status, message } = await loadEditableShare(req, req.params.id);
    if (!share) return res.status(status).send({ message });
    await deleteShareRecord(share);
    return res.send({ message: "分享已删除。" });
  } catch (err) {
    return res.status(500).send({ message: err.message || "删除教师分享时发生错误。" });
  }
};
