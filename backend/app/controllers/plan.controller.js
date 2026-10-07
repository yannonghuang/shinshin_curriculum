const fs = require("fs");
const os = require("os");
const path = require("path");
const util = require("util");
const multer = require("multer");
const dynamicDocGenerator = require("../services/dynamicDocGenerator");
const templateParser = require("../services/templateParser");
const planDocExtract = require("../services/planDocExtract");
const { diffPlanFormDataSegments, diffExecutionFormDataSegments } = require("../services/segmentVersion");
const { migratePlanFormData } = require("../services/templateMigration");
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

// Ephemeral disk storage for a re-uploaded design/execution doc -- unlike
// template.controller.js's uploads (which persist sourceFilePath long-term,
// one row per template version), this file is read once by
// planDocExtract.js#extractFromFile and deleted immediately after (see
// uploadDesignDoc/uploadExecutionDoc's `finally`), so it lives in a fresh
// mkdtemp'd OS temp dir per request rather than backend/upload/ -- same
// os.tmpdir()/mkdtempSync pattern artifact.controller.js already uses for
// its own short-lived zip-building temp dirs.
const planDocUploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, fs.mkdtempSync(path.join(os.tmpdir(), "plan-doc-upload-"))),
  filename: (req, file, cb) => cb(null, "upload.docx"),
});
const uploadPlanDocSingle = util.promisify(multer({ storage: planDocUploadStorage }).single("file"));

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

// Pulls the real template's own word/{styles,numbering,theme1}.xml so a
// generated/filled-in doc adopts the source template's fonts/sizes/numbering
// instead of docx's own defaults -- see templateParser.js#resolveStylesXml
// (also shared with template.controller.js#downloadBlank, the teacher-facing
// blank template, for the same reason).
const { resolveStylesXml, resolveNumberingXml, resolveThemeXml } = templateParser;

// "super" inherits every admin privilege, including the admin bypasses this
// gates (edit/delete any plan regardless of ownership, suspend/unsuspend).
const isAdminRequester = async (userId, t) => {
  const user = await User.findByPk(userId, { transaction: t });
  if (!user) return false;
  const roles = await user.getRoles({ transaction: t });
  return roles.some((r) => r.name === "admin" || r.name === "super");
};

const isExpertRequester = async (userId, t) => {
  const user = await User.findByPk(userId, { transaction: t });
  if (!user) return false;
  const roles = await user.getRoles({ transaction: t });
  return roles.some((r) => r.name === "expert");
};

const isTeacherRequester = async (userId, t) => {
  const user = await User.findByPk(userId, { transaction: t });
  if (!user) return false;
  const roles = await user.getRoles({ transaction: t });
  return roles.some((r) => r.name === "teacher");
};

// Shared by findOne/renderDoc/renderExecutionDoc -- the single-plan
// equivalent of findAll's restrictToExcellent/restrictToSubmitted, so a
// direct link to a plan a caller couldn't see in the list can't be used to
// route around that same restriction. Caller already handles the
// isExcellentCase case before reaching this (that's public to everyone
// regardless of status, matching the list). Owner and admin always pass;
// expert/teacher pass only once the plan is no longer a draft -- a
// still-in-progress draft is the owner's alone to show.
const canViewNonExcellentPlan = async (plan, userId) => {
  if (userId && plan.teacherId === userId) return true;
  if (!userId) return false;
  const [admin, expert, teacher] = await Promise.all([isAdminRequester(userId), isExpertRequester(userId), isTeacherRequester(userId)]);
  if (admin) return true;
  return (expert || teacher) && plan.status !== "draft";
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
    const { page, size, keyword, theme, grade, year, season, teacherId, isExcellentCase, status, mine, templateVersionId, schoolCode, reviewedByMe } =
      req.query;
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

    // ?reviewedByMe=true backs an expert's 我的点评: the plans the caller has
    // written a review on -- submitted or still a saved draft (their own
    // drafts are theirs to see) -- most recently reviewed first, each with
    // its myReviews counts. Resolved from req.userId, never a client id.
    let myReviewStats = null;
    if (reviewedByMe === "true" || reviewedByMe === true) {
      if (!req.userId) {
        return res.status(401).send({ message: "查看“我的点评”需要先登录。" });
      }
      const rows = await Review.findAll({
        where: { reviewerId: req.userId, reviewerType: { [Op.ne]: "ai" } },
        attributes: [
          "planId",
          "status",
          [db.sequelize.fn("COUNT", db.sequelize.col("id")), "count"],
          [db.sequelize.fn("MAX", db.sequelize.col("updated_at")), "lastAt"],
        ],
        group: [db.sequelize.col("plan_id"), "status"],
        raw: true,
      });
      myReviewStats = new Map();
      for (const r of rows) {
        const stat = myReviewStats.get(r.planId) || { submitted: 0, saved: 0, lastAt: null };
        stat[r.status] = Number(r.count);
        if (!stat.lastAt || new Date(r.lastAt) > new Date(stat.lastAt)) stat.lastAt = r.lastAt;
        myReviewStats.set(r.planId, stat);
      }
    }
    const myReviewedIds = myReviewStats
      ? [...myReviewStats.entries()].sort((a, b) => new Date(b[1].lastAt) - new Date(a[1].lastAt)).map(([id]) => Number(id))
      : null;

    // Suspended plans are hidden from the public gallery and from other
    // teachers' lists, but stay visible to admin (always) and to the owning
    // teacher via ?mine=true (read-only there -- see update's suspended check).
    const requesterIsAdmin = req.userId ? await isAdminRequester(req.userId) : false;
    const requesterIsExpert = req.userId ? await isExpertRequester(req.userId) : false;
    // A teacher gets the same cross-school visibility as an expert (browsing
    // 全部乡土课程, not just their own) -- see plans-list.component.js's
    // isManagerOrExpertView, which now treats teacher/expert/admin alike for
    // this same reason. hideSuspended below is unaffected: a teacher still
    // shouldn't see another teacher's suspended plan, same as an expert.
    const requesterIsTeacher = req.userId ? await isTeacherRequester(req.userId) : false;
    const hideSuspended = !requesterIsAdmin && !viewingMine;

    // Only 优秀案例 (excellent-case) plans are ever visible outside their own
    // owner -- a plan isn't promoted to public just by existing. Admin/expert/
    // teacher get full visibility (management/review/peer-browsing all need
    // it); ?mine=true is the owner viewing their own, excellent or not. This
    // applies regardless of any other filter (keyword/teacherId/etc.) so a
    // non-owner teacher can't route around it by, say, querying a specific
    // teacherId directly -- it's the role check above that grants the wider
    // access, not the filter shape.
    const restrictToExcellent = !viewingMine && !requesterIsAdmin && !requesterIsExpert && !requesterIsTeacher;

    // Draft plans are still a work in progress -- only the owner (?mine=true)
    // or admin should ever browse one outside excellent-case promotion.
    // Expert/teacher's cross-school browsing (restrictToExcellent above) is
    // restricted to non-draft (submitted or reviewed) plans only, enforced
    // regardless of the `status` query param so a request for status=draft
    // can't route around it -- same "role check grants access, not the
    // filter shape" reasoning as restrictToExcellent.
    const restrictToSubmitted = !viewingMine && !requesterIsAdmin && (requesterIsExpert || requesterIsTeacher);

    const condition = {
      [Op.and]: [
        hideSuspended ? { suspended: false } : null,
        myReviewedIds ? { id: { [Op.in]: myReviewedIds } } : null,
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
        // Backs the 模板管理 page's "相关课程计划" count link -- a plan using
        // this template version for either its design or execution doc
        // counts as a dependent (same either/or pair as
        // template.controller.js#list/#remove).
        templateVersionId
          ? {
              [Op.or]: [
                { planTemplateVersionId: { [Op.eq]: templateVersionId } },
                { executionTemplateVersionId: { [Op.eq]: templateVersionId } },
              ],
            }
          : null,
        restrictToSubmitted ? { status: { [Op.ne]: "draft" } } : status ? { status: { [Op.eq]: `${status}` } } : null,
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
          // Backs 用户管理's 学校信息 panel ("该校课程计划" list) -- narrows to
          // plans whose *owning teacher* is at this school (Plan itself has
          // no schoolCode of its own). Sequelize defaults an include to
          // required:true whenever it carries a `where`, which is exactly
          // the inner-join semantics wanted here (teacherId is NOT NULL, so
          // this never silently drops a plan for having no Teacher row).
          where: schoolCode ? { schoolCode: { [Op.eq]: `${schoolCode}` } } : undefined,
          include: [{ model: db.school, as: "School", attributes: ["code", "name"], required: false }],
        },
      ],
      distinct: true,
      limit,
      offset,
      // 我的点评 lists most recently reviewed first (myReviewedIds' order;
      // the ids are integers straight from the DB, safe to inline).
      order:
        myReviewedIds && myReviewedIds.length
          ? [[db.sequelize.literal(`FIELD(\`${Plan.name}\`.\`id\`, ${myReviewedIds.join(",")})`), "ASC"]]
          : [["id", "DESC"]],
    });

    // aiReviewed/expertReviewed are derived, not stored -- "has this plan
    // received at least one review of that reviewerType", computed with one
    // extra lightweight query for this page's plan ids rather than N+1 or an
    // eager Review include (which would pull full review content into a
    // list response, including the up-to-1000-row hierarchy-view fetch).
    // "expert" means reviewerType='expert' specifically, not 'admin' -- see
    // review.model.js's own comment on why those stay distinct.
    const planIds = data.rows.map((r) => r.id);
    const reviewRows = planIds.length
      ? await Review.findAll({
          where: { planId: { [Op.in]: planIds }, reviewerType: { [Op.in]: ["ai", "expert"] }, status: "submitted" },
          attributes: ["planId", "reviewerType"],
        })
      : [];
    const aiReviewedIds = new Set(reviewRows.filter((r) => r.reviewerType === "ai").map((r) => r.planId));
    const expertReviewedIds = new Set(reviewRows.filter((r) => r.reviewerType === "expert").map((r) => r.planId));
    data.rows = data.rows.map((row) => {
      const plain = row.get({ plain: true });
      plain.aiReviewed = aiReviewedIds.has(plain.id);
      plain.expertReviewed = expertReviewedIds.has(plain.id);
      if (myReviewStats) plain.myReviews = myReviewStats.get(plain.id) || null;
      return plain;
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
          // Drafts are their author's alone (see review.model.js's status).
          where: { status: "submitted" },
          required: false,
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
          // Reviewer name -- used by plan-detail.component.js's 基本信息 tab to
          // list expert reviewers' names when expertReviewed is true. aiReviewed/
          // expertReviewed themselves are derived client-side from this same
          // array (see that component), not duplicated here.
          include: [{ model: User, as: "Reviewer", attributes: ["chineseName", "username"] }],
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
    if (!data.isExcellentCase && !(await canViewNonExcellentPlan(data, req.userId))) {
      return res.status(403).send({ message: "无权查看该乡土课程设计。" });
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
    // available to whoever can already view the plan (owner/admin/expert/
    // teacher, or anyone for a public 优秀案例), not owner-only.
    if (!plan.isExcellentCase && !(await canViewNonExcellentPlan(plan, req.userId))) {
      return res.status(403).send({ message: "无权查看该乡土课程设计。" });
    }

    // "第二部分：分课时设计" is freeform per-课时 title+content (see
    // EMPTY_LESSON) -- not part of the field-template mechanism at all, so
    // it's composed by a hardcoded tail rather than driven by any schema
    // (see dynamicDocGenerator.js#buildLessonDesignTrailingChildren, shared
    // with planContext.js's AI-review content).
    const trailingChildren = dynamicDocGenerator.buildLessonDesignTrailingChildren(plan);

    const buffer = await dynamicDocGenerator.generateDoc({
      docTitle: "乡土课程设计方案",
      meta: dynamicDocGenerator.buildPlanMetaRows(plan.PlanTemplateVersion, plan),
      schema: plan.PlanTemplateVersion ? plan.PlanTemplateVersion.schemaJson : { sections: [] },
      answers: plan.planFormData,
      trailingChildren,
      stylesXml: resolveStylesXml(plan.PlanTemplateVersion),
      numberingXml: resolveNumberingXml(plan.PlanTemplateVersion),
      themeXml: resolveThemeXml(plan.PlanTemplateVersion),
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
    if (!plan.isExcellentCase && !(await canViewNonExcellentPlan(plan, req.userId))) {
      return res.status(403).send({ message: "无权查看该乡土课程设计。" });
    }

    const records = Array.isArray(plan.executionFormData) ? plan.executionFormData : [];
    const record = records.find((r) => Number(r.index) === lessonIndex) || {};
    const buffer = await dynamicDocGenerator.generateDoc({
      docTitle: `课时实施记录 · 第${lessonIndex}课时`,
      schema: plan.ExecutionTemplateVersion ? plan.ExecutionTemplateVersion.schemaJson : { sections: [] },
      answers: record,
      stylesXml: resolveStylesXml(plan.ExecutionTemplateVersion),
      numberingXml: resolveNumberingXml(plan.ExecutionTemplateVersion),
      themeXml: resolveThemeXml(plan.ExecutionTemplateVersion),
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

// POST /api/plans/:id/design-doc -- multipart "file", the upload
// counterpart to renderDoc's GET (download). Runs the same extraction
// planDocExtract.js#extractFromFile used to do client-side in the browser
// (mammoth + this plan's own pinned PlanTemplateVersion schema) against the
// uploaded file, then forwards the resulting fields straight into the SAME
// exports.update this app's regular PUT already goes through by mutating
// req.body and calling it directly -- ownership/suspended checks, theme/
// grade validation, the update transaction, and segment-version diffing all
// come from there, unchanged, rather than a second copy of any of it.
exports.uploadDesignDoc = async (req, res) => {
  let tempDir = null;
  try {
    await uploadPlanDocSingle(req, res);
    if (!req.file) {
      return res.status(422).send({ message: "请选择要上传的 .docx 文件。" });
    }
    tempDir = path.dirname(req.file.path);

    const plan = await Plan.findByPk(req.params.id, {
      include: [{ model: TemplateVersion, as: "PlanTemplateVersion" }],
    });
    if (!plan) {
      return res.status(404).send({ message: `未找到乡土课程设计 id=${req.params.id}。` });
    }
    const schema = plan.PlanTemplateVersion ? plan.PlanTemplateVersion.schemaJson : { sections: [] };

    const { sectionAnswers, lessons, planFields, hasContent } = await planDocExtract.extractFromFile(req.file.path, schema);
    if (!hasContent && lessons.length === 0) {
      return res
        .status(422)
        .send({ message: "未能从文件中识别到有效内容，请确认文件是按课程设计方案模版填写的 .docx。" });
    }

    // 乡土主题 validated against the currently-ACTIVE plan_design template's
    // own themeOptions -- same source exports.getOptions (and, before this
    // moved server-side, the frontend's own PlanDataService.getOptions()
    // call before validating) already uses, not this plan's own possibly-
    // older pinned version, matching existing behavior exactly.
    let matchedTheme = null;
    if (planFields.theme) {
      let themeOptions = PLAN_THEMES;
      const activeVersion = await TemplateVersion.findOne({ where: { templateKey: "plan_design", isActive: true } });
      if (activeVersion && Array.isArray(activeVersion.schemaJson.themeOptions) && activeVersion.schemaJson.themeOptions.length > 0) {
        themeOptions = activeVersion.schemaJson.themeOptions;
      }
      matchedTheme = themeOptions.find((t) => t.trim() === planFields.theme.trim()) || null;
    }

    req.body = {
      planFormData: { ...sectionAnswers, lessons },
      ...(planFields.title ? { title: planFields.title } : {}),
      ...(planFields.grade ? { grade: planFields.grade } : {}),
      ...(planFields.studentCount ? { studentCount: Number(planFields.studentCount) } : {}),
      ...(planFields.instructorName ? { instructorName: planFields.instructorName } : {}),
      ...(matchedTheme ? { theme: matchedTheme } : {}),
      ...(lessons.length > 0
        ? { plannedLessonCount: lessons.length }
        : planFields.plannedLessonCount
        ? { plannedLessonCount: Number(planFields.plannedLessonCount) }
        : {}),
    };
    return exports.update(req, res);
  } catch (err) {
    return res.status(500).send({
      message: err.message || `上传乡土课程设计 id=${req.params.id} 的课程设计文件时发生错误。`,
    });
  } finally {
    if (tempDir) fs.rm(tempDir, { recursive: true, force: true }, () => {});
  }
};

// Same shape as uploadDesignDoc above, but for one 课时's 实施记录 -- the
// upload counterpart to renderExecutionDoc's GET. `existing` is read fresh
// from the plan's own current executionFormData column within this same
// request (rather than a client-supplied in-memory array, which is what the
// browser version had to do instead, reading from a live component prop
// specifically to avoid clobbering another lesson's unsaved edits sitting
// only in memory) -- server-side this is simply the authoritative value,
// no staleness risk to work around.
exports.uploadExecutionDoc = async (req, res) => {
  let tempDir = null;
  try {
    await uploadPlanDocSingle(req, res);
    if (!req.file) {
      return res.status(422).send({ message: "请选择要上传的 .docx 文件。" });
    }
    tempDir = path.dirname(req.file.path);

    const lessonIndex = Number(req.params.lessonIndex);
    if (!Number.isInteger(lessonIndex) || lessonIndex <= 0) {
      return res.status(422).send({ message: "课时序号无效。" });
    }

    const plan = await Plan.findByPk(req.params.id, {
      include: [{ model: TemplateVersion, as: "ExecutionTemplateVersion" }],
    });
    if (!plan) {
      return res.status(404).send({ message: `未找到乡土课程设计 id=${req.params.id}。` });
    }
    const schema = plan.ExecutionTemplateVersion ? plan.ExecutionTemplateVersion.schemaJson : { sections: [] };

    const { sectionAnswers, hasContent } = await planDocExtract.extractFromFile(req.file.path, schema);
    if (!hasContent) {
      return res
        .status(422)
        .send({ message: "未能从文件中识别到有效内容，请确认文件是按课时实施记录模板填写的 .docx。" });
    }

    const existing = Array.isArray(plan.executionFormData) ? plan.executionFormData : [];
    const newExecutionFormData = existing.some((r) => Number(r.index) === lessonIndex)
      ? existing.map((r) => (Number(r.index) === lessonIndex ? { ...sectionAnswers, index: lessonIndex } : r))
      : [...existing, { ...sectionAnswers, index: lessonIndex }];

    req.body = { executionFormData: newExecutionFormData };
    return exports.update(req, res);
  } catch (err) {
    return res.status(500).send({
      message: err.message || `上传乡土课程设计 id=${req.params.id} 第 ${req.params.lessonIndex} 课时的实施文件时发生错误。`,
    });
  } finally {
    if (tempDir) fs.rm(tempDir, { recursive: true, force: true }, () => {});
  }
};

// PUT /api/plans/migrate-my-plans -- teacher-only, scoped to req.userId (the
// "我的乡土课程" flashing 迁移 button's action). Bulk-migrates every one of the
// caller's own plans flagged needsMigration (set by an admin's
// template.controller.js#migrate) onto the currently-active plan_design
// version, via templateMigration.js's label-based field matching. A plan
// whose matching leaves old-only content behind gets
// needsManualMigrationReview instead of a clean "done" -- see
// #removeManualMigration below for how a teacher clears that.
exports.migrateMine = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const activeVersion = await TemplateVersion.findOne({
      where: { templateKey: "plan_design", isActive: true },
      transaction: t,
    });
    if (!activeVersion) {
      await t.rollback();
      return res.status(409).send({ message: "未找到课程设计方案模板的启用版本，无法迁移。" });
    }

    const plans = await Plan.findAll({
      where: { teacherId: req.userId, needsMigration: true },
      include: [{ model: TemplateVersion, as: "PlanTemplateVersion" }],
      transaction: t,
    });

    const now = new Date();
    let migratedCount = 0;
    let manualReviewCount = 0;

    for (const plan of plans) {
      if (plan.planTemplateVersionId === activeVersion.id) {
        await plan.update({ needsMigration: false }, { transaction: t });
        continue;
      }
      const oldSchema = plan.PlanTemplateVersion ? plan.PlanTemplateVersion.schemaJson : { sections: [] };
      const { newFormData, manualMigrationEntries } = migratePlanFormData(
        plan.planFormData,
        oldSchema,
        activeVersion.schemaJson
      );
      const hasManual = manualMigrationEntries.length > 0;
      await plan.update(
        {
          planFormData: newFormData,
          planTemplateVersionId: activeVersion.id,
          needsMigration: false,
          needsManualMigrationReview: hasManual,
          contentVersionAt: now,
        },
        { transaction: t }
      );
      migratedCount += 1;
      if (hasManual) manualReviewCount += 1;
    }

    await t.commit();
    return res.send({
      message: `已迁移 ${migratedCount} 个乡土课程设计${manualReviewCount ? `，其中 ${manualReviewCount} 个有内容需手动整理` : ""}。`,
      migratedCount,
      manualReviewCount,
    });
  } catch (err) {
    await t.rollback();
    return res.status(500).send({ message: err.message || "迁移乡土课程设计时发生错误。" });
  }
};

// DELETE /api/plans/:id/manual-migration -- owner-only (no admin bypass,
// same content-editing rule as #update), clears the migration leftovers
// plan.controller.js#migrateMine stashed at planFormData._manualMigration
// once the teacher has manually copied over whatever they still needed --
// this is what stops the plan's "flashing manual migration" styling.
exports.removeManualMigration = async (req, res) => {
  try {
    const plan = await Plan.findByPk(req.params.id);
    if (!plan) {
      return res.status(404).send({ message: `未找到乡土课程设计 id=${req.params.id}。` });
    }
    if (plan.teacherId !== req.userId) {
      return res.status(403).send({ message: "只能修改本人创建的乡土课程设计。" });
    }
    const nextFormData = { ...(plan.planFormData || {}) };
    delete nextFormData._manualMigration;
    await plan.update({
      planFormData: nextFormData,
      needsManualMigrationReview: false,
      contentVersionAt: new Date(),
    });
    return res.send({ message: "已删除手动迁移板块。" });
  } catch (err) {
    return res.status(500).send({ message: err.message || "删除手动迁移板块时发生错误。" });
  }
};
