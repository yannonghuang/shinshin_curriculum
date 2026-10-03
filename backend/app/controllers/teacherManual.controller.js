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
// like any other -- see teacherManualPublish.js -- and an admin is free
// to file other "how to use the system" topics alongside it under the same
// category (materials-library.component.js only special-cases the *render*
// of this one specific topic, by category+theme, not the category as a
// whole).
const { generateTeacherManualBuffer } = require("../services/teacherManualGenerator");
const { publishTeacherManual, MANUAL_FILENAME, MANUAL_MIME } = require("../services/teacherManualPublish");

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
// creating, first time) the single MaterialArtifact row that holds it -- see
// teacherManualPublish.js, which server.js also runs at startup to keep an
// already-published manual in step with each deploy.
exports.publish = async (req, res) => {
  try {
    const { topic } = await publishTeacherManual();
    return res.send({
      message: "教师手册已生成并发布到学习资源库「使用指南 / 教师手册」。",
      materialTopicId: topic.id,
    });
  } catch (err) {
    return res.status(500).send({ message: err.message || "发布教师手册时发生错误。" });
  }
};
