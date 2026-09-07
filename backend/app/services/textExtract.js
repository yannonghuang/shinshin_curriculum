const mammoth = require("mammoth");
const childProcess = require("child_process");

// Shared text-extraction used by both review.controller.js's AI-review
// prompt builder and the knowledge-base ingestion pipeline
// (knowledgeIngest.js) -- previously two separate inline copies of the same
// .docx/.pptx logic; lifted out here so both consumers extract identically.
//
// Extractable: .docx, .pptx, .pdf -- no legacy .doc/.ppt, no image/video
// content. Callers treat "" as a normal, expected "nothing to extract"
// outcome, not an error.

const extractDocxText = async (filePath) => {
  const result = await mammoth.extractRawText({ path: filePath });
  return (result.value || "").trim();
};

// Same as extractDocxText, but for a .docx rendered on the fly into a Buffer
// (see dynamicDocGenerator.js) rather than one already on disk.
const extractDocxTextFromBuffer = async (buffer) => {
  const result = await mammoth.extractRawText({ buffer });
  return (result.value || "").trim();
};

// .pptx is a zip of per-slide XML files; each text run lives in an <a:t>
// element. Shells out to the same `unzip` binary artifact.controller.js's
// bulkCreateFromZip already depends on, rather than adding a pptx-parsing npm
// package for one regex's worth of extraction. `slide*.xml`'s wildcard is
// matched by unzip itself (no shell involved, so no glob-injection risk).
const extractPptxText = (filePath) => {
  let xml;
  try {
    xml = childProcess
      .execFileSync("unzip", ["-p", filePath, "ppt/slides/slide*.xml"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8");
  } catch (e) {
    return ""; // not a real zip, or no slides matched -- fall through to "no text extracted"
  }
  return [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(" ").trim();
};

// Text layer only -- no OCR in this pipeline, same tier as 图片/视频, so a
// scanned/image-only PDF still yields "". Shells out to mutool (MuPDF,
// installed via apk -- see Dockerfile*) rather than a JS PDF library: this
// replaced an earlier pdf-parse (pdfjs-dist)-based implementation after a
// real prod incident -- a 4.96MB image-heavy PDF took pdfjs-dist ~800MB RSS
// and 8-17s to extract from, which triggered a host-wide kernel OOM-kill on
// the small prod VM (global OOM, not even scoped to this container). The
// identical file through mutool: ~48MB peak, ~0.2s, and more complete text
// output besides -- a native, mature PDF interpreter is simply a better tool
// for this than a from-scratch JS reimplementation. `timeout` is a hedge
// against a truly pathological file well past anything seen in testing, not
// a limit expected to bind in practice.
const PDF_EXTRACT_TIMEOUT_MS = 20000;

const extractPdfText = (filePath) => {
  try {
    return childProcess
      .execFileSync("mutool", ["draw", "-q", "-F", "txt", "-o", "-", filePath], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: PDF_EXTRACT_TIMEOUT_MS,
        maxBuffer: 50 * 1024 * 1024,
      })
      .toString("utf8")
      .trim();
  } catch (e) {
    // mutool exits 0 with empty output for a real, text-less (e.g. scanned)
    // PDF -- that never reaches this catch. Landing here means mutool itself
    // failed (missing binary, timed out, a corrupt/unreadable file), which
    // used to be swallowed with no trace at all; log it so a real tooling
    // failure is at least visible in the backend logs, even though the
    // caller still treats "" as a normal, non-fatal outcome either way.
    console.error("PDF 文本提取失败（mutool 执行出错）：", filePath, e.message);
    return "";
  }
};

// Extracts plain text from a file on disk, based on its (case-insensitive,
// no-dot) extension. Returns "" for anything unsupported rather than
// throwing.
const extractTextFromFile = async (filePath, ext) => {
  const normalizedExt = (ext || "").toLowerCase().replace(/^\./, "");
  try {
    if (normalizedExt === "docx") return await extractDocxText(filePath);
    if (normalizedExt === "pptx") return extractPptxText(filePath);
    if (normalizedExt === "pdf") return await extractPdfText(filePath);
  } catch (e) {
    console.error("文本提取失败:", filePath, e.message);
  }
  return "";
};

module.exports = { extractTextFromFile, extractDocxText, extractDocxTextFromBuffer, extractPptxText, extractPdfText };
