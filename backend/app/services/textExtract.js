const fs = require("fs");
const mammoth = require("mammoth");
const childProcess = require("child_process");
const { PDFParse } = require("pdf-parse");

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

// Text layer only -- pdf-parse reads what's already encoded as text in the
// PDF, same as every other extractor here; a scanned/image-only PDF still
// yields "" (no OCR in this pipeline, same tier as 图片/视频). Load options
// trim memory overhead pdfjs-dist otherwise spends on things a pure text
// extraction never needs: no font-face/glyph rendering, no eval'd PDF
// functions, no range/stream fetching (the whole file is already an in-memory
// buffer) -- confirmed necessary in prod, where a 5-7MB real-world PDF ran
// the backend container out of memory (V8 "Reached heap limit", an
// uncatchable fatal abort -- see the container's mem_limit/NODE_OPTIONS in
// docker-compose.prod.yml for the other half of this fix).
const extractPdfText = async (filePath) => {
  const parser = new PDFParse({
    data: fs.readFileSync(filePath),
    disableFontFace: true,
    isEvalSupported: false,
    disableAutoFetch: true,
    disableStream: true,
  });
  try {
    const result = await parser.getText();
    return (result.text || "").trim();
  } finally {
    await parser.destroy();
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
