const fs = require("fs");
const db = require("../models");
const Plan = db.plan;
const User = db.user;
const Artifact = db.artifact;
const Review = db.review;
const Op = db.Sequelize.Op;

const PLAN_THEMES = db.PLAN_THEMES;
const GRADE_OPTIONS = db.GRADE_OPTIONS;
const PLAN_MODES = ["upload", "online"];
const PLAN_STATUSES = ["draft", "submitted", "reviewed"];

const getPagination = (page, size) => {
  const limit = size ? +size : 30;
  const offset = page ? page * limit : 0;
  return { limit, offset };
};

// Pagination envelope shape per the plan's REST conventions:
// {totalItems, rows, totalPages, currentPage}
const getPagingData = (data, page, limit) => {
  const { count: totalItems, rows } = data;
  const currentPage = page ? +page : 0;
  const totalPages = Math.ceil(totalItems / limit);
  return { totalItems, rows, totalPages, currentPage };
};

const mustConfirm = (value) => value === true || value === "true" || value === "1";

const normalizeInput = (value) => (typeof value === "string" ? value.trim() : "");

const parseYear = (year) => {
  if (year === undefined || year === null || year === "") return null;
  const y = Number(year);
  if (!Number.isInteger(y)) return null;
  if (y < 1900 || y > 2100) return null;
  return y;
};

const parseId = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const parseLessonCount = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

const isAdminRequester = async (userId, t) => {
  const user = await User.findByPk(userId, { transaction: t });
  if (!user) return false;
  const roles = await user.getRoles({ transaction: t });
  return roles.some((r) => r.name === "admin");
};

exports.getOptions = (req, res) => {
  return res.send({
    themes: PLAN_THEMES,
    grades: GRADE_OPTIONS,
    planModes: PLAN_MODES,
    statuses: PLAN_STATUSES,
  });
};

exports.create = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const {
      title,
      theme,
      grade,
      year,
      plannedLessonCount,
      planMode,
      planFormData,
      teacherId,
      status,
    } = req.body;

    const normalizedTitle = normalizeInput(title);
    if (!normalizedTitle) {
      await t.rollback();
      return res.status(422).send({ message: "课程标题不能为空。" });
    }

    const parsedYear = parseYear(year);
    if (!parsedYear) {
      await t.rollback();
      return res.status(422).send({ message: "年份无效，必须是 1900-2100 的整数。" });
    }

    if (theme !== undefined && theme !== null && theme !== "" && !PLAN_THEMES.includes(theme)) {
      await t.rollback();
      return res.status(422).send({ message: "乡土主题 无效。" });
    }

    if (grade !== undefined && grade !== null && grade !== "" && !GRADE_OPTIONS.includes(grade)) {
      await t.rollback();
      return res.status(422).send({ message: "年级 无效。" });
    }

    if (!PLAN_MODES.includes(planMode)) {
      await t.rollback();
      return res.status(422).send({ message: "填写方式 无效，必须是 upload 或 online。" });
    }

    const parsedLessonCount = plannedLessonCount !== undefined ? parseLessonCount(plannedLessonCount) : null;
    if (plannedLessonCount !== undefined && plannedLessonCount !== null && plannedLessonCount !== "" && parsedLessonCount === null) {
      await t.rollback();
      return res.status(422).send({ message: "预计课时无效，必须是非负整数。" });
    }

    if (status !== undefined && !PLAN_STATUSES.includes(status)) {
      await t.rollback();
      return res.status(422).send({ message: "状态 无效。" });
    }

    // Only admins may create a plan on behalf of another teacher
    // (used for the "管理员上传" excellent-case path).
    let effectiveTeacherId = req.userId;
    if (teacherId !== undefined && teacherId !== null && teacherId !== "") {
      const parsedTeacherId = parseId(teacherId);
      if (!parsedTeacherId) {
        await t.rollback();
        return res.status(422).send({ message: "teacherId 无效。" });
      }
      if (parsedTeacherId !== req.userId) {
        const requesterIsAdmin = await isAdminRequester(req.userId, t);
        if (!requesterIsAdmin) {
          await t.rollback();
          return res.status(403).send({ message: "只有管理员可以指定其他教师创建课程。" });
        }
        const teacher = await User.findByPk(parsedTeacherId, { transaction: t });
        if (!teacher) {
          await t.rollback();
          return res.status(422).send({ message: "指定的教师不存在。" });
        }
      }
      effectiveTeacherId = parsedTeacherId;
    }

    const data = await Plan.create(
      {
        teacherId: effectiveTeacherId,
        title: normalizedTitle,
        theme: theme || null,
        grade: grade || null,
        year: parsedYear,
        plannedLessonCount: parsedLessonCount,
        planMode,
        planFormData: planMode === "online" ? planFormData || {} : null,
        status: status || "draft",
      },
      { transaction: t }
    );

    await t.commit();
    return res.send(data);
  } catch (err) {
    await t.rollback();
    return res.status(500).send({
      message: err.message || "创建乡土课程计划时发生错误。",
    });
  }
};

exports.findAll = async (req, res) => {
  try {
    const { page, size, keyword, theme, grade, year, teacherId, isExcellentCase, status } = req.query;
    const { limit, offset } = getPagination(page, size);

    const parsedYear = parseYear(year);
    if (year !== undefined && year !== null && year !== "" && !parsedYear) {
      return res.status(422).send({ message: "年份筛选无效，必须是 1900-2100 的整数。" });
    }

    const condition = {
      [Op.and]: [
        keyword
          ? {
              [Op.or]: [
                { title: { [Op.like]: `%${keyword}%` } },
                { theme: { [Op.like]: `%${keyword}%` } },
              ],
            }
          : null,
        theme ? { theme: { [Op.eq]: `${theme}` } } : null,
        grade ? { grade: { [Op.eq]: `${grade}` } } : null,
        parsedYear ? { year: { [Op.eq]: parsedYear } } : null,
        teacherId ? { teacherId: { [Op.eq]: `${teacherId}` } } : null,
        status ? { status: { [Op.eq]: `${status}` } } : null,
        isExcellentCase !== undefined
          ? { isExcellentCase: { [Op.eq]: isExcellentCase === "true" || isExcellentCase === "1" } }
          : null,
      ],
    };

    const data = await Plan.findAndCountAll({
      where: condition,
      include: [{ model: User, as: "Teacher", attributes: ["id", "username", "chineseName"] }],
      distinct: true,
      limit,
      offset,
      order: [["id", "DESC"]],
    });

    return res.send(getPagingData(data, page, limit));
  } catch (err) {
    return res.status(500).send({
      message: err.message || "查询乡土课程计划列表时发生错误。",
    });
  }
};

exports.findOne = async (req, res) => {
  try {
    const data = await Plan.findByPk(req.params.id, {
      include: [
        { model: User, as: "Teacher", attributes: ["id", "username", "chineseName"] },
        {
          model: Artifact,
          as: "Artifacts",
          attributes: [
            "id",
            "lessonIndex",
            "description",
            "category",
            "type",
            "attachmentName",
            "attachmentMime",
            "attachmentSize",
            "createdAt",
          ],
        },
        {
          model: Review,
          as: "Reviews",
          attributes: [
            "id",
            "lessonIndex",
            "reviewerType",
            "reviewerId",
            "sectionKey",
            "score",
            "content",
            "aiModel",
            "createdAt",
          ],
        },
      ],
      order: [
        [{ model: Artifact, as: "Artifacts" }, "id", "DESC"],
        [{ model: Review, as: "Reviews" }, "id", "DESC"],
      ],
    });

    if (!data) {
      return res.status(404).send({ message: `未找到乡土课程计划 id=${req.params.id}。` });
    }

    return res.send(data);
  } catch (err) {
    return res.status(500).send({
      message: err.message || `查询乡土课程计划 id=${req.params.id} 时发生错误。`,
    });
  }
};

exports.update = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const id = req.params.id;
    const {
      title,
      theme,
      grade,
      year,
      plannedLessonCount,
      planMode,
      planFormData,
      status,
      isExcellentCase,
      curatorNote,
    } = req.body;

    const data = await Plan.findByPk(id, { transaction: t });
    if (!data) {
      await t.rollback();
      return res.status(404).send({ message: `未找到乡土课程计划 id=${id}。` });
    }

    const payload = {};

    if (title !== undefined) {
      const normalizedTitle = normalizeInput(title);
      if (!normalizedTitle) {
        await t.rollback();
        return res.status(422).send({ message: "课程标题不能为空。" });
      }
      payload.title = normalizedTitle;
    }

    if (theme !== undefined) {
      if (theme !== null && theme !== "" && !PLAN_THEMES.includes(theme)) {
        await t.rollback();
        return res.status(422).send({ message: "乡土主题 无效。" });
      }
      payload.theme = theme || null;
    }

    if (grade !== undefined) {
      if (grade !== null && grade !== "" && !GRADE_OPTIONS.includes(grade)) {
        await t.rollback();
        return res.status(422).send({ message: "年级 无效。" });
      }
      payload.grade = grade || null;
    }

    if (year !== undefined) {
      const parsedYear = parseYear(year);
      if (!parsedYear) {
        await t.rollback();
        return res.status(422).send({ message: "年份无效，必须是 1900-2100 的整数。" });
      }
      payload.year = parsedYear;
    }

    if (plannedLessonCount !== undefined) {
      const parsedLessonCount = parseLessonCount(plannedLessonCount);
      if (plannedLessonCount !== null && plannedLessonCount !== "" && parsedLessonCount === null) {
        await t.rollback();
        return res.status(422).send({ message: "预计课时无效，必须是非负整数。" });
      }
      payload.plannedLessonCount = parsedLessonCount;
    }

    if (planMode !== undefined) {
      if (!PLAN_MODES.includes(planMode)) {
        await t.rollback();
        return res.status(422).send({ message: "填写方式 无效，必须是 upload 或 online。" });
      }
      payload.planMode = planMode;
    }

    if (planFormData !== undefined) {
      payload.planFormData = planFormData;
    }

    if (status !== undefined) {
      if (!PLAN_STATUSES.includes(status)) {
        await t.rollback();
        return res.status(422).send({ message: "状态 无效。" });
      }
      payload.status = status;
    }

    // 优秀案例 flagging + curator note are admin-only, even though writes to
    // a plan are otherwise gated at the route level as isTeacherOrAdmin.
    if (isExcellentCase !== undefined || curatorNote !== undefined) {
      const requesterIsAdmin = await isAdminRequester(req.userId, t);
      if (!requesterIsAdmin) {
        await t.rollback();
        return res.status(403).send({ message: "只有管理员可以设置优秀案例标记或点评备注。" });
      }
      if (isExcellentCase !== undefined) {
        payload.isExcellentCase = isExcellentCase === true || isExcellentCase === "true" || isExcellentCase === "1";
      }
      if (curatorNote !== undefined) {
        payload.curatorNote = curatorNote;
      }
    }

    if (Object.keys(payload).length > 0) {
      await Plan.update(payload, { where: { id }, transaction: t });
    }

    await t.commit();
    return res.send({ message: "乡土课程计划更新成功。" });
  } catch (err) {
    await t.rollback();
    return res.status(500).send({
      message: err.message || `更新乡土课程计划 id=${req.params.id} 时发生错误。`,
    });
  }
};

exports.delete = async (req, res) => {
  const id = req.params.id;
  if (!mustConfirm(req.query.confirmCascade)) {
    return res.status(400).send({
      message: "危险操作：将永久删除该乡土课程计划及其所有附件与点评。请使用 confirmCascade=true 重新提交。",
    });
  }

  const t = await db.sequelize.transaction();
  try {
    const data = await Plan.findByPk(id, { transaction: t });
    if (!data) {
      await t.rollback();
      return res.status(404).send({ message: `未找到乡土课程计划 id=${id}。` });
    }

    const artifacts = await Artifact.findAll({
      where: { planId: id },
      attributes: ["id", "attachmentPath"],
      transaction: t,
    });
    const artifactPaths = (artifacts || []).map((x) => x.attachmentPath).filter(Boolean);

    // Application-level cascade for compatibility even if DB FK is missing.
    await Review.destroy({ where: { planId: id }, transaction: t });
    await Artifact.destroy({ where: { planId: id }, transaction: t });
    await Plan.destroy({ where: { id }, transaction: t });
    await t.commit();

    for (const filePath of artifactPaths) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (e) {
        console.error("删除附件文件失败:", filePath, e.message);
      }
    }

    return res.send({ message: "乡土课程计划及其关联数据已删除。" });
  } catch (err) {
    await t.rollback();
    return res.status(500).send({
      message: err.message || `删除乡土课程计划 id=${id} 时发生错误。`,
    });
  }
};

// Online-fill -> downloadable file. Renders `planFormData` via
// services/planDocGenerator.js and registers the resulting .docx as an
// artifacts row through the same code path manual uploads use
// (artifact.controller.js's registerArtifactFile).
exports.generateDoc = async (req, res) => {
  try {
    const plan = await Plan.findByPk(req.params.id);
    if (!plan) {
      return res.status(404).send({ message: `未找到乡土课程计划 id=${req.params.id}。` });
    }

    const planDocGenerator = require("../services/planDocGenerator");
    const artifactController = require("./artifact.controller");

    const buffer = await planDocGenerator.generatePlanDocx(plan);
    const fileName = `${plan.title || "乡土课程设计方案"}.docx`;

    const artifact = await artifactController.registerArtifactFile({
      planId: plan.id,
      lessonIndex: null,
      category: "课程设计文件",
      description: "系统自动生成的课程设计方案文档",
      buffer,
      originalName: fileName,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    return res.send(artifact);
  } catch (err) {
    return res.status(500).send({
      message: err.message || `生成乡土课程计划 id=${req.params.id} 的课程设计文件时发生错误。`,
    });
  }
};
