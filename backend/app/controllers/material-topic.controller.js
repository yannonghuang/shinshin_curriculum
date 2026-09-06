const fs = require("fs");
const path = require("path");

const db = require("../models");
const MaterialTopic = db.materialTopic;
const MaterialFolder = db.materialFolder;
const MaterialArtifact = db.materialArtifact;
const MaterialLink = db.materialLink;
const knowledgeIngest = require("../services/knowledgeIngest");

// Knowledge-base chunk text for a topic's own 基本信息 (year/theme/lecturer/
// comment) -- indexed under sourceType 'material_topic_meta' so a question
// like "谁讲过伞饭文化" matches even before any file/link is uploaded under
// the topic.
const topicMetaText = (topic) =>
  `年份：${topic.year}\n主题：${topic.theme}\n主讲人：${topic.lecturer || ""}\n备注：${topic.comment || ""}`;

const mustConfirm = (value) => value === true || value === "true" || value === "1";

// GET /api/material-topics -- one call returns every Theme's 基本信息 so the
// frontend can build the whole Year -> Theme nav tree client-side (grouped by
// `year`) without a separate request per year.
exports.findAll = async (req, res) => {
  try {
    const data = await MaterialTopic.findAll({ order: [["year", "DESC"], ["id", "ASC"]] });
    return res.send(data);
  } catch (err) {
    return res.status(500).send({ message: err.message || "查询共享学习材料库时发生错误。" });
  }
};

exports.findOne = async (req, res) => {
  try {
    const data = await MaterialTopic.findByPk(req.params.id);
    if (!data) {
      return res.status(404).send({ message: `未找到主题 id=${req.params.id}。` });
    }
    return res.send(data);
  } catch (err) {
    return res.status(500).send({ message: err.message || `查询主题 id=${req.params.id} 时发生错误。` });
  }
};

// POST /api/material-topics -- admin-only (route-gated), creates a new
// Theme/主题(Event) directly under its `year` -- year is just a field here,
// not its own table, matching plans.year.
exports.create = async (req, res) => {
  try {
    const year = Number(req.body.year);
    const theme = (req.body.theme || "").trim();
    if (!Number.isInteger(year) || year <= 0) {
      return res.status(422).send({ message: "年份无效。" });
    }
    if (!theme) {
      return res.status(422).send({ message: "主题名称不能为空。" });
    }

    const data = await MaterialTopic.create({
      year,
      theme,
      lecturer: req.body.lecturer || null,
      comment: req.body.comment || null,
    });

    await knowledgeIngest.ingestSource({
      sourceType: "material_topic_meta",
      sourceId: data.id,
      materialTopicId: data.id,
      text: topicMetaText(data),
    });
    await knowledgeIngest.regenerateSkillCard(data.id);

    return res.send(data);
  } catch (err) {
    return res.status(500).send({ message: err.message || "创建主题时发生错误。" });
  }
};

// PUT /api/material-topics/:id -- admin-only, updates 基本信息 fields.
exports.update = async (req, res) => {
  try {
    const data = await MaterialTopic.findByPk(req.params.id);
    if (!data) {
      return res.status(404).send({ message: `未找到主题 id=${req.params.id}。` });
    }

    const payload = {};
    if (req.body.year !== undefined) {
      const year = Number(req.body.year);
      if (!Number.isInteger(year) || year <= 0) {
        return res.status(422).send({ message: "年份无效。" });
      }
      payload.year = year;
    }
    if (req.body.theme !== undefined) {
      const theme = (req.body.theme || "").trim();
      if (!theme) {
        return res.status(422).send({ message: "主题名称不能为空。" });
      }
      payload.theme = theme;
    }
    if (req.body.lecturer !== undefined) payload.lecturer = req.body.lecturer || null;
    if (req.body.comment !== undefined) payload.comment = req.body.comment || null;

    await MaterialTopic.update(payload, { where: { id: data.id } });

    await knowledgeIngest.ingestSource({
      sourceType: "material_topic_meta",
      sourceId: data.id,
      materialTopicId: data.id,
      text: topicMetaText({ ...data.toJSON(), ...payload }),
    });
    await knowledgeIngest.regenerateSkillCard(data.id);

    return res.send({ message: "主题更新成功。" });
  } catch (err) {
    return res.status(500).send({ message: err.message || `更新主题 id=${req.params.id} 时发生错误。` });
  }
};

// DELETE /api/material-topics/:id?confirmDelete=true -- admin-only, cascades
// (via FK ON DELETE CASCADE) to every link/folder row for this topic; every
// artifact's physical file is removed here first, same shape as
// folder.controller.js#delete's own confirm-then-remove flow.
exports.delete = async (req, res) => {
  if (!mustConfirm(req.query.confirmDelete)) {
    return res.status(400).send({
      message: "危险操作：将永久删除该主题及其所有材料内容和链接。请使用 confirmDelete=true 重新提交。",
    });
  }

  try {
    const data = await MaterialTopic.findByPk(req.params.id);
    if (!data) {
      return res.status(404).send({ message: `未找到主题 id=${req.params.id}。` });
    }

    const artifacts = await MaterialArtifact.findAll({ where: { materialTopicId: data.id } });
    for (const artifact of artifacts) {
      if (artifact.attachmentPath && fs.existsSync(artifact.attachmentPath)) {
        try {
          fs.unlinkSync(artifact.attachmentPath);
        } catch (e) {
          console.error("删除主题附件文件失败:", artifact.attachmentPath, e.message);
        }
      }
    }

    const topicDir = path.join(`${__dirname}/../../upload`, "MaterialTopic", `${data.id}`);
    if (fs.existsSync(topicDir)) {
      try {
        fs.rmSync(topicDir, { recursive: true, force: true });
      } catch (e) {
        console.error("删除主题上传目录失败:", topicDir, e.message);
      }
    }

    // No explicit knowledge_chunks/knowledge_skills cleanup needed here --
    // unlike source_id (polymorphic, points at whichever table sourceType
    // names), material_topic_id on both tables is a real FK with ON DELETE
    // CASCADE (see the migration), so this one delete already removes every
    // chunk and the skill card for this topic regardless of source_type.
    await MaterialTopic.destroy({ where: { id: data.id } });
    return res.send({ message: "主题删除成功。" });
  } catch (err) {
    return res.status(500).send({ message: err.message || `删除主题 id=${req.params.id} 时发生错误。` });
  }
};
