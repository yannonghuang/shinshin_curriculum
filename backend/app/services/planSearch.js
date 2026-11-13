// 全部乡土课程's 语义搜索 (experts and admins): questions like
// 「请找出5个设置社会情感目标较好的项目」 or 「哪些项目让学生采访了老人」,
// answered locally -- no LLM call per search.
//
// Every non-empty plan field (课程设计 section fields and each 课时's fields)
// is embedded once (text-embedding-v4, like the knowledge base -- see
// embeddings.js) into plan_search_vectors, refreshed by a background sync
// when a plan's text changes. A search then embeds at most one or two
// texts and ranks the plans in-process.
//
// What the plans are compared against depends on the question:
//   - 「哪些项目…」 (finding): the question itself, matched against every
//     ~200-char window of a field, so one sentence buried in a long
//     教学活动流程 still counts.
//   - 「…较好/优秀的…」 about a 学习目标 category (definition): the
//     category's definition from the library's framework terms
//     (curriculumGlossary.js), minus similarity to what it must not reward
//     (for 社会情感: culture goals, which belong in 其他目标). Measured on
//     prod's 117 template-v36 plans (2026-11-12): the bare question
//     「社会情感目标较好」 ranked by topic -- 3 of its top 5 were
//     culture-goal fields, the exemplary CASEL-five plan came 5th; the
//     definition minus culture put that plan 1st and a culture-only field
//     from 3rd to 100th. A whole field is compared here (one vector per
//     field), not windows -- that is what was measured.
//   - 「…较好…」 about anything else (library): the question plus the best-
//     matching 学习资源库 passages (embeddings.js#semanticSearch) as the
//     yardstick, whole-field like the definition mode.
// This measures whether a field is *about* the right thing, not how well it
// is written (specific, observable, tied to the 任务链) -- the AI 打分
// result is the place for that judgment.
const crypto = require("crypto");
const db = require("../models");
const { embedTexts, semanticSearch, EMBEDDING_MODEL } = require("./embeddings");
const { GOAL_CATEGORY_NAMES, goalCategoryOf, goalSearchProfile } = require("./curriculumGlossary");

const { Op } = db.Sequelize;
const PlanSearchVector = db.planSearchVector;

const WINDOW_SIZE = 200;
const WINDOW_STEP = 150;
// One field's whole-text vector covers this much of it; text-embedding-v4
// takes far more, but a field this long is no longer "one goal list".
const MAX_WHOLE_CHARS = 2000;
// A very long field (a pasted 教学活动流程) is windowed only this far.
const MAX_WINDOWED_CHARS = 4000;
const MIN_FIELD_CHARS = 4;
// Changing windowing or what gets embedded bumps this, re-embedding all.
const SCHEME = `${EMBEDDING_MODEL}:plan-w${WINDOW_SIZE}-v1`;
const FINDING_INSTRUCT = "根据问题，检索课程设计中与问题描述相符的内容";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;
const LIBRARY_YARDSTICK_CHARS = 1200;

// ---------------------------------------------------------------- parts

const normalizeSpace = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

// "5.教学活动流程：" -> "教学活动流程"
const cleanLabel = (label) =>
  String(label || "")
    .replace(/^\s*\d+\s*[.、．]\s*/, "")
    .replace(/[：:\s]+$/, "")
    .trim();

// A field's real answer, or "" -- an untouched field may still hold its
// template hint (prefilled into the textarea), which isn't the plan's text.
const answerText = (value, hint) => {
  if (value == null || typeof value === "object") return "";
  const text = String(value).trim();
  if (text.length < MIN_FIELD_CHARS) return "";
  if (hint && normalizeSpace(text) === normalizeSpace(hint)) return "";
  return text;
};

// Every field of a template node, depth-first, deduplicated by key (a
// section's flattened `fields` repeat its subsections' fields).
const collectFields = (node, out = [], seen = new Set()) => {
  if (!node) return out;
  for (const f of [...(node.fields || []), ...(node.ownFields || [])]) {
    if (f && f.key && !seen.has(f.key)) {
      seen.add(f.key);
      out.push(f);
    }
  }
  for (const sub of node.subsections || []) collectFields(sub, out, seen);
  return out;
};

const valueIn = (formData, sectionKey, key) => {
  const nested = formData[sectionKey];
  if (nested && typeof nested === "object" && !Array.isArray(nested) && nested[key] != null) return nested[key];
  return formData[key];
};

// The searchable parts of one plan: [{ partKey, label, text }].
const planParts = (plan) => {
  const schema = (plan.PlanTemplateVersion && plan.PlanTemplateVersion.schemaJson) || {};
  const formData = plan.planFormData || {};
  const parts = [];
  const seen = new Set();
  for (const section of schema.sections || []) {
    for (const f of collectFields(section)) {
      if (seen.has(f.key)) continue;
      seen.add(f.key);
      const text = answerText(valueIn(formData, section.key, f.key), f.hint);
      if (text) parts.push({ partKey: `${section.key}.${f.key}`, label: cleanLabel(f.label), text });
    }
  }
  const lessonFields = collectFields(schema.lessonSchema);
  (Array.isArray(formData.lessons) ? formData.lessons : []).forEach((lesson, i) => {
    if (!lesson || typeof lesson !== "object") return;
    const index = Number(lesson.index) || i + 1;
    for (const f of lessonFields) {
      const text = answerText(lesson[f.key], f.hint);
      if (text) parts.push({ partKey: `L${index}.${f.key}`, label: `第${index}课时·${cleanLabel(f.label)}`, text });
    }
  });
  return parts;
};

const windowsOf = (text) => {
  const t = text.slice(0, MAX_WINDOWED_CHARS);
  if (t.length <= WINDOW_SIZE) return [t];
  const out = [];
  for (let i = 0; i < t.length; i += WINDOW_STEP) {
    out.push(t.slice(i, i + WINDOW_SIZE));
    if (i + WINDOW_SIZE >= t.length) break;
  }
  return out;
};

const normalize = (v) => {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 1) out[i] = v[i] / n;
  return out;
};

// [whole, ...windows] (raw vectors) <-> one Buffer of normalized float32s.
const encodeVectors = (vectors) => {
  const dims = vectors[0].length;
  const all = new Float32Array(dims * vectors.length);
  vectors.forEach((v, i) => all.set(normalize(v), i * dims));
  return { vectors: Buffer.from(all.buffer), dims };
};

const decodeVectors = (buf, dims) => {
  // Copy out: a Buffer from the driver may sit at an unaligned offset.
  const all = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  const out = [];
  for (let i = 0; i + dims <= all.length; i += dims) out.push(all.subarray(i, i + dims));
  return out;
};

const hashOf = (part) => crypto.createHash("sha1").update(`${SCHEME}\n${part.label}\n${part.text}`).digest("hex");

// ---------------------------------------------------------------- indexing

// Brings one plan's rows in step with its current text: embeds new/changed
// fields, drops fields that were emptied or no longer exist.
async function indexPlan(plan) {
  const parts = planParts(plan);
  const existing = await PlanSearchVector.findAll({ where: { planId: plan.id }, attributes: ["id", "partKey", "contentHash"] });
  const byKey = new Map(existing.map((r) => [r.partKey, r]));
  const changed = parts.filter((p) => {
    const row = byKey.get(p.partKey);
    return !row || row.contentHash !== hashOf(p);
  });
  if (changed.length) {
    // A short field is its own only window -- no second vector for it.
    const inputs = changed.map((p) => {
      const windows = p.text.length > WINDOW_SIZE ? windowsOf(p.text) : [];
      return { p, windows, texts: [p.text.slice(0, MAX_WHOLE_CHARS), ...windows] };
    });
    const vectors = await embedTexts(inputs.flatMap((x) => x.texts));
    let k = 0;
    for (const { p, texts } of inputs) {
      const encoded = encodeVectors(vectors.slice(k, k + texts.length));
      k += texts.length;
      const values = {
        planId: plan.id,
        partKey: p.partKey,
        label: p.label.slice(0, 255),
        // Only what windowing and snippets use (and TEXT's 64 KB cap).
        content: p.text.slice(0, MAX_WINDOWED_CHARS),
        contentHash: hashOf(p),
        ...encoded,
        embeddingModel: SCHEME,
      };
      const row = byKey.get(p.partKey);
      if (row) await PlanSearchVector.update(values, { where: { id: row.id } });
      else await PlanSearchVector.create(values);
    }
  }
  const live = new Set(parts.map((p) => p.partKey));
  const stale = existing.filter((r) => !live.has(r.partKey)).map((r) => r.id);
  if (stale.length) await PlanSearchVector.destroy({ where: { id: { [Op.in]: stale } } });
  return changed.length;
}

// Background sync: every plan changed since the last pass (all of them on
// the first pass after a restart -- unchanged fields cost only a hash
// compare). One pass at a time; a request during a pass runs another after.
const state = { running: false, again: false, lastStartedAt: null, total: 0, done: 0, lastError: null };
let debounce = null;

async function syncIndex({ log = () => {} } = {}) {
  if (state.running) {
    state.again = true;
    return;
  }
  state.running = true;
  try {
    do {
      state.again = false;
      const startedAt = new Date();
      const where = state.lastStartedAt ? { updatedAt: { [Op.gte]: state.lastStartedAt } } : {};
      const ids = (await db.plan.findAll({ where, attributes: ["id"], raw: true })).map((r) => r.id);
      state.total = ids.length;
      state.done = 0;
      let embedded = 0;
      let failed = false;
      for (const id of ids) {
        const plan = await db.plan.findByPk(id, {
          attributes: ["id", "planFormData"],
          include: [{ model: db.templateVersion, as: "PlanTemplateVersion", attributes: ["id", "schemaJson"] }],
        });
        if (plan) {
          try {
            embedded += await indexPlan(plan);
          } catch (e) {
            // Leave this plan as it was; the next pass starts from the
            // previous checkpoint, so it is retried.
            failed = true;
            state.lastError = `plan#${id}: ${e.message}`;
            console.error(`语义搜索索引失败（plan#${id}）:`, e.message);
          }
        }
        state.done += 1;
      }
      if (!failed) state.lastStartedAt = startedAt;
      if (embedded) log(`语义搜索索引：${ids.length} 个课程设计，新向量化 ${embedded} 个字段。`);
    } while (state.again);
  } finally {
    state.running = false;
  }
}

// After a plan save -- coalesced, so a burst of autosaves embeds once.
function requestSync() {
  clearTimeout(debounce);
  debounce = setTimeout(() => syncIndex().catch((e) => console.error("语义搜索索引同步失败:", e.message)), 30 * 1000);
  if (debounce.unref) debounce.unref();
}

// ---------------------------------------------------------------- search

const dot = (a, b) => {
  if (a.length !== b.length) return -1;
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
};

// In-memory copy of the index, reloaded when its rows change (same check
// as embeddings.js#loadVectors).
let cache = { version: null, rows: [] };

async function loadIndex() {
  const [stat] = await PlanSearchVector.findAll({
    attributes: [
      [db.Sequelize.fn("COUNT", db.Sequelize.col("id")), "n"],
      [db.Sequelize.fn("MAX", db.Sequelize.col("id")), "maxId"],
      [db.Sequelize.fn("MAX", db.Sequelize.col("updated_at")), "maxUpdated"],
    ],
    where: { embeddingModel: SCHEME },
    raw: true,
  });
  const version = `${stat.n}|${stat.maxId}|${stat.maxUpdated}`;
  if (version === cache.version) return cache.rows;
  const rows = await PlanSearchVector.findAll({
    attributes: ["planId", "partKey", "label", "content", "vectors", "dims"],
    where: { embeddingModel: SCHEME },
    raw: true,
  });
  const out = [];
  for (const r of rows) {
    const [whole, ...windows] = decodeVectors(r.vectors, r.dims);
    if (whole) out.push({ planId: Number(r.planId), partKey: r.partKey, label: r.label, content: r.content, whole, windows });
  }
  cache = { version, rows: out };
  return cache.rows;
}

const CN_DIGITS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

// 「5个」「前十」「二十个」 -> a number; null if the question names none.
const parseCount = (q) => {
  const m = q.match(/(?:前\s*)?(\d+|[一二两三四五六七八九十]{1,3})\s*(?:个|项|份|篇|门|名)/) || q.match(/前\s*(\d+|[一二两三四五六七八九十]{1,3})/);
  if (!m) return null;
  const raw = m[1];
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === "十") return 10;
  if (raw.startsWith("十")) return 10 + (CN_DIGITS[raw[1]] || 0);
  if (raw.length >= 2 && raw[1] === "十") return CN_DIGITS[raw[0]] * 10 + (CN_DIGITS[raw[2]] || 0);
  return CN_DIGITS[raw] || null;
};

const QUALITY_RE = /较好|好的|最好|更好|优秀|出色|突出|到位|扎实|规范|示范|最佳|高质量|写得好|做得好|设置得好|设计得好|值得借鉴|典范/;

// The 学习目标 category a question names: 「社会情感目标」, 「SEL」,
// 「实践技能」... ; 其他/其它 only as 「其他目标」.
const categoryIn = (q) => {
  if (/SEL|社会情感/i.test(q)) return "社会情感";
  if (/其[他它]目标/.test(q)) return "其它";
  return GOAL_CATEGORY_NAMES.find((c) => c !== "其它" && q.includes(c)) || null;
};

// "驱动问题（儿童视角）" -> "驱动问题", for matching a question's wording.
const labelCore = (label) =>
  label
    .replace(/^第\d+课时·/, "")
    .replace(/[（(].*?[）)]/g, "")
    .replace(/[\s.．、：:]/g, "");

// Which fields a question is about: a 学习目标 category's fields, or fields
// whose label the question names; null = every field.
const targetFieldsFor = (q, rows, category) => {
  if (category) return { test: (row) => goalCategoryOf(row.label) === category, labels: [`${category === "其它" ? "其他" : category}目标`] };
  const named = [...new Set(rows.map((r) => labelCore(r.label)))].filter((core) => core.length >= 2 && q.includes(core));
  // The longest names win (「师生共议驱动问题」 over 「驱动问题」).
  const specific = named.filter((n) => !named.some((o) => o !== n && o.includes(n)));
  if (!specific.length) return { test: () => true, labels: null };
  const set = new Set(specific);
  return { test: (row) => set.has(labelCore(row.label)), labels: specific };
};

// The library passages a 「…较好…」 question is measured against, with
// their source titles for the explanation.
async function libraryYardstick(q) {
  const hits = await semanticSearch(q, { limit: 3 });
  if (!hits.length) return null;
  const chunks = await db.knowledgeChunk.findAll({ where: { id: { [Op.in]: hits.map((h) => h.id) } }, attributes: ["id", "content", "sourceType", "sourceId"] });
  const byId = new Map(chunks.map((c) => [Number(c.id), c]));
  const ordered = hits.map((h) => byId.get(h.id)).filter(Boolean);
  const summaries = await db.knowledgeSourceSummary.findAll({
    where: { [Op.or]: ordered.map((c) => ({ sourceType: c.sourceType, sourceId: c.sourceId })) },
    attributes: ["sourceType", "sourceId", "title"],
  });
  const titleOf = (c) => {
    const s = summaries.find((x) => x.sourceType === c.sourceType && String(x.sourceId) === String(c.sourceId));
    return s && s.title;
  };
  let text = "";
  for (const c of ordered) {
    if (text.length >= LIBRARY_YARDSTICK_CHARS) break;
    text += `${c.content.slice(0, LIBRARY_YARDSTICK_CHARS - text.length)}\n`;
  }
  return { text, sources: [...new Set(ordered.map(titleOf).filter(Boolean))] };
}

const snippetOf = (row, windowIndex) => {
  const source = windowIndex != null && row.windows.length ? windowsOf(row.content)[windowIndex] || row.content : row.content;
  const s = normalizeSpace(source);
  return s.length > 180 ? `${s.slice(0, 180)}…` : s;
};

// Ranks the plans in `planIds` (the caller's visible set) for `query`.
// Returns { mode, basis, fields, contrast, results: [{ planId, score, label,
// snippet }], index: { parts, syncing } }.
// `rows` (normally loaded from the index) lets a dry run rank an
// in-memory index built with buildRows.
async function searchPlans(query, { planIds, limit, rows: given } = {}) {
  const q = normalizeSpace(query).slice(0, 300);
  const rows = (given || (await loadIndex())).filter((r) => !planIds || planIds.has(r.planId));
  const index = { parts: rows.length, syncing: state.running, progress: state.running ? `${state.done}/${state.total}` : null };
  const n = Math.min(MAX_LIMIT, Number(limit) || parseCount(q) || DEFAULT_LIMIT);
  if (!q || !rows.length) return { mode: null, basis: null, fields: null, contrast: null, results: [], index };

  const category = categoryIn(q);
  const quality = QUALITY_RE.test(q);
  const target = targetFieldsFor(q, rows, quality ? category : null);
  const candidates = rows.filter(target.test);

  let mode = "finding";
  let basis = null;
  let contrast = null;
  let pos;
  let neg = null;
  if (quality && category) {
    const profile = goalSearchProfile(category);
    const texts = [profile.positive, ...(profile.contrast ? [profile.contrast] : [])];
    const [p, c] = (await embedTexts(texts)).map(normalize);
    mode = "definition";
    pos = p;
    neg = c || null;
    basis = `课程框架术语中「${target.labels[0]}」的定义（来自学习资源库）`;
    contrast = profile.contrast;
  } else if (quality) {
    const yard = await libraryYardstick(q);
    if (yard) {
      [pos] = (await embedTexts([`${q}\n${yard.text}`])).map(normalize);
      mode = "library";
      basis = yard.sources.length ? `学习资源库：${yard.sources.map((t) => `《${t}》`).join("、")}` : "学习资源库中与问题最相关的段落";
    }
  }
  if (mode === "finding") {
    [pos] = (await embedTexts([q], { instruct: FINDING_INSTRUCT })).map(normalize);
  }

  // Each plan's best field.
  const best = new Map();
  for (const row of candidates) {
    let score;
    let windowIndex = null;
    if (mode === "finding" && row.windows.length) {
      // A long field by its best window only: its whole-text vector drifts
      // toward "a PBL plan in general", and on prod a generic 入项活动
      // overview outranked fields that describe the interview.
      score = -1;
      row.windows.forEach((w, i) => {
        const s = dot(w, pos);
        if (s > score) {
          score = s;
          windowIndex = i;
        }
      });
    } else if (mode === "finding") {
      score = dot(row.whole, pos);
    } else {
      score = dot(row.whole, pos) - (neg ? dot(row.whole, neg) : 0);
    }
    const prev = best.get(row.planId);
    if (!prev || score > prev.score) best.set(row.planId, { row, score, windowIndex });
  }
  const results = [...best.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map(({ row, score, windowIndex }) => ({
      planId: row.planId,
      score: Math.round(score * 1000) / 1000,
      label: row.label,
      snippet: snippetOf(row, windowIndex),
    }));
  return { mode, basis, fields: target.labels, contrast, results, index };
}

module.exports = { searchPlans, syncIndex, requestSync, indexPlan, planParts, parseCount, categoryIn, encodeVectors, decodeVectors, SCHEME };
