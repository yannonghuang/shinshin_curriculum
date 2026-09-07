const db = require("../models");
const KnowledgeChunk = db.knowledgeChunk;
const KnowledgeSkill = db.knowledgeSkill;
const MaterialTopic = db.materialTopic;
const MaterialLink = db.materialLink;
const MaterialArtifact = db.materialArtifact;
const llmClient = require("./llmClient");

const CHUNK_TARGET_SIZE = 600;
const CHUNK_OVERLAP = 100;

// Splits text into ~CHUNK_TARGET_SIZE-char chunks, preferring paragraph
// boundaries (falls back to a hard slice, with a little overlap so context
// isn't lost right at the cut, for any single paragraph longer than the
// target). Character-based, not word-based -- Chinese has no whitespace word
// boundaries to count on.
function splitIntoChunks(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return [];

  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks = [];
  let current = "";

  const flushCurrent = () => {
    if (current) chunks.push(current);
    current = "";
  };

  for (const para of paragraphs) {
    if (current.length + para.length + 1 <= CHUNK_TARGET_SIZE) {
      current = current ? `${current}\n${para}` : para;
      continue;
    }
    flushCurrent();
    if (para.length <= CHUNK_TARGET_SIZE) {
      current = para;
      continue;
    }
    // A single paragraph longer than the target -- hard-slice it with overlap.
    let start = 0;
    while (start < para.length) {
      const end = Math.min(start + CHUNK_TARGET_SIZE, para.length);
      chunks.push(para.slice(start, end));
      if (end >= para.length) break;
      start = end - CHUNK_OVERLAP;
    }
  }
  flushCurrent();
  return chunks;
}

// Replaces every knowledge_chunks row for one polymorphic source with fresh
// ones -- delete-then-insert is the simplest correct model for re-ingestion
// on file replace/update, not a diff-and-patch. Deliberately does NOT touch
// existing rows when the new extraction yields nothing: text extraction can
// fail transiently (a timed-out mutool call, a corrupt temp file) in ways
// indistinguishable here from "this document genuinely has no text", and an
// artifact update/re-upload re-runs this against the *same* sourceId (see
// material-artifact.controller.js#update) -- destroying first unconditionally
// meant a single flaky re-extraction permanently wiped out a previously
// good, already-ingested source, silently, with the knowledge_skills card
// generated from it left dangling as the only surviving trace. Worst case
// now is stale content lingering after a genuine intentional change to
// something non-extractable -- far cheaper than losing real content outright.
async function ingestSource({ sourceType, sourceId, materialTopicId, text }) {
  const pieces = splitIntoChunks(text);
  if (pieces.length === 0) {
    console.warn(`知识库摄取：来源 ${sourceType}#${sourceId}（主题 ${materialTopicId}）提取到的文本为空，保留原有知识条目不变。`);
    return { written: false, chunkCount: 0 };
  }
  await KnowledgeChunk.destroy({ where: { sourceType, sourceId } });
  await KnowledgeChunk.bulkCreate(
    pieces.map((content, chunkIndex) => ({ sourceType, sourceId, materialTopicId, chunkIndex, content }))
  );
  return { written: true, chunkCount: pieces.length };
}

async function deleteSourceChunks({ sourceType, sourceId }) {
  await KnowledgeChunk.destroy({ where: { sourceType, sourceId } });
}

// Latest "something about this topic's material changed" instant: the topic
// row itself (基本信息 edits) plus every link/artifact under it. Compared
// against the skill card's own updatedAt to decide whether a regeneration
// would actually pick up anything new.
async function getLatestMaterialActivity(topic) {
  const [latestLink, latestArtifact] = await Promise.all([
    MaterialLink.max("updatedAt", { where: { materialTopicId: topic.id } }),
    MaterialArtifact.max("updatedAt", { where: { materialTopicId: topic.id } }),
  ]);
  return [topic.updatedAt, latestLink, latestArtifact]
    .filter(Boolean)
    .map((d) => new Date(d).getTime())
    .reduce((max, t) => Math.max(max, t), 0);
}

// One LLM call per topic, folding in its 基本信息 plus every current chunk
// of every source under it (all already deterministically extracted -- this
// call curates/summarizes, it does no extraction of its own). Regenerates
// (replace via upsert on the topic's unique constraint, not append) only when
// some material under the topic is newer than the card's own last-generated
// timestamp, so the call stays cheap to invoke liberally (every mutation,
// a future batch/cron sweep, ...) without re-summarizing unchanged topics.
// Best-effort: swallows its own errors so a failed/unconfigured LLM call
// never blocks the material save that triggered it -- a missing/stale skill
// card just means retrieval falls back to the raw chunks tier for that
// topic, not a hard failure of the upload itself.
async function regenerateSkillCardInner(materialTopicId, { force = false } = {}) {
  try {
    const topic = await MaterialTopic.findByPk(materialTopicId);
    if (!topic) return { ok: false, reason: "not_found" };

    // An admin who has edited or explicitly reviewed a card has taken
    // ownership of it -- silently regenerating over that on the next
    // unrelated upload would discard curation work for no reason. Auto
    // regeneration only ever applies to a still-AI-authored, not-yet-reviewed
    // card (including the very first one). A `force` call (the admin's own
    // "强制生成" button) is exactly the escape hatch for this -- it's an
    // explicit request to overwrite, reviewed or not.
    const existing = await KnowledgeSkill.findOne({ where: { materialTopicId } });
    if (!force && existing && (existing.sourceType === "admin" || existing.reviewed)) {
      return { ok: false, reason: "reviewed_locked" };
    }

    // Incremental: skip the LLM call entirely if nothing under the topic has
    // changed since the card currently on file was generated. `force` skips
    // this too -- the whole point of the button is "regenerate right now
    // regardless."
    if (!force && existing) {
      const latestActivity = await getLatestMaterialActivity(topic);
      if (latestActivity <= new Date(existing.updatedAt).getTime()) return { ok: false, reason: "up_to_date" };
    }

    const chunks = await KnowledgeChunk.findAll({ where: { materialTopicId }, order: [["id", "ASC"]] });

    // A topic with nothing but its own 基本信息 chunk (see
    // material-topic.controller.js's topicMetaText) has no real material yet
    // -- retrieval already covers "谁讲过伞饭文化"-style questions via that
    // meta chunk directly (knowledgeRetrieve.js), so an LLM call here would
    // just be paraphrasing the same title/year/lecturer fields back as a
    // "card." Skip it (slow + adds nothing); the first real link/file upload
    // is what actually earns a generated card. This guard applies even when
    // forced -- there's nothing to summarize either way.
    const hasRealMaterial = chunks.some((c) => c.sourceType !== "material_topic_meta");
    if (!hasRealMaterial) return { ok: false, reason: "no_material" };

    const combinedText = chunks
      .map((c) => c.content)
      .join("\n\n")
      .slice(0, 8000);

    const systemPrompt =
      "你是乡土课程知识库的整理助手。请阅读以下乡土课程材料的基本信息与内容摘录，生成一张简明知识卡片，" +
      '严格以 JSON 格式回复，不要包含其他文字或代码块标记：{"title": "...", "summary": "...", "keyPoints": ["...", "..."], "tags": ["...", "..."]}。' +
      "summary 控制在150字以内，keyPoints 3-5条，tags 3-6个关键词。";
    const userContent =
      `年份：${topic.year}\n主题：${topic.theme}\n主讲人：${topic.lecturer || "未填写"}\n备注：${topic.comment || "无"}\n\n` +
      (combinedText ? `材料内容摘录：\n${combinedText}` : "（暂无已提取的材料内容）");

    const result = await llmClient.llmChat({
      systemPrompt,
      messages: [{ role: "user", content: userContent }],
      maxTokens: 800,
      temperature: 0.2,
    });

    let parsed;
    try {
      const cleaned = (result.text || "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error("知识卡片生成：解析 JSON 失败，跳过本次生成。", e.message);
      return { ok: false, reason: "parse_error" };
    }

    const [skill] = await KnowledgeSkill.upsert({
      materialTopicId,
      title: parsed.title || topic.theme,
      summary: parsed.summary || "",
      keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [],
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      sourceType: "ai",
      reviewed: false,
    });
    return { ok: true, skill };
  } catch (e) {
    console.error("知识卡片生成失败（不影响材料本身的保存）:", e.message);
    return { ok: false, reason: "error", message: e.message };
  }
}

// Per-topic queue, keyed by materialTopicId, holding the tail promise of
// whatever regeneration is currently running/pending for that topic.
// Without this, artifact ingestion running off the request path (see
// material-artifact.controller.js) means two uploads landing close together
// for the same topic can both read "no newer card yet" before either writes
// back -- each firing its own LLM call and racing to upsert, wasting an API
// call and leaving whichever happens to finish last as a coin-flip winner.
// Chaining onto the topic's own tail promise instead means the second call
// simply waits for the first to finish; its own incremental check inside
// regenerateSkillCardInner then usually finds nothing left to do and returns
// immediately, so correctness costs nothing extra in the common case.
const skillCardQueues = new Map();

// Count of regenerateSkillCard calls currently queued or running per topic --
// lets the frontend's 知识卡片 tab poll "is this topic's card being generated
// right now" (isGenerating below) regardless of which of the many call sites
// triggered it (基本信息 save, link add/edit, an upload's fire-and-forget
// regeneration, or the admin's 强制生成 button) -- unlike skillCardQueues'
// tail promise, a plain count survives multiple overlapping calls for the
// same topic without one's completion misreporting the others as done.
const generatingCounts = new Map();

function regenerateSkillCard(materialTopicId, options) {
  generatingCounts.set(materialTopicId, (generatingCounts.get(materialTopicId) || 0) + 1);
  const tail = (skillCardQueues.get(materialTopicId) || Promise.resolve()).catch(() => {});
  const run = tail.then(() => regenerateSkillCardInner(materialTopicId, options));
  skillCardQueues.set(materialTopicId, run.catch(() => {}));
  run.finally(() => {
    const remaining = (generatingCounts.get(materialTopicId) || 1) - 1;
    if (remaining <= 0) generatingCounts.delete(materialTopicId);
    else generatingCounts.set(materialTopicId, remaining);
  });
  return run;
}

function isGenerating(materialTopicId) {
  return generatingCounts.has(materialTopicId);
}

module.exports = { ingestSource, deleteSourceChunks, regenerateSkillCard, isGenerating, splitIntoChunks };
