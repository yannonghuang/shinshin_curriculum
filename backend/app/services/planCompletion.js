// 完成度: how much of a plan the teacher has actually filled in, as a
// weighted average of four parts (each 0..1):
//
//   基本信息     10%  -- title (renamed from the "未命名课程设计" placeholder),
//                       theme, grade, season, 预计课时, 学生人数, 执教人
//   课程设计     40%  -- share of the pinned plan_design template's fields
//                       with an answer (an upload-mode plan with no online
//                       form counts as complete once a design file exists)
//   分课时设计   20%  -- per 课时, share of the template's per-lesson fields
//                       answered, averaged over 预计课时
//   课时实施     30%  -- per 课时, share of the pinned lesson_execution
//                       template's fields answered, averaged over 预计课时
//
// Field-based rather than character-count-based so a long answer in one box
// can't make up for ten empty ones, and schema-driven (whichever template
// version the plan is pinned to) so it follows template changes without a
// code change. A plan with no 预计课时 and no lessons scores 0 on both
// per-lesson parts -- planning zero lessons isn't a finished plan.
// Placeholder title plans-list.component.js#createEmptyPlan creates every
// new plan with -- not yet a real title.
const EMPTY_TITLE = "未命名课程设计";

const WEIGHTS = { basic: 0.1, design: 0.4, lessonDesign: 0.2, execution: 0.3 };

const isFilled = (value) => {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.some(isFilled);
  if (typeof value === "object") return Object.values(value).some(isFilled);
  return false;
};

// Field keys are unique across a whole schema (see dynamicDocGenerator.js#
// renderSectionTree), so a Set dedupes a top-level section's flattened
// `fields` against the same fields reached again through `subsections`.
const collectFieldKeys = (node, keys = new Set()) => {
  (node.fields || []).forEach((f) => f && f.key && keys.add(f.key));
  (node.subsections || []).forEach((child) => collectFieldKeys(child, keys));
  return keys;
};

// Same answers layout as dynamicDocGenerator.js#sectionAnswers: namespaced
// by section key only when the schema has more than one section.
const fillRatioForSchema = (schema, answers) => {
  const sections = (schema && schema.sections) || [];
  let total = 0;
  let filled = 0;
  sections.forEach((section) => {
    const values = (sections.length > 1 ? (answers || {})[section.key] : answers) || {};
    collectFieldKeys(section).forEach((key) => {
      total += 1;
      if (isFilled(values[key])) filled += 1;
    });
  });
  return total ? filled / total : 0;
};

const fillRatioForKeys = (keys, values) => {
  if (keys.length === 0) return 0;
  return keys.filter((key) => isFilled((values || {})[key])).length / keys.length;
};

const lessonCountOf = (plan) => {
  const lessons = Array.isArray(plan.planFormData && plan.planFormData.lessons) ? plan.planFormData.lessons : [];
  return plan.plannedLessonCount || lessons.length || 0;
};

const averageOverLessons = (count, ratioForLesson) => {
  if (count <= 0) return 0;
  let sum = 0;
  for (let i = 1; i <= count; i += 1) sum += ratioForLesson(i);
  return sum / count;
};

// `plan` is a plain plan row; `planSchema`/`executionSchema` are the pinned
// template versions' schemaJson (or null); `hasDesignArtifact` covers the
// upload-mode case.
function computeCompletion(plan, { planSchema, executionSchema, hasDesignArtifact }) {
  const basicValues = [
    plan.title && plan.title.trim() !== EMPTY_TITLE ? plan.title : null,
    plan.theme,
    plan.grade,
    plan.season,
    plan.plannedLessonCount,
    plan.studentCount,
    plan.instructorName,
  ];
  const basic = basicValues.filter(isFilled).length / basicValues.length;

  const design = plan.planFormData ? fillRatioForSchema(planSchema, plan.planFormData) : hasDesignArtifact ? 1 : 0;

  const lessonCount = lessonCountOf(plan);
  const lessons = Array.isArray(plan.planFormData && plan.planFormData.lessons) ? plan.planFormData.lessons : [];
  const lessonSchema = planSchema && planSchema.lessonSchema;
  // No per-lesson template -> the freeform 标题/内容 pair dynamicDocGenerator
  // falls back to.
  const lessonKeys = lessonSchema ? Array.from(collectFieldKeys(lessonSchema)) : ["title", "content"];
  const lessonDesign = averageOverLessons(lessonCount, (i) =>
    fillRatioForKeys(lessonKeys, lessons.find((l) => Number(l.index) === i))
  );

  const records = Array.isArray(plan.executionFormData) ? plan.executionFormData : [];
  const execution = averageOverLessons(lessonCount, (i) =>
    fillRatioForSchema(executionSchema, records.find((r) => Number(r.index) === i) || {})
  );

  const parts = { basic, design, lessonDesign, execution };
  const overall = Object.keys(WEIGHTS).reduce((sum, k) => sum + WEIGHTS[k] * parts[k], 0);
  const pct = (n) => Math.round(n * 100);
  return {
    overall: pct(overall),
    basic: pct(basic),
    design: pct(design),
    lessonDesign: pct(lessonDesign),
    execution: pct(execution),
    lessonCount,
  };
}

module.exports = { computeCompletion, WEIGHTS };
