const db = require("../models");
const ShareTopic = db.shareTopic;
const Share = db.share;

const normalizeText = (value) => (typeof value === "string" ? value.trim() : "");

const LOCKED_MESSAGE = "该话题下已有教师分享，不能修改或删除。";

const shareCountsByTopic = async () => {
  const rows = await Share.findAll({
    attributes: ["shareTopicId", [db.Sequelize.fn("COUNT", db.Sequelize.col("id")), "count"]],
    group: ["shareTopicId"],
    raw: true,
  });
  return new Map(rows.map((r) => [String(r.shareTopicId), Number(r.count)]));
};

// GET /api/share-topics -- every 话题, newest first, each with its
// shareCount (the frontend's tree and its "locked" state both come from it).
exports.findAll = async (req, res) => {
  try {
    const [topics, counts] = await Promise.all([ShareTopic.findAll({ order: [["id", "DESC"]] }), shareCountsByTopic()]);
    return res.send(topics.map((t) => ({ ...t.toJSON(), shareCount: counts.get(String(t.id)) || 0 })));
  } catch (err) {
    return res.status(500).send({ message: err.message || "查询分享话题时发生错误。" });
  }
};

// POST /api/share-topics -- admin-only.
exports.create = async (req, res) => {
  try {
    const title = normalizeText(req.body.title);
    if (!title) return res.status(422).send({ message: "话题名称不能为空。" });
    const data = await ShareTopic.create({
      title,
      description: normalizeText(req.body.description) || null,
      createdBy: req.userId,
    });
    return res.send({ ...data.toJSON(), shareCount: 0 });
  } catch (err) {
    return res.status(500).send({ message: err.message || "创建分享话题时发生错误。" });
  }
};

// PUT /api/share-topics/:id -- admin-only, and only while no share exists
// under the topic: a share was written to the topic as worded at the time.
exports.update = async (req, res) => {
  try {
    const topic = await ShareTopic.findByPk(req.params.id);
    if (!topic) return res.status(404).send({ message: "话题不存在。" });
    if ((await Share.count({ where: { shareTopicId: topic.id } })) > 0) {
      return res.status(409).send({ message: LOCKED_MESSAGE });
    }
    const payload = {};
    if (req.body.title !== undefined) {
      const title = normalizeText(req.body.title);
      if (!title) return res.status(422).send({ message: "话题名称不能为空。" });
      payload.title = title;
    }
    if (req.body.description !== undefined) payload.description = normalizeText(req.body.description) || null;
    await topic.update(payload);
    return res.send({ message: "话题已更新。" });
  } catch (err) {
    return res.status(500).send({ message: err.message || "更新分享话题时发生错误。" });
  }
};

// DELETE /api/share-topics/:id -- admin-only, and only while no share
// exists under the topic (shares.share_topic_id is ON DELETE RESTRICT too).
exports.delete = async (req, res) => {
  try {
    const topic = await ShareTopic.findByPk(req.params.id);
    if (!topic) return res.status(404).send({ message: "话题不存在。" });
    if ((await Share.count({ where: { shareTopicId: topic.id } })) > 0) {
      return res.status(409).send({ message: LOCKED_MESSAGE });
    }
    await topic.destroy();
    return res.send({ message: "话题已删除。" });
  } catch (err) {
    return res.status(500).send({ message: err.message || "删除分享话题时发生错误。" });
  }
};
