const fs = require("fs");
const path = require("path");

const db = require("../models");
const MaterialTopic = db.materialTopic;
const MaterialFolder = db.materialFolder;
const MaterialArtifact = db.materialArtifact;
const MaterialLink = db.materialLink;
const KnowledgeSkill = db.knowledgeSkill;
const Op = db.Sequelize.Op;
const knowledgeIngest = require("../services/knowledgeIngest");
const { searchKnowledgeBase } = require("../services/knowledgeRetrieve");

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

// GET /api/material-topics/search?q= -- searches the same two-tier KB
// (knowledge_skills/knowledge_chunks) the co-pilot and AI review use,
// resolved back to one result per matching topic (best-scoring hit wins when
// a topic has more than one).
exports.search = async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.send([]);

    const hits = await searchKnowledgeBase(q, { limit: 20 });
    const bestHitByTopic = new Map();
    for (const hit of hits) {
      const existing = bestHitByTopic.get(hit.materialTopicId);
      if (!existing || hit.score > existing.score) {
        bestHitByTopic.set(hit.materialTopicId, hit);
      }
    }

    const topicIds = Array.from(bestHitByTopic.keys());
    if (topicIds.length === 0) return res.send([]);

    const topics = await MaterialTopic.findAll({ where: { id: { [Op.in]: topicIds } } });
    const topicsById = new Map(topics.map((t) => [t.id, t]));

    const results = topicIds
      .map((id) => {
        const topic = topicsById.get(id);
        if (!topic) return null; // shouldn't happen (FK cascade keeps these in sync), but don't 500 over it
        const hit = bestHitByTopic.get(id);
        return {
          topicId: id,
          year: topic.year,
          theme: topic.theme,
          tier: hit.tier,
          snippet: (hit.content || hit.title || "").slice(0, 120),
          score: hit.score,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    return res.send(results);
  } catch (err) {
    return res.status(500).send({ message: err.message || "搜索共享学习材料库时发生错误。" });
  }
};

// GET /api/material-topics/:id/skill -- any authenticated role. Returns null
// (not 404) when a topic has no card yet (e.g. DASHSCOPE_API_KEY unset, or
// the LLM call failed at ingest time) -- that's a normal, expected state, not
// an error.
exports.getSkill = async (req, res) => {
  try {
    const topicId = Number(req.params.id);
    if (!Number.isInteger(topicId) || topicId <= 0) {
      return res.status(422).send({ message: "主题 ID 无效。" });
    }
    const skill = await KnowledgeSkill.findOne({ where: { materialTopicId: topicId } });
    return res.send(skill || null);
  } catch (err) {
    return res.status(500).send({ message: err.message || "查询知识卡片时发生错误。" });
  }
};

// PUT /api/material-topics/:id/skill -- admin-only. Always stamps
// sourceType:'admin', reviewed:true -- this is the review/edit action itself,
// so it always counts as "an admin has taken ownership of this card" (see
// knowledgeIngest.js#regenerateSkillCard's own guard against overwriting
// that). Creates the row if none exists yet (e.g. ingestion never produced
// one) rather than 404ing.
exports.updateSkill = async (req, res) => {
  try {
    const topicId = Number(req.params.id);
    if (!Number.isInteger(topicId) || topicId <= 0) {
      return res.status(422).send({ message: "主题 ID 无效。" });
    }
    const topic = await MaterialTopic.findByPk(topicId);
    if (!topic) {
      return res.status(404).send({ message: "主题不存在。" });
    }

    const payload = { sourceType: "admin", reviewed: true };
    if (req.body.title !== undefined) payload.title = req.body.title;
    if (req.body.summary !== undefined) payload.summary = req.body.summary;
    if (req.body.keyPoints !== undefined) payload.keyPoints = req.body.keyPoints;
    if (req.body.tags !== undefined) payload.tags = req.body.tags;

    const existing = await KnowledgeSkill.findOne({ where: { materialTopicId: topicId } });
    if (existing) {
      await existing.update(payload);
    } else {
      await KnowledgeSkill.create({ materialTopicId: topicId, ...payload });
    }
    return res.send({ message: "知识卡片更新成功。" });
  } catch (err) {
    return res.status(500).send({ message: err.message || "更新知识卡片时发生错误。" });
  }
};

// GET /api/material-topics/:id/skill/generating -- any authenticated role,
// polled by the 知识卡片 tab to show "正在由AI生成..." while true. Reflects
// knowledgeIngest.js's generatingCounts, so it's accurate regardless of
// which trigger (基本信息 save, link add/edit, upload, or 强制生成) is
// currently running/queued for this topic -- not just the admin's own
// force-click.
exports.getSkillGenerating = async (req, res) => {
  const topicId = Number(req.params.id);
  if (!Number.isInteger(topicId) || topicId <= 0) {
    return res.status(422).send({ message: "主题 ID 无效。" });
  }
  return res.send({ generating: knowledgeIngest.isGenerating(topicId) });
};

const REGENERATE_SKIP_MESSAGES = {
  no_material: "该主题暂无已提取的材料内容，无法生成知识卡片。请先上传文件或添加链接。",
  not_found: "主题不存在。",
  error: "生成知识卡片时发生错误，请稍后重试。",
  parse_error: "AI 返回内容解析失败，请稍后重试。",
};

// POST /api/material-topics/:id/skill/regenerate -- admin-only. The manual
// "强制生成知识卡片" button on 基本信息: unlike the automatic regeneration
// fired after every save/upload (see knowledgeIngest.js's guards), this
// bypasses both the "already admin-reviewed" and "nothing changed since last
// generation" skips -- that's the whole point of "force." It still goes
// through the same per-topic queue as every other call (knowledgeIngest.js's
// skillCardQueues) so it can't race an auto-regeneration still in flight from
// a just-finished upload, and it's awaited here (unlike the fire-and-forget
// call sites elsewhere) so the admin gets a real success/failure response
// instead of a silent no-op.
exports.forceRegenerateSkill = async (req, res) => {
  try {
    const topicId = Number(req.params.id);
    if (!Number.isInteger(topicId) || topicId <= 0) {
      return res.status(422).send({ message: "主题 ID 无效。" });
    }
    const topic = await MaterialTopic.findByPk(topicId);
    if (!topic) {
      return res.status(404).send({ message: "主题不存在。" });
    }

    const result = await knowledgeIngest.regenerateSkillCard(topicId, { force: true });
    if (!result || !result.ok) {
      const reason = result && result.reason;
      return res.status(422).send({ message: REGENERATE_SKIP_MESSAGES[reason] || "本次未生成新的知识卡片。" });
    }
    return res.send({ message: "知识卡片已重新生成。", skill: result.skill });
  } catch (err) {
    return res.status(500).send({ message: err.message || "生成知识卡片时发生错误。" });
  }
};
