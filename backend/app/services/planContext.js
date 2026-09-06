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

// Renders the same plain-text summary of a plan (or one of its lessons) that
// review.controller.js's AI-review prompt sends the model -- basic info,
// then whichever of {online-filled record rendered to a doc and extracted,
// uploaded artifacts' own extracted text} is actually available, in that
// order of preference, matching exactly what a human reader would
// download/preview.
async function buildPlanContentText(plan, lessonIndex, artifacts) {
  const lines = [];
  lines.push(`课程标题：${plan.title || ""}`);
  if (plan.theme) lines.push(`乡土主题：${plan.theme}`);
  if (plan.grade) lines.push(`年级：${plan.grade}`);
  if (plan.plannedLessonCount) lines.push(`预计课时：${plan.plannedLessonCount}`);

  const appendArtifactSection = async (introLine, listIntro) => {
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

  if (lessonIndex) {
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
      await appendArtifactSection("", hasRecord ? "补充上传的支撑材料：" : "该课时已上传的支撑材料：");
    } else if (!hasRecord) {
      lines.push("该课时暂无实施记录或已上传的支撑材料文件。");
    }
  } else if (plan.planFormData) {
    try {
      const buffer = await dynamicDocGenerator.generateDoc({
        docTitle: "乡土课程设计方案",
        schema: plan.PlanTemplateVersion ? plan.PlanTemplateVersion.schemaJson : { sections: [] },
        answers: plan.planFormData,
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
    await appendArtifactSection("", "该课程设计未使用在线表单填写，已上传的课程设计文件：");
  } else {
    lines.push("\n该课程设计暂无在线表单内容或上传文件。");
  }

  return lines.join("\n");
}

// OpenAI-style tool definition for the co-pilot agent loop (chat.controller.js)
// -- lets the model fetch a plan's actual content on demand rather than
// having it force-injected into every single turn, mirroring
// knowledgeRetrieve.js's searchKnowledgeBaseToolDef pattern exactly. The
// system prompt only needs a lightweight "you're looking at 《title》
// (planId: N)" pointer; the model calls this when a question actually
// concerns the plan's content (e.g. "review this plan"), not for every
// message in the conversation.
const getPlanDetailsToolDef = {
  type: "function",
  function: {
    name: "get_plan_details",
    description: "获取指定乡土课程设计的详细内容（基本信息、WHY/WHAT/HOW 在线填写内容或已上传文件的文字内容等）。",
    parameters: {
      type: "object",
      properties: {
        planId: { type: "number", description: "课程设计 ID" },
      },
      required: ["planId"],
    },
  },
};

async function getPlanDetails({ planId }) {
  const plan = await db.plan.findByPk(planId, {
    include: [
      { model: db.templateVersion, as: "PlanTemplateVersion" },
      { model: db.templateVersion, as: "ExecutionTemplateVersion" },
    ],
  });
  if (!plan) return { error: "未找到该课程设计。" };
  const artifacts = plan.planFormData ? [] : await db.artifact.findAll({ where: { planId, lessonIndex: null } });
  const content = await buildPlanContentText(plan, null, artifacts);
  return { title: plan.title, content };
}

module.exports = { buildPlanContentText, getPlanDetailsToolDef, getPlanDetails };
