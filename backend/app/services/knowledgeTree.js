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
// Retrieval (buildContext) is top-down: one routing call shows the model the
// topic + source summaries and contents inventories and asks which are
// relevant to the subject; assembly then fills a character budget in
// priority order -- anchor items (e.g. every rubric in the library)
// verbatim, then routed items and high-relevance sources verbatim, then
// medium-relevance sources as summaries, then untouched topics as one-line
// background. Anything that doesn't fit verbatim degrades to its summary
// rather than being cut off, and what was used how is returned as
// provenance for the caller to record.
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
// summary only means retrieval falls back to the source's title.
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

const ROUTE_SYSTEM_PROMPT =
  "你是学习资源库的检索助手。给定一个任务和资源库目录（主题 → 资料来源 → 资料中的具体内容条目），" +
  "请选出完成该任务需要参考的资料：\n" +
  "- sources：相关的资料来源，relevance 取 high（需要细读原文）或 medium（了解概要即可）；与任务无关的不要选；\n" +
  "- items：需要原文引用的具体内容条目编号（如 S3.2）。\n" +
  '严格以 JSON 格式回复，不要包含其他文字或代码块标记：{"sources": [{"id": "S3", "relevance": "high"}], "items": ["S3.2"]}';

const TOPIC_ROUTE_SYSTEM_PROMPT =
  "你是学习资源库的检索助手。给定一个任务和资源库的主题列表，请选出与任务相关、需要进一步查看的主题。" +
  '严格以 JSON 格式回复，不要包含其他文字或代码块标记：{"topics": ["T3"]}';

async function loadCatalog(excludeCategories) {
  const topics = await MaterialTopic.findAll({
    where: excludeCategories.length ? { category: { [Op.notIn]: excludeCategories } } : {},
    include: [{ model: KnowledgeSkill, as: "Skill", required: false }],
    order: [["category", "ASC"], ["id", "ASC"]],
  });
  const topicIds = topics.map((t) => t.id);
  if (topicIds.length === 0) return { topics: [], sources: [] };

  // Every real source that has chunks, whether or not it has a summary yet
  // (e.g. not backfilled) -- an unsummarized source can still be read
  // verbatim, it just routes on its title alone.
  const chunkStats = await KnowledgeChunk.findAll({
    attributes: [
      "sourceType",
      "sourceId",
      "materialTopicId",
      [db.Sequelize.fn("COUNT", db.Sequelize.col("id")), "chunkCount"],
      [db.Sequelize.fn("SUM", db.Sequelize.fn("CHAR_LENGTH", db.Sequelize.col("content"))), "charCount"],
    ],
    where: { materialTopicId: { [Op.in]: topicIds }, sourceType: { [Op.ne]: "material_topic_meta" } },
    group: ["sourceType", "sourceId", "materialTopicId"],
    raw: true,
  });
  const summaries = await KnowledgeSourceSummary.findAll({ where: { materialTopicId: { [Op.in]: topicIds } } });
  const summaryByKey = new Map(summaries.map((s) => [`${s.sourceType}:${s.sourceId}`, s]));

  const topicById = new Map(topics.map((t) => [Number(t.id), t]));
  const sources = [];
  for (const row of chunkStats) {
    const key = `${row.sourceType}:${row.sourceId}`;
    const s = summaryByKey.get(key);
    sources.push({
      key,
      sourceType: row.sourceType,
      sourceId: Number(row.sourceId),
      topic: topicById.get(Number(row.materialTopicId)),
      title: s ? s.title : await sourceTitle(row.sourceType, row.sourceId),
      summary: s ? s.summary : "",
      contents: s && Array.isArray(s.contents) ? s.contents : [],
      chunkCount: Number(row.chunkCount),
      charCount: Number(row.charCount),
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
  sources.forEach((s, i) => (s.ref = `S${i + 1}`));
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
  out = out.replace(/(^|[-_\s（(·、])[\u4e00-\u9fa5]{1,3}(?:专家|老师|教授|博士|校长)(?=$|[-_\s）)·、.\d])/g, "$1");
  return out
    .replace(/[-_·、\s]+(?=\.[a-zA-Z0-9]+$)/, "") // dangling separator before the extension
    .replace(/([-_·、])\1+/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/（\s*）|\(\s*\)/g, "")
    .trim();
}

function topicHeader(t, { includeTopicMeta = false } = {}) {
  const lines = [`## [T${t.id}] ${topicLabel(t)}`];
  if (includeTopicMeta) {
    if (t.lecturer) lines.push(`主讲人：${t.lecturer}`);
    if (t.comment) lines.push(`备注：${t.comment}`);
  }
  if (t.Skill && t.Skill.summary) lines.push(`主题概要：${t.Skill.summary}`);
  return lines.join("\n");
}

function sourceCatalogLines(s) {
  const lines = [`- [${s.ref}] 《${s.title}》（${s.charCount} 字）${s.summary ? `：${s.summary}` : ""}`];
  s.contents.forEach((it, i) => lines.push(`    · [${s.ref}.${i + 1}]（${KIND_LABELS[it.kind] || it.kind}）${it.label}`));
  return lines.join("\n");
}

function buildCatalogText(topics, sources, headerOpts) {
  return topics
    .map((t) => {
      const own = sources.filter((s) => Number(s.topic.id) === Number(t.id));
      return own.length ? `${topicHeader(t, headerOpts)}\n${own.map(sourceCatalogLines).join("\n")}` : null;
    })
    .filter(Boolean)
    .join("\n\n");
}

async function route(subject, topics, sources, headerOpts) {
  let candidates = sources;
  let candidateTopics = topics;
  const fullCatalog = buildCatalogText(topics, sources, headerOpts);

  if (fullCatalog.length > ROUTE_CATALOG_MAX_CHARS) {
    // Too big to show at once: pick topics first from their headers and
    // source titles, then route among the chosen topics' sources.
    const topicCatalog = topics
      .map((t) => {
        const titles = sources.filter((s) => Number(s.topic.id) === Number(t.id)).map((s) => `《${s.title}》`);
        return `${topicHeader(t, headerOpts)}\n资料：${titles.join("、") || "无"}`;
      })
      .join("\n\n");
    const r = await llmClient.llmChat({
      systemPrompt: TOPIC_ROUTE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: `任务：${subject}\n\n主题列表：\n${topicCatalog}` }],
      maxTokens: 512,
      temperature: 0,
      thinking: false, // a pick from a list -- see llmClient.js#llmChat
    });
    const picked = new Set((parseJsonReply(r.text).topics || []).map((id) => String(id).replace(/^T/, "")));
    candidateTopics = topics.filter((t) => picked.has(String(t.id)));
    candidates = sources.filter((s) => picked.has(String(s.topic.id)));
  }

  const catalog = buildCatalogText(candidateTopics, candidates, headerOpts);
  if (!catalog) return { high: new Set(), medium: new Set(), items: new Set(), model: null };
  const result = await llmClient.llmChat({
    systemPrompt: ROUTE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: `任务：${subject}\n\n资源库目录：\n${catalog}` }],
    maxTokens: 1024,
    temperature: 0,
    thinking: false, // a pick from a list -- see llmClient.js#llmChat
  });
  const parsed = parseJsonReply(result.text);
  const high = new Set();
  const medium = new Set();
  for (const s of Array.isArray(parsed.sources) ? parsed.sources : []) {
    const ref = str(s && s.id);
    if (!ref) continue;
    (s.relevance === "high" ? high : medium).add(ref);
  }
  return { high, medium, items: new Set((parsed.items || []).map(str)), model: result.model };
}

// Builds a subject-relevant material context within `budget` characters.
//   subject        -- what the material is for (drives routing)
//   anchorKinds    -- contents-item kinds always included verbatim,
//                     library-wide, regardless of routing (e.g. ["rubric"])
//   excludeCategories -- topic categories left out entirely
//   includeTopicMeta  -- show topics' 主讲人/备注 (chat needs these to answer
//                     "谁讲过…"; standards/reviews must not name people)
//   redact         -- strip person names from source titles (see redactNames)
//   semantic       -- add chunk-level embedding matches (embeddings.js),
//                     up to semanticLimit passages
// Returns { text, provenance, usedChunkIds }.
async function buildContext({
  subject,
  anchorKinds = [],
  excludeCategories = [MANUAL_CATEGORY],
  budget = 60000,
  includeTopicMeta = false,
  redact = false,
  semantic = true,
  semanticLimit = 6,
}) {
  const { topics, sources } = await loadCatalog(excludeCategories);
  if (sources.length === 0) return { text: "", provenance: null, usedChunkIds: [] };
  if (redact) {
    const names = await loadPersonNames();
    sources.forEach((s) => (s.title = redactNames(s.title, names)));
  }
  const headerOpts = { includeTopicMeta };

  let routed;
  try {
    routed = await route(subject, topics, sources, headerOpts);
  } catch (e) {
    // Routing failed -- degrade to "everything at summary level" rather than
    // failing the caller; anchors are still included verbatim below.
    console.error("资料检索路由失败，改为全部使用摘要:", e.message);
    routed = { high: new Set(), medium: new Set(sources.map((s) => s.ref)), items: new Set(), model: null };
  }

  const byRef = new Map(sources.map((s) => [s.ref, s]));
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
  const sections = { anchors: [], items: [], semantic: [], verbatim: [], summaries: [], background: [] };
  const provenance = { subject, anchors: [], verbatim: [], semantic: [], summarized: [], background: [], routedBy: routed.model };
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

  // 2. Chunk-level semantic hits (embeddings.js): the pages closest in
  // meaning to the subject, wherever they are -- including details no
  // summary or inventory label mentions, which routing alone can't see.
  // Contiguous hits from the same source are merged into one passage.
  // Placed before routed items: a hit is one precise ~600-char chunk,
  // while a routed inventory item can span several, so under a tight
  // budget the precise matches must not be crowded out by the broad ones.
  if (semantic) {
    let hits = [];
    try {
      hits = await embeddings.semanticSearch(subject, {
        topicIds: topics.map((t) => Number(t.id)),
        excludeSourceTypes: ["material_topic_meta"],
        limit: semanticLimit,
      });
    } catch (e) {
      console.error("语义检索失败，跳过:", e.message);
    }
    const bySourceKey = new Map(sources.map((x) => [x.key, x]));
    const groups = new Map();
    for (const h of hits) {
      const src = bySourceKey.get(`${h.sourceType}:${h.sourceId}`);
      if (!src) continue;
      if (!groups.has(src.key)) groups.set(src.key, { src, hits: [] });
      groups.get(src.key).hits.push(h);
    }
    for (const { src, hits: hs } of groups.values()) {
      hs.sort((a, b) => a.chunkIndex - b.chunkIndex);
      const runs = [];
      for (const h of hs) {
        const last = runs[runs.length - 1];
        if (last && h.chunkIndex === last.to + 1) {
          last.to = h.chunkIndex;
          last.score = Math.max(last.score, h.score);
        } else runs.push({ from: h.chunkIndex, to: h.chunkIndex, score: h.score });
      }
      for (const run of runs) {
        const got = await takeChunks(src, run.from, run.to);
        if (!got || !got.text) continue;
        sections.semantic.push(`${place(src, got.chunks)}：\n${got.text}`);
        provenance.semantic.push({
          title: src.title,
          topic: topicLabel(src.topic),
          locator: locatorOf(got.chunks),
          score: Math.round(run.score * 1000) / 1000,
        });
        touchedTopics.add(Number(src.topic.id));
      }
    }
  }

  // 3. Routed items verbatim.
  for (const ref of routed.items) {
    const m = ref.match(/^(S\d+)\.(\d+)$/);
    const s = m && byRef.get(m[1]);
    const it = s && s.contents[Number(m[2]) - 1];
    if (!it) continue;
    const got = await takeChunks(s, it.chunkFrom, it.chunkTo);
    if (!got || !got.text) continue;
    sections.items.push(`${place(s, got.chunks)} ${it.label}：\n${got.text}`);
    provenance.verbatim.push({ title: s.title, topic: topicLabel(s.topic), label: it.label, locator: locatorOf(got.chunks) });
    touchedTopics.add(Number(s.topic.id));
  }

  // 4. High-relevance sources in full, or their summary if they don't fit.
  const summarize = (s) => {
    const line = `《${s.title}》（${topicLabel(s.topic)}）：${s.summary || "（暂无摘要）"}${
      s.contents.length ? `\n  包含：${s.contents.map((it) => it.label).join("；")}` : ""
    }`;
    sections.summaries.push(line);
    remaining -= line.length;
    provenance.summarized.push({ title: s.title, topic: topicLabel(s.topic) });
    touchedTopics.add(Number(s.topic.id));
  };
  for (const s of sources.filter((x) => routed.high.has(x.ref))) {
    const got = await takeChunks(s, 0, Number.MAX_SAFE_INTEGER);
    if (got && got.text) {
      sections.verbatim.push(`${place(s, got.chunks)}：\n${got.text}`);
      provenance.verbatim.push({ title: s.title, topic: topicLabel(s.topic), label: null, locator: locatorOf(got.chunks) });
      touchedTopics.add(Number(s.topic.id));
    } else if (got === null) {
      summarize(s);
    }
  }

  // 5. Medium-relevance sources as summaries.
  for (const s of sources.filter((x) => routed.medium.has(x.ref) && !routed.high.has(x.ref))) summarize(s);

  // 6. Untouched topics: one line of background each.
  const backgroundTopicIds = [];
  for (const t of topics) {
    if (touchedTopics.has(Number(t.id)) || !t.Skill || !t.Skill.summary) continue;
    sections.background.push(`${topicLabel(t)}：${t.Skill.summary}`);
    provenance.background.push(topicLabel(t));
    backgroundTopicIds.push(Number(t.id));
  }

  const blocks = [];
  if (sections.anchors.length) blocks.push(`【资料中已有的评价/评分标准（原文）】\n\n${sections.anchors.join("\n\n")}`);
  if (sections.semantic.length) blocks.push(`【语义相关片段原文】\n\n${sections.semantic.join("\n\n")}`);
  if (sections.items.length) blocks.push(`【相关内容原文】\n\n${sections.items.join("\n\n")}`);
  if (sections.verbatim.length) blocks.push(`【相关资料原文】\n\n${sections.verbatim.join("\n\n")}`);
  if (sections.summaries.length) blocks.push(`【其他相关资料摘要】\n\n${sections.summaries.join("\n\n")}`);
  if (sections.background.length) blocks.push(`【其他主题概要】\n${sections.background.join("\n")}`);

  provenance.topicIds = [...touchedTopics, ...backgroundTopicIds];
  return { text: blocks.join("\n\n"), provenance, usedChunkIds: [...usedChunkIds] };
}

module.exports = { summarizeSource, deleteSourceSummary, buildContext, redactNames, loadPersonNames, locatorOf, KIND_LABELS };
