// "Context-aware" 欣欣小助手: a question asked from a field's / section's
// 问欣欣小助手 menu on the plan page (plan-detail.component.js#AskAiMenu)
// carries a `focus` -- which part of the plan it is about, plus what the
// edit box holds right now (possibly unsaved). This module validates it,
// resolves it against the plan's own template (field hint, saved value), and
// renders it -- together with the user's relationship to the plan -- as
// system-prompt text, so the teacher no longer has to describe or paste the
// section they are working on.

// Which part of the plan: a WHY/WHAT/HOW-equivalent section, one 课时 of
// 分课时设计, or one 课时's 实施记录. With a fieldKey the focus is one field
// inside it; without, the whole part (or a subsection, per labelPath).
const FOCUS_KINDS = ["planSection", "planLesson", "executionRecord"];
const MAX_LABEL_PARTS = 6;
const MAX_LABEL_CHARS = 80;
const MAX_KEY_CHARS = 64;
// Bounds the edit box text carried per message -- a whole section's fields
// joined together can run long, and it is replayed nowhere else.
const MAX_DRAFT_CHARS = 6000;

const cleanString = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

// Client-supplied -> a stored, bounded shape, or null if it isn't one. The
// focus is only meaningful on a plan page (planId), and its planId always
// comes from that page context, never from the focus itself.
const normalizeFocus = (raw, planId) => {
  if (!raw || typeof raw !== "object" || !planId) return null;
  if (!FOCUS_KINDS.includes(raw.kind)) return null;
  const labelPath = (Array.isArray(raw.labelPath) ? raw.labelPath : [])
    .map((p) => cleanString(p, MAX_LABEL_CHARS))
    .filter(Boolean)
    .slice(0, MAX_LABEL_PARTS);
  if (labelPath.length === 0) return null;
  const lessonIndex = Number(raw.lessonIndex);
  const focus = { kind: raw.kind, planId: Number(planId), labelPath };
  const fieldKey = cleanString(raw.fieldKey, MAX_KEY_CHARS);
  const sectionKey = cleanString(raw.sectionKey, MAX_KEY_CHARS);
  if (fieldKey) focus.fieldKey = fieldKey;
  if (sectionKey) focus.sectionKey = sectionKey;
  if (Number.isInteger(lessonIndex) && lessonIndex > 0) focus.lessonIndex = lessonIndex;
  if (typeof raw.draftText === "string") {
    focus.draftText = raw.draftText.length > MAX_DRAFT_CHARS ? `${raw.draftText.slice(0, MAX_DRAFT_CHARS)}……（已截断）` : raw.draftText;
  }
  return focus;
};

// "WHY ·学习目标 › 核心问题" -- also the label the panel shows on the bubble.
const focusLabel = (focus) => (focus && Array.isArray(focus.labelPath) ? focus.labelPath.join(" › ") : "");

// Depth-first search of a template node (section / subsection / lessonSchema)
// for a field by key -- keys are unique across a whole schema.
const findField = (node, key) => {
  if (!node || !key) return null;
  for (const f of node.ownFields || node.fields || []) {
    if (f && f.key === key) return f;
  }
  for (const sub of node.subsections || []) {
    const hit = findField(sub, key);
    if (hit) return hit;
  }
  return null;
};

const findFieldInSchema = (schema, key) => {
  for (const section of (schema && schema.sections) || []) {
    const hit = findField(section, key);
    if (hit) return hit;
  }
  return null;
};

// planFormData is nested by section key for a multi-section schema, flat for
// a single-section one (plan-detail.component.js#mergeFormData) -- look in
// both places rather than re-deriving which.
const savedPlanValue = (planFormData, key) => {
  if (!planFormData || !key) return undefined;
  if (planFormData[key] != null && typeof planFormData[key] !== "object") return planFormData[key];
  for (const v of Object.values(planFormData)) {
    if (v && typeof v === "object" && !Array.isArray(v) && v[key] != null) return v[key];
  }
  return undefined;
};

const byLessonIndex = (records, index) => (Array.isArray(records) ? records.find((r) => r && Number(r.index) === Number(index)) : null) || {};

// The template field behind a field-level focus and its saved value, per
// which part of the plan it lives in. Either may be missing (a template
// re-uploaded since, an untouched field).
const resolveField = (plan, focus) => {
  if (!focus.fieldKey) return { field: null, saved: undefined };
  const planSchema = (plan.PlanTemplateVersion && plan.PlanTemplateVersion.schemaJson) || {};
  if (focus.kind === "planLesson") {
    const lesson = byLessonIndex(plan.planFormData && plan.planFormData.lessons, focus.lessonIndex);
    return { field: findField(planSchema.lessonSchema, focus.fieldKey), saved: lesson[focus.fieldKey] };
  }
  if (focus.kind === "executionRecord") {
    const execSchema = (plan.ExecutionTemplateVersion && plan.ExecutionTemplateVersion.schemaJson) || {};
    return { field: findFieldInSchema(execSchema, focus.fieldKey), saved: byLessonIndex(plan.executionFormData, focus.lessonIndex)[focus.fieldKey] };
  }
  return { field: findFieldInSchema(planSchema, focus.fieldKey), saved: savedPlanValue(plan.planFormData, focus.fieldKey) };
};

const PART_LABELS = {
  planSection: "课程设计方案",
  planLesson: "分课时设计",
  executionRecord: "实施记录",
};

// The block appended to the system prompt for the turn being answered.
// `plan` must be loaded with PlanTemplateVersion/ExecutionTemplateVersion.
const describeFocus = (plan, focus) => {
  const label = focusLabel(focus);
  const part = PART_LABELS[focus.kind] + (focus.lessonIndex ? `·第${focus.lessonIndex}课时` : "");
  const lines = [`\n\n【当前聚焦】用户是在课程设计《${plan.title}》(planId: ${plan.id}) 的「${label}」处（${part}）打开你的，本轮问题针对这一部分。`];
  lines.push("用户消息中的「这一栏」「这里」「这部分」等指的就是它；回答要紧扣这一部分，必要时结合课程的其他部分（可调用 get_plan_details 查看全文）。");

  const { field, saved } = resolveField(plan, focus);
  const hint = field && field.hint ? String(field.hint).trim() : "";
  const draft = typeof focus.draftText === "string" ? focus.draftText : undefined;
  const savedText = saved != null ? String(saved) : "";

  if (focus.fieldKey && hint && (draft === undefined || draft.trim() === hint) && !savedText.trim()) {
    lines.push(`该栏尚未填写，模板对这一栏的填写提示为：\n<<<\n${hint}\n>>>`);
    return lines.join("\n");
  }
  if (hint) lines.push(`模板对这一栏的填写提示：${hint.length > 400 ? `${hint.slice(0, 400)}……` : hint}`);

  const current = draft !== undefined ? draft : savedText;
  if (!current.trim()) {
    lines.push("这一部分目前是空的。");
  } else {
    const unsaved = draft !== undefined && focus.fieldKey && draft !== savedText;
    lines.push(`这一部分的当前内容${unsaved ? "（编辑框中的最新内容，尚未保存）" : ""}：\n<<<\n${current}\n>>>`);
  }
  return lines.join("\n");
};

// Who the user is *to this plan* -- the global role line (chat.controller.js
// #buildActionPrompt) says 教师/专家, but not whether this is their own plan
// they are editing or someone else's they are reviewing, which changes what
// a useful answer looks like.
const describeRelationship = (plan, userId, roles) => {
  const isOwner = String(plan.teacherId) === String(userId);
  const has = (r) => (roles || []).includes(r);
  if (isOwner) {
    return (
      "\n用户身份：该课程设计的作者，正在编写/修改它。回答以帮助作者把内容写好为目标；给修改建议时尽量直接给出可替换原文的修改稿。" +
      "只有用户明确要求「写进去」「保存」「替换」时才调用工具修改课程设计。"
    );
  }
  // Experts and admins get a neutral reading, matching their 解读这里-only
  // menu (ask-ai-menu.component.js) -- no ready-made review or verdict;
  // they still get one if they ask for it.
  if (has("expert") || has("admin") || has("super")) {
    const who = has("expert") ? "专家" : "管理员";
    return (
      `\n用户身份：${who}，正在查看他人的课程设计（只读）。回答以客观解读为主：说明内容与设计意图，用户明确要求时再给出评价或建议；` +
      "不要提议或尝试修改该课程设计。"
    );
  }
  return "\n用户身份：教师，正在浏览其他教师的课程设计（只读），多半是想学习借鉴。回答侧重解读设计思路与可借鉴之处；不要提议或尝试修改该课程设计。";
};

// The short tag an earlier turn's question carries when replayed as history,
// so "这一栏" in turn 3 still resolves to what it meant then.
const replayPrefix = (focus) => (focus && focus.labelPath ? `【针对：${focusLabel(focus)}】` : "");

module.exports = { normalizeFocus, describeFocus, describeRelationship, focusLabel, replayPrefix };
