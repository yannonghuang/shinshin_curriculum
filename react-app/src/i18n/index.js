// Minimal UI i18n: the Chinese source string *is* the key, so every call site
// stays readable as Chinese and a missing English entry just falls back to the
// Chinese text instead of showing a raw key.
//
//   tr("保存")                         -> "Save" (en) / "保存" (zh)
//   tr("共 {n} 条", { n: rows.length })  -> "{n} total" with {n} filled in
//
// A var that is a React element (e.g. a <b> or <Link>) makes tr() return an
// array of fragments instead of a string, so JSX interpolation keeps working.
//
// Language: an explicit choice (navbar 中/EN toggle, saved in localStorage)
// wins; otherwise the browser language decides -- any zh-* stays Chinese,
// anything else gets English. That's how users outside China get English by
// default without any IP lookup. The choice is sent to the backend on every
// API call (X-Lang header, see http-common.js) so its messages match.
//
// Only UI chrome is translated. Stored data values (乡土主题/年级/学期/文件类别
// ...) stay Chinese in the DB and API -- wrap them with tr() only where they're
// *displayed*. AI prompts and AI output are left as-is.
import React from "react";
import axios from "axios";
import en from "./en";

const STORAGE_KEY = "lang";
export const LANGS = ["zh", "en"];

function detect() {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (LANGS.includes(saved)) return saved;
  } catch (e) {
    // storage blocked -- fall through to browser language
  }
  const prefs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "zh"]);
  return /^zh\b/i.test(prefs[0] || "") ? "zh" : "en";
}

let current = detect();
if (typeof document !== "undefined") document.documentElement.lang = current === "zh" ? "zh-CN" : "en";
// Every request (the shared http-common instance and auth.service's bare
// axios calls alike) tells the backend which language its messages should
// be in -- see backend middleware/lang.js. Set on the global defaults before
// http-common.js calls axios.create(), which copies them.
axios.defaults.headers.common["X-Lang"] = current;
if (current === "en" && typeof document !== "undefined") document.title = en["乡土智课系统"] || document.title;

export const getLang = () => current;
// For toLocaleString / toLocaleDateString.
export const LOCALE = current === "zh" ? "zh-CN" : "en-US";
// 1.2万 in Chinese, 12K in English.
export const formatWan = (n) => {
  n = Number(n) || 0;
  if (current === "zh") return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : n.toLocaleString(LOCALE);
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : n.toLocaleString(LOCALE);
};
export const isEn = () => current === "en";

// Class components everywhere and module-level tr() calls (constants, labels)
// make a live re-render impractical -- a reload is simplest and safe (the
// unsaved-changes guards still get their chance via beforeunload).
export function setLang(lang) {
  if (!LANGS.includes(lang) || lang === current) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch (e) {
    // ignore -- choice just won't persist
  }
  window.location.reload();
}

const PLACEHOLDER = /\{([^{}]+)\}/g;

export function tr(zh, vars) {
  if (zh == null) return zh;
  const key = String(zh);
  let text = current === "en" && Object.prototype.hasOwnProperty.call(en, key) ? en[key] : key;
  if (process.env.NODE_ENV !== "production" && current === "en" && !(key in en) && /[㐀-鿿]/.test(key)) {
    reportMissing(key);
  }
  if (!vars) return text;
  const hasElement = Object.keys(vars).some((k) => React.isValidElement(vars[k]));
  if (!hasElement) {
    return text.replace(PLACEHOLDER, (m, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name] ?? "") : m));
  }
  const parts = [];
  let last = 0;
  text.replace(PLACEHOLDER, (m, name, offset) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return m;
    if (offset > last) parts.push(text.slice(last, offset));
    const v = vars[name];
    parts.push(React.isValidElement(v) ? React.cloneElement(v, { key: parts.length }) : String(v ?? ""));
    last = offset + m.length;
    return m;
  });
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// Dev aid: in English mode, collect untranslated keys once each so they can
// be copied into en.js -- run `window.__missingI18n` in the console.
const missing = new Set();
function reportMissing(key) {
  if (missing.has(key)) return;
  missing.add(key);
  window.__missingI18n = Array.from(missing);
  // eslint-disable-next-line no-console
  console.warn("[i18n] missing en:", key);
}
