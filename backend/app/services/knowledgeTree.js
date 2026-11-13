// Knowledge tree over 学习资源库, so a prompt about some subject gets the
// *relevant* material verbatim instead of an all-or-nothing, first-N-chars
// slice of the whole library:
//
//   topic      -- knowledge_skills card (knowledgeIngest.js#regenerateSkillCard)
//     source   -- knowledge_source_summaries: summary + "contents" inventory
//       leaf   -- knowledge_chunks: verbatim text, with page ranges
//
// Built incrementally: re-ingesting one source re-summarizes only that
// source (summarizeSource, called from knowledgeIngest.js#ingestSource);
// the topic card above it already regenerates on its own incremental check.
//
// Retrieval (buildContext) makes no LLM call. It fills a character budget in
// priority order: anchor items (e.g. every rubric in the library, found via
// the source nodes' contents inventories) verbatim, then chunks matched by
// embedding similarity (embeddings.js), then untouched topics as one-line
// background from their cards. What was used how is returned as provenance
// for the caller to record. (An earlier version had an LLM route over the
// source summaries first; at this library's size the embeddings alone are
// precise enough, so the extra call per search was dropped.)
const db = require("../models");
const { Op } = db.Sequelize;
const MaterialTopic = db.materialTopic;
const MaterialArtifact = db.materialArtifact;
const MaterialLink = db.materialLink;
const KnowledgeSkill = db.knowledgeSkill;
const KnowledgeChunk = db.knowledgeChunk;
const KnowledgeSourceSummary = db.knowledgeSourceSummary;
const llmClient = require("./llmClient");
const embeddings = require("./embeddings");
const { MANUAL_CATEGORY } = require("../constants/materialCategories");

const CONTENT_KINDS = ["rubric", "case", "method", "concept", "data", "other"];
const KIND_LABELS = { rubric: "评价标准", case: "案例", method: "方法", concept: "理念", data: "资料", other: "其他" };

// A source this small is its own summary -- no LLM call.
const TINY_SOURCE_CHARS = 500;
// Text per summarization call; longer sources are summarized window by
// window and the window summaries merged.
const SUMMARY_WINDOW_CHARS = 16000;
// Above this, routing goes topic-first (two calls) instead of showing every
// source summary at once.
const ROUTE_CATALOG_MAX_CHARS = 24000;

const str = (v) => (v === undefined || v === null ? "" : String(v).trim());

function parseJsonReply(raw) {
  const cleaned = (raw || "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  return JSON.parse(cleaned);
}

function locatorOf(chunks) {
  const froms = chunks.map((c) => c.pageFrom).filter((p) => p !== null && p !== undefined);
  const tos = chunks.map((c) => c.pageTo).filter((p) => p !== null && p !== undefined);
  if (froms.length === 0) return null;
  const a = Math.min(...froms);
  const b = Math.max(...tos);
  return a === b ? `第 ${a} 页` : `第 ${a}–${b} 页`;
}

async function sourceTitle(sourceType, sourceId) {
  if (sourceType === "material_artifact") {
    const a = await MaterialArtifact.findByPk(sourceId, { attributes: ["attachmentName", "description"] });
    return a ? a.attachmentName || a.description || `文件 #${sourceId}` : `文件 #${sourceId}`;
  }
  if (sourceType === "material_link") {
    const l = await MaterialLink.findByPk(sourceId, { attributes: ["description", "url"] });
    return l ? l.description || l.url : `链接 #${sourceId}`;
  }
  return "主题基本信息";
}

// ---------------------------------------------------------------- summarize

const SUMMARY_SYSTEM_PROMPT =
  "你是乡土课程学习资源库的索引整理员。下面是一份学习材料的原文，已按片段编号标注（【片段 k】，如有页码则注明）。" +
  "请为它生成用于「检索定位」的索引，而不只是概述：\n" +
  "1. summary：150字以内，概述这份材料讲了什么；\n" +
  "2. contents：材料中值得被单独检索、引用的具体内容清单（按材料长度 3-20 条），每条 {kind, label, chunkFrom, chunkTo}：\n" +
  "   - kind 取值：rubric（任何评价/评分/评估标准、量表、等级描述、权重表）、case（具体案例/课例）、method（方法、流程、步骤、框架、模板）、" +
  "concept（核心理念、定义、原则）、data（数据、清单、名录、表格）、other；\n" +
  "   - label 要具体到能据此判断是否与某个任务相关，例如「课程设计评估标准表：五维度×三级，含权重」「KUD+S 目标案例《家乡的古树》」，不要写「评价相关内容」这类泛泛描述；\n" +
  "   - chunkFrom/chunkTo 为该内容所在的片段编号范围（含两端）；\n" +
  "   - 材料中出现的每一份评价/评分/评估标准或量表都必须单独列为 rubric 条目，不得遗漏或合并进其他条目。\n" +
  '严格以 JSON 格式回复，不要包含其他文字或代码块标记：{"summary": "...", "contents": [{"kind": "rubric", "label": "...", "chunkFrom": 0, "chunkTo": 1}]}';

const MERGE_SYSTEM_PROMPT =
  "下面是同一份学习材料分段整理出的若干段概述，请合并为一段 150 字以内的整体概述。" +
  '严格以 JSON 格式回复，不要包含其他文字或代码块标记：{"summary": "..."}';

function markChunk(c) {
  const page = c.pageFrom ? (c.pageFrom === c.pageTo ? `｜第 ${c.pageFrom} 页` : `｜第 ${c.pageFrom}-${c.pageTo} 页`) : "";
  return `【片段 ${c.chunkIndex}${page}】\n${c.content}`;
}

function sanitizeContents(items, maxIndex) {
  return (Array.isArray(items) ? items : [])
    .map((it) => {
      const from = Math.max(0, Math.min(Number(it && it.chunkFrom), maxIndex));
      const to = Math.max(from, Math.min(Number(it && it.chunkTo), maxIndex));
      return {
        kind: CONTENT_KINDS.includes(it && it.kind) ? it.kind : "other",
        label: str(it && it.label),
        chunkFrom: Number.isFinite(from) ? from : 0,
        chunkTo: Number.isFinite(to) ? to : 0,
      };
    })
    .filter((it) => it.label);
}

async function summarizeWindow({ title, topicLabel, chunks }) {
  const result = await llmClient.llmChat({
    systemPrompt: SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: "user", content: `材料：《${title}》（所属主题：${topicLabel}）\n\n${chunks.map(markChunk).join("\n\n")}` }],
    maxTokens: 2048,
    temperature: 0,
  });
  const parsed = parseJsonReply(result.text);
  return { summary: str(parsed.summary), contents: parsed.contents, model: result.model };
}

// (Re)builds one source's summary node from its current chunks. Best-effort
// like the rest of ingestion: logs and returns on failure, since a missing
// summary only means the source has no anchors (its chunks are still
// searchable) and 资料索引 shows it without a summary.
async function summarizeSource({ sourceType, sourceId, materialTopicId }) {
  try {
    const chunks = await KnowledgeChunk.findAll({ where: { sourceType, sourceId }, order: [["chunkIndex", "ASC"]] });
    if (chunks.length === 0) return null;
    const topic = await MaterialTopic.findByPk(materialTopicId);
    const topicLabel = topic ? `${topic.category} / ${topic.theme}` : "";
    const title = await sourceTitle(sourceType, sourceId);
    const charCount = chunks.reduce((n, c) => n + c.content.length, 0);

    let summary;
    let contents = [];
    let aiModel = null;
    if (charCount <= TINY_SOURCE_CHARS || sourceType === "material_topic_meta") {
      summary = chunks.map((c) => c.content).join(" ").slice(0, 300);
    } else {
      const windows = [];
      let current = [];
      let size = 0;
      for (const c of chunks) {
        if (size + c.content.length > SUMMARY_WINDOW_CHARS && current.length > 0) {
          windows.push(current);
          current = [];
          size = 0;
        }
        current.push(c);
        size += c.content.length;
      }
      if (current.length > 0) windows.push(current);

      const parts = [];
      for (const w of windows) parts.push(await summarizeWindow({ title, topicLabel, chunks: w }));
      aiModel = parts[0].model;
      contents = sanitizeContents(
        parts.flatMap((p) => (Array.isArray(p.contents) ? p.contents : [])),
        chunks[chunks.length - 1].chunkIndex
      );
      if (parts.length === 1) {
        summary = parts[0].summary;
      } else {
        const merged = await llmClient.llmChat({
          systemPrompt: MERGE_SYSTEM_PROMPT,
          messages: [{ role: "user", content: parts.map((p, i) => `第 ${i + 1} 段：${p.summary}`).join("\n") }],
          maxTokens: 512,
          temperature: 0,
        });
        summary = str(parseJsonReply(merged.text).summary);
      }
    }

    const existing = await KnowledgeSourceSummary.findOne({ where: { sourceType, sourceId } });
    const values = { materialTopicId, title, summary, contents, chunkCount: chunks.length, charCount, aiModel };
    if (existing) return existing.update(values);
    return KnowledgeSourceSummary.create({ sourceType, sourceId, ...values });
  } catch (e) {
    console.error(`资料摘要生成失败（${sourceType}#${sourceId}，不影响资料本身）:`, e.message);
    return null;
  }
}

async function deleteSourceSummary({ sourceType, sourceId }) {
  await KnowledgeSourceSummary.destroy({ where: { sourceType, sourceId } });
}

// ---------------------------------------------------------------- retrieve

async function loadCatalog(excludeCategories) {
  const topics = await MaterialTopic.findAll({
    where: excludeCategories.length ? { category: { [Op.notIn]: excludeCategories } } : {},
    include: [{ model: KnowledgeSkill, as: "Skill", required: false }],
    order: [["category", "ASC"], ["id", "ASC"]],
  });
  const topicIds = topics.map((t) => t.id);
  if (topicIds.length === 0) return { topics: [], sources: [] };

  // Every real source that has chunks, whether or not it has a summary yet
  // (e.g. not backfilled) -- an unsummarized source is still searchable, it
  // just has no contents inventory (so no anchors) and is titled from its
  // file/link.
  const rows = await KnowledgeChunk.findAll({
    attributes: ["sourceType", "sourceId", "materialTopicId"],
    where: { materialTopicId: { [Op.in]: topicIds }, sourceType: { [Op.ne]: "material_topic_meta" } },
    group: ["sourceType", "sourceId", "materialTopicId"],
    raw: true,
  });
  const summaries = await KnowledgeSourceSummary.findAll({ where: { materialTopicId: { [Op.in]: topicIds } } });
  const summaryByKey = new Map(summaries.map((s) => [`${s.sourceType}:${s.sourceId}`, s]));

  const topicById = new Map(topics.map((t) => [Number(t.id), t]));
  const sources = [];
  for (const row of rows) {
    const key = `${row.sourceType}:${row.sourceId}`;
    const s = summaryByKey.get(key);
    sources.push({
      key,
      sourceType: row.sourceType,
      sourceId: Number(row.sourceId),
      topic: topicById.get(Number(row.materialTopicId)),
      title: s ? s.title : await sourceTitle(row.sourceType, row.sourceId),
      contents: s && Array.isArray(s.contents) ? s.contents : [],
    });
  }
  // Deterministic order (topic, then source) so the same library always
  // yields the same prompt.
  const topicOrder = new Map(topics.map((t, i) => [Number(t.id), i]));
  sources.sort(
    (a, b) =>
      topicOrder.get(Number(a.topic.id)) - topicOrder.get(Number(b.topic.id)) ||
      a.sourceType.localeCompare(b.sourceType) ||
      a.sourceId - b.sourceId
  );
  return { topics, sources };
}

const topicLabel = (t) => `${t.category} / ${t.theme}`;

// ---------------------------------------------------------------- names
//
// File names often carry a person's name (e.g. "…框架-王海英.pdf",
// "…王专家.pdf"). Contexts that must not attribute anything to a named
// person -- AI 点评标准 and AI 点评 -- get redacted titles, both in the
// prompt and in the provenance shown on the page. Names come from every
// topic's 主讲人 field, plus an "X专家/老师/教授/博士" pattern for names that
// aren't registered as a lecturer anywhere.
async function loadPersonNames() {
  const rows = await MaterialTopic.findAll({ attributes: ["lecturer"], raw: true });
  const names = new Set();
  for (const r of rows) {
    for (const n of str(r.lecturer).split(/[、,，;；\/\s]+/)) {
      if (n.length >= 2 && n.length <= 4) names.add(n);
    }
  }
  return [...names].sort((a, b) => b.length - a.length);
}

function redactNames(text, names) {
  let out = str(text);
  const honorific = "(?:专家|老师|教授|博士|校长)?";
  for (const n of names) out = out.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + honorific, "g"), "");
  out = out.replace(/(^|[-_\s（(·、])[一-龥]{1,3}(?:专家|老师|教授|博士|校长)(?=$|[-_\s）)·、.\d])/g, "$1");
  return out
    .replace(/[-_·、\s]+(?=\.[a-zA-Z0-9]+$)/, "") // dangling separator before the extension
    .replace(/([-_·、])\1+/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/（\s*）|\(\s*\)/g, "")
    .trim();
}

// Chunks sorted by chunkIndex, split into runs of consecutive indexes.
function contiguousRuns(chunks) {
  const runs = [];
  for (const c of [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex)) {
    const last = runs[runs.length - 1];
    if (last && c.chunkIndex === last[last.length - 1].chunkIndex + 1) last.push(c);
    else runs.push([c]);
  }
  return runs;
}

// Builds a subject-relevant material context within `budget` characters.
// No LLM call: relevance is embedding similarity (embeddings.js) over every
// chunk -- at this library's size (a couple hundred chunks) that is precise
// enough on its own, and an LLM picking sources from summaries first only
// added a round trip per search.
//   subject        -- what the material is for (drives the semantic match)
//   anchorKinds    -- contents-item kinds always included verbatim,
//                     library-wide (e.g. ["rubric"]); the source summaries'
//                     contents inventories are what tag them
//   excludeCategories -- topic categories left out entirely
//   redact         -- strip person names from source titles (see redactNames)
//   semanticLimit  -- max chunks matched by meaning (thresholded -- only
//                     real matches; see embeddings.js#semanticSearch)
//   fill           -- instead of the thresholded top matches, take every
//                     chunk, most similar first, until the budget is spent
//                     (AI 点评标准, which wants as much of the library as
//                     fits, not just the closest few pages)
// Order of priority: anchors, then matched chunks, then one line of
// background per topic nothing else came from. Everything counts against
// the budget.
// Returns { text, provenance, usedChunkIds }.
async function buildContext({
  subject,
  anchorKinds = [],
  excludeCategories = [MANUAL_CATEGORY],
  budget = 60000,
  redact = false,
  semanticLimit = 6,
  fill = false,
}) {
  const { topics, sources } = await loadCatalog(excludeCategories);
  if (sources.length === 0) return { text: "", provenance: null, usedChunkIds: [] };
  if (redact) {
    const names = await loadPersonNames();
    sources.forEach((s) => (s.title = redactNames(s.title, names)));
  }

  const chunkCache = new Map();
  const chunksOf = async (s) => {
    if (!chunkCache.has(s.key)) {
      chunkCache.set(
        s.key,
        await KnowledgeChunk.findAll({ where: { sourceType: s.sourceType, sourceId: s.sourceId }, order: [["chunkIndex", "ASC"]] })
      );
    }
    return chunkCache.get(s.key);
  };

  let remaining = budget;
  const usedChunkIds = new Set();
  const sections = { anchors: [], semantic: [], filled: [], background: [] };
  const provenance = { subject, anchors: [], verbatim: [], semantic: [], background: [] };
  const touchedTopics = new Set();

  // Verbatim text for a chunk range of one source, skipping chunks already
  // quoted; null if it doesn't fit the remaining budget.
  const takeChunks = async (s, from, to) => {
    const picked = (await chunksOf(s)).filter(
      (c) => c.chunkIndex >= from && c.chunkIndex <= to && !usedChunkIds.has(String(c.id))
    );
    if (picked.length === 0) return { text: "", chunks: [] };
    const text = picked.map((c) => c.content).join("\n");
    if (text.length > remaining) return null;
    remaining -= text.length;
    picked.forEach((c) => usedChunkIds.add(String(c.id)));
    return { text, chunks: picked };
  };
  const place = (s, chunks) => {
    const loc = locatorOf(chunks);
    return `《${s.title}》（${topicLabel(s.topic)}${loc ? `，${loc}` : ""}）`;
  };

  // 1. Anchors: every inventory item of an anchor kind, library-wide.
  for (const s of sources) {
    for (const it of s.contents) {
      if (!anchorKinds.includes(it.kind)) continue;
      const got = await takeChunks(s, it.chunkFrom, it.chunkTo);
      if (!got || !got.text) continue;
      sections.anchors.push(`${place(s, got.chunks)} ${it.label}：\n${got.text}`);
      provenance.anchors.push({ title: s.title, topic: topicLabel(s.topic), label: it.label, locator: locatorOf(got.chunks) });
      touchedTopics.add(Number(s.topic.id));
    }
  }

  const bySourceKey = new Map(sources.map((x) => [x.key, x]));
  const topicIds = topics.map((t) => Number(t.id));
  let hits = [];
  try {
    hits = await embeddings.semanticSearch(subject, {
      topicIds,
      excludeSourceTypes: ["material_topic_meta"],
      ...(fill ? { rankAll: true } : { limit: semanticLimit }),
    });
  } catch (e) {
    console.error("语义检索失败，跳过:", e.message);
  }

  if (!fill) {
    // 2. Chunk-level semantic hits: the pages closest in meaning to the
    // subject. Contiguous hits from the same source are merged into one
    // passage.
    const groups = new Map();
    for (const h of hits) {
      const src = bySourceKey.get(`${h.sourceType}:${h.sourceId}`);
      if (!src) continue;
      if (!groups.has(src.key)) groups.set(src.key, { src, hits: [] });
      groups.get(src.key).hits.push(h);
    }
    for (const { src, hits: hs } of groups.values()) {
      for (const run of contiguousRuns(hs)) {
        const got = await takeChunks(src, run[0].chunkIndex, run[run.length - 1].chunkIndex);
        if (!got || !got.text) continue;
        sections.semantic.push(`${place(src, got.chunks)}：\n${got.text}`);
        provenance.semantic.push({
          title: src.title,
          topic: topicLabel(src.topic),
          locator: locatorOf(got.chunks),
          score: Math.round(Math.max(...run.map((h) => h.score)) * 1000) / 1000,
        });
        touchedTopics.add(Number(src.topic.id));
      }
    }
  } else {
    // 2'. Fill: every chunk not yet quoted, most similar first (chunks with
    // no vector, or all of them if the query couldn't be embedded, after
    // the scored ones in library order), as long as it fits -- then
    // emitted source by source, most relevant source first, each in
    // reading order.
    const score = new Map(hits.map((h) => [Number(h.id), h.score]));
    const candidates = [];
    for (const s of sources) {
      for (const c of await chunksOf(s)) {
        if (!usedChunkIds.has(String(c.id))) candidates.push({ s, c, score: score.has(Number(c.id)) ? score.get(Number(c.id)) : -1 });
      }
    }
    candidates.sort((a, b) => b.score - a.score); // stable: ties keep library order
    const taken = new Map(); // source key -> { s, chunks, best }
    for (const { s, c, score: sc } of candidates) {
      if (c.content.length > remaining) continue;
      remaining -= c.content.length;
      usedChunkIds.add(String(c.id));
      if (!taken.has(s.key)) taken.set(s.key, { s, chunks: [], best: sc });
      taken.get(s.key).chunks.push(c);
    }
    for (const { s, chunks } of [...taken.values()].sort((a, b) => b.best - a.best)) {
      for (const run of contiguousRuns(chunks)) {
        sections.filled.push(`${place(s, run)}：\n${run.map((c) => c.content).join("\n")}`);
        provenance.verbatim.push({ title: s.title, topic: topicLabel(s.topic), label: null, locator: locatorOf(run) });
      }
      touchedTopics.add(Number(s.topic.id));
    }
  }

  // 3. Untouched topics: one line of background each, while it fits.
  const backgroundTopicIds = [];
  for (const t of topics) {
    if (touchedTopics.has(Number(t.id)) || !t.Skill || !t.Skill.summary) continue;
    const line = `${topicLabel(t)}：${t.Skill.summary}`;
    if (line.length > remaining) continue;
    remaining -= line.length;
    sections.background.push(line);
    provenance.background.push(topicLabel(t));
    backgroundTopicIds.push(Number(t.id));
  }

  const blocks = [];
  if (sections.anchors.length) blocks.push(`【资料中已有的评价/评分标准（原文）】\n\n${sections.anchors.join("\n\n")}`);
  if (sections.semantic.length) blocks.push(`【语义相关片段原文】\n\n${sections.semantic.join("\n\n")}`);
  if (sections.filled.length) blocks.push(`【相关资料原文】\n\n${sections.filled.join("\n\n")}`);
  if (sections.background.length) blocks.push(`【其他主题概要】\n${sections.background.join("\n")}`);

  provenance.topicIds = [...touchedTopics, ...backgroundTopicIds];
  return { text: blocks.join("\n\n"), provenance, usedChunkIds: [...usedChunkIds] };
}

module.exports = { summarizeSource, deleteSourceSummary, buildContext, redactNames, loadPersonNames, locatorOf, KIND_LABELS };
