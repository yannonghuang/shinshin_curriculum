// Response-message i18n. Controllers and services keep writing Chinese
// messages; middleware/lang.js translates the JSON response's `message` /
// `error` strings on the way out when the request asked for English
// (frontend sends X-Lang on every call -- see react-app/src/i18n/index.js).
//
// en.js is keyed by the exact Chinese text. A key with {0}, {1}... is a
// pattern for a message built from a template literal or "..." + err.message
// concatenation: each placeholder matches any text, which is carried over into
// the English text unchanged (and is itself translated if it happens to be a
// known message, e.g. a service error appended to a controller prefix).
//
// Only whole-string matches are replaced, so user content that merely
// contains a known phrase passes through untouched.
const en = require("./en");

const exact = new Map();
const patterns = [];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

for (const [zh, english] of Object.entries(en)) {
  if (/\{\d+\}/.test(zh)) {
    const names = [];
    const re = zh
      .split(/(\{\d+\})/)
      .map((part) => {
        const m = part.match(/^\{(\d+)\}$/);
        if (!m) return escapeRe(part);
        names.push(m[1]);
        return "([\\s\\S]*?)";
      })
      .join("");
    patterns.push({ re: new RegExp(`^${re}$`), names, english });
  } else {
    exact.set(zh, english);
  }
}
// Longer (more specific) patterns first, so a bare "{0}失败。"-style pattern
// can't shadow a more specific one.
patterns.sort((a, b) => b.re.source.length - a.re.source.length);

function translate(text, lang, depth = 0) {
  if (lang !== "en" || typeof text !== "string" || !text || depth > 2) return text;
  if (!/[㐀-鿿]/.test(text)) return text;
  if (exact.has(text)) return exact.get(text);
  for (const { re, names, english } of patterns) {
    const m = text.match(re);
    if (!m) continue;
    return names.reduce((out, name, i) => out.split(`{${name}}`).join(translate(m[i + 1], lang, depth + 1)), english);
  }
  return text;
}

// Translate `message` / `error` string fields of a response body (top level
// and a couple of levels down, e.g. { task: { error } }), leaving everything
// else -- user content, AI output, data values -- as is.
const FIELDS = new Set(["message", "error"]);
function translateBody(body, lang, depth = 0) {
  if (lang !== "en" || !body || typeof body !== "object" || depth > 2) return body;
  if (Array.isArray(body)) return body;
  let out = body;
  for (const key of Object.keys(body)) {
    const v = body[key];
    let nv = v;
    if (FIELDS.has(key) && typeof v === "string") nv = translate(v, lang);
    else if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !Buffer.isBuffer(v)) nv = translateBody(v, lang, depth + 1);
    if (nv !== v) {
      if (out === body) out = { ...body };
      out[key] = nv;
    }
  }
  return out;
}

// X-Lang (sent by the frontend) wins; otherwise Accept-Language, defaulting
// to Chinese for clients that send neither (curl, scripts, older builds).
function detectLang(req) {
  const explicit = String(req.get("x-lang") || "").toLowerCase();
  if (explicit === "en" || explicit === "zh") return explicit;
  const accept = String(req.get("accept-language") || "").trim().toLowerCase();
  if (!accept) return "zh";
  return accept.startsWith("zh") ? "zh" : "en";
}

module.exports = { translate, translateBody, detectLang };
