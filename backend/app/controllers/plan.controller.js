const fs = require("fs");
const dynamicDocGenerator = require("../services/dynamicDocGenerator");
const templateParser = require("../services/templateParser");
const { diffPlanFormDataSegments, diffExecutionFormDataSegments } = require("../services/segmentVersion");
const db = require("../models");
const Plan = db.plan;
const User = db.user;
const Artifact = db.artifact;
const Review = db.review;
const TemplateVersion = db.templateVersion;
const Op = db.Sequelize.Op;

const PLAN_THEMES = db.PLAN_THEMES;
const GRADE_OPTIONS = db.GRADE_OPTIONS;
const PLAN_SEASONS = db.PLAN_SEASONS;
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

const parseLessonCount = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

// Pulls the real template's own word/styles.xml (see
// templateParser.js#extractStylesXml) so a generated/filled-in doc adopts
// the source template's fonts/sizes instead of docx's own defaults --
// only possible when the pinned template version came from an upload
// (sourceFilePath set); the hand-authored seed versions have no source file
// and simply keep today's default styling.
const resolveStylesXml = (version) => {
  if (!version || !version.sourceFilePath || !fs.existsSync(version.sourceFilePath)) return null;
  return templateParser.extractStylesXml(version.sourceFilePath);
};

// See resolveStylesXml above and dynamicDocGenerator.js#generateDoc's
// `numberingXml` -- a heading style's real multi-level numbering/indentation
// lives in word/numbering.xml, not styles.xml.
const resolveNumberingXml = (version) => {
  if (!version || !version.sourceFilePath || !fs.existsSync(version.sourceFilePath)) return null;
  return templateParser.extractNumberingXml(version.sourceFilePath);
};

// The real template can leave a meta label un-bold (confirmed: the 2026
// template's own "课程名称：" isn't bold, while its schema fields elsewhere
// are inconsistently bold/not) -- resolved per label from templateParser.js's
// basicInfoBold, captured from that same "基本信息" heading before it was
// dropped from the schema, so this reproduces the template's real choice
// instead of the previous blanket-bold default. Undefined (not just a
// missing key) for any schema that never captured one -- a table/flat-
// parsed schema, the hand-authored seed, or a heading-parsed template with
// no "基本信息" heading at all -- so generateDoc's own bold=true default
// applies there, unchanged from before this existed.
const metaBold = (version, label) => {
  const bold = version && version.schemaJson && version.schemaJson.basicInfoBold;
  return bold ? bold[label] : undefined;
};

const isAdminRequester = async (userId, t) => {
  const user = await User.findByPk(userId, { transaction: t });
  if (!user) return false;
  const roles = await user.getRoles({ transaction: t });
  return roles.some((r) => r.name === "admin");
};

const isExpertRequester = async (userId, t) => {
  const user = await User.findByPk(userId, { transaction: t });
  if (!user) return false;
  const roles = await user.getRoles({ transaction: t });
  return roles.some((r) => r.name === "expert");
};

// 乡土主题 options come from the active plan_design template's own "附件"
// section when it has one (see templateParser.js#extractThemeOptionsFromFields)
// -- e.g. a template can define its own theme list without a code change --
// falling back to the hardcoded PLAN_THEMES for every template without one
// (every existing uploaded/hand-authored version, none of which had this
// section before this feature existed).
exports.getOptions = async (req, res) => {
  let themes = PLAN_THEMES;
  try {
    const active = await TemplateVersion.findOne({ where: { templateKey: "plan_design", isActive: true } });
    if (active && Array.isArray(active.schemaJson.themeOptions) && active.schemaJson.themeOptions.length > 0) {
      themes = active.schemaJson.themeOptions;
    }
  } catch (err) {
    // Falls back to PLAN_THEMES below -- a broken lookup here shouldn't
    // block every other option (grades/seasons/etc.) from loading.
  }
  return res.send({
    themes,
    grades: GRADE_OPTIONS,
    seasons: PLAN_SEASONS,
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
      studentCount,
      instructorName,
      year,
      season,
      plannedLessonCount,
      planMode,
      planFormData,
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

    if (season !== undefined && season !== null && season !== "" && !PLAN_SEASONS.includes(season)) {
      await t.rollback();
      return res.status(422).send({ message: "学期 无效，必须是 秋季 或 春季。" });
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

    const parsedStudentCount = studentCount !== undefined ? parseLessonCount(studentCount) : null;
    if (studentCount !== undefined && studentCount !== null && studentCount !== "" && parsedStudentCount === null) {
      await t.rollback();
      return res.status(422).send({ message: "学生人数无效，必须是非负整数。" });
    }

    if (status !== undefined && !PLAN_STATUSES.includes(status)) {
      await t.rollback();
      return res.status(422).send({ message: "状态 无效。" });
    }

    // Pins this plan to whichever template versions are active right now --
    // never re-resolved later, so a template edit after this plan exists
    // never changes how it renders/generates (see templateVersion.model.js).
    const [planTemplateVersion, executionTemplateVersion] = await Promise.all([
      TemplateVersion.findOne({ where: { templateKey: "plan_design", isActive: true }, transaction: t }),
      TemplateVersion.findOne({ where: { templateKey: "lesson_execution", isActive: true }, transaction: t }),
    ]);
    if (!planTemplateVersion || !executionTemplateVersion) {
      await t.rollback();
      return res.status(500).send({ message: "未找到启用的课程设计/实施记录模板，请联系管理员。" });
    }

    const data = await Plan.create(
      {
        teacherId: req.userId,
        title: normalizedTitle,
        theme: theme || null,
        grade: grade || null,
        studentCount: parsedStudentCount,
        instructorName: normalizeInput(instructorName) || null,
        year: parsedYear,
        season: season || null,
        plannedLessonCount: parsedLessonCount,
        planMode,
        planFormData: planMode === "online" ? planFormData || {} : null,
        planTemplateVersionId: planTemplateVersion.id,
        executionTemplateVersionId: executionTemplateVersion.id,
        status: status || "draft",
      },
      { transaction: t }
    );

    await t.commit();
    return res.send(data);
  } catch (err) {
    await t.rollback();
    return res.status(500).send({
      message: err.message || "创建乡土课程设计时发生错误。",
    });
  }
};

exports.findAll = async (req, res) => {
  try {
    const { page, size, keyword, theme, grade, year, season, teacherId, isExcellentCase, status, mine } = req.query;
    const { limit, offset } = getPagination(page, size);

    const parsedYear = parseYear(year);
    if (year !== undefined && year !== null && year !== "" && !parsedYear) {
      return res.status(422).send({ message: "年份筛选无效，必须是 1900-2100 的整数。" });
    }

    // ?mine=true is always resolved from the authenticated caller (req.userId,
    // set by authJwt.attachUserIfPresent on this route) -- never trust a
    // client-supplied teacherId for "mine", or any logged-in user could see
    // another teacher's plans just by requesting mine=true while impersonating
    // nothing (teacherId is otherwise a legitimate admin-facing filter, e.g.
    // the admin UI's own "只看我的" toggle also goes through this same param).
    let effectiveTeacherId = teacherId;
    const viewingMine = mine === "true" || mine === true;
    if (viewingMine) {
      if (!req.userId) {
        return res.status(401).send({ message: "查看“我的”课程设计需要先登录。" });
      }
      effectiveTeacherId = req.userId;
    }

    // Suspended plans are hidden from the public gallery and from other
    // teachers' lists, but stay visible to admin (always) and to the owning
    // teacher via ?mine=true (read-only there -- see update's suspended check).
    const requesterIsAdmin = req.userId ? await isAdminRequester(req.userId) : false;
    const requesterIsExpert = req.userId ? await isExpertRequester(req.userId) : false;
    const hideSuspended = !requesterIsAdmin && !viewingMine;

    // Only 优秀案例 (excellent-case) plans are ever visible outside their own
    // owner -- a plan isn't promoted to public just by existing. Admin/expert
    // get full visibility (management/review need it); ?mine=true is the
    // owner viewing their own, excellent or not. This applies regardless of
    // any other filter (keyword/teacherId/etc.) so a non-owner teacher can't
    // route around it by, say, querying a specific teacherId directly.
    const restrictToExcellent = !viewingMine && !requesterIsAdmin && !requesterIsExpert;

    const condition = {
      [Op.and]: [
        hideSuspended ? { suspended: false } : null,
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
        season ? { season: { [Op.eq]: `${season}` } } : null,
        effectiveTeacherId ? { teacherId: { [Op.eq]: `${effectiveTeacherId}` } } : null,
        status ? { status: { [Op.eq]: `${status}` } } : null,
        restrictToExcellent
          ? { isExcellentCase: true }
          : isExcellentCase !== undefined
          ? { isExcellentCase: { [Op.eq]: isExcellentCase === "true" || isExcellentCase === "1" } }
          : null,
      ],
    };

    const data = await Plan.findAndCountAll({
      where: condition,
      include: [
        {
          model: User,
          as: "Teacher",
          attributes: ["id", "username", "chineseName"],
          include: [{ model: db.school, as: "School", attributes: ["code", "name"], required: false }],
        },
      ],
      distinct: true,
      limit,
      offset,
      order: [["id", "DESC"]],
    });

    return res.send(getPagingData(data, page, limit));
  } catch (err) {
    return res.status(500).send({
      message: err.message || "查询乡土课程设计列表时发生错误。",
    });
  }
};

exports.findOne = async (req, res) => {
  try {
    const data = await Plan.findByPk(req.params.id, {
      include: [
        {
          model: User,
          as: "Teacher",
          attributes: ["id", "username", "chineseName"],
          include: [{ model: db.school, as: "School", attributes: ["code", "name"], required: false }],
        },
        // The schema each form/doc renders from -- resolved here so the
        // frontend gets it in the same request that loads the plan, rather
        // than a second round-trip. Whole row (small JSON blob) is fine to
        // send as-is, no attributes trim needed.
        { model: TemplateVersion, as: "PlanTemplateVersion" },
        { model: TemplateVersion, as: "ExecutionTemplateVersion" },
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
      return res.status(404).send({ message: `未找到乡土课程设计 id=${req.params.id}。` });
    }

    // Same visibility rule as findAll: only 优秀案例 plans are public. A
    // direct link to someone else's ordinary plan is a 403, not an open
    // door -- being excellent is what promotes a plan to public, not just
    // existing. Requires authJwt.attachUserIfPresent on the route so
    // req.userId is resolved for a logged-in caller while still allowing an
    // anonymous request through (the public gallery has no login).
    if (!data.isExcellentCase) {
      const isOwner = !!(req.userId && data.teacherId === req.userId);
      const requesterIsAdmin = req.userId ? await isAdminRequester(req.userId) : false;
      const requesterIsExpert = req.userId ? await isExpertRequester(req.userId) : false;
      if (!isOwner && !requesterIsAdmin && !requesterIsExpert) {
        return res.status(403).send({ message: "无权查看该乡土课程设计。" });
      }
    }

    return res.send(data);
  } catch (err) {
    return res.status(500).send({
      message: err.message || `查询乡土课程设计 id=${req.params.id} 时发生错误。`,
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
      studentCount,
      instructorName,
      year,
      season,
      plannedLessonCount,
      planMode,
      planFormData,
      executionFormData,
      status,
      isExcellentCase,
    } = req.body;

    // PlanTemplateVersion included for diffPlanFormDataSegments below -- a
    // heading-style-parsed template's WHY/WHAT/HOW-equivalent anchors don't
    // correspond to planFormData's own top-level keys the way the hand-
    // authored seed's "why"/"what"/"how" do (see segmentVersion.js), so the
    // diff needs the schema to map a changed field back to its owning anchor.
    const data = await Plan.findByPk(id, { include: [{ model: TemplateVersion, as: "PlanTemplateVersion" }], transaction: t });
    if (!data) {
      await t.rollback();
      return res.status(404).send({ message: `未找到乡土课程设计 id=${id}。` });
    }

    // Route-level gating is only isTeacherOrAdmin (any teacher), so ownership
    // must be enforced here -- otherwise any teacher could edit any other
    // teacher's plan. Content fields (title..status) are owner-only, with NO
    // admin bypass -- managers can suspend/delete/promote/leave notes, but
    // may not edit a plan's actual case content, even one they don't own.
    const requesterIsAdmin = await isAdminRequester(req.userId, t);
    const isOwner = data.teacherId === req.userId;
    const editingContent = [
      title,
      theme,
      grade,
      studentCount,
      instructorName,
      year,
      season,
      plannedLessonCount,
      planMode,
      planFormData,
      executionFormData,
      status,
    ].some((v) => v !== undefined);

    if (editingContent) {
      if (!isOwner) {
        await t.rollback();
        return res.status(403).send({ message: "只能修改本人创建的乡土课程设计。" });
      }
      if (data.suspended) {
        await t.rollback();
        return res.status(403).send({ message: "该乡土课程设计已被管理员停用，如需修改请联系管理员。" });
      }
    }

    const payload = {};
    // Bumping this (rather than relying on the plain updated_at column,
    // which MySQL bumps for every write regardless of which fields changed)
    // is what defines a new review "thread boundary" -- see review.model.js.
    const now = new Date();
    if (editingContent) payload.contentVersionAt = now;

    // Per-segment counterpart: planFormData/executionFormData are always
    // sent wholesale (see plan-detail.component.js's saveFormData/
    // saveExecutionRecord -- there's no per-tab save), so the only way to
    // know which segment(s) a given save actually touched is to diff
    // against what's already stored. Only the segments that actually
    // changed get their segmentVersionAt entry bumped -- editing HOW must
    // not mark a review of WHY as superseded. See segmentVersion.js and
    // plan.model.js's segmentVersionAt comment.
    const changedSegmentKeys = [
      ...(planFormData !== undefined
        ? diffPlanFormDataSegments(data.planFormData, planFormData, data.PlanTemplateVersion && data.PlanTemplateVersion.schemaJson)
        : []),
      ...(executionFormData !== undefined ? diffExecutionFormDataSegments(data.executionFormData, executionFormData) : []),
    ];
    if (changedSegmentKeys.length > 0) {
      const nextSegmentVersionAt = { ...(data.segmentVersionAt || {}) };
      for (const key of changedSegmentKeys) nextSegmentVersionAt[key] = now;
      payload.segmentVersionAt = nextSegmentVersionAt;
    }

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

    if (studentCount !== undefined) {
      const parsedStudentCount = parseLessonCount(studentCount);
      if (studentCount !== null && studentCount !== "" && parsedStudentCount === null) {
        await t.rollback();
        return res.status(422).send({ message: "学生人数无效，必须是非负整数。" });
      }
      payload.studentCount = parsedStudentCount;
    }

    if (instructorName !== undefined) {
      payload.instructorName = normalizeInput(instructorName) || null;
    }

    if (year !== undefined) {
      const parsedYear = parseYear(year);
      if (!parsedYear) {
        await t.rollback();
        return res.status(422).send({ message: "年份无效，必须是 1900-2100 的整数。" });
      }
      payload.year = parsedYear;
    }

    if (season !== undefined) {
      if (season !== null && season !== "" && !PLAN_SEASONS.includes(season)) {
        await t.rollback();
        return res.status(422).send({ message: "学期 无效，必须是 秋季 或 春季。" });
      }
      payload.season = season || null;
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

    if (executionFormData !== undefined) {
      payload.executionFormData = executionFormData;
    }

    if (status !== undefined) {
      if (!PLAN_STATUSES.includes(status)) {
        await t.rollback();
        return res.status(422).send({ message: "状态 无效。" });
      }
      payload.status = status;
    }

    // 优秀案例 flagging is admin-only, even though writes to a plan are
    // otherwise gated at the route level as isTeacherOrAdmin.
    if (isExcellentCase !== undefined) {
      if (!requesterIsAdmin) {
        await t.rollback();
        return res.status(403).send({ message: "只有管理员可以设置优秀案例标记。" });
      }
      payload.isExcellentCase = isExcellentCase === true || isExcellentCase === "true" || isExcellentCase === "1";
    }

    if (Object.keys(payload).length > 0) {
      await Plan.update(payload, { where: { id }, transaction: t });
    }

    await t.commit();
    return res.send({ message: "乡土课程设计更新成功。" });
  } catch (err) {
    await t.rollback();
    return res.status(500).send({
      message: err.message || `更新乡土课程设计 id=${req.params.id} 时发生错误。`,
    });
  }
};

// Suspend / unsuspend a plan (PUT /api/plans/:id/suspend|unsuspend, authJwt.isAdmin-gated).
// Mirrors auth.controller.js's user suspend/unsuspend: a suspended plan isn't
// deleted, just hidden from the public gallery and other teachers' lists
// (see findAll) and locked against edits (see update) until an admin
// unsuspends it. The owning teacher can still view it read-only.
exports.suspend = async (req, res) => {
  const id = req.params.id;
  try {
    const [num] = await Plan.update({ suspended: true }, { where: { id } });
    if (num === 1) res.send({ message: "乡土课程设计已停用。" });
    else res.status(404).send({ message: `未找到乡土课程设计 id=${id}。` });
  } catch (err) {
    res.status(500).send({ message: err.message });
  }
};

exports.unsuspend = async (req, res) => {
  const id = req.params.id;
  try {
    const [num] = await Plan.update({ suspended: false }, { where: { id } });
    if (num === 1) res.send({ message: "乡土课程设计已恢复启用。" });
    else res.status(404).send({ message: `未找到乡土课程设计 id=${id}。` });
  } catch (err) {
    res.status(500).send({ message: err.message });
  }
};

exports.delete = async (req, res) => {
  const id = req.params.id;
  if (!mustConfirm(req.query.confirmCascade)) {
    return res.status(400).send({
      message: "危险操作：将永久删除该乡土课程设计及其所有附件与点评。请使用 confirmCascade=true 重新提交。",
    });
  }

  const t = await db.sequelize.transaction();
  try {
    const data = await Plan.findByPk(id, { transaction: t });
    if (!data) {
      await t.rollback();
      return res.status(404).send({ message: `未找到乡土课程设计 id=${id}。` });
    }

    if (data.teacherId !== req.userId && !(await isAdminRequester(req.userId, t))) {
      await t.rollback();
      return res.status(403).send({ message: "只能删除本人创建的乡土课程设计。" });
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

    return res.send({ message: "乡土课程设计及其关联数据已删除。" });
  } catch (err) {
    await t.rollback();
    return res.status(500).send({
      message: err.message || `删除乡土课程设计 id=${id} 时发生错误。`,
    });
  }
};

// Online-fill -> .docx, rendered on request via services/dynamicDocGenerator.js
// against whichever template_versions row this plan was pinned to at
// creation (plan.PlanTemplateVersion) and streamed straight back. Nothing
// is persisted -- no Artifact row, no file on disk -- so this always
// reflects the plan's *current* content and there's no stale generated-file
// copy to track or clean up. Backs the 课程设计文件 panel's 下载/预览
// commands (both hit this same endpoint; the frontend decides whether to
// save the response or render it inline) as well as any other reader who
// just wants "the plan as a document".
exports.renderDoc = async (req, res) => {
  try {
    const plan = await Plan.findByPk(req.params.id, {
      include: [{ model: TemplateVersion, as: "PlanTemplateVersion" }],
    });
    if (!plan) {
      return res.status(404).send({ message: `未找到乡土课程设计 id=${req.params.id}。` });
    }

    // Same visibility rule as findOne -- rendering the doc is a read action
    // available to whoever can already view the plan (owner/admin/expert, or
    // anyone for a public 优秀案例), not owner-only.
    if (!plan.isExcellentCase) {
      const isOwner = !!(req.userId && plan.teacherId === req.userId);
      const requesterIsAdmin = req.userId ? await isAdminRequester(req.userId) : false;
      const requesterIsExpert = req.userId ? await isExpertRequester(req.userId) : false;
      if (!isOwner && !requesterIsAdmin && !requesterIsExpert) {
        return res.status(403).send({ message: "无权查看该乡土课程设计。" });
      }
    }

    // "第二部分：分课时设计" is freeform per-课时 title+content (see
    // EMPTY_LESSON) -- not part of the field-template mechanism at all, so
    // it's composed by a hardcoded tail rather than driven by any schema
    // (see dynamicDocGenerator.js#buildLessonDesignTrailingChildren, shared
    // with planContext.js's AI-review content).
    const trailingChildren = dynamicDocGenerator.buildLessonDesignTrailingChildren(plan);

    const buffer = await dynamicDocGenerator.generateDoc({
      docTitle: "乡土课程设计方案",
      meta: [
        ["课程名称", plan.title, metaBold(plan.PlanTemplateVersion, "课程名称")],
        ["任教年级", plan.grade, metaBold(plan.PlanTemplateVersion, "任教年级")],
        ["学生人数", plan.studentCount, metaBold(plan.PlanTemplateVersion, "学生人数")],
        ["执教人", plan.instructorName, metaBold(plan.PlanTemplateVersion, "执教人")],
        ["预计课时", plan.plannedLessonCount, metaBold(plan.PlanTemplateVersion, "预计课时")],
      ],
      schema: plan.PlanTemplateVersion ? plan.PlanTemplateVersion.schemaJson : { sections: [] },
      answers: plan.planFormData,
      trailingChildren,
      stylesXml: resolveStylesXml(plan.PlanTemplateVersion),
      numberingXml: resolveNumberingXml(plan.PlanTemplateVersion),
    });
    const fileName = `${plan.title || "乡土课程设计方案"}.docx`;

    res.set({
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    });
    return res.send(buffer);
  } catch (err) {
    return res.status(500).send({
      message: err.message || `生成乡土课程设计 id=${req.params.id} 的课程设计文件时发生错误。`,
    });
  }
};

// Same on-the-fly, nothing-persisted shape as renderDoc above, but for one
// 课时's 实施记录, rendered against plan.ExecutionTemplateVersion instead
// of the plan's own WHY/WHAT/HOW-equivalent template. Backs the 课程实施
// 文件 panel's 下载/预览 commands.
exports.renderExecutionDoc = async (req, res) => {
  try {
    const plan = await Plan.findByPk(req.params.id, {
      include: [{ model: TemplateVersion, as: "ExecutionTemplateVersion" }],
    });
    if (!plan) {
      return res.status(404).send({ message: `未找到乡土课程设计 id=${req.params.id}。` });
    }

    const lessonIndex = Number(req.params.lessonIndex);
    if (!Number.isInteger(lessonIndex) || lessonIndex <= 0) {
      return res.status(422).send({ message: "课时序号无效。" });
    }

    // Same visibility rule as renderDoc/findOne.
    if (!plan.isExcellentCase) {
      const isOwner = !!(req.userId && plan.teacherId === req.userId);
      const requesterIsAdmin = req.userId ? await isAdminRequester(req.userId) : false;
      const requesterIsExpert = req.userId ? await isExpertRequester(req.userId) : false;
      if (!isOwner && !requesterIsAdmin && !requesterIsExpert) {
        return res.status(403).send({ message: "无权查看该乡土课程设计。" });
      }
    }

    const records = Array.isArray(plan.executionFormData) ? plan.executionFormData : [];
    const record = records.find((r) => Number(r.index) === lessonIndex) || {};
    const buffer = await dynamicDocGenerator.generateDoc({
      docTitle: `课时实施记录 · 第${lessonIndex}课时`,
      schema: plan.ExecutionTemplateVersion ? plan.ExecutionTemplateVersion.schemaJson : { sections: [] },
      answers: record,
      stylesXml: resolveStylesXml(plan.ExecutionTemplateVersion),
      numberingXml: resolveNumberingXml(plan.ExecutionTemplateVersion),
    });
    const fileName = `${plan.title || "乡土课程设计方案"}-课时${lessonIndex}-实施记录.docx`;

    res.set({
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    });
    return res.send(buffer);
  } catch (err) {
    return res.status(500).send({
      message: err.message || `生成乡土课程设计 id=${req.params.id} 第 ${req.params.lessonIndex} 课时的实施文件时发生错误。`,
    });
  }
};
