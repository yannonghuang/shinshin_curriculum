// Dashboard (admin only): one row per plan -- every plan, drafts and
// suspended ones included -- with its 完成度 (planCompletion.js), newest
// AI 打分 and expert-review summary. Both the table (GET /api/dashboard)
// and its Excel export (POST /api/dashboard/export) build rows here, so an
// exported cell always matches what the table showed.
const ExcelJS = require("exceljs");
const db = require("../models");
const { computeCompletion } = require("./planCompletion");
const aiReviewStandard = require("./aiReviewStandard");

const { Op } = db.Sequelize;
const Plan = db.plan;
const Review = db.review;
const AiPlanScore = db.aiPlanScore;

const UNASSIGNED_SCHOOL_NAME = "未分配学校";
const STATUS_LABELS = { draft: "草稿", submitted: "已提交", reviewed: "已点评" };

// Expert reviews written in 实施's scope show up only under 实施整体点评
// (see review-list.component.js's aggregate scoping); every other expert
// review is visible from 计划整体点评.
const IMPLEMENTATION_SECTION_KEYS = ["IMPLEMENTATION_OVERALL", "EXECUTION_RECORD"];

const round1 = (n) => Math.round(n * 10) / 10;
const timeOf = (d) => (d ? new Date(d).getTime() : null);

async function buildRows() {
  const plans = await Plan.findAll({
    attributes: { exclude: ["segmentVersionAt"] },
    include: [
      {
        model: db.user,
        as: "Teacher",
        attributes: ["id", "username", "chineseName"],
        include: [{ model: db.school, as: "School", attributes: ["code", "name"], required: false }],
      },
    ],
    order: [["id", "DESC"]],
  });
  if (plans.length === 0) return [];
  const planIds = plans.map((p) => p.id);

  // Loaded once and shared -- only a handful of template versions exist,
  // so eager-including schemaJson on every plan would repeat it N times.
  const versionIds = new Set();
  plans.forEach((p) => {
    if (p.planTemplateVersionId) versionIds.add(p.planTemplateVersionId);
    if (p.executionTemplateVersionId) versionIds.add(p.executionTemplateVersionId);
  });
  const [versions, designArtifacts, scoreRows, reviewRows, standard] = await Promise.all([
    db.templateVersion.findAll({ where: { id: { [Op.in]: Array.from(versionIds) } }, attributes: ["id", "schemaJson"] }),
    db.artifact.findAll({ where: { planId: { [Op.in]: planIds }, lessonIndex: null }, attributes: ["planId"], raw: true }),
    AiPlanScore.findAll({ where: { planId: { [Op.in]: planIds } }, order: [["id", "DESC"]] }),
    Review.findAll({
      where: { planId: { [Op.in]: planIds }, reviewerType: { [Op.in]: ["ai", "expert"] } },
      attributes: ["planId", "reviewerType", "sectionKey", "score", "createdAt"],
      include: [{ model: db.user, as: "Reviewer", attributes: ["username", "chineseName"], required: false }],
    }),
    aiReviewStandard.getLatestStandard(),
  ]);

  const schemaById = new Map(versions.map((v) => [Number(v.id), v.schemaJson]));
  const hasDesignArtifact = new Set(designArtifacts.map((a) => Number(a.planId)));
  const latestScore = new Map();
  scoreRows.forEach((s) => {
    if (!latestScore.has(Number(s.planId))) latestScore.set(Number(s.planId), s);
  });
  const reviewsByPlan = new Map();
  reviewRows.forEach((r) => {
    const key = Number(r.planId);
    if (!reviewsByPlan.has(key)) reviewsByPlan.set(key, []);
    reviewsByPlan.get(key).push(r);
  });

  return plans.map((p) => {
    const id = Number(p.id);
    const teacher = p.Teacher;
    const school = teacher && teacher.School;
    const s = latestScore.get(id);
    const reviews = reviewsByPlan.get(id) || [];
    const expert = reviews.filter((r) => r.reviewerType === "expert");
    const expertScores = expert.map((r) => r.score).filter((v) => v !== null && v !== undefined).map(Number);
    const reviewerNames = Array.from(
      new Set(expert.map((r) => (r.Reviewer ? r.Reviewer.chineseName || r.Reviewer.username : "")).filter(Boolean))
    );
    const lastExpertAt = expert.reduce((max, r) => (timeOf(r.createdAt) > max ? timeOf(r.createdAt) : max), 0);

    return {
      planId: id,
      title: p.title,
      teacherId: p.teacherId,
      teacherName: teacher ? teacher.chineseName || teacher.username : "",
      schoolCode: school ? school.code : null,
      schoolName: school ? school.name : UNASSIGNED_SCHOOL_NAME,
      year: p.year,
      season: p.season,
      grade: p.grade,
      theme: p.theme,
      status: p.status,
      submitted: p.status !== "draft",
      suspended: p.suspended,
      isExcellentCase: p.isExcellentCase,
      updatedAt: p.contentVersionAt,
      completion: computeCompletion(p, {
        planSchema: schemaById.get(Number(p.planTemplateVersionId)) || null,
        executionSchema: schemaById.get(Number(p.executionTemplateVersionId)) || null,
        hasDesignArtifact: hasDesignArtifact.has(id),
      }),
      aiScore: s
        ? {
            totalScore: Number(s.totalScore),
            dimensionScores: s.dimensionScores,
            summary: s.summary,
            standardId: s.standardId,
            createdAt: s.createdAt,
            outdatedStandard: !!standard && Number(s.standardId) !== Number(standard.id),
            contentChanged: timeOf(s.planVersionAt) !== timeOf(p.contentVersionAt),
          }
        : null,
      aiReviewed: reviews.some((r) => r.reviewerType === "ai"),
      expertReviews: {
        count: expert.length,
        averageScore: expertScores.length ? round1(expertScores.reduce((a, b) => a + b, 0) / expertScores.length) : null,
        reviewers: reviewerNames,
        lastAt: lastExpertAt ? new Date(lastExpertAt) : null,
        // Which 整体点评 view to link to -- see IMPLEMENTATION_SECTION_KEYS.
        scope:
          expert.length > 0 && expert.every((r) => IMPLEMENTATION_SECTION_KEYS.includes(r.sectionKey))
            ? "implementation"
            : "design",
      },
    };
  });
}

const termLabel = (row) => `${row.year}年${row.season || ""}`;
const yesNo = (v) => (v ? "是" : "否");
const dateText = (d) => (d ? new Date(d).toLocaleString("zh-CN", { hour12: false }) : "");

// Everything the Excel export can include, in column order. `defaultOn`
// marks the set pre-selected in the export dialog (the table's own columns).
const EXPORT_FIELDS = [
  { key: "teacherName", label: "教师姓名", width: 12, defaultOn: true, value: (r) => r.teacherName },
  { key: "schoolName", label: "学校", width: 28, defaultOn: true, value: (r) => r.schoolName },
  { key: "schoolCode", label: "学校代码", width: 12, value: (r) => r.schoolCode || "" },
  { key: "title", label: "课程名称", width: 30, defaultOn: true, value: (r) => r.title },
  { key: "planUrl", label: "课程链接", width: 40, value: (r, ctx) => (ctx.origin ? `${ctx.origin}/plans/${r.planId}` : "") },
  { key: "term", label: "学期", width: 12, value: termLabel },
  { key: "grade", label: "年级", width: 10, value: (r) => r.grade || "" },
  { key: "theme", label: "乡土主题", width: 16, value: (r) => r.theme || "" },
  { key: "status", label: "状态", width: 8, value: (r) => STATUS_LABELS[r.status] || r.status },
  { key: "submitted", label: "是否提交", width: 8, defaultOn: true, value: (r) => yesNo(r.submitted) },
  { key: "completion", label: "完成度(%)", width: 10, defaultOn: true, value: (r) => r.completion.overall },
  { key: "completionBasic", label: "基本信息(%)", width: 10, value: (r) => r.completion.basic },
  { key: "completionDesign", label: "课程设计(%)", width: 10, value: (r) => r.completion.design },
  { key: "completionLessonDesign", label: "分课时设计(%)", width: 12, value: (r) => r.completion.lessonDesign },
  { key: "completionExecution", label: "课时实施(%)", width: 10, value: (r) => r.completion.execution },
  { key: "lessonCount", label: "课时数", width: 8, value: (r) => r.completion.lessonCount },
  { key: "aiScore", label: "AI 总分", width: 8, defaultOn: true, value: (r) => (r.aiScore ? r.aiScore.totalScore : "") },
  {
    key: "aiDimensions",
    label: "AI 各维度得分",
    width: 40,
    value: (r) =>
      r.aiScore ? (r.aiScore.dimensionScores || []).map((d) => `${d.name}：${d.score}/${d.weight}`).join("\n") : "",
  },
  { key: "aiSummary", label: "AI 打分总结", width: 50, value: (r) => (r.aiScore ? r.aiScore.summary || "" : "") },
  { key: "aiScoredAt", label: "AI 打分时间", width: 18, value: (r) => (r.aiScore ? dateText(r.aiScore.createdAt) : "") },
  { key: "aiReviewed", label: "AI 已点评", width: 8, value: (r) => yesNo(r.aiReviewed) },
  { key: "expertReviewCount", label: "专家点评数", width: 10, defaultOn: true, value: (r) => r.expertReviews.count },
  {
    key: "expertAverageScore",
    label: "专家平均分",
    width: 10,
    value: (r) => (r.expertReviews.averageScore === null ? "" : r.expertReviews.averageScore),
  },
  { key: "expertReviewers", label: "点评专家", width: 20, value: (r) => r.expertReviews.reviewers.join("、") },
  { key: "suspended", label: "已停用", width: 8, value: (r) => yesNo(r.suspended) },
  { key: "isExcellentCase", label: "优秀案例", width: 8, value: (r) => yesNo(r.isExcellentCase) },
  { key: "updatedAt", label: "最近修改", width: 18, value: (r) => dateText(r.updatedAt) },
];

const exportFieldOptions = () => EXPORT_FIELDS.map(({ key, label, defaultOn }) => ({ key, label, defaultOn: !!defaultOn }));

// `planIds` is the table's current filtered + sorted order; `fieldKeys`
// the columns picked in the export dialog (unknown keys ignored).
async function buildWorkbook({ planIds, fieldKeys, origin }) {
  const rows = await buildRows();
  const byId = new Map(rows.map((r) => [r.planId, r]));
  const selected = (Array.isArray(planIds) ? planIds : rows.map((r) => r.planId))
    .map((id) => byId.get(Number(id)))
    .filter(Boolean);
  const wanted = new Set(Array.isArray(fieldKeys) ? fieldKeys : []);
  const fields = EXPORT_FIELDS.filter((f) => wanted.has(f.key));
  if (fields.length === 0) {
    const err = new Error("请至少选择一个导出字段。");
    err.status = 422;
    throw err;
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("乡土课程");
  sheet.columns = fields.map((f) => ({ header: f.label, key: f.key, width: f.width }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  const ctx = { origin };
  selected.forEach((r) => {
    const row = sheet.addRow(Object.fromEntries(fields.map((f) => [f.key, f.value(r, ctx)])));
    const urlCell = fields.some((f) => f.key === "planUrl") && row.getCell("planUrl");
    if (urlCell && urlCell.value) urlCell.value = { text: urlCell.value, hyperlink: urlCell.value };
  });
  sheet.eachRow((row) => {
    row.alignment = { vertical: "top", wrapText: true };
  });
  return workbook.xlsx.writeBuffer();
}

module.exports = { buildRows, buildWorkbook, exportFieldOptions };
