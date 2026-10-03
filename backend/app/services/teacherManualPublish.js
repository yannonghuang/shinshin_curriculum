const fs = require("fs");
const path = require("path");

const db = require("../models");
const MaterialTopic = db.materialTopic;
const MaterialArtifact = db.materialArtifact;
const { generateTeacherManualBuffer } = require("./teacherManualGenerator");
const knowledgeIngest = require("./knowledgeIngest");
const textExtract = require("./textExtract");
const { MANUAL_CATEGORY, MANUAL_THEME, LEGACY_MANUAL_CATEGORY } = require("../constants/materialCategories");

// Files the generated 教师使用手册 into 学习资源库 使用指南/教师手册 and the
// knowledge base -- shared by the admin 发布 button
// (teacherManual.controller.js#publish) and the startup sync below.
// Lazy-required: material-artifact.controller.js pulls in the whole
// controller stack, which this service shouldn't load at require time.
const getArtifactStorageDirectory = (...args) =>
  require("../controllers/material-artifact.controller").getArtifactStorageDirectory(...args);

// Renamed from this on 2026-09 ("在线" was misleading -- the download-only
// path exists too) -- kept only so publish can rename that one existing
// topic in place on its next run instead of orphaning it.
const OLD_MANUAL_THEME = "教师在线手册";
const MANUAL_FILENAME = "教师使用手册.docx";
const MANUAL_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Looked up by category+theme, not category alone -- 使用指南 is shared with
// whatever other "how to use the system" topics an admin files there by
// hand, so an exact match is what identifies *this* topic specifically.
const findManualTopic = () => MaterialTopic.findOne({ where: { category: MANUAL_CATEGORY, theme: MANUAL_THEME } });

const findOrCreateManualTopic = async () => {
  const topic = await findManualTopic();
  if (topic) return topic;
  // Two one-time migrations, checked in order, each renaming the existing
  // topic in place rather than orphaning it or duplicating it:
  //   1. still under the old theme name (教师在线手册 -> 教师手册);
  //   2. still under the even older dedicated 手册 category (see
  //      LEGACY_MANUAL_CATEGORY) from before that existed.
  const renamedTheme = await MaterialTopic.findOne({ where: { category: MANUAL_CATEGORY, theme: OLD_MANUAL_THEME } });
  const legacy =
    renamedTheme || (await MaterialTopic.findOne({ where: { category: LEGACY_MANUAL_CATEGORY, theme: OLD_MANUAL_THEME } }));
  if (legacy) return legacy.update({ category: MANUAL_CATEGORY, theme: MANUAL_THEME });
  return MaterialTopic.create({
    category: MANUAL_CATEGORY,
    theme: MANUAL_THEME,
    comment: "系统自动生成的教师使用手册，由「教师手册」管理页面发布/更新。",
  });
};

// Regenerates the manual and overwrites (or creates, first time) the single
// MaterialArtifact row that holds it, so republishing updates the same
// library entry in place instead of piling up duplicate files. Knowledge-base
// ingestion runs in the background -- the file is already saved by then, so
// the caller needn't wait on extraction/summarization. That ingestion is what
// makes the manual's wording answerable by 欣欣小助手.
async function publishTeacherManual({ buffer } = {}) {
  const manual = buffer || (await generateTeacherManualBuffer());
  const topic = await findOrCreateManualTopic();

  const targetDir = getArtifactStorageDirectory(topic.id, "Word文档");
  const attachmentPath = path.resolve(path.join(targetDir, MANUAL_FILENAME));
  fs.writeFileSync(attachmentPath, manual);

  let artifact = await MaterialArtifact.findOne({ where: { materialTopicId: topic.id, attachmentName: MANUAL_FILENAME } });
  if (artifact) {
    await artifact.update({ attachmentPath, attachmentMime: MANUAL_MIME, attachmentSize: manual.length, type: "docx" });
  } else {
    artifact = await MaterialArtifact.create({
      materialTopicId: topic.id,
      folderId: null,
      category: "Word文档",
      description: "系统自动生成的教师使用手册。",
      attachmentPath,
      attachmentName: MANUAL_FILENAME,
      attachmentMime: MANUAL_MIME,
      attachmentSize: manual.length,
      type: "docx",
    });
  }

  (async () => {
    try {
      const segments = await textExtract.extractSegmentsFromFile(attachmentPath, "docx");
      await knowledgeIngest.ingestSource({ sourceType: "material_artifact", sourceId: artifact.id, materialTopicId: topic.id, segments });
      await knowledgeIngest.regenerateSkillCard(topic.id);
    } catch (e) {
      console.error("教师手册知识库摄取失败（不影响手册本身的发布）:", e.message);
    }
  })();

  return { topic, artifact };
}

// Run once at server startup: the manual's text lives in code
// (teacherManualGenerator.js), but 欣欣小助手 reads the *published* copy in the
// knowledge base -- which used to change only when an admin remembered to
// click 发布 after a deploy, so the assistant could go on answering from a
// manual that predates the features it was asked about. Compared by
// extracted text, not bytes (every generated .docx differs in its embedded
// timestamps); screenshot-only changes don't matter to the knowledge base.
// Only an already-published manual is kept in sync -- whether teachers get
// one in 学习资源库 at all stays the admin's first 发布.
async function syncPublishedTeacherManual() {
  const topic = await findManualTopic();
  if (!topic) return { updated: false, reason: "not_published" };
  const artifact = await MaterialArtifact.findOne({ where: { materialTopicId: topic.id, attachmentName: MANUAL_FILENAME } });
  if (!artifact) return { updated: false, reason: "not_published" };

  const buffer = await generateTeacherManualBuffer();
  const freshText = await textExtract.extractDocxTextFromBuffer(buffer);
  let publishedText = "";
  try {
    publishedText = await textExtract.extractDocxText(artifact.attachmentPath);
  } catch (e) {
    // Missing/unreadable file -- republishing restores it.
  }
  if (publishedText === freshText) return { updated: false, reason: "unchanged" };

  await publishTeacherManual({ buffer });
  return { updated: true };
}

module.exports = { publishTeacherManual, syncPublishedTeacherManual, MANUAL_FILENAME, MANUAL_MIME };
