// 目标一致性与完整性核查: checks that a plan's design is internally
// consistent -- chiefly that WHY·学习目标 equals the union of the 分课时设计's
// per-lesson 教学目标: every stated objective is taken up by at least one
// lesson, and every lesson objective traces back to a stated objective --
// plus the completeness of the objective fields themselves. The report is fed
// to both AI 打分 (aiPlanScoring.js) and AI 点评 (aiPlanReview.js), so a
// score and a review of the same plan judge its consistency from the same
// findings rather than each noticing (or missing) gaps on its own.
//
// Two halves:
// - deterministic: which fields hold objectives (schema-driven, by label --
//   see extractObjectives), which are empty, which planned lessons have no
//   content at all;
// - AI: splits the WHY objectives into atomic items and maps each lesson
//   objective onto them. Coverage in both directions is then *derived* from
//   that one mapping (see reconcile), so "covered by a lesson" and "traces
//   back to WHY" can't contradict each other.
const llmClient = require("./llmClient");
const planContext = require("./planContext");

const OBJECTIVE_RE = /目标/;

const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
const cleanLabel = (label) => str(label).replace(/^\d+\s*[.、．]\s*/, "").replace(/[：:]\s*$/, "");
const timeOf = (d) => (d ? new Date(d).getTime() : null);

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

// Shared with every prompt that judges consistency (the standalone check
// below, AI 打分, AI 点评, and the combined 打分加点评 turn) so they all hold
// the plan to the same rule.
const PRINCIPLE =
  "总体学习目标（WHY·学习目标）应当恰好等于各课时教学目标的并集：(a) 每一条总体学习目标都至少在一个课时中得到落实；(b) 每一个课时提出的教学目标都能在总体学习目标中找到对应。";

// How a lesson objective counts as "corresponding" -- shared by the
// standalone check and the combined turn's in-line check.
const MATCH_RULE =
  "判断看实质含义，不要求字面一致：课时目标是总体目标的具体化、组成部分或前置步骤时算对应；只是泛泛相关、或超出总体目标范围时不算对应。";

const OTHER_ISSUES_HINT =
  "其他明显的一致性或完整性问题，例如：驱动问题、最终成果或公开展示在分课时设计中没有落实；课程设计（HOW）的阶段安排与分课时设计不符；课时之间目标重复或顺序不合理";

const SYSTEM_PROMPT =
  "你是乡土课程设计审核专家，负责核查一份课程设计方案中「总体学习目标」（WHY·学习目标）与「分课时设计」中各课时教学目标之间的一致性与完整性。\n" +
  `原则：${PRINCIPLE}\n` +
  "步骤：\n" +
  "1. 把总体学习目标拆分为独立的目标条目（一条目标只表达一个可落实的学习结果），编号 W1、W2……，保留其所属类别（如认知思维目标），text 尽量引用原文；\n" +
  `2. 把每个课时的教学目标拆分为独立的目标条目，对每一条判断它对应哪些总体目标条目（matches 填编号，可多个；确实无对应时为空数组）。${MATCH_RULE}\n` +
  `3. otherIssues 列出${OTHER_ISSUES_HINT}（最多 5 条）。没有则为空数组；\n` +
  "4. summary 用 1-2 句话概括一致性状况。\n" +
  "只依据给出的材料，不要臆测未写出的内容；全文不得提及任何人名。\n" +
  "严格以 JSON 格式回复，不要包含其他文字或代码块标记：" +
  '{"whyObjectives": [{"id": "W1", "category": "认知思维目标", "text": "..."}], ' +
  '"lessonObjectives": [{"lesson": 1, "text": "...", "matches": ["W1"]}], "otherIssues": ["..."], "summary": "..."}';

// The objectives, laid out side by side -- the standalone check's input,
// and (with the completeness findings) the combined turn's in-line one.
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

function buildUserContent(plan, extracted, designText) {
  const lines = [`课程标题：${plan.title || ""}`, "", ...objectivesLines(extracted)];
  if (designText) lines.push(`\n【课程设计方案全文（供核对驱动问题、最终成果、阶段安排等）】\n${designText}`);
  return lines.join("\n");
}

// Coverage is derived from the lesson->WHY mapping alone: a WHY item is
// covered iff some lesson objective matches it, and a lesson objective is
// an orphan iff it matches none. Unknown ids / lesson numbers the model
// invents are dropped rather than trusted.
function reconcile(parsed, extracted) {
  const why = (Array.isArray(parsed.whyObjectives) ? parsed.whyObjectives : [])
    .map((o) => ({ id: str(o && o.id), category: str(o && o.category), text: str(o && o.text) }))
    .filter((o) => o.id && o.text);
  const ids = new Set(why.map((o) => o.id));
  const lessonIndexes = new Set(extracted.lessons.map((l) => l.index));
  const lessonObjectives = (Array.isArray(parsed.lessonObjectives) ? parsed.lessonObjectives : [])
    .map((o) => ({
      lesson: Number(o && o.lesson),
      text: str(o && o.text),
      matches: (Array.isArray(o && o.matches) ? o.matches : []).map(str).filter((id) => ids.has(id)),
    }))
    .filter((o) => lessonIndexes.has(o.lesson) && o.text);

  const whyObjectives = why.map((o) => ({
    ...o,
    coveredBy: [...new Set(lessonObjectives.filter((l) => l.matches.includes(o.id)).map((l) => l.lesson))].sort((a, b) => a - b),
  }));
  return {
    whyObjectives,
    lessonObjectives,
    uncovered: whyObjectives.filter((o) => o.coveredBy.length === 0),
    orphans: lessonObjectives.filter((o) => o.matches.length === 0),
    otherIssues: (Array.isArray(parsed.otherIssues) ? parsed.otherIssues : []).map(str).filter(Boolean),
    summary: str(parsed.summary),
  };
}

// Same content + same prompt at temperature 0 gives the same report, and
// AI 打分 and AI 点评 of the same content each ask for it -- so reports are
// cached per plan content version. Bounded; oldest entries evicted first.
const CACHE_MAX = 200;
const cache = new Map();

function cacheGet(key) {
  return cache.get(key);
}

function cacheSet(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// `plan` must be loaded with PlanTemplateVersion (every AI caller's
// planIncludes already are). Returns null for an upload-mode plan (no online
// form -- nothing structured to check), otherwise
// { completeness: [...], alignment: {...} | null, alignmentError, model }.
// An AI failure degrades to the deterministic half rather than failing the
// score/review that asked for the report.
const cacheKey = (plan) => `${plan.id}:${timeOf(plan.contentVersionAt)}`;

async function checkPlan(plan) {
  if (!plan.planFormData) return null;
  const key = cacheKey(plan);
  const cached = cacheGet(key);
  if (cached) return cached;

  const extracted = extractObjectives(plan, plan.planFormData);
  const completeness = checkCompleteness(extracted);
  const hasWhy = extracted.whyObjectives.some((o) => o.text);
  const hasLessonObjectives = extracted.lessons.some((l) => l.objectives);

  const report = { completeness, alignment: null, alignmentError: null, model: null };
  if (hasWhy && hasLessonObjectives) {
    try {
      const designText = await planContext.buildDesignText(plan);
      const result = await llmClient.llmChat({
        systemPrompt: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserContent(plan, extracted, designText) }],
        maxTokens: 3072,
        temperature: 0,
      });
      const cleaned = (result.text || "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
      report.alignment = reconcile(JSON.parse(cleaned), extracted);
      report.model = result.model;
    } catch (e) {
      console.error(`目标一致性核查失败（课程 #${plan.id}）:`, e.message);
      report.alignmentError = e.message;
    }
  }
  // Only a complete report is cached -- a transient AI failure shouldn't
  // pin the degraded version for this content version.
  if (!report.alignmentError) cacheSet(key, report);
  return report;
}

// The report as prompt text for AI 打分/点评. Deliberately states findings,
// not verdicts on the score -- how much they weigh is the rubric's call.
function reportText(report) {
  if (!report) return "";
  const lines = ["【目标一致性与完整性核查结果】（系统预先核查，打分与点评须据此评判课程目标与分课时设计之间的一致性与完整性）"];
  if (report.completeness.length) {
    lines.push("完整性问题：");
    report.completeness.forEach((m) => lines.push(`- ${m}`));
  }
  const a = report.alignment;
  if (a) {
    lines.push(`总体学习目标共 ${a.whyObjectives.length} 条，分课时教学目标共 ${a.lessonObjectives.length} 条。`);
    if (a.uncovered.length) {
      lines.push("未在任何课时中落实的总体学习目标：");
      a.uncovered.forEach((o) => lines.push(`- ${o.id}（${o.category}）${o.text}`));
    } else {
      lines.push("每一条总体学习目标都至少在一个课时中得到落实。");
    }
    if (a.orphans.length) {
      lines.push("在总体学习目标中找不到对应的课时教学目标：");
      a.orphans.forEach((o) => lines.push(`- 第${o.lesson}课时：${o.text}`));
    } else {
      lines.push("每一条课时教学目标都能在总体学习目标中找到对应。");
    }
    lines.push("总体目标落实情况：");
    a.whyObjectives.forEach((o) =>
      lines.push(`- ${o.id}（${o.category}）${o.text} → ${o.coveredBy.length ? `第 ${o.coveredBy.join("、")} 课时` : "无"}`)
    );
    if (a.otherIssues.length) {
      lines.push("其他一致性问题：");
      a.otherIssues.forEach((m) => lines.push(`- ${m}`));
    }
    if (a.summary) lines.push(`概述：${a.summary}`);
  } else if (report.alignmentError) {
    lines.push("（目标对应关系核查未能完成，请直接依据课程材料判断总体目标与课时目标的一致性。）");
  } else if (!report.completeness.length) {
    lines.push("（目标信息不足，无法核对对应关系。）");
  }
  return lines.join("\n");
}

// For the combined 打分加点评 turn (aiScoreAndReview.js), which avoids a
// separate LLM call for the check: a report already cached for this content
// is reused as is (free); otherwise the deterministic half plus the
// objectives side by side, for the same turn to do the mapping itself (see
// INLINE_INSTRUCTIONS). Returns { text, inline } or null for an upload-mode
// plan.
function combinedTurnInput(plan) {
  if (!plan.planFormData) return null;
  const cached = cacheGet(cacheKey(plan));
  if (cached) return { text: reportText(cached), inline: false };
  const extracted = extractObjectives(plan, plan.planFormData);
  const lines = ["【目标一致性与完整性核查材料】（请按要求自行完成核查）"];
  const completeness = checkCompleteness(extracted);
  if (completeness.length) {
    lines.push("系统已发现的完整性问题：");
    completeness.forEach((m) => lines.push(`- ${m}`));
  }
  lines.push(...objectivesLines(extracted));
  return { text: lines.join("\n"), inline: true };
}

// What the combined turn is asked to do with combinedTurnInput's in-line
// material -- the standalone check's steps, reduced to just the findings.
const INLINE_INSTRUCTIONS =
  `核查原则：${PRINCIPLE}${MATCH_RULE}` +
  "请先把总体学习目标与各课时教学目标拆分为独立条目并逐一对照，在 JSON 的 consistency 中只列出问题：" +
  "uncovered（未在任何课时中落实的总体目标，引用原文）、orphans（在总体目标中找不到对应的课时目标，写成“第N课时：目标原文”）、" +
  `otherIssues（${OTHER_ISSUES_HINT}，最多 3 条）；没有问题的项为空数组。`;

module.exports = { checkPlan, reportText, combinedTurnInput, INLINE_INSTRUCTIONS, PRINCIPLE, extractObjectives, checkCompleteness, reconcile };
