const dynamicDocGenerator = require("./dynamicDocGenerator");
const textExtract = require("./textExtract");
const db = require("../models");

// Builds the same "what does this plan/lesson actually contain" text used
// both by review.controller.js's AI-review prompt and by the co-pilot's
// pageContext awareness (chat.controller.js) -- lifted out of
// review.controller.js so both consumers see identical content, not two
// slowly-diverging copies.

const findExecutionRecord = (plan, lessonIndex) => {
  const records = Array.isArray(plan.executionFormData) ? plan.executionFormData : [];
  return records.find((r) => Number(r.index) === Number(lessonIndex)) || {};
};

// Schema-agnostic (field keys come from whichever template_versions row is
// active, not a fixed list) -- any non-empty answer, ignoring the sparse
// array's own `index` bookkeeping key, counts as "has content".
const hasAnswerContent = (record) =>
  Object.entries(record || {}).some(([key, value]) => key !== "index" && value != null && String(value).trim() !== "");

// Which uploaded artifact's actual *content* (not just its filename) gets
// read in, in order of precedence: Word > PPT > photos > videos. Text-only --
// no vision support -- so only Word/PPT can really be read; a photo or video
// "wins" the precedence over a lower tier that isn't present, but never
// contributes extracted text of its own. Only the modern XML-based formats
// (.docx/.pptx) are extractable; a legacy .doc/.ppt in the winning tier still
// counts toward that tier -- so its presence doesn't fall through to a lower
// type -- it just contributes no text of its own.
const WORD_EXTS = ["docx"];
const PPT_EXTS = ["pptx"];
const MAX_EXTRACTED_CHARS = 6000; // keeps the prompt bounded regardless of how many/how large the winning tier's files are

const extractArtifactText = async (artifact) => textExtract.extractTextFromFile(artifact.attachmentPath, artifact.type);

// Caps the combined design+every-lesson text built by buildWholePlanContentText
// -- MAX_EXTRACTED_CHARS above already bounds one lesson's artifact extract,
// but nothing bounded the sum across every lesson once a plan has many.
const MAX_TOTAL_CHARS = 12000;

// Picks the highest-precedence tier with at least one artifact present, and
// extracts as much of its files' text as fits in MAX_EXTRACTED_CHARS
// (truncating the last file included, if any, rather than dropping it
// entirely). Returns null if there are no artifacts at all.
const buildPrecedenceExtract = async (artifacts) => {
  const tiers = [
    { label: "Word 文档", match: (a) => WORD_EXTS.includes((a.type || "").toLowerCase()) },
    { label: "PPT 课件", match: (a) => PPT_EXTS.includes((a.type || "").toLowerCase()) },
    { label: "照片", match: (a) => a.category === "图片" },
    { label: "视频", match: (a) => a.category === "视频" },
  ];
  for (const tier of tiers) {
    const matched = artifacts.filter(tier.match);
    if (matched.length === 0) continue;

    const parts = [];
    let used = 0;
    for (const artifact of matched) {
      const text = await extractArtifactText(artifact);
      if (!text) continue;
      const remaining = MAX_EXTRACTED_CHARS - used;
      if (remaining <= 0) break;
      const slice = text.length > remaining ? `${text.slice(0, remaining)}……（内容过长，已截断）` : text;
      parts.push(`【${artifact.attachmentName}】\n${slice}`);
      used += slice.length;
    }
    return { tierLabel: tier.label, matchedCount: matched.length, extractedCount: parts.length, text: parts.join("\n\n") };
  }
  return null;
};

const buildBasicInfoLines = (plan) => {
  const lines = [];
  lines.push(`课程标题：${plan.title || ""}`);
  if (plan.theme) lines.push(`乡土主题：${plan.theme}`);
  if (plan.grade) lines.push(`年级：${plan.grade}`);
  if (plan.studentCount) lines.push(`学生人数：${plan.studentCount}`);
  if (plan.instructorName) lines.push(`执教人：${plan.instructorName}`);
  if (plan.plannedLessonCount) lines.push(`预计课时：${plan.plannedLessonCount}`);
  // Locality anchor for the AI agent's theme/locality-first framing (see
  // review.controller.js's AI_REVIEW_SYSTEM_PROMPT and chat.controller.js's
  // COPILOT_SYSTEM_PROMPT) -- only present when the caller loaded `plan`
  // with the Teacher->School include (createAiReview, copilotActions.js's get_plan_details).
  if (plan.Teacher?.School?.address) lines.push(`学校/地区：${plan.Teacher.School.address}`);
  return lines;
};

const appendArtifactSection = async (lines, artifacts, introLine, listIntro) => {
  lines.push(introLine);
  lines.push(listIntro);
  for (const a of artifacts) {
    lines.push(`- [${a.category}] ${a.attachmentName}${a.description ? "：" + a.description : ""}`);
  }
  const extract = await buildPrecedenceExtract(artifacts);
  if (extract && extract.text) {
    lines.push(`\n以下是优先级最高的一类已上传文件（${extract.tierLabel}，共 ${extract.matchedCount} 个，已提取 ${extract.extractedCount} 个的文字内容）：`);
    lines.push(extract.text);
  }
};

// One lesson's 实施记录 content -- shared by buildPlanContentText's
// single-lesson branch and buildWholePlanContentText's per-lesson loop.
const buildLessonExecutionLines = async (plan, lessonIndex, artifacts) => {
  const lines = [];
  lines.push(`\n本次内容针对第 ${lessonIndex} 课时的乡土课程实施记录。`);

  const record = findExecutionRecord(plan, lessonIndex);
  const hasRecord = hasAnswerContent(record);
  if (hasRecord) {
    try {
      const buffer = await dynamicDocGenerator.generateDoc({
        docTitle: `课时实施记录 · 第${lessonIndex}课时`,
        schema: plan.ExecutionTemplateVersion ? plan.ExecutionTemplateVersion.schemaJson : { sections: [] },
        answers: record,
      });
      const docText = await textExtract.extractDocxTextFromBuffer(buffer);
      lines.push("以下是该课时的实施记录（在线填写，优先参考）：");
      lines.push(docText || "（文档内容为空）");
    } catch (e) {
      console.error("构建课时内容摘要：生成课时实施记录文档失败。", e.message);
    }
  }

  if (artifacts && artifacts.length > 0) {
    await appendArtifactSection(lines, artifacts, "", hasRecord ? "补充上传的支撑材料：" : "该课时已上传的支撑材料：");
  } else if (!hasRecord) {
    lines.push("该课时暂无实施记录或已上传的支撑材料文件。");
  }
  return lines;
};

// The whole design section's content -- shared by buildPlanContentText's
// design branch and buildWholePlanContentText. Now includes 分课时设计 (via
// dynamicDocGenerator's shared trailingChildren builder), which the design
// AI review previously omitted entirely.
const buildDesignLines = async (plan, artifacts) => {
  const lines = [];
  if (plan.planFormData) {
    try {
      const buffer = await dynamicDocGenerator.generateDoc({
        docTitle: "乡土课程设计方案",
        schema: plan.PlanTemplateVersion ? plan.PlanTemplateVersion.schemaJson : { sections: [] },
        answers: plan.planFormData,
        trailingChildren: dynamicDocGenerator.buildLessonDesignTrailingChildren(plan),
      });
      const docText = await textExtract.extractDocxTextFromBuffer(buffer);
      lines.push("\n以下是该课程设计方案文档内容：");
      lines.push(docText || "（文档内容为空）");
    } catch (e) {
      console.error("构建课程内容摘要：生成课程设计文档失败，回退为原始表单数据。", e.message);
      lines.push("\n以下是该课程设计方案的在线填写内容（JSON）：");
      lines.push(JSON.stringify(plan.planFormData, null, 2));
    }
  } else if (artifacts && artifacts.length > 0) {
    await appendArtifactSection(lines, artifacts, "", "该课程设计未使用在线表单填写，已上传的课程设计文件：");
  } else {
    lines.push("\n该课程设计暂无在线表单内容或上传文件。");
  }
  return lines;
};

// Renders the same plain-text summary of a plan (or one of its lessons) that
// review.controller.js's AI-review prompt sends the model -- basic info,
// then whichever of {online-filled record rendered to a doc and extracted,
// uploaded artifacts' own extracted text} is actually available, in that
// order of preference, matching exactly what a human reader would
// download/preview.
async function buildPlanContentText(plan, lessonIndex, artifacts) {
  const lines = buildBasicInfoLines(plan);
  if (lessonIndex) {
    lines.push(...(await buildLessonExecutionLines(plan, lessonIndex, artifacts)));
  } else {
    lines.push(...(await buildDesignLines(plan, artifacts)));
  }
  return lines.join("\n");
}

// The combined 设计+实施 content behind 实施/整体点评's AI review ("AI review
// on both sections") -- design content plus every lesson's execution
// content, each lesson rendered even with no content (buildLessonExecutionLines
// already degrades to a "暂无..." line, keeping lesson numbering intact).
async function buildWholePlanContentText(plan) {
  const lines = buildBasicInfoLines(plan);

  const designArtifacts = plan.planFormData
    ? []
    : await db.artifact.findAll({ where: { planId: plan.id, lessonIndex: null } });
  lines.push(...(await buildDesignLines(plan, designArtifacts)));

  const lessons = Array.isArray(plan.planFormData && plan.planFormData.lessons) ? plan.planFormData.lessons : [];
  const lessonCount = plan.plannedLessonCount || lessons.length || 0;
  for (let i = 1; i <= lessonCount; i += 1) {
    const lessonArtifacts = await db.artifact.findAll({ where: { planId: plan.id, lessonIndex: i } });
    lines.push(`\n—— 第${dynamicDocGenerator.lessonOrdinal(i)}课时 ——`);
    lines.push(...(await buildLessonExecutionLines(plan, i, lessonArtifacts)));
  }

  const text = lines.join("\n");
  return text.length > MAX_TOTAL_CHARS ? `${text.slice(0, MAX_TOTAL_CHARS)}\n……（内容过长，已截断）` : text;
}

// Just the design (basic info + 课程设计方案 incl. 分课时设计), bounded the
// same as buildWholePlanContentText -- for planConsistency.js, which checks
// the design against itself and has no use for the 实施记录.
async function buildDesignText(plan) {
  const lines = buildBasicInfoLines(plan);
  lines.push(...(await buildDesignLines(plan, [])));
  const text = lines.join("\n");
  return text.length > MAX_TOTAL_CHARS ? `${text.slice(0, MAX_TOTAL_CHARS)}\n……（内容过长，已截断）` : text;
}

const REVIEWER_TYPE_LABELS ={ ai: "AI点评", expert: "专家点评", admin: "管理员点评" };

// Mirrors review-list.component.js's sectionLabel, minus the sectionLabels
// map it resolves a heading-parsed template's auto-generated anchor keys
// ("S0"/"S1"/...) through -- that map is built client-side from the plan's
// own template schema and isn't available here, so those fall back to their
// raw key, which is still legible enough for an LLM prompt even if not as
// polished as the UI's own label.
const basicSectionLabel = (sectionKey, lessonIndex) => {
  if (!sectionKey) return "整体";
  if (sectionKey === "LESSON_DESIGN") return `分课时设计·第${lessonIndex || ""}课时`;
  if (sectionKey === "EXECUTION_RECORD") return `实施记录·第${lessonIndex || ""}课时`;
  if (sectionKey === "IMPLEMENTATION_OVERALL") return "实施整体";
  return sectionKey;
};

// Bounds how much review history a prompt carries -- both by entry count and
// by total rendered length -- so a plan with a long review history doesn't
// blow up the AI-review prompt's token budget the way MAX_TOTAL_CHARS
// already bounds buildWholePlanContentText's own content. Keeps the most
// recent entries (in chronological order) when the count cap trims anything,
// since recent feedback is more likely to still be actionable than old.
const REVIEW_HISTORY_MAX_ENTRIES = 20;
const REVIEW_HISTORY_MAX_CHARS = 4000;

// Renders every existing review on a plan as plain text, so a new AI-review
// request is aware of what's already been said -- by human experts and by
// its own prior runs -- instead of writing as if from a blank slate every
// time (see review.controller.js#createAiReview, which appends this to
// whichever content text it already built). Deliberately plan-wide rather
// than scoped to the requesting AI review's own section: a design-aggregate
// review benefits from knowing what a segment reviewer already flagged on
// WHAT·项目简介, for instance, not just prior 整体 comments.
async function buildReviewHistoryText(planId) {
  const reviews = await db.review.findAll({
    where: { planId, status: "submitted" },
    order: [["createdAt", "ASC"]],
    limit: REVIEW_HISTORY_MAX_ENTRIES,
  });
  if (reviews.length === 0) return "";

  const lines = [
    "\n以下是该课程设计此前收到的全部点评记录（含历史版本，按时间顺序），请参考、避免重复此前已提出的意见，并可在此基础上继续深入：",
  ];
  for (const r of reviews) {
    const typeLabel = REVIEWER_TYPE_LABELS[r.reviewerType] || r.reviewerType;
    const sectionLabel = basicSectionLabel(r.sectionKey, r.lessonIndex);
    const time = r.createdAt ? new Date(r.createdAt).toLocaleString("zh-cn") : "";
    const scoreNote = r.score !== null && r.score !== undefined ? `，评分：${r.score}` : "";
    lines.push(`- [${typeLabel} · ${sectionLabel} · ${time}${scoreNote}]\n  ${r.content}`);
  }

  const text = lines.join("\n");
  return text.length > REVIEW_HISTORY_MAX_CHARS ? `${text.slice(0, REVIEW_HISTORY_MAX_CHARS)}\n……（历史点评过多，已截断）` : text;
}

module.exports = {
  buildPlanContentText,
  buildWholePlanContentText,
  buildDesignText,
  buildReviewHistoryText,
};
