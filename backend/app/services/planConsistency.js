// 目标一致性与完整性核查: a plan's design must be internally consistent --
// chiefly WHY·学习目标 must equal the union of the 分课时设计's per-lesson
// 教学目标: every stated objective is taken up by at least one lesson, and
// every lesson objective traces back to a stated objective -- and the
// objective fields themselves must be filled in.
//
// No LLM call of its own: this module supplies the deterministic half
// (which fields hold objectives -- schema-driven, by label, see
// extractObjectives -- which are empty, which planned lessons have no
// content at all) and lays the objectives out side by side; the mapping
// itself is done inside the same turn that scores and/or reviews the plan
// (aiPlanEvaluation.js), following INSTRUCTIONS. So the check applies to
// both AI 打分 and AI 点评 whether they run separately or combined, at no
// extra call.
const OBJECTIVE_RE = /目标/;

const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
const cleanLabel = (label) => str(label).replace(/^\d+\s*[.、．]\s*/, "").replace(/[：:]\s*$/, "");

// Every field holding an objective: all fields of a (sub)section whose own
// label names 目标 (e.g. "WHY ·学习目标"), plus any other field whose label
// does. Field keys are unique across a schema (see planCompletion.js#
// collectFieldKeys), so a Map dedupes a section's flattened `fields`
// against the same fields reached again through `subsections`.
function collectObjectiveFields(node, inObjectiveSection, out) {
  const here = inObjectiveSection || OBJECTIVE_RE.test(str(node.label));
  (node.fields || []).forEach((f) => {
    if (f && f.key && (here || OBJECTIVE_RE.test(str(f.label)))) out.set(f.key, cleanLabel(f.label) || f.key);
  });
  (node.subsections || []).forEach((child) => collectObjectiveFields(child, here, out));
  return out;
}

// { whyObjectives: [{ category, text }], lessons: [{ index, title, objectives,
// hasContent }], lessonObjectivesFromContent } -- `lessonObjectivesFromContent`
// is set when the template has no per-lesson 目标 field (a freeform 分课时设计),
// in which case each lesson's whole content stands in for its objectives and
// the AI extracts them.
function extractObjectives(plan, planFormData) {
  const schema = (plan.PlanTemplateVersion && plan.PlanTemplateVersion.schemaJson) || { sections: [] };
  const sections = schema.sections || [];
  const answers = planFormData || {};

  const whyObjectives = [];
  sections.forEach((section) => {
    const values = (sections.length > 1 ? answers[section.key] : answers) || {};
    collectObjectiveFields(section, false, new Map()).forEach((label, key) => {
      whyObjectives.push({ category: label, text: str(values[key]) });
    });
  });

  const lessonSchema = schema.lessonSchema;
  const objectiveKeys = lessonSchema ? [...collectObjectiveFields(lessonSchema, false, new Map()).keys()] : [];
  const titleField = lessonSchema && (lessonSchema.fields || []).find((f) => /标题/.test(str(f.label)));
  const fromContent = objectiveKeys.length === 0;

  const lessonRows = Array.isArray(answers.lessons) ? answers.lessons : [];
  const lessonCount = plan.plannedLessonCount || lessonRows.length || 0;
  const lessons = [];
  for (let i = 1; i <= lessonCount; i += 1) {
    const row = lessonRows.find((l) => Number(l.index) === i) || {};
    const hasContent = Object.entries(row).some(([k, v]) => k !== "index" && str(v) !== "");
    const objectives = fromContent
      ? [str(row.content)].filter(Boolean).join("\n")
      : objectiveKeys.map((k) => str(row[k])).filter(Boolean).join("\n");
    const title = titleField ? str(row[titleField.key]) : str(row.title);
    lessons.push({ index: i, title, objectives, hasContent });
  }
  return { whyObjectives, lessons, lessonObjectivesFromContent: fromContent };
}

// Deterministic completeness findings -- no LLM needed to see an empty box.
function checkCompleteness({ whyObjectives, lessons, lessonObjectivesFromContent }) {
  const issues = [];
  if (whyObjectives.length > 0 && whyObjectives.every((o) => !o.text)) {
    issues.push("WHY·学习目标 全部未填写，课程缺少总体学习目标。");
  }
  if (lessons.length === 0) {
    issues.push("未设置预计课时，也没有分课时设计，无法核对课时目标。");
  }
  const empty = lessons.filter((l) => !l.hasContent).map((l) => l.index);
  if (empty.length) issues.push(`第 ${empty.join("、")} 课时的分课时设计完全未填写。`);
  const noObjective = lessons.filter((l) => l.hasContent && !l.objectives).map((l) => l.index);
  if (noObjective.length) {
    issues.push(
      lessonObjectivesFromContent
        ? `第 ${noObjective.join("、")} 课时没有可识别的课时内容。`
        : `第 ${noObjective.join("、")} 课时未填写教学目标。`
    );
  }
  return issues;
}

const PRINCIPLE =
  "总体学习目标（WHY·学习目标）应当恰好等于各课时教学目标的并集：(a) 每一条总体学习目标都至少在一个课时中得到落实；(b) 每一个课时提出的教学目标都能在总体学习目标中找到对应。";

// What the evaluating turn is asked to do with inputText's material.
const INSTRUCTIONS =
  `核查原则：${PRINCIPLE}` +
  "请把总体学习目标与各课时教学目标分别拆分为独立的目标条目（一条目标只表达一个可落实的学习结果）并逐一对照。" +
  "判断看实质含义，不要求字面一致：课时目标是总体目标的具体化、组成部分或前置步骤时算对应；只是泛泛相关、或超出总体目标范围时不算对应。" +
  "同时留意其他明显的一致性或完整性问题，例如：驱动问题、最终成果或公开展示在分课时设计中没有落实；课程设计（HOW）的阶段安排与分课时设计不符；课时之间目标重复或顺序不合理。" +
  "只依据给出的材料，不要臆测未写出的内容。\n";

function objectivesLines(extracted) {
  const lines = ["【总体学习目标（WHY·学习目标）】"];
  extracted.whyObjectives.forEach((o) => lines.push(`${o.category}：${o.text || "（未填写）"}`));
  lines.push(
    extracted.lessonObjectivesFromContent
      ? "【分课时设计（模板没有单独的课时目标栏，请从课时内容中提取教学目标）】"
      : "【分课时设计·各课时教学目标】"
  );
  extracted.lessons.forEach((l) => {
    lines.push(`第${l.index}课时${l.title ? `《${l.title}》` : ""}：${l.objectives || "（未填写）"}`);
  });
  return lines;
}

// The check's input for the evaluating turn: the deterministic findings
// plus the objectives side by side. null for an upload-mode plan (no online
// form -- nothing structured to check). `plan` must be loaded with
// PlanTemplateVersion.
function inputText(plan) {
  if (!plan.planFormData) return null;
  const extracted = extractObjectives(plan, plan.planFormData);
  const lines = ["【目标一致性与完整性核查材料】"];
  const completeness = checkCompleteness(extracted);
  if (completeness.length) {
    lines.push("系统已发现的完整性问题：");
    completeness.forEach((m) => lines.push(`- ${m}`));
  }
  lines.push(...objectivesLines(extracted));
  return lines.join("\n");
}

module.exports = { inputText, INSTRUCTIONS, PRINCIPLE, extractObjectives, checkCompleteness };
