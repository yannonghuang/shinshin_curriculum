const db = require("../models");
const MaterialLink = db.materialLink;
const MaterialTopic = db.materialTopic;

// GET /api/material-topics/:topicId/links
exports.findByTopic = async (req, res) => {
  try {
    const topicId = Number(req.params.topicId);
    if (!Number.isInteger(topicId) || topicId <= 0) {
      return res.status(422).send({ message: "主题 ID 无效。" });
    }
    const data = await MaterialLink.findAll({ where: { materialTopicId: topicId }, order: [["id", "ASC"]] });
    return res.send(data);
  } catch (err) {
    return res.status(500).send({ message: err.message || "查询材料链接时发生错误。" });
  }
};

// POST /api/material-topics/:topicId/links -- admin-only (route-gated)
exports.create = async (req, res) => {
  try {
    const topicId = Number(req.params.topicId);
    if (!Number.isInteger(topicId) || topicId <= 0) {
      return res.status(422).send({ message: "主题 ID 无效。" });
    }
    const url = (req.body.url || "").trim();
    if (!url) {
      return res.status(422).send({ message: "链接地址不能为空。" });
    }

    const topic = await MaterialTopic.findByPk(topicId);
    if (!topic) {
      return res.status(404).send({ message: "主题不存在。" });
    }

    const data = await MaterialLink.create({
      materialTopicId: topicId,
      description: req.body.description || null,
      url,
    });
    return res.send(data);
  } catch (err) {
    return res.status(500).send({ message: err.message || "创建材料链接时发生错误。" });
  }
};

// PUT /api/material-links/:id -- admin-only
exports.update = async (req, res) => {
  try {
    const data = await MaterialLink.findByPk(req.params.id);
    if (!data) {
      return res.status(404).send({ message: `未找到链接 id=${req.params.id}。` });
    }

    const payload = {};
    if (req.body.description !== undefined) payload.description = req.body.description || null;
    if (req.body.url !== undefined) {
      const url = (req.body.url || "").trim();
      if (!url) {
        return res.status(422).send({ message: "链接地址不能为空。" });
      }
      payload.url = url;
    }

    await MaterialLink.update(payload, { where: { id: data.id } });
    return res.send({ message: "链接更新成功。" });
  } catch (err) {
    return res.status(500).send({ message: err.message || `更新链接 id=${req.params.id} 时发生错误。` });
  }
};

// DELETE /api/material-links/:id -- admin-only
exports.delete = async (req, res) => {
  try {
    const data = await MaterialLink.findByPk(req.params.id);
    if (!data) {
      return res.status(404).send({ message: `未找到链接 id=${req.params.id}。` });
    }
    await MaterialLink.destroy({ where: { id: data.id } });
    return res.send({ message: "链接删除成功。" });
  } catch (err) {
    return res.status(500).send({ message: err.message || `删除链接 id=${req.params.id} 时发生错误。` });
  }
};
