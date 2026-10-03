const fs = require("fs");
const os = require("os");
const path = require("path");
const ExcelJS = require("exceljs");
const db = require("../models");
const ChatAttachment = db.chatAttachment;
const { Op } = db.Sequelize;
const llmClient = require("./llmClient");
const textExtract = require("./textExtract");

// Files a user hands 欣欣小助手 -- picked from disk, dropped onto the panel, or
// pasted (a screenshot) into its input. Everything is turned into *text* once,
// at upload time, and that text is what the chat model reads on every later
// turn: documents through textExtract.js (the same extraction the AI review
// and knowledge base already use), images through a one-off call to a vision
// model that transcribes and describes them. The chat model itself
// (qwen3.8-max, see llmClient.js) and the history replay in
// chat.controller.js#appendTurn therefore stay text-only.

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
// The panel downscales images before uploading (see copilot-panel.component.js
// #prepareImage), so a real upload is a few hundred KB -- this only guards
// against a client that skipped that step. Must fit chat_attachments.image_data
// (MEDIUMBLOB, 16MB).
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// Stored text is capped well above what any single turn feeds the model
// (MODEL_CHARS_PER_ATTACHMENT) so a later export or a bigger budget can still
// use it, but a pathological file can't bloat the row without bound.
const MAX_STORED_CHARS = 200000;

// Per-turn budget for attachment text replayed into the model -- a 50-page
// PDF would otherwise eat the whole context window on every turn it's in the
// history window. Truncation is announced inline so the model can tell the
// teacher it only saw the beginning.
const MODEL_CHARS_PER_ATTACHMENT = 12000;
const MODEL_CHARS_PER_TURN = 30000;

const DOCUMENT_EXTS = ["docx", "pptx", "pdf", "xlsx", "txt", "md", "csv"];
// Raster formats only, and the stored/served MIME type always comes from this
// table, never from the client -- an SVG (or anything labelled image/*) could
// otherwise carry script that runs when the panel opens its blob: URL.
const IMAGE_MIME_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};
const EXT_BY_IMAGE_MIME = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp" };
// Old binary Office formats -- textExtract.js only reads the zip-based ones,
// and there's no converter in the image. Rejected with a specific hint rather
// than the generic "unsupported" so the teacher knows the one-step fix.
const LEGACY_HINTS = { doc: "docx", ppt: "pptx", xls: "xlsx" };

const VISION_MODEL = () => process.env.COPILOT_VISION_MODEL || "qwen-vl-max";
const VISION_PROMPT =
  "请先完整、准确地转写图片中的全部文字（保持原有的段落、列表与层次结构；表格请用 Markdown 表格表示），" +
  "然后用一两句话简要描述图片中的非文字内容（如照片、插图、图表、示意图所表达的信息）。" +
  "如果图片中没有文字，直接描述图片内容即可。只输出转写与描述本身，不要添加其他说明。";

const userError = (message, status = 422) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

const extOf = (name) => (path.extname(name || "").slice(1) || "").toLowerCase();

const clip = (text, max) => (text.length > max ? text.slice(0, max) : text);

const extractXlsxText = async (buffer) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const parts = [];
  workbook.eachSheet((sheet) => {
    const rows = [];
    sheet.eachRow((row) => {
      const cells = (row.values || []).slice(1).map((v) => {
        if (v == null) return "";
        if (typeof v === "object") return v.text || v.result || (v.richText ? v.richText.map((r) => r.text).join("") : "");
        return String(v);
      });
      rows.push(cells.join("\t"));
    });
    if (rows.length > 0) parts.push(`【工作表：${sheet.name}】\n${rows.join("\n")}`);
  });
  return parts.join("\n\n");
};

// textExtract.js works on paths (it shells out to unzip/mutool for
// .pptx/.pdf), so the in-memory upload goes through a short-lived temp file.
const extractDocumentText = async (buffer, ext) => {
  if (["txt", "md", "csv"].includes(ext)) return buffer.toString("utf8").replace(/^﻿/, "").trim();
  if (ext === "xlsx") return (await extractXlsxText(buffer)).trim();
  const tmpPath = path.join(os.tmpdir(), `copilot-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
  fs.writeFileSync(tmpPath, buffer);
  try {
    return await textExtract.extractTextFromFile(tmpPath, ext);
  } finally {
    fs.unlink(tmpPath, () => {});
  }
};

const describeImage = async (buffer, mime) => {
  const dataUrl = `data:${mime || "image/png"};base64,${buffer.toString("base64")}`;
  const result = await llmClient.llmChat({
    model: VISION_MODEL(),
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUrl } },
          { type: "text", text: VISION_PROMPT },
        ],
      },
    ],
    maxTokens: 2048,
    temperature: 0.1,
  });
  return (result.text || "").trim();
};

// Turns one uploaded file into a chat_attachments row (not yet linked to any
// message). Throws a status-422 error with a teacher-facing message for
// anything that can't be used; a supported file that simply yields no text
// (a scanned PDF, a vision-model failure) is still accepted, with `warning`
// set so the panel can say so before the teacher sends it.
async function ingest({ userId, buffer, originalName, mime, width, height }) {
  const name = (originalName || "").trim() || "附件";
  // A nameless paste only has its MIME type to go on.
  const ext = extOf(name) || EXT_BY_IMAGE_MIME[(mime || "").toLowerCase()] || "";
  if (LEGACY_HINTS[ext]) {
    throw userError(`暂不支持旧版 .${ext} 文件，请在 Office/WPS 中另存为 .${LEGACY_HINTS[ext]} 后再上传。`);
  }
  if (!buffer || buffer.length === 0) throw userError("文件为空。");
  if (buffer.length > MAX_UPLOAD_BYTES) throw userError(`文件过大（上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB）。`);

  const isImage = !!IMAGE_MIME_BY_EXT[ext];
  if (!isImage && !DOCUMENT_EXTS.includes(ext)) {
    throw userError(`不支持的文件类型。可上传：${DOCUMENT_EXTS.map((e) => `.${e}`).join("、")}，或图片。`);
  }

  let extractedText = "";
  let warning = null;
  if (isImage) {
    if (buffer.length > MAX_IMAGE_BYTES) throw userError(`图片过大（上限 ${MAX_IMAGE_BYTES / 1024 / 1024}MB）。`);
    try {
      extractedText = await describeImage(buffer, IMAGE_MIME_BY_EXT[ext]);
    } catch (e) {
      console.error("欣欣小助手图片识别失败:", e.message);
      warning = "未能识别图片内容，助手将只知道您上传了一张图片。";
    }
  } else {
    try {
      extractedText = await extractDocumentText(buffer, ext);
    } catch (e) {
      console.error("欣欣小助手附件解析失败:", name, e.message);
    }
    if (!extractedText) warning = "未能从该文件中提取到文字（例如扫描版 PDF），助手将无法阅读其内容。";
  }

  const row = await ChatAttachment.create({
    userId,
    name: name.slice(0, 255),
    mime: isImage ? IMAGE_MIME_BY_EXT[ext] : (mime || "").slice(0, 128) || null,
    size: buffer.length,
    kind: isImage ? "image" : "document",
    extractedText: clip(extractedText, MAX_STORED_CHARS) || null,
    imageData: isImage ? buffer : null,
    width: isImage && Number(width) > 0 ? Number(width) : null,
    height: isImage && Number(height) > 0 ? Number(height) : null,
  });
  return { ...publicMeta(row), chars: extractedText.length, warning };
}

// What the client sees -- never the extracted text (can be huge) or the
// image bytes (served separately, see chat.controller.js#getAttachmentImage).
const publicMeta = (a) => ({
  id: a.id,
  name: a.name,
  kind: a.kind,
  mime: a.mime,
  size: a.size,
  width: a.width,
  height: a.height,
});

const META_ATTRIBUTES = ["id", "messageId", "name", "kind", "mime", "size", "width", "height"];

// Claims the given still-unsent uploads for one just-created user message.
// Only the caller's own, not-yet-linked rows qualify -- anything else (another
// user's id, an id already sent with an earlier message) is a client bug or
// tampering and fails the send rather than being silently dropped.
async function linkToMessage(userId, attachmentIds, messageId, transaction) {
  const ids = [...new Set((attachmentIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) return [];
  const [count] = await ChatAttachment.update(
    { messageId },
    { where: { id: { [Op.in]: ids }, userId, messageId: null }, transaction }
  );
  if (count !== ids.length) throw userError("部分附件已失效，请重新上传。");
  return ChatAttachment.findAll({ where: { id: { [Op.in]: ids } }, attributes: META_ATTRIBUTES, transaction });
}

// Validates ownership up front, before a message row is written -- so a bad
// id fails the send cleanly instead of leaving a half-written turn behind.
async function assertUsable(userId, attachmentIds) {
  const ids = [...new Set((attachmentIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) return;
  const count = await ChatAttachment.count({ where: { id: { [Op.in]: ids }, userId, messageId: null } });
  if (count !== ids.length) throw userError("部分附件已失效，请重新上传。");
}

// messageId -> [attachment] for a batch of messages, extracted text included
// only when asked for (model replay/compaction need it, the panel doesn't).
async function loadForMessages(messageIds, { withText = false, withImage = false } = {}) {
  const map = new Map();
  if (!messageIds || messageIds.length === 0) return map;
  const attributes = [...META_ATTRIBUTES];
  if (withText) attributes.push("extractedText");
  if (withImage) attributes.push("imageData");
  const rows = await ChatAttachment.findAll({
    where: { messageId: { [Op.in]: messageIds } },
    attributes,
    order: [["id", "ASC"]],
  });
  for (const r of rows) {
    if (!map.has(r.messageId)) map.set(r.messageId, []);
    map.get(r.messageId).push(r);
  }
  return map;
}

// The block appended after a user message's own text when it's replayed to
// the model. Delimited explicitly so the model can tell the teacher's words
// from the file's, and so text inside a file reads as material, not as
// instructions from the teacher.
function renderForModel(attachments, { perAttachment = MODEL_CHARS_PER_ATTACHMENT, perTurn = MODEL_CHARS_PER_TURN } = {}) {
  if (!attachments || attachments.length === 0) return "";
  let budget = perTurn;
  const blocks = attachments.map((a) => {
    const label = a.kind === "image" ? "图片" : "文件";
    const text = a.extractedText || "";
    if (!text) return `【附件${label}：${a.name}】（未能提取到内容）`;
    const allowed = Math.max(0, Math.min(perAttachment, budget));
    budget -= Math.min(text.length, allowed);
    if (allowed === 0) return `【附件${label}：${a.name}】（内容过长，本轮未载入）`;
    const body = text.length > allowed ? `${text.slice(0, allowed)}\n……（以下内容过长已截断，共 ${text.length} 字）` : text;
    const intro = a.kind === "image" ? "（以下为图片的文字转写与内容描述）\n" : "";
    return `【附件${label}：${a.name}】\n${intro}${body}\n【附件结束】`;
  });
  return `\n\n${blocks.join("\n\n")}`;
}

module.exports = {
  ingest,
  publicMeta,
  linkToMessage,
  assertUsable,
  loadForMessages,
  renderForModel,
  MAX_UPLOAD_BYTES,
};
