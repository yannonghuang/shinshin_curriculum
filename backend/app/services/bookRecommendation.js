// 课外读物推荐 (super-only): given a book list (uploaded .xlsx/.csv) and a
// recipient school, recommend the books that comply with the school's
// province's 课外读物进校园 rules, grouped by 课程标准学段.
//
//   1. 指导检索 skill (guidanceSearchSkill.js) -- the province's rules,
//      cached per province;
//   2. 图书检索 skill (bookSearchSkill.js) -- each book's profile from
//      豆瓣读书 / web search, cached per book;
//   3. evaluation -- the model checks profiles against the rules in
//      batches: 推荐 (with the one best-fitting stage), 不推荐 (citing the
//      rule) or 待人工复核 (not enough to go on);
//   4. self-improvement -- the book search skill's notes are revised from
//      this run's hits and misses (skillNotes.js); the guidance skill
//      revises its own when it fetches.
// A run is a book_recommendation_runs row; it processes in the background
// (process-local, like aiScoreAndReview.js's batch) and the page polls it.
const ExcelJS = require("exceljs");
const db = require("../models");
const llmClient = require("./llmClient");
const skillNotes = require("./skillNotes");
const bookSearchSkill = require("./bookSearchSkill");
const guidanceSearchSkill = require("./guidanceSearchSkill");
const { STAGES, STAGE_KEYS, stageLabel } = require("../constants/readingStages");

const MAX_BOOKS = 500;
const SEARCH_CONCURRENCY = 3;
const EVAL_BATCH = 12;

const userError = (message, status = 422) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

// ---------------------------------------------------------------------------
// School -> province, school -> stages
// ---------------------------------------------------------------------------

const PROVINCES = [
  "北京", "天津", "河北", "山西", "内蒙古", "辽宁", "吉林", "黑龙江", "上海", "江苏", "浙江", "安徽", "福建", "江西",
  "山东", "河南", "湖北", "湖南", "广东", "广西", "海南", "重庆", "四川", "贵州", "云南", "西藏", "陕西", "甘肃",
  "青海", "宁夏", "新疆", "香港", "澳门", "台湾",
];
const MUNICIPALITIES = ["北京", "天津", "上海", "重庆"];
const AUTONOMOUS = { 内蒙古: "内蒙古自治区", 广西: "广西壮族自治区", 西藏: "西藏自治区", 宁夏: "宁夏回族自治区", 新疆: "新疆维吾尔自治区" };
const fullProvinceName = (p) => AUTONOMOUS[p] || (MUNICIPALITIES.includes(p) ? `${p}市` : ["香港", "澳门"].includes(p) ? `${p}特别行政区` : `${p}省`);
const PROVINCE_NAMES = PROVINCES.map(fullProvinceName);

// Address first (it's the school's actual registered location), then name.
function provinceOf(school) {
  for (const text of [school.address, school.name]) {
    const t = String(text || "").trim();
    const hit = PROVINCES.find((p) => t.startsWith(p));
    if (hit) return fullProvinceName(hit);
  }
  return "";
}

// 小学 -> stages 1-3; 中学 (not also a 小学) -> stage 4; anything else
// (九年一贯制, 中心校, 学校...) -> all four. Only a default -- the page
// lets the user adjust it.
function stagesOf(school) {
  const text = `${school.name || ""} ${school.address || ""}`;
  if (/小学|小學/.test(text) && !/九年|一贯/.test(text)) return ["1-2", "3-4", "5-6"];
  if (/中学/.test(text) && !/小学|九年|一贯/.test(text)) return ["7-9"];
  return [...STAGE_KEYS];
}

// ---------------------------------------------------------------------------
// Book list parsing
// ---------------------------------------------------------------------------

const COLUMN_PATTERNS = {
  title: /^(书名|题名|图书名称|图书名|名称|正题名|title)$/i,
  isbn: /^(isbn|书号|国际标准书号|isbn号|标准书号)$/i,
  publisher: /^(出版社|出版者|出版单位|publisher)$/i,
  year: /^(出版年|出版年份|出版时间|出版日期|年份|year)$/i,
  author: /^(作者|著者|责任者|author)$/i,
};

const cellText = (v) => {
  if (v == null) return "";
  if (v instanceof Date) return String(v.getFullYear());
  if (typeof v === "object") {
    if (v.richText) return v.richText.map((r) => r.text).join("");
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return String(v.result);
    return "";
  }
  // Large ISBNs come through as numbers -- never let them go exponential.
  if (typeof v === "number") return Number.isInteger(v) ? v.toFixed(0) : String(v);
  return String(v);
};

// Minimal RFC 4180 CSV (quoted fields, doubled quotes, CRLF).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function readRows(buffer, ext) {
  if (ext === "csv") {
    let text = buffer.toString("utf8");
    // Excel on Chinese Windows saves CSV as GBK; a UTF-8 decode of that is
    // full of U+FFFD.
    if ((text.match(/�/g) || []).length > 3) text = new TextDecoder("gbk").decode(buffer);
    return parseCsv(text.replace(/^﻿/, ""));
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row) => rows.push((row.values || []).slice(1).map(cellText)));
  return rows;
}

// [{ title, isbn, publisher, year, author }], de-duplicated by the search
// skill's cache key. Throws a userError naming what's wrong.
async function parseBookList(buffer, fileName) {
  const ext = String(fileName || "").split(".").pop().toLowerCase();
  if (!["xlsx", "csv"].includes(ext)) throw userError("请上传 .xlsx 或 .csv 文件。");
  let rows;
  try {
    rows = await readRows(buffer, ext);
  } catch (e) {
    throw userError(`无法读取文件：${e.message}`);
  }
  const headerIndex = rows.slice(0, 10).findIndex((r) => r.some((c) => COLUMN_PATTERNS.title.test(String(c).trim()) || COLUMN_PATTERNS.isbn.test(String(c).trim())));
  if (headerIndex < 0) throw userError("未找到表头：第一行需包含「书名」和/或「ISBN（书号）」列。");
  const header = rows[headerIndex].map((c) => String(c).trim());
  const col = {};
  Object.entries(COLUMN_PATTERNS).forEach(([key, re]) => {
    const i = header.findIndex((h) => re.test(h));
    if (i >= 0) col[key] = i;
  });

  const seen = new Set();
  const books = [];
  rows.slice(headerIndex + 1).forEach((r) => {
    const get = (key) => (col[key] === undefined ? "" : String(r[col[key]] || "").trim());
    const book = { title: get("title"), isbn: bookSearchSkill.normalizeIsbn(get("isbn")) || get("isbn"), publisher: get("publisher"), year: get("year"), author: get("author") };
    if (!book.title && !bookSearchSkill.normalizeIsbn(book.isbn)) return;
    const key = bookSearchSkill.lookupKeyOf(book);
    if (seen.has(key)) return;
    seen.add(key);
    books.push(book);
  });
  if (books.length === 0) throw userError("文件中没有可识别的图书（每行至少需要书名或有效的 ISBN）。");
  if (books.length > MAX_BOOKS) throw userError(`一次最多 ${MAX_BOOKS} 本，文件中有 ${books.length} 本，请分批上传。`);
  return books;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

// Ids of runs this process is working on -- a "running" row not in here was
// cut off by a restart (see listRuns/getRun).
const active = new Set();

async function settleInterrupted(row) {
  if (row.status === "running" && !active.has(Number(row.id))) {
    await row.update({ status: "failed", error: "服务重启导致运行中断，请重新运行。", finishedAt: new Date() });
  }
  return row;
}

// The province always comes from the school's own address/name, never
// from the caller -- the rules applied must be the school's actual
// province's.
async function startRun({ userId, schoolCode, stages, fileName, books }) {
  const school = await db.school.findByPk(schoolCode);
  if (!school) throw userError("学校不存在。");
  const prov = provinceOf(school);
  if (!prov) throw userError("无法从学校地址识别所在省份，请先完善学校地址。");
  const chosen = STAGE_KEYS.filter((k) => (stages || []).includes(k));
  if (chosen.length === 0) throw userError("请至少选择一个学段。");

  const run = await db.bookRecommendationRun.create({
    schoolCode: school.code,
    schoolName: school.name,
    schoolAddress: school.address,
    province: prov,
    stages: chosen,
    fileName,
    books,
    status: "running",
    progress: { step: "guidance", searched: 0, total: books.length },
    createdBy: userId,
  });
  active.add(Number(run.id));
  processRun(run).finally(() => active.delete(Number(run.id)));
  return run;
}

async function rerun(runId, userId) {
  const prev = await db.bookRecommendationRun.findByPk(runId);
  if (!prev) throw userError("运行记录不存在。", 404);
  return startRun({
    userId,
    schoolCode: prev.schoolCode,
    stages: prev.stages,
    fileName: prev.fileName,
    books: prev.books,
  });
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

async function processRun(run) {
  try {
    const guidance = await guidanceSearchSkill.getGuidance(run.province);
    await run.update({ guidanceFetchedAt: guidance.fetchedAt, progress: { step: "search", searched: 0, total: run.books.length } });

    const notes = await skillNotes.notesPrompt(bookSearchSkill.SKILL);
    let searched = 0;
    const traces = [];
    const lookups = await mapPool(run.books, SEARCH_CONCURRENCY, async (book) => {
      let res;
      try {
        res = await bookSearchSkill.lookup(book, { notes });
      } catch (e) {
        res = { row: null, error: e.message };
      }
      if (res.trace) traces.push(res.trace);
      searched += 1;
      await run.update({ progress: { step: "search", searched, total: run.books.length } });
      return res;
    });

    await run.update({ progress: { step: "evaluate", searched, total: run.books.length } });
    const decisions = await evaluate(run, guidance, lookups);
    const result = assembleResult(run, lookups, decisions);
    await run.update({ status: "done", result, progress: null, finishedAt: new Date() });

    if (traces.length > 0) {
      skillNotes.reviseNotes(bookSearchSkill.SKILL, {
        skillPurpose: "根据 ISBN 和/或书名检索图书（先查豆瓣读书 ISBN 页面，再联网检索补充），获取内容简介、主题、适读年龄、获奖与争议等信息。",
        experience: describeTraces(traces),
      });
    }
  } catch (e) {
    console.error(`课外读物推荐运行 #${run.id} 失败：`, e);
    await run.update({ status: "failed", error: e.message, finishedAt: new Date() }).catch(() => {});
  }
}

function describeTraces(traces) {
  const found = traces.filter((t) => t.douban === "found" || t.attempts.some((a) => a.found));
  const lines = [
    `本次新检索 ${traces.length} 本，找到 ${found.length} 本。`,
    `豆瓣 ISBN 页面：命中 ${traces.filter((t) => t.douban === "found").length}，未收录 ${traces.filter((t) => t.douban === "not_found").length}，` +
      `访问受限 ${traces.filter((t) => t.douban === "blocked").length}，出错 ${traces.filter((t) => t.douban === "error").length}，无ISBN ${traces.filter((t) => t.douban === "no_isbn").length}。`,
  ];
  traces.slice(0, 30).forEach((t) => {
    lines.push(
      `- ${t.book}：豆瓣 ${t.douban || "-"}；` +
        t.attempts.map((a) => `检索「${a.query}」${a.found ? "找到" : "未找到"}（来源：${a.sites.join("、") || "无"}）`).join("；")
    );
  });
  return lines.join("\n");
}

const guidanceText = (g) => {
  const c = g.content;
  return [
    `【依据文件】${c.documents.map((d) => `${d.level ? `${d.level}：` : ""}《${d.title}》${d.issuer ? `（${d.issuer}${d.year ? `，${d.year}` : ""}）` : ""}`).join("；") || "无"}`,
    `【红线（禁止进校园情形）】\n${c.redLines.map((r, i) => `R${i + 1}. ${r}`).join("\n")}`,
    `【推荐原则】\n${c.principles.map((p) => `- ${p}`).join("\n")}`,
    `【学段要求】\n${STAGE_KEYS.filter((k) => c.stageGuidance[k]).map((k) => `${stageLabel(k)}：${c.stageGuidance[k]}`).join("\n")}`,
    c.localNotes.length ? `【本省特别要求】\n${c.localNotes.map((n) => `- ${n}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

const profileText = (row) => {
  const p = row.profile || {};
  return [
    `《${row.title}》`,
    row.author && `作者：${row.author}`,
    row.publisher && `出版社：${row.publisher}${row.pubYear ? `，${row.pubYear}` : ""}`,
    p.summary && `简介：${p.summary}`,
    p.themes && p.themes.length && `主题：${p.themes.join("、")}`,
    p.readingLevel && `适读：${p.readingLevel}`,
    p.suggestedStages && p.suggestedStages.length && `建议学段：${p.suggestedStages.join("、")}`,
    p.rating !== null && p.rating !== undefined && `豆瓣评分：${p.rating}（${p.ratingCount || 0}人评价）`,
    p.endorsements && p.endorsements.length && `获奖/入选：${p.endorsements.join("、")}`,
    p.concerns && p.concerns.length && `疑点：${p.concerns.join("；")}`,
  ]
    .filter(Boolean)
    .join("；");
};

// decisions[i] for lookups[i]: { decision: recommend|exclude|review, stage,
// reason, rule }. Books the search skill couldn't find go straight to
// review -- there's nothing to judge them on.
async function evaluate(run, guidance, lookups) {
  const decisions = lookups.map((l) =>
    l.row && l.row.found ? null : { decision: "review", stage: "", reason: l.error ? `检索出错：${l.error}` : "未检索到该书的可靠信息，需人工核实。", rule: "" }
  );
  const pending = lookups.map((l, i) => i).filter((i) => !decisions[i]);
  const stageLine = run.stages.map((k) => `${k}（${stageLabel(k)}）`).join("、");
  const systemPrompt =
    `你是中小学课外读物进校园的审核与推荐专家。受赠学校：${run.schoolName}（${run.province}）。本校学段：${stageLine}。\n` +
    `请严格依据以下${run.province}适用的规定，逐本判断每本书：\n\n${guidanceText(guidance)}\n\n` +
    "判断规则：\n" +
    "- recommend：不触犯任何红线、内容积极健康、适合本校某个学段；stage 填最适合的一个学段（必须是本校学段之一）。\n" +
    "- exclude：触犯红线（rule 填对应编号如 R3 并在 reason 中说明）、明显不适合中小学生，或只适合本校没有的学段（reason 说明）。\n" +
    "- review：信息不足以判断，或存在疑点需要人工复核（reason 说明疑点）。\n" +
    "豆瓣评分可作为质量参考：评分8.0以上且评价人数较多为口碑良好；评分低于6.5应在 reason 中提示。获奖或入选权威推荐书目可加分。\n" +
    "reason 不超过60字，具体说明依据。不要编造图书资料中没有的内容。\n" +
    '只输出 JSON：{"items": [{"id": 1, "decision": "recommend|exclude|review", "stage": "", "reason": "", "rule": ""}]}';

  for (let start = 0; start < pending.length; start += EVAL_BATCH) {
    const batch = pending.slice(start, start + EVAL_BATCH);
    const list = batch.map((i, n) => `${n + 1}. ${profileText(lookups[i].row)}`).join("\n");
    let items = [];
    try {
      const result = await llmClient.llmChat({ systemPrompt, messages: [{ role: "user", content: list }], maxTokens: 3000 });
      const parsed = skillNotes.parseJsonObject(result.text);
      items = Array.isArray(parsed.items) ? parsed.items : [];
    } catch (e) {
      console.warn(`课外读物评估批次失败（运行 #${run.id}）：${e.message}`);
    }
    batch.forEach((i, n) => {
      const item = items.find((it) => Number(it.id) === n + 1);
      const decision = item && ["recommend", "exclude", "review"].includes(item.decision) ? item.decision : "review";
      let stage = item && run.stages.includes(String(item.stage)) ? String(item.stage) : "";
      if (decision === "recommend" && !stage) stage = ((lookups[i].row.profile || {}).suggestedStages || []).find((s) => run.stages.includes(s)) || "";
      decisions[i] = {
        decision: decision === "recommend" && !stage ? "review" : decision,
        stage,
        reason: item ? String(item.reason || "").trim() : "AI 评估失败，需人工复核。",
        rule: item ? String(item.rule || "").trim() : "",
      };
    });
  }
  return decisions;
}

function assembleResult(run, lookups, decisions) {
  const entries = run.books.map((book, i) => {
    const row = lookups[i].row;
    const p = (row && row.profile) || {};
    return {
      index: i + 1,
      inputTitle: book.title,
      inputIsbn: book.isbn,
      title: (row && row.title) || book.title,
      isbn: (row && row.isbn) || book.isbn,
      author: (row && row.author) || book.author || "",
      publisher: (row && row.publisher) || book.publisher || "",
      year: (row && row.pubYear) || book.year || "",
      found: !!(row && row.found),
      summary: p.summary || "",
      themes: p.themes || [],
      rating: p.rating ?? null,
      ratingCount: p.ratingCount ?? null,
      endorsements: p.endorsements || [],
      concerns: p.concerns || [],
      doubanUrl: p.doubanUrl || null,
      foundIsbn: p.foundIsbn || null,
      isbnMismatch: !!p.isbnMismatch,
      sources: (row && row.sources) || [],
      ...decisions[i],
    };
  });
  return {
    stages: run.stages.map((key) => ({ key, label: stageLabel(key), books: entries.filter((e) => e.decision === "recommend" && e.stage === key) })),
    excluded: entries.filter((e) => e.decision === "exclude"),
    review: entries.filter((e) => e.decision === "review"),
    counts: {
      total: entries.length,
      recommended: entries.filter((e) => e.decision === "recommend").length,
      excluded: entries.filter((e) => e.decision === "exclude").length,
      review: entries.filter((e) => e.decision === "review").length,
    },
  };
}

const runSummary = (row) => ({
  id: row.id,
  schoolCode: row.schoolCode,
  schoolName: row.schoolName,
  province: row.province,
  stages: row.stages,
  fileName: row.fileName,
  bookCount: row.books ? row.books.length : Number(row.get("bookCount")) || 0,
  status: row.status,
  progress: row.progress,
  counts: row.result ? row.result.counts : row.get("counts") || null,
  error: row.error,
  createdAt: row.createdAt,
  finishedAt: row.finishedAt,
});

async function listRuns() {
  // Just the result's counts -- the whole result can run to hundreds of books.
  const rows = await db.bookRecommendationRun.findAll({
    attributes: {
      exclude: ["result", "books"],
      include: [
        [db.sequelize.fn("JSON_EXTRACT", db.sequelize.col("result"), db.sequelize.literal("'$.counts'")), "counts"],
        [db.sequelize.fn("JSON_LENGTH", db.sequelize.col("books")), "bookCount"],
      ],
    },
    order: [["id", "DESC"]],
    limit: 100,
  });
  return Promise.all(rows.map(async (r) => runSummary(await settleInterrupted(r))));
}

async function getRun(id) {
  const row = await db.bookRecommendationRun.findByPk(id);
  if (!row) throw userError("运行记录不存在。", 404);
  await settleInterrupted(row);
  const guidance = await db.readingGuidance.findOne({ where: { province: row.province } });
  return { ...runSummary(row), schoolAddress: row.schoolAddress, guidanceFetchedAt: row.guidanceFetchedAt, result: row.result, guidance };
}

async function deleteRun(id) {
  if (active.has(Number(id))) throw userError("运行中的记录不能删除。");
  await db.bookRecommendationRun.destroy({ where: { id } });
}

// Guidance cache for the page: every cached province, plus whether one is
// being re-fetched right now.
async function listGuidances() {
  const rows = await db.readingGuidance.findAll({ order: [["province", "ASC"]] });
  return rows.map((r) => ({ ...r.toJSON(), refreshing: guidanceSearchSkill.isRefreshing(r.province), stale: Date.now() - new Date(r.fetchedAt).getTime() > guidanceSearchSkill.TTL_MS }));
}

// Kicks off a re-fetch and returns immediately; the page polls listGuidances.
function refreshGuidance(province) {
  if (!PROVINCE_NAMES.includes(province)) throw userError("省份无效。");
  guidanceSearchSkill.getGuidance(province, { force: true }).catch((e) => console.warn(`指导检索失败（${province}）：${e.message}`));
}

async function getSkillNotes() {
  const [book, guidance] = await Promise.all([skillNotes.getNotes(bookSearchSkill.SKILL), skillNotes.getNotes(guidanceSearchSkill.SKILL)]);
  return { [bookSearchSkill.SKILL]: book, [guidanceSearchSkill.SKILL]: guidance };
}

module.exports = {
  STAGES,
  provinceOf,
  stagesOf,
  parseBookList,
  startRun,
  rerun,
  listRuns,
  getRun,
  deleteRun,
  listGuidances,
  refreshGuidance,
  getSkillNotes,
};
