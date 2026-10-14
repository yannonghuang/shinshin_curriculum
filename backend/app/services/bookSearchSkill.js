// 图书检索 skill -- finds what a book is about from its ISBN and/or title,
// the server-side successor of the standalone shinshin_douban/ agents
// (douban/dangdang via Selenium). Two sources:
//   1. 豆瓣读书 by ISBN (doubanSource.js) -- exact match, plus the rating
//      and rating count the old agents collected as a quality signal;
//   2. DashScope's search-enabled model (llmClient.webSearch) -- 当当/京东/
//      publisher pages etc. for what douban lacks (适读年龄, 获奖/入选书目,
//      争议), and the only source for books without a usable ISBN or not on
//      douban, or while douban is rate-limiting us.
// Like the old agents, a miss on ISBN is retried on title alone, and a hit
// whose ISBN differs from the uploaded one is flagged (新ISBN: a reprint or
// new edition). The model turns what was found into a structured profile,
// cached in book_profiles and reused until stale. Self-improving via
// skillNotes.js: its notes go into every search prompt, and
// bookRecommendation.js revises them after each run from this skill's
// hit/miss record (see lookup's `trace`).
const db = require("../models");
const llmClient = require("./llmClient");
const skillNotes = require("./skillNotes");
const doubanSource = require("./doubanSource");
const { STAGE_KEYS } = require("../constants/readingStages");

const SKILL = "book_search";
const SKILL_PURPOSE = "根据 ISBN 和/或书名联网检索图书（豆瓣读书、当当、京东图书、出版社官网等），获取内容简介、主题、适读年龄等信息。";

// A found profile is renewed after a year; a miss is retried sooner (the
// book may have been listed since, or the skill's notes improved).
const FOUND_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const clean = (v) => String(v == null ? "" : v).trim();

// Excel hands an ISBN column over as a number, sometimes "9787...861.0".
const normalizeIsbn = (raw) => {
  const s = clean(raw).replace(/\.0+$/, "").toUpperCase().replace(/[^0-9X]/g, "");
  return s.length === 13 || s.length === 10 ? s : "";
};
const normalizeTitle = (raw) => clean(raw).replace(/[《》<>「」『』"'“”\s]/g, "").toLowerCase();

// Cache key: the ISBN when there is a valid one, else the title.
const lookupKeyOf = (book) => {
  const isbn = normalizeIsbn(book.isbn);
  return isbn ? `isbn:${isbn}` : `title:${normalizeTitle(book.title)}`.slice(0, 255);
};

const isFresh = (row) => {
  if (!row || !row.fetchedAt) return false;
  const age = Date.now() - new Date(row.fetchedAt).getTime();
  return age < (row.found ? FOUND_TTL_MS : MISS_TTL_MS);
};

const describeBook = (book) =>
  [
    book.title && `书名《${clean(book.title)}》`,
    normalizeIsbn(book.isbn) && `ISBN ${normalizeIsbn(book.isbn)}`,
    clean(book.author) && `作者 ${clean(book.author)}`,
    clean(book.publisher) && `出版社 ${clean(book.publisher)}`,
    clean(book.year) && `出版年 ${clean(book.year)}`,
  ]
    .filter(Boolean)
    .join("，");

const CONCERN_HINT =
  "是否含有可能不适宜中小学生的内容（如暴力恐怖、色情低俗、封建迷信、宗教宣传、错误历史观或价值观、" +
  "损害国家形象、涉及民族宗教问题不当表述等）或公开争议";

// Full search (no douban hit): everything about the book. Supplementary
// search (douban already identified it): just what douban lacks.
async function searchOnce(bookLine, notes, { supplementary = false } = {}) {
  const ask = supplementary
    ? `请联网检索这本书：${bookLine}。用中文客观总结：适读年龄或年级、所获奖项或入选的推荐书目（如教育部基础教育课程教材发展中心推荐书目、` +
      `“百班千人”、新闻出版署推荐等）、专业书评要点，以及${CONCERN_HINT}。`
    : `请联网检索这本书：${bookLine}。优先查阅豆瓣读书、当当、京东图书、出版社官网等图书页面。` +
      "用中文客观总结：书名、作者（含国籍）、出版社、出版年、ISBN、内容简介、主要主题、适读年龄或年级、" +
      `所获奖项或入选的推荐书目，以及${CONCERN_HINT}。` +
      "若检索结果中找不到与 ISBN/书名确切对应的这本书，请明确写出“未找到”。";
  const result = await llmClient.webSearch({
    prompt: `${ask}检索结果中没有的信息不要补充或推测。${notes}`,
    maxTokens: 1500,
  });
  return { text: result.text || "", sources: (result.sources || []).slice(0, 8) };
}

const formatDouban = (d) =>
  [
    `书名：${d.title}`,
    d.originalTitle && `原作名：${d.originalTitle}`,
    d.author && `作者：${d.author}`,
    d.publisher && `出版社：${d.publisher}`,
    d.year && `出版年：${d.year}`,
    d.series && `丛书：${d.series}`,
    d.isbn && `ISBN：${d.isbn}`,
    d.rating !== null && `豆瓣评分：${d.rating}（${d.ratingCount || 0}人评价）`,
    d.intro && `内容简介：${d.intro}`,
  ]
    .filter(Boolean)
    .join("\n");

async function extractProfile(book, { douban, searchText }) {
  const result = await llmClient.llmChat({
    systemPrompt:
      "根据给出的图书资料（豆瓣读书页面信息和/或联网检索摘要），整理出目标图书的结构化档案。只依据资料内容，资料未提及的字段留空，不要推测。" +
      "found：资料确实对应给定 ISBN 或书名的这本书时为 true（同名不同书、仅找到同系列其他书都算 false；有豆瓣页面信息时即为 true）。" +
      "isbn：资料中这本书的 ISBN（没有则留空）。" +
      `suggestedStages：根据适读年龄判断适合的学段，取值只能是 ${STAGE_KEYS.join("、")}（1-2 指1—2年级，以此类推）。` +
      "concerns：可能不适宜中小学生的内容或公开争议，没有则为空数组。" +
      '只输出 JSON：{"found": true, "title": "", "author": "", "publisher": "", "year": "", "isbn": "", "summary": "200字以内内容简介", ' +
      '"themes": [""], "readingLevel": "", "suggestedStages": [""], "endorsements": ["获奖/入选书目"], "concerns": [""]}',
    messages: [
      {
        role: "user",
        content:
          `【目标图书】${describeBook(book)}` +
          (douban ? `\n\n【豆瓣读书页面信息】\n${formatDouban(douban)}` : "") +
          (searchText ? `\n\n【联网检索摘要】\n${searchText}` : ""),
      },
    ],
    maxTokens: 1200,
    thinking: false,
  });
  const p = skillNotes.parseJsonObject(result.text);
  return {
    found: !!douban || p.found === true,
    title: (douban && douban.title) || clean(p.title),
    author: (douban && douban.author) || clean(p.author),
    publisher: (douban && douban.publisher) || clean(p.publisher),
    year: (douban && douban.year) || clean(p.year),
    isbn: normalizeIsbn((douban && douban.isbn) || p.isbn),
    profile: {
      summary: clean(p.summary),
      themes: skillNotes.strList(p.themes),
      readingLevel: clean(p.readingLevel),
      suggestedStages: skillNotes.strList(p.suggestedStages).filter((s) => STAGE_KEYS.includes(s)),
      endorsements: skillNotes.strList(p.endorsements),
      concerns: skillNotes.strList(p.concerns),
      rating: douban ? douban.rating : null,
      ratingCount: douban ? douban.ratingCount : null,
      doubanUrl: douban ? douban.url : null,
    },
    model: result.model,
  };
}

const sitesOf = (sources) => [...new Set(sources.map((s) => s.site).filter(Boolean))];

// Profile for one input book: { row, cached, trace }. trace records what
// was tried, for the skill's self-improvement step. `force` skips the cache.
async function lookup(book, { notes, force = false } = {}) {
  const lookupKey = lookupKeyOf(book);
  const cachedRow = await db.bookProfile.findOne({ where: { lookupKey } });
  if (!force && isFresh(cachedRow)) return { row: cachedRow, cached: true, trace: null };

  const inputIsbn = normalizeIsbn(book.isbn);
  const trace = { book: describeBook(book), douban: inputIsbn ? null : "no_isbn", attempts: [] };
  let extracted = null;
  let sources = [];

  const douban = inputIsbn ? await doubanSource.lookupByIsbn(inputIsbn) : null;
  if (douban) trace.douban = douban.status;
  if (douban && douban.status === "found") {
    const d = douban.book;
    const line = describeBook({ title: d.title, author: d.author, publisher: d.publisher, isbn: d.isbn || inputIsbn });
    const search = await searchOnce(line, notes || "", { supplementary: true });
    extracted = await extractProfile(book, { douban: d, searchText: search.text });
    sources = [{ title: `豆瓣读书：${d.title}`, url: d.url, site: "豆瓣读书" }, ...search.sources];
    trace.attempts.push({ query: `[补充] ${line}`, found: true, sites: sitesOf(search.sources) });
  } else {
    // ISBN + title first; if that misses and there was an ISBN, the ISBN
    // may be the problem (typo, a reprint's), so retry on title alone --
    // the same ISBN-then-title pair the old douban/dangdang agents ran.
    const attempts = [describeBook(book)];
    if (inputIsbn && clean(book.title)) {
      attempts.push(describeBook({ title: book.title, author: book.author, publisher: book.publisher }));
    }
    for (const line of attempts) {
      const search = await searchOnce(line, notes || "");
      extracted = await extractProfile(book, { searchText: search.text });
      sources = search.sources;
      trace.attempts.push({ query: line, found: extracted.found, sites: sitesOf(sources) });
      if (extracted.found) break;
    }
  }

  // 新ISBN: the book found carries a different ISBN than the uploaded one.
  const foundIsbn = extracted.found ? extracted.isbn : "";
  const profile = extracted.found
    ? { ...extracted.profile, foundIsbn: foundIsbn || null, isbnMismatch: !!(inputIsbn && foundIsbn && foundIsbn !== inputIsbn) }
    : null;
  const values = {
    lookupKey,
    isbn: inputIsbn || foundIsbn || null,
    title: (extracted.found && extracted.title) || clean(book.title) || inputIsbn,
    author: (extracted.found && extracted.author) || clean(book.author) || null,
    publisher: (extracted.found && extracted.publisher) || clean(book.publisher) || null,
    pubYear: ((extracted.found && extracted.year) || clean(book.year) || "").slice(0, 16) || null,
    found: extracted.found,
    profile,
    sources: sources.map((s) => ({ title: s.title, url: s.url, site: s.site })),
    aiModel: extracted.model,
    fetchedAt: new Date(),
  };
  const row = cachedRow ? await cachedRow.update(values) : await db.bookProfile.create(values);
  return { row, cached: false, trace };
}

module.exports = { SKILL, SKILL_PURPOSE, lookup, lookupKeyOf, normalizeIsbn, describeBook };
