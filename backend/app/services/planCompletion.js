// 完成度: how much of the 计划 (plan) the teacher has filled in, plus --
// separately -- how much of the per-lesson 实施记录 is. Reported as separate
// percentages (no combined total), since the generic part, the per-lesson
// design and the implementation progress at very different paces:
//
//   总体设计完成度 (general) -- 基本信息 20% + 课程设计 80%:
//     基本信息   -- title (renamed from the "未命名课程设计" placeholder),
//                   theme, grade, season, 预计课时, 学生人数, 执教人
//     课程设计   -- WHY/WHAT/HOW: share of the pinned plan_design
//                   template's fields with an answer (an upload-mode plan
//                   with no online form counts as complete once a design
//                   file exists)
//   分课时设计完成度 (lessonDesign) -- per 课时, share of the template's
//     per-lesson fields answered, weighted over 预计课时 (see below)
//   实施完成度 (execution) -- per 课时, share of the pinned lesson_execution
//     template's fields answered in executionFormData, averaged evenly
//     over 预计课时 (records are written one by one as lessons are taught,
//     so every lesson counts the same)
//
// Within 分课时设计, lessons weigh linearly less the later they come: with n
// 课时, 课时1 weighs n, 课时2 n-1, ... 课时n 1 (normalized) -- e.g. 4 课时:
// 40%/30%/20%/10%. The nearer lessons are the ones a teacher works on
// first, so a plan whose first lessons are filled in counts as further
// along than one with only its last lessons done.
//
// Field-based rather than character-count-based so a long answer in one box
// can't make up for ten empty ones, and schema-driven (whichever template
// version the plan is pinned to) so it follows template changes without a
// code change. A plan with no 预计课时 and no lessons scores 0 on
// 分课时设计 -- planning zero lessons isn't a finished plan.
// Placeholder title plans-list.component.js#createEmptyPlan creates every
// new plan with -- not yet a real title.
const EMPTY_TITLE = "未命名课程设计";

// Weights within 总体设计完成度.
const GENERAL_WEIGHTS = { basic: 0.2, design: 0.8 };

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

// Linearly decaying lesson weights, see the header: 课时i weighs
// (count - i + 1) / (1 + 2 + ... + count).
const weightedOverLessons = (count, ratioForLesson) => {
  if (count <= 0) return 0;
  const total = (count * (count + 1)) / 2;
  let sum = 0;
  for (let i = 1; i <= count; i += 1) sum += ((count - i + 1) / total) * ratioForLesson(i);
  return sum;
};

// `plan` is a plain plan row; `planSchema`/`executionSchema` are the pinned
// plan_design/lesson_execution template versions' schemaJson (or null);
// `hasDesignArtifact` covers the upload-mode case.
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
  const lessonDesign = weightedOverLessons(lessonCount, (i) =>
    fillRatioForKeys(lessonKeys, lessons.find((l) => Number(l.index) === i))
  );

  const records = Array.isArray(plan.executionFormData) ? plan.executionFormData : [];
  const execution =
    lessonCount > 0 && executionSchema
      ? Array.from({ length: lessonCount }, (_, k) =>
          fillRatioForSchema(executionSchema, records.find((r) => Number(r.index) === k + 1))
        ).reduce((a, b) => a + b, 0) / lessonCount
      : 0;

  const general = GENERAL_WEIGHTS.basic * basic + GENERAL_WEIGHTS.design * design;
  const pct = (n) => Math.round(n * 100);
  return {
    general: pct(general),
    basic: pct(basic),
    design: pct(design),
    lessonDesign: pct(lessonDesign),
    execution: pct(execution),
    lessonCount,
  };
}

module.exports = { computeCompletion, GENERAL_WEIGHTS };
