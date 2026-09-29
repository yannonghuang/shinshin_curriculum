// Chunk-level semantic matching for the knowledge tree. The tree's LLM
// routing (knowledgeTree.js) matches by meaning but only at the granularity
// of source summaries and contents inventories -- a detail buried on one
// page that no summary or inventory label mentions is invisible to it, and
// FULLTEXT only finds it when the wording happens to match. Embedding every
// chunk closes that gap: a query is compared against every page's text by
// meaning.
//
// DashScope's OpenAI-compatible /embeddings endpoint (same key/base URL as
// llmClient.js). Vectors live in knowledge_chunks.embedding; similarity is
// computed in-process over a cached, pre-normalized copy of them -- at this
// library's scale (hundreds to low thousands of chunks) a brute-force dot
// product is sub-millisecond, no vector database needed.
//
// Two choices here were measured, not assumed (dev, the 乡土课程价值与设计框架
// deck, paraphrased queries sharing almost no words with the target page):
//   - Each chunk is embedded as overlapping ~200-char windows, scored by its
//     best window. A ~600-char chunk packs several slides, and one relevant
//     sentence gets averaged away among them -- windows put a buried detail
//     (e.g. "老农看天判断播种时间") from 4th to 1st.
//   - Queries carry an `instruct` (retrieval task description), which
//     text-embedding-v4 honors on the compatible endpoint (`text_type` is
//     ignored there). It moved the right chunk to 1st on 3 of 4 queries.
// Calibration with both: real matches 0.58-0.73, unrelated queries <= 0.52
// (hence MIN_SCORE below).
const db = require("../models");
const { fetchWithRetry } = require("./llmClient");
const { Op } = db.Sequelize;
const KnowledgeChunk = db.knowledgeChunk;
const KnowledgeSourceSummary = db.knowledgeSourceSummary;

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-v4";
const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS || 1024);
const BATCH_SIZE = 10; // DashScope's per-request input limit for text-embedding-v3/v4
const WINDOW_SIZE = 200;
const WINDOW_STEP = 150;
// Stored in knowledge_chunks.embedding_model: model + windowing, so changing
// either one marks every chunk for re-embedding.
const EMBEDDING_SCHEME = `${EMBEDDING_MODEL}:w${WINDOW_SIZE}`;
const QUERY_INSTRUCT = "根据问题，检索乡土课程培训资料中能回答该问题的段落";
const MIN_SCORE = 0.56;
const RELATIVE_MARGIN = 0.06;

function windowsOf(text) {
  const t = text || "";
  if (t.length <= WINDOW_SIZE) return [t];
  const out = [];
  for (let i = 0; i < t.length; i += WINDOW_STEP) {
    out.push(t.slice(i, i + WINDOW_SIZE));
    if (i + WINDOW_SIZE >= t.length) break;
  }
  return out;
}

async function embedTexts(texts, { instruct } = {}) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("DASHSCOPE_API_KEY is not configured");
  const baseUrl = process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    // Same transient-failure retry as chat calls (see llmClient.js).
    const resp = await fetchWithRetry(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: batch,
        dimensions: EMBEDDING_DIMENSIONS,
        encoding_format: "float",
        ...(instruct ? { instruct } : {}),
      }),
    });
    const data = await resp.json();
    const sorted = [...data.data].sort((a, b) => a.index - b.index);
    out.push(...sorted.map((d) => d.embedding));
  }
  return out;
}

// What gets embedded for each window of a chunk: its source's title as
// context (a slide's bare text often doesn't say what deck it belongs to),
// then the window's text.
const windowTexts = (title, chunk) => windowsOf(chunk.content).map((w) => `${title ? `《${title}》\n` : ""}${w}`);

// Embeds every chunk of one source that has no vector from the current
// model. Best-effort: a failure leaves those chunks unembedded (semantic
// search just won't see them until the next run), never fails ingestion.
async function embedSource({ sourceType, sourceId }) {
  try {
    const chunks = await KnowledgeChunk.findAll({
      where: {
        sourceType,
        sourceId,
        [Op.or]: [{ embeddingModel: null }, { embeddingModel: { [Op.ne]: EMBEDDING_SCHEME } }],
      },
      order: [["chunkIndex", "ASC"]],
    });
    if (chunks.length === 0) return 0;
    const summary = await KnowledgeSourceSummary.findOne({ where: { sourceType, sourceId }, attributes: ["title"] });
    const perChunk = chunks.map((c) => windowTexts(summary && summary.title, c));
    const vectors = await embedTexts(perChunk.flat());
    let k = 0;
    for (let i = 0; i < chunks.length; i += 1) {
      const mine = vectors.slice(k, k + perChunk[i].length);
      k += perChunk[i].length;
      // An array of window vectors (see the header comment).
      await chunks[i].update({ embedding: mine, embeddingModel: EMBEDDING_SCHEME });
    }
    return chunks.length;
  } catch (e) {
    console.error(`向量化失败（${sourceType}#${sourceId}，不影响资料本身）:`, e.message);
    return 0;
  }
}

// Backfill helper: every source (optionally within one topic) that has any
// chunk not yet embedded with the current model.
async function embedMissing({ topicId = null, log = () => {} } = {}) {
  const where = { [Op.or]: [{ embeddingModel: null }, { embeddingModel: { [Op.ne]: EMBEDDING_SCHEME } }] };
  if (topicId) where.materialTopicId = topicId;
  const sources = await KnowledgeChunk.findAll({ attributes: ["sourceType", "sourceId"], where, group: ["sourceType", "sourceId"], raw: true });
  let total = 0;
  for (const s of sources) {
    const n = await embedSource({ sourceType: s.sourceType, sourceId: Number(s.sourceId) });
    total += n;
    log(`${n ? "✓" : "!"} 向量化 ${s.sourceType}#${s.sourceId}：${n} 段`);
  }
  return total;
}

// ---------------------------------------------------------------- search

// In-memory copy of every current-model vector, normalized so cosine
// similarity is a plain dot product. Reloaded only when the embedded chunk
// set changes (re-ingestion replaces chunks with new ids; re-embedding bumps
// updated_at), checked with one aggregate query per search.
let cache = { version: null, rows: [] };

async function loadVectors() {
  const [stat] = await KnowledgeChunk.findAll({
    attributes: [
      [db.Sequelize.fn("COUNT", db.Sequelize.col("id")), "n"],
      [db.Sequelize.fn("MAX", db.Sequelize.col("id")), "maxId"],
      [db.Sequelize.fn("MAX", db.Sequelize.col("updated_at")), "maxUpdated"],
    ],
    where: { embeddingModel: EMBEDDING_SCHEME },
    raw: true,
  });
  const version = `${stat.n}|${stat.maxId}|${stat.maxUpdated}`;
  if (version === cache.version) return cache.rows;

  const chunks = await KnowledgeChunk.findAll({
    attributes: ["id", "sourceType", "sourceId", "materialTopicId", "chunkIndex", "pageFrom", "pageTo", "embedding"],
    where: { embeddingModel: EMBEDDING_SCHEME },
  });
  const rows = [];
  for (const c of chunks) {
    const windows = Array.isArray(c.embedding) ? c.embedding.filter((v) => Array.isArray(v) && v.length > 0) : [];
    if (windows.length === 0) continue;
    const vecs = windows.map(normalize);
    rows.push({
      id: Number(c.id),
      sourceType: c.sourceType,
      sourceId: Number(c.sourceId),
      materialTopicId: Number(c.materialTopicId),
      chunkIndex: c.chunkIndex,
      pageFrom: c.pageFrom,
      pageTo: c.pageTo,
      vecs,
    });
  }
  cache = { version, rows };
  return rows;
}

function normalize(v) {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 1) out[i] = v[i] / norm;
  return out;
}

// Top chunks by similarity to `query` (a chunk's score is its best
// window's cosine similarity), restricted to the given topics. Kept only if
// above MIN_SCORE and within RELATIVE_MARGIN of the best hit -- the absolute
// floor drops everything for a query the library has nothing on; the
// relative one drops the long tail of "same library, different subject"
// chunks that sit just under a real match.
async function semanticSearch(query, { topicIds = null, excludeSourceTypes = [], limit = 6 } = {}) {
  const rows = await loadVectors();
  if (rows.length === 0 || !str(query)) return [];
  const [raw] = await embedTexts([query], { instruct: QUERY_INSTRUCT });
  const qv = normalize(raw);

  const allowed = topicIds ? new Set(topicIds.map(Number)) : null;
  const scored = [];
  for (const r of rows) {
    if (allowed && !allowed.has(r.materialTopicId)) continue;
    if (excludeSourceTypes.includes(r.sourceType)) continue;
    let best = -1;
    for (const vec of r.vecs) {
      if (vec.length !== qv.length) continue;
      let dot = 0;
      for (let i = 0; i < qv.length; i += 1) dot += vec[i] * qv[i];
      if (dot > best) best = dot;
    }
    if (best >= MIN_SCORE) scored.push({ ...r, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.length ? scored[0].score : 0;
  return scored
    .filter((h) => h.score >= top - RELATIVE_MARGIN)
    .slice(0, limit)
    .map(({ vecs, ...rest }) => rest);
}

function str(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

module.exports = { embedTexts, embedSource, embedMissing, semanticSearch, EMBEDDING_MODEL, EMBEDDING_SCHEME };
