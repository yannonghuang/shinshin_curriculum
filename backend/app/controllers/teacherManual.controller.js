// Admin-only access to the generated 教师使用手册 (see teacherManualGenerator.js
// for the actual content) -- #download just streams a freshly-built .docx,
// while #publish additionally files it into 学习资源库 under a 手册/教师在线
// 手册 topic (creating that topic on first use), so both the "download it
// straight from admin" and the "hand it to teachers via the resource
// library they already know" paths stay in sync with the same generator.
const fs = require("fs");
const path = require("path");

const db = require("../models");
const MaterialTopic = db.materialTopic;
const MaterialArtifact = db.materialArtifact;
const { generateTeacherManualBuffer } = require("../services/teacherManualGenerator");
const { getArtifactStorageDirectory } = require("./material-artifact.controller");
const { MANUAL_CATEGORY } = require("../constants/materialCategories");

const MANUAL_THEME = "教师在线手册";
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
// finds-or-creates the 学习资源库 手册/教师在线手册 topic, overwriting (or
// creating, first time) the single MaterialArtifact row that holds it, so
// republishing after a content change updates the same library entry in
// place instead of piling up duplicate files.
exports.publish = async (req, res) => {
  try {
    const buffer = await generateTeacherManualBuffer();

    // Looked up by category alone, not category+theme -- MANUAL_CATEGORY is
    // exclusively used by this feature (see materialCategories.js), so this
    // stays correct across a MANUAL_THEME rename too (rather than creating a
    // second, orphaned topic the moment MANUAL_THEME's own literal changes).
    let topic = await MaterialTopic.findOne({ where: { category: MANUAL_CATEGORY } });
    if (!topic) {
      topic = await MaterialTopic.create({
        category: MANUAL_CATEGORY,
        theme: MANUAL_THEME,
        comment: "系统自动生成的教师使用手册，由「教师手册」管理页面发布/更新。",
      });
    } else if (topic.theme !== MANUAL_THEME) {
      await topic.update({ theme: MANUAL_THEME });
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

    // Deliberately no knowledgeIngest.ingestSource/regenerateSkillCard call
    // here -- 手册 topics are UI documentation, not domain material, and
    // must never feed 欣欣助手/AI 点评's retrieval or trigger a 知识卡片
    // summarization. Both would be no-ops anyway (knowledgeIngest.js itself
    // now excludes MANUAL_CATEGORY at its own choke points), but skipping
    // the call here also avoids the wasted textExtract() work on every
    // publish.

    return res.send({
      message: "教师手册已生成并发布到学习资源库「手册 / 教师在线手册」。",
      materialTopicId: topic.id,
    });
  } catch (err) {
    return res.status(500).send({ message: err.message || "发布教师手册时发生错误。" });
  }
};
