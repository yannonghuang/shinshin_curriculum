// 豆瓣读书 by ISBN -- the 图书检索 skill's exact-match source. Grown out of
// the standalone shinshin_douban/douban_rating_agent.py (Selenium + a
// logged-in cookie, scraping search results): book.douban.com/isbn/<isbn>/
// redirects straight to the book's subject page, which is server-rendered
// and readable without logging in, so a plain fetch is enough here -- no
// browser, no cookie. Title-only search on douban is a JS-rendered page, so
// books without a usable ISBN go through web search instead
// (bookSearchSkill.js).
//
// Douban rate-limits ("访问超限" / a sec.douban.com check / 403): requests
// are spaced out (MIN_GAP_MS + jitter, as the Python agent's SLEEP_BETWEEN
// did), and once blocked the source stays off for BLOCK_COOLDOWN_MS -- the
// skill falls back to web search rather than stalling a run.

const MIN_GAP_MS = 3000;
const JITTER_MS = 3000;
const BLOCK_COOLDOWN_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 15000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

let nextSlot = 0;
let blockedUntil = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Serializes callers onto evenly spaced slots (concurrent book lookups share
// one douban budget).
async function waitTurn() {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + MIN_GAP_MS + Math.floor(Math.random() * JITTER_MS);
  if (slot > now) await sleep(slot - now);
}

const decodeEntities = (s) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&middot;/g, "·");
const textOf = (html) => decodeEntities(String(html || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, " ")).replace(/[ \t]+/g, " ").trim();
const firstMatch = (html, re) => {
  const m = html.match(re);
  return m ? m[1] : "";
};

// The subject page's #info block as { 作者, 出版社, 出版年, 丛书, 原作名, ... }.
function parseInfo(html) {
  const block = firstMatch(html, /<div id="info"[^>]*>([\s\S]*?)<\/div>/);
  const info = {};
  textOf(block)
    .split(/\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join(" ")
    .replace(/\s+([:：])/g, "$1")
    .split(/\s(?=[^\s:：]{1,6}[:：])/)
    .forEach((part) => {
      const m = part.match(/^([^\s:：]{1,6})[:：]\s*(.*)$/);
      if (m && m[2]) info[m[1]] = m[2].trim();
    });
  return info;
}

// 内容简介: the expanded ("all hidden") copy when the page truncates it,
// else the first intro.
function parseIntro(html) {
  const section = firstMatch(html, /<div class="indent" id="link-report">([\s\S]*?)<\/div>\s*<\/span>\s*<\/div>|<div class="indent" id="link-report">([\s\S]*?)<h2/);
  const scope = section || html;
  const full = firstMatch(scope, /<span class="all hidden">[\s\S]*?<div class="intro">([\s\S]*?)<\/div>/);
  const short = firstMatch(scope, /<div class="intro">([\s\S]*?)<\/div>/);
  return textOf(full || short)
    .replace(/\(展开全部\)/g, "")
    .replace(/\s*\n\s*/g, "\n")
    .slice(0, 1500);
}

function parseSubject(html, url) {
  const info = parseInfo(html);
  const rating = parseFloat(firstMatch(html, /property="v:average">\s*([\d.]+)\s*</));
  const votes = parseInt(firstMatch(html, /property="v:votes">(\d+)</), 10);
  return {
    url,
    title: decodeEntities(firstMatch(html, /property="v:itemreviewed">([^<]*)</)).trim(),
    isbn: firstMatch(html, /<meta property="book:isbn" content="([^"]*)"/) || info.ISBN || "",
    author: info["作者"] || "",
    publisher: info["出版社"] || "",
    year: info["出版年"] || "",
    series: info["丛书"] || "",
    originalTitle: info["原作名"] || "",
    rating: Number.isFinite(rating) ? rating : null,
    ratingCount: Number.isFinite(votes) ? votes : null,
    intro: parseIntro(html),
  };
}

const isBlockedPage = (status, html) =>
  status === 403 || status === 418 || status === 429 || /访问超限|sec\.douban\.com|异常请求|检测到有异常/.test(html || "");

// { status: "found", book } | { status: "not_found" } | { status: "blocked" }
// | { status: "error", message }. Never throws.
async function lookupByIsbn(isbn) {
  if (!isbn) return { status: "not_found" };
  if (Date.now() < blockedUntil) return { status: "blocked" };
  await waitTurn();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`https://book.douban.com/isbn/${encodeURIComponent(isbn)}/`, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "zh-CN,zh;q=0.9" },
      redirect: "follow",
      signal: controller.signal,
    });
    const html = await resp.text();
    if (isBlockedPage(resp.status, html)) {
      blockedUntil = Date.now() + BLOCK_COOLDOWN_MS;
      console.warn(`豆瓣访问受限，${BLOCK_COOLDOWN_MS / 60000} 分钟内改用联网检索`);
      return { status: "blocked" };
    }
    if (resp.status === 404 || !/\/subject\/\d+/.test(resp.url)) return { status: "not_found" };
    if (!resp.ok) return { status: "error", message: `HTTP ${resp.status}` };
    const book = parseSubject(html, resp.url);
    return book.title ? { status: "found", book } : { status: "not_found" };
  } catch (e) {
    return { status: "error", message: e.name === "AbortError" ? "请求超时" : e.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { lookupByIsbn, parseSubject };
