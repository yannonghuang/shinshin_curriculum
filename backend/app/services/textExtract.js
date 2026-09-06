const mammoth = require("mammoth");
const childProcess = require("child_process");

// Shared text-extraction used by both review.controller.js's AI-review
// prompt builder and the knowledge-base ingestion pipeline
// (knowledgeIngest.js) -- previously two separate inline copies of the same
// .docx/.pptx logic; lifted out here so both consumers extract identically.
//
// Only the modern XML-based formats (.docx/.pptx) are extractable -- no pdf,
// no legacy .doc/.ppt, no image/video content. Callers treat "" as a normal,
// expected "nothing to extract" outcome, not an error.

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

// Extracts plain text from a file on disk, based on its (case-insensitive,
// no-dot) extension. Returns "" for anything unsupported rather than
// throwing.
const extractTextFromFile = async (filePath, ext) => {
  const normalizedExt = (ext || "").toLowerCase().replace(/^\./, "");
  try {
    if (normalizedExt === "docx") return await extractDocxText(filePath);
    if (normalizedExt === "pptx") return extractPptxText(filePath);
  } catch (e) {
    console.error("文本提取失败:", filePath, e.message);
  }
  return "";
};

module.exports = { extractTextFromFile, extractDocxText, extractDocxTextFromBuffer, extractPptxText };
