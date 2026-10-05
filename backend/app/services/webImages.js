const dns = require("dns").promises;
const net = require("net");

// Fetching pages and images from the open web for 欣欣小助手's find_photos
// (copilotActions.js). The URLs come from web-search results, i.e. from the
// internet, so every fetch here is treated as hostile input:
//   - http(s) only, and the host must resolve to public addresses -- never
//     loopback, private, link-local or cloud-metadata ranges (SSRF), checked
//     again on every redirect hop (redirects are followed by hand);
//   - hard timeouts and byte caps, so a slow or huge response can't tie up
//     the small production box;
//   - only raster images, with the type taken from the bytes themselves,
//     never from the server's Content-Type (no SVG -- it can carry script).

// WeChat article pages run past 1.5MB of HTML -- and they're among the
// richest sources of local photos.
const PAGE_MAX_BYTES = 4 * 1024 * 1024;
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 3;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

const isPrivateIPv4 = (ip) => {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast / reserved
  );
};

const isPrivateIPv6 = (ip) => {
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1") return true;
  if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique local
  if (/^fe[89ab]/.test(v)) return true; // link-local
  const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIPv4(mapped[1]) : false;
};

async function assertPublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (e) {
    throw new Error("无效的网址");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("仅支持 http/https 网址");
  if (url.username || url.password) throw new Error("网址不能包含账号信息");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true });
  if (addresses.length === 0) throw new Error("无法解析该网址");
  for (const { address, family } of addresses) {
    if (family === 4 ? isPrivateIPv4(address) : isPrivateIPv6(address)) throw new Error("不允许访问内部网络地址");
  }
  return url;
}

// GET with the guards above; resolves { buffer, finalUrl, contentType }.
async function safeFetch(rawUrl, { maxBytes, accept, referer } = {}) {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = await assertPublicUrl(current);
    const resp = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": USER_AGENT, Accept: accept || "*/*", ...(referer ? { Referer: referer } : {}) },
    });
    if (resp.status >= 300 && resp.status < 400 && resp.headers.get("location")) {
      current = new URL(resp.headers.get("location"), url).toString();
      continue;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const declared = Number(resp.headers.get("content-length") || 0);
    if (declared && declared > maxBytes) throw new Error("内容过大");
    // Read incrementally so an undeclared huge body is cut off at the cap.
    const reader = resp.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        reader.cancel().catch(() => {});
        throw new Error("内容过大");
      }
      chunks.push(value);
    }
    return { buffer: Buffer.concat(chunks.map((c) => Buffer.from(c))), finalUrl: url.toString(), contentType: resp.headers.get("content-type") || "" };
  }
  throw new Error("重定向次数过多");
}

// A page's share image -- og:image, falling back to twitter:image -- which
// is what a news/article page sets as "the" picture of the page.
const META_IMAGE_RES = [
  /<meta[^>]+(?:property|name)=["'](?:og:image(?::url)?|twitter:image(?::src)?)["'][^>]*content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image(?::url)?|twitter:image(?::src)?)["']/i,
];
const decodeHtml = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// Candidate photos on a page, best first: its declared share image, then
// the article's own pictures (many article pages -- Weibo, government sites
// -- declare none, but carry real photos in the body). Lazy-loaded images
// keep the real URL in data-src. Obvious page chrome is skipped by name;
// size/shape checks after download catch the rest.
const CHROME_RE = /logo|icon|avatar|qrcode|qr_code|erweima|banner|btn|button|search|sprite|blank|loading|placeholder|\.svg|\.gif/i;
const MAX_BODY_CANDIDATES = 4;

async function pageImageCandidates(pageUrl) {
  const { buffer, finalUrl } = await safeFetch(pageUrl, { maxBytes: PAGE_MAX_BYTES, accept: "text/html,*/*;q=0.5" });
  const html = buffer.toString("utf8");
  const out = [];
  const add = (raw) => {
    try {
      const abs = new URL(decodeHtml(raw.trim()), finalUrl).toString();
      if (/^https?:/i.test(abs) && !out.includes(abs)) out.push(abs);
    } catch (e) {
      // unparseable src -- skip
    }
  };
  for (const re of META_IMAGE_RES) {
    const m = html.match(re);
    if (m) add(m[1]);
  }
  let body = 0;
  for (const m of html.matchAll(/<img\b[^>]*?\s(?:data-src|data-original|src)=["']([^"']+)["']/gi)) {
    if (body >= MAX_BODY_CANDIDATES) break;
    if (m[1].startsWith("data:") || CHROME_RE.test(m[1])) continue;
    add(m[1]);
    body += 1;
  }
  return { candidates: out, finalUrl };
}

// Raster type and pixel size from the file's own header bytes.
function sniffImage(buf) {
  if (buf.length < 24) return null;
  if (buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") {
    return { mime: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.toString("ascii", 0, 3) === "GIF") {
    return { mime: "image/gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8 ") return { mime: "image/webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { mime: "image/webp", width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") return { mime: "image/webp", width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    return { mime: "image/webp", width: 0, height: 0 };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    // Walk JPEG segments to the first start-of-frame marker.
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { mime: "image/jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return { mime: "image/jpeg", width: 0, height: 0 };
  }
  return null;
}

// A page's share image is sometimes just the site's logo or a thin banner --
// photos worth showing are reasonably large and not extreme in shape.
const MIN_SIDE = 240;
const MAX_ASPECT = 3;
const looksLikePhoto = ({ width, height }) =>
  width >= MIN_SIDE && height >= MIN_SIDE && Math.max(width, height) / Math.min(width, height) <= MAX_ASPECT;

// The first candidate on a page that downloads and passes the photo checks:
// { buffer, mime, width, height, imageUrl } or null.
const MAX_IMAGE_TRIES = 3;
async function fetchPagePhoto(pageUrl) {
  const { candidates, finalUrl } = await pageImageCandidates(pageUrl);
  for (const imageUrl of candidates.slice(0, MAX_IMAGE_TRIES)) {
    try {
      // Referer = the page itself: many Chinese image hosts (Weibo's sinaimg,
      // WeChat's mmbiz) refuse requests without their own site's referer.
      const { buffer } = await safeFetch(imageUrl, { maxBytes: IMAGE_MAX_BYTES, accept: "image/*", referer: finalUrl });
      const info = sniffImage(buffer);
      if (info && looksLikePhoto(info)) return { buffer, mime: info.mime, width: info.width, height: info.height, imageUrl };
    } catch (e) {
      // this candidate failed -- try the next
    }
  }
  return null;
}

module.exports = { fetchPagePhoto, safeFetch, assertPublicUrl, sniffImage };
