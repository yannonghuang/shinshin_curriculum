// AI 点评标准: a single scoring rubric synthesized from everything in
// 学习资源库, generated once and then reused verbatim when AI-scoring every
// plan -- so two plans are always judged against the same yardstick, instead
// of each AI review improvising its own criteria from whatever it happens to
// retrieve for that one plan.
//
// Input comes from the knowledge tree (knowledgeTree.js#buildContext): every
// evaluation standard already present anywhere in the library (rubric
// items of the sources' contents inventories) verbatim as anchors, plus the
// material the router judges relevant to building a scoring standard --
// verbatim where it fits the budget, as summaries where it doesn't. What
// was used is stored on the standard (`retrieval`) and shown on its page.
//
// Experts/admins can then override the AI's standard (checkRevision/
// saveRevision below): every override is checked -- structurally, and by the
// AI against the same materials -- and saved as a new version attributed to
// its operator, together with the cautions they saw and chose to accept.
const crypto = require("crypto");
const db = require("../models");
const authConfig = require("../config/auth.config");
const AiReviewStandard = db.aiReviewStandard;
const llmClient = require("./llmClient");
const knowledgeTree = require("./knowledgeTree");

const MATERIAL_BUDGET = 60000;

// What the router is asked to find material for. 使用指南 (the system's own
// usage docs) is excluded by buildContext's default -- it documents how to
// use the app, not what makes a good 乡土课程.
// Plan scope only: the standard judges the 计划 (课程设计方案 incl.
// 分课时设计), not the 实施记录 -- see aiPlanEvaluation.js.
const STANDARD_SUBJECT = "为乡土课程设计方案（含分课时设计）制定统一的点评评分标准（评分维度、权重、评分要点、等级描述）";
const REVISION_CHECK_SUBJECT = "审核对乡土课程点评评分标准的人工修订是否有资料依据";

const SYSTEM_PROMPT =
  "你是乡土课程教学评价专家。下面是从「学习资源库」中检索出的材料：首先是资料中已有的评价/评分标准原文（如有），" +
  "然后是其他相关资料的原文或摘要。请分析、综合这些材料所体现的乡土课程理念、设计要求与优秀实践，制定一套统一的「乡土课程 AI 点评评分标准」，" +
  "用于对所有教师提交的乡土课程设计方案（含分课时设计）进行一致的点评与打分；标准只针对课程设计本身，不涉及课时实施记录。\n" +
  "要求：\n" +
  "1. 资料中已有针对课程设计的评估标准时，必须以它为骨架：沿用其评分维度与权重，把其等级描述细化为下面要求的四级，" +
  "只有在其他资料有明确依据时才增补或调整维度，并在 basis 中说明调整依据；其他类型的评价标准（如学生发展评价）用于充实评分要点；\n" +
  "2. 满分 100 分，划分为 4-7 个评分维度，各维度 weight（分值）之和必须等于 100；\n" +
  "3. 每个维度给出：name（名称）、weight（分值）、description（该维度考察什么，1-2句）、" +
  "criteria（3-5条具体、可观察的评分要点）、levels（4个等级：优秀/良好/合格/待改进，每级给出分数区间 range 与判定描述 descriptor）；\n" +
  "4. 标准必须来源于材料：尽量引用或提炼材料中的理念与要求，不要编造材料中没有依据的内容；" +
  "每个维度的 basis 字段用一句话说明它依据了哪份资料的哪部分内容；全文不得提及任何人名、主讲人或专家；\n" +
  "5. 标准需通用于不同乡土主题、年级与地区，避免只适用于某一个具体主题；\n" +
  "6. scoringNotes 给出 3-5 条跨维度的评分说明（如扣分原则、证据要求、如何处理信息缺失）。\n" +
  "严格以 JSON 格式回复，不要包含其他文字或代码块标记：" +
  '{"title": "...", "overview": "...", "totalScore": 100, "dimensions": [{"name": "...", "weight": 20, "description": "...", ' +
  '"basis": "...", "criteria": ["..."], "levels": [{"label": "优秀", "range": "18-20", "descriptor": "..."}]}], "scoringNotes": ["..."]}';

const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
const strList = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

// One canonical shape for both the AI's JSON and a human override coming in
// from the editor -- so checks, the signature in signCheck, and rendering
// all see exactly the same structure regardless of who produced it.
function normalizeContent(raw) {
  const src = raw || {};
  return {
    title: str(src.title) || "乡土课程 AI 点评评分标准",
    overview: str(src.overview),
    totalScore: 100,
    dimensions: (Array.isArray(src.dimensions) ? src.dimensions : []).map((d) => ({
      name: str(d && d.name),
      weight: Number(d && d.weight) || 0,
      description: str(d && d.description),
      basis: str(d && d.basis),
      criteria: strList(d && d.criteria),
      levels: (Array.isArray(d && d.levels) ? d.levels : []).map((lv) => ({
        label: str(lv && lv.label),
        range: str(lv && lv.range),
        descriptor: str(lv && lv.descriptor),
      })),
    })),
    scoringNotes: strList(src.scoringNotes),
  };
}

function parseJsonReply(raw) {
  const cleaned = (raw || "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  return JSON.parse(cleaned);
}

function parseStandard(raw) {
  const content = normalizeContent(parseJsonReply(raw));
  if (content.dimensions.length === 0) throw new Error("评分标准缺少评分维度");
  return content;
}

// "18-20" / "18～20" / "18至20" / "20" -> { min, max }; null if unparsable.
function parseRange(range) {
  const m = str(range).match(/^(\d+(?:\.\d+)?)\s*(?:[-–—~～至到]\s*(\d+(?:\.\d+)?))?\s*分?$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] !== undefined ? Number(m[2]) : a;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

// Deterministic, no-LLM checks on a standard's internal consistency. Only
// 'error' items block saving (a standard nothing can be scored against);
// everything else is a caution the operator may knowingly override.
function checkStructure(content) {
  const issues = [];
  const add = (level, dimension, message) => issues.push({ level, dimension: dimension || null, message });

  if (content.dimensions.length === 0) {
    add("error", null, "评分标准至少需要一个评分维度。");
    return issues;
  }

  const total = content.dimensions.reduce((sum, d) => sum + d.weight, 0);
  if (Math.abs(total - content.totalScore) > 1e-6) {
    add("warning", null, `各维度分值之和为 ${total}，与满分 ${content.totalScore} 不一致。`);
  }

  const seen = new Set();
  content.dimensions.forEach((d, i) => {
    const label = d.name || `第 ${i + 1} 个维度`;
    if (!d.name) add("error", label, "维度名称不能为空。");
    else if (seen.has(d.name)) add("warning", label, "维度名称重复。");
    seen.add(d.name);

    if (d.weight <= 0) add("warning", label, "分值应大于 0。");
    if (d.criteria.length === 0) add("warning", label, "没有评分要点，评分时缺少可观察的依据。");
    if (d.levels.length === 0) {
      add("warning", label, "没有等级描述。");
      return;
    }

    const ranges = [];
    d.levels.forEach((lv) => {
      const r = parseRange(lv.range);
      if (!r) add("warning", label, `等级「${lv.label || "未命名"}」的分数区间「${lv.range}」无法识别。`);
      else ranges.push(r);
    });
    if (ranges.length !== d.levels.length) return;

    ranges.sort((a, b) => a.min - b.min);
    if (ranges[0].min !== 0) add("warning", label, `最低等级应从 0 分起，目前从 ${ranges[0].min} 分起。`);
    const top = ranges[ranges.length - 1].max;
    if (top !== d.weight) add("warning", label, `最高等级上限为 ${top} 分，与该维度分值 ${d.weight} 不一致。`);
    for (let k = 1; k < ranges.length; k += 1) {
      const prev = ranges[k - 1];
      const cur = ranges[k];
      if (cur.min <= prev.max) add("warning", label, `分数区间 ${prev.min}-${prev.max} 与 ${cur.min}-${cur.max} 重叠。`);
      else if (cur.min > prev.max + 1) add("warning", label, `分数区间 ${prev.min}-${prev.max} 与 ${cur.min}-${cur.max} 之间有断档。`);
    }
  });

  return issues;
}

const CHECK_SYSTEM_PROMPT =
  "你是乡土课程教学评价专家，负责审核专家/管理员对「乡土课程 AI 点评评分标准」所做的人工修订。" +
  "你将看到：学习资源库材料摘要、修订前的标准、修订后的标准。\n" +
  "请逐项找出修订前后发生变化的地方（维度增删、分值调整、评分要点、等级描述、评分说明等），" +
  "并判断每项变化是否有学习资源库材料作为依据。只针对以下情况给出提醒：\n" +
  "1. 变化在材料中找不到依据，或与材料体现的理念、要求相矛盾（「超出资料依据」）；\n" +
  "2. 变化导致标准内部不一致（例如评分要点与等级描述脱节、某维度权重明显失衡、与其他维度重复）；\n" +
  "3. 变化可能导致对不同主题、年级、地区的课程评分不公平或难以一致执行。\n" +
  "有材料依据、合理的修订无需提醒。severity 取 high（与材料明显矛盾或严重影响评分）、medium（缺乏依据）、low（建议性）。" +
  "message 需说明理由，并尽量指出材料中相关的理念或要求。全文不得提及任何人名、主讲人或专家。\n" +
  "严格以 JSON 格式回复，不要包含其他文字或代码块标记：" +
  '{"summary": "一句话总体评价", "items": [{"dimension": "相关维度名称或“整体”", "severity": "medium", "change": "发生了什么变化", "message": "提醒内容"}]}';

// The AI half of a revision check: compares the override against the version
// it was edited from, in light of the same 学习资源库 materials the standard
// was synthesized from, and flags changes that lack a basis in them.
async function checkAgainstMaterials(baseContent, content) {
  const { text } = await knowledgeTree.buildContext({
    subject: REVISION_CHECK_SUBJECT,
    anchorKinds: ["rubric"],
    budget: MATERIAL_BUDGET,
    redact: true,
  });
  const userContent =
    `学习资源库材料：\n\n${text || "（学习资源库暂无材料内容）"}\n\n` +
    `修订前的标准：\n${JSON.stringify(baseContent)}\n\n` +
    `修订后的标准：\n${JSON.stringify(content)}`;

  const result = await llmClient.llmChat({
    systemPrompt: CHECK_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
    maxTokens: 2048,
    temperature: 0.2,
  });

  const parsed = parseJsonReply(result.text);
  const severities = ["high", "medium", "low"];
  return {
    summary: str(parsed.summary),
    model: result.model,
    items: (Array.isArray(parsed.items) ? parsed.items : []).map((it) => ({
      dimension: str(it && it.dimension),
      severity: severities.includes(it && it.severity) ? it.severity : "medium",
      change: str(it && it.change),
      message: str(it && it.message),
    })),
  };
}

// Binds a check result to the exact content + base version it was run on, so
// #saveRevision can trust the cautions the editor sends back (and store them
// as "what the operator was warned about") without paying for a second LLM
// call -- any edit after the check, or a tampered cautions payload, fails
// verification and the check simply re-runs server-side.
function signCheck(content, baseId, cautions) {
  return crypto
    .createHmac("sha256", authConfig.secret)
    .update(JSON.stringify({ content, baseId: Number(baseId), cautions }))
    .digest("hex");
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 422;
  return err;
}

async function findBase(baseId) {
  const base = await AiReviewStandard.findByPk(baseId);
  if (!base) throw badRequest("找不到作为修订基础的标准版本。");
  return base;
}

async function checkRevision({ content: rawContent, baseId }) {
  const base = await findBase(baseId);
  const content = normalizeContent(rawContent);
  const structural = checkStructure(content);
  // Structurally unusable -- nothing meaningful for the AI to judge yet.
  const ai = structural.some((i) => i.level === "error")
    ? null
    : await checkAgainstMaterials(normalizeContent(base.content), content);
  const cautions = { structural, ai };
  return { content, cautions, signature: signCheck(content, base.id, cautions) };
}

async function saveRevision({ content: rawContent, baseId, changeNote, cautions, signature, userId }) {
  const base = await findBase(baseId);
  const content = normalizeContent(rawContent);

  let checked = cautions;
  if (!cautions || !signature || signCheck(content, base.id, cautions) !== signature) {
    ({ cautions: checked } = await checkRevision({ content, baseId: base.id }));
  }
  const blocking = checked.structural.filter((i) => i.level === "error");
  if (blocking.length > 0) throw badRequest(blocking.map((i) => i.message).join(" "));

  const row = await AiReviewStandard.create({
    content,
    source: "human",
    baseId: base.id,
    changeNote: str(changeNote) || null,
    cautions: checked,
    sourceTopicIds: base.sourceTopicIds,
    aiModel: null,
    createdBy: userId,
  });
  return getStandard(row.id);
}

async function generateStandardInner(userId) {
  const { text, provenance } = await knowledgeTree.buildContext({
    subject: STANDARD_SUBJECT,
    anchorKinds: ["rubric"],
    budget: MATERIAL_BUDGET,
    redact: true,
  });
  if (!text) {
    throw new Error("学习资源库中暂无可用于生成评分标准的材料内容。");
  }

  const result = await llmClient.llmChat({
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `学习资源库材料：\n\n${text}` }],
    maxTokens: 4096,
    temperature: 0.2,
  });

  let content;
  try {
    content = parseStandard(result.text);
  } catch (e) {
    throw new Error(`AI 返回的评分标准格式无效：${e.message}`);
  }

  return AiReviewStandard.create({
    content,
    sourceTopicIds: provenance.topicIds,
    retrieval: provenance,
    aiModel: result.model,
    createdBy: userId || null,
  });
}

// One generation at a time, process-wide: the standard is a single global
// artifact, so a second click while one is running just joins the in-flight
// run instead of paying for a duplicate LLM call. lastError is surfaced by
// getStatus so the page can show why a background run failed.
let inFlight = null;
let lastError = null;

function startGeneration(userId) {
  if (inFlight) return inFlight;
  lastError = null;
  inFlight = generateStandardInner(userId)
    .catch((e) => {
      lastError = e.message;
      console.error("AI 点评标准生成失败:", e.message);
      return null;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

// An AI version is presented as purely synthesized from 学习资源库 -- whoever
// clicked 生成/重新生成 is kept for audit only and never sent to the page. A
// human revision, by contrast, is attributed to its operator.
function present(row) {
  if (!row) return null;
  const { createdBy, Creator, ...rest } = row.get({ plain: true });
  if (rest.source === "human") {
    rest.operator = Creator ? { id: Creator.id, name: Creator.chineseName || Creator.username } : null;
  }
  return rest;
}

const creatorInclude = { model: db.user, as: "Creator", attributes: ["id", "username", "chineseName"], required: false };

async function getLatestStandard() {
  return present(await AiReviewStandard.findOne({ include: [creatorInclude], order: [["id", "DESC"]] }));
}

async function getStandard(id) {
  return present(await AiReviewStandard.findByPk(id, { include: [creatorInclude] }));
}

// History list for the version picker -- metadata only, no content.
async function listVersions() {
  const rows = await AiReviewStandard.findAll({
    attributes: ["id", "source", "baseId", "changeNote", "aiModel", "createdBy", "createdAt"],
    include: [creatorInclude],
    order: [["id", "DESC"]],
  });
  return rows.map(present);
}

function getStatus() {
  return { generating: !!inFlight, lastError };
}

module.exports = {
  startGeneration,
  getLatestStandard,
  getStandard,
  listVersions,
  getStatus,
  checkRevision,
  saveRevision,
  checkStructure,
  normalizeContent,
};
