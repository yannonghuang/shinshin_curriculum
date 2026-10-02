// Admin-only access to the generated 教师使用手册 (see teacherManualGenerator.js
// for the actual content) -- #download just streams a freshly-built .docx,
// while #publish additionally files it into 学习资源库 under a 使用指南/教师
// 手册 topic (creating that topic on first use), so both the "download it
// straight from admin" and the "hand it to teachers via the resource
// library they already know" paths stay in sync with the same generator.
//
// 使用指南 is deliberately just an ordinary MaterialTopic category, not a
// special-cased one: per the "学习资源库 is the single source of truth, on
// both thematic topics and system usage, feeding 欣欣助手/AI 点评 alike"
// design, this topic's content is ingested into the knowledge base exactly
// like any other -- see the ingestOne() call below -- and an admin is free
// to file other "how to use the system" topics alongside it under the same
// category (materials-library.component.js only special-cases the *render*
// of this one specific topic, by category+theme, not the category as a
// whole).
const fs = require("fs");
const path = require("path");

const db = require("../models");
const MaterialTopic = db.materialTopic;
const MaterialArtifact = db.materialArtifact;
const { generateTeacherManualBuffer } = require("../services/teacherManualGenerator");
const { getArtifactStorageDirectory } = require("./material-artifact.controller");
const knowledgeIngest = require("../services/knowledgeIngest");
const textExtract = require("../services/textExtract");
const { MANUAL_CATEGORY, MANUAL_THEME, LEGACY_MANUAL_CATEGORY } = require("../constants/materialCategories");

// Renamed from this on 2026-09 ("在线" was misleading -- the download-only
// path exists too, see #download above) -- kept only so #publish can rename
// that one existing topic in place on its next run instead of orphaning it.
const OLD_MANUAL_THEME = "教师在线手册";
const MANUAL_FILENAME = "教师使用手册.docx";
const MANUAL_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// GET /api/admin/teacher-manual/download -- always regenerated on request,
// same "never a stale cached file" contract as template.controller.js#
// downloadBlank.
exports.download = async (req, res) => {
  try {
    const buffer = await generateTeacherManualBuffer();
    res.set({
      "Content-Type": MANUAL_MIME,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(MANUAL_FILENAME)}`,
    });
    return res.send(buffer);
  } catch (err) {
    return res.status(500).send({ message: err.message || "生成教师手册时发生错误。" });
  }
};

// PUT /api/admin/teacher-manual/publish -- regenerates the manual and
// finds-or-creates the 学习资源库 使用指南/教师手册 topic, overwriting (or
// creating, first time) the single MaterialArtifact row that holds it, so
// republishing after a content change updates the same library entry in
// place instead of piling up duplicate files.
exports.publish = async (req, res) => {
  try {
    const buffer = await generateTeacherManualBuffer();

    // Looked up by category+theme, not category alone -- unlike the old
    // 手册-only category this replaced, 使用指南 is shared with whatever other
    // "how to use the system" topics an admin files there by hand, so an
    // exact match is what identifies *this* topic specifically.
    let topic = await MaterialTopic.findOne({ where: { category: MANUAL_CATEGORY, theme: MANUAL_THEME } });
    if (!topic) {
      // Two one-time migrations, checked in order, each renaming the
      // existing topic in place rather than orphaning it or duplicating it:
      //   1. still under the old theme name (教师在线手册 -> 教师手册);
      //   2. still under the even older dedicated 手册 category (see
      //      LEGACY_MANUAL_CATEGORY) from before that existed.
      const renamedTheme = await MaterialTopic.findOne({ where: { category: MANUAL_CATEGORY, theme: OLD_MANUAL_THEME } });
      const legacy =
        renamedTheme || (await MaterialTopic.findOne({ where: { category: LEGACY_MANUAL_CATEGORY, theme: OLD_MANUAL_THEME } }));
      if (legacy) {
        topic = await legacy.update({ category: MANUAL_CATEGORY, theme: MANUAL_THEME });
      } else {
        topic = await MaterialTopic.create({
          category: MANUAL_CATEGORY,
          theme: MANUAL_THEME,
          comment: "系统自动生成的教师使用手册，由「教师手册」管理页面发布/更新。",
        });
      }
    }

    const targetDir = getArtifactStorageDirectory(topic.id, "Word文档");
    const attachmentPath = path.resolve(path.join(targetDir, MANUAL_FILENAME));
    fs.writeFileSync(attachmentPath, buffer);

    let artifact = await MaterialArtifact.findOne({
      where: { materialTopicId: topic.id, attachmentName: MANUAL_FILENAME },
    });
    if (artifact) {
      await artifact.update({
        attachmentPath,
        attachmentMime: MANUAL_MIME,
        attachmentSize: buffer.length,
        type: "docx",
      });
    } else {
      artifact = await MaterialArtifact.create({
        materialTopicId: topic.id,
        folderId: null,
        category: "Word文档",
        description: "系统自动生成的教师使用手册。",
        attachmentPath,
        attachmentName: MANUAL_FILENAME,
        attachmentMime: MANUAL_MIME,
        attachmentSize: buffer.length,
        type: "docx",
      });
    }

    // Same fire-and-forget contract as material-artifact.controller.js#
    // create's own ingestOne -- the file is already safely saved by this
    // point, so the publish response shouldn't hang on extraction/
    // summarization. This is what makes the manual's own content
    // (workflow/button/status wording) answerable by 欣欣助手.
    (async () => {
      try {
        const segments = await textExtract.extractSegmentsFromFile(attachmentPath, "docx");
        await knowledgeIngest.ingestSource({
          sourceType: "material_artifact",
          sourceId: artifact.id,
          materialTopicId: topic.id,
          segments,
        });
        await knowledgeIngest.regenerateSkillCard(topic.id);
      } catch (e) {
        console.error("教师手册知识库摄取失败（不影响手册本身的发布）:", e.message);
      }
    })();

    return res.send({
      message: "教师手册已生成并发布到学习资源库「使用指南 / 教师手册」。",
      materialTopicId: topic.id,
    });
  } catch (err) {
    return res.status(500).send({ message: err.message || "发布教师手册时发生错误。" });
  }
};
