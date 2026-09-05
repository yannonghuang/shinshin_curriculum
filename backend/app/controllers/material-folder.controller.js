const fs = require("fs");

const db = require("../models");
const MaterialFolder = db.materialFolder;
const MaterialArtifact = db.materialArtifact;
const MaterialTopic = db.materialTopic;
const Op = db.Sequelize.Op;

const mustConfirm = (value) => value === true || value === "true" || value === "1";

// Undefined -> "leave as-is" (caller decides the default); null/""/"root" -> root
// of that 主题's file space; else must be an existing folder id.
const normalizeParentFolderId = (value) => {
  if (value === undefined) return undefined;
  if (value === null || value === "" || value === "root") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : NaN; // NaN signals "invalid, not just absent"
};

// Every descendant folder id of `rootId` (inclusive) -- see
// folder.controller.js#collectFolderIdsInclusive, same shape.
const collectFolderIdsInclusive = async (rootId) => {
  const ids = [rootId];
  let frontier = [rootId];
  while (frontier.length > 0) {
    const children = await MaterialFolder.findAll({
      where: { parentFolderId: { [Op.in]: frontier } },
      attributes: ["id"],
    });
    frontier = children.map((c) => c.id);
    ids.push(...frontier);
  }
  return ids;
};

// POST /api/material-topics/:topicId/folders -- admin-only (route-gated), so
// unlike folder.controller.js#create there's no per-user ownership check --
// any admin may create a folder in any Theme's material contents.
exports.create = async (req, res) => {
  try {
    const topicId = Number(req.params.topicId);
    if (!Number.isInteger(topicId) || topicId <= 0) {
      return res.status(422).send({ message: "主题 ID 无效。" });
    }

    const name = (req.body.name || "").trim();
    if (!name) {
      return res.status(422).send({ message: "文件夹名称不能为空。" });
    }

    const topic = await MaterialTopic.findByPk(topicId);
    if (!topic) {
      return res.status(404).send({ message: "主题不存在。" });
    }

    const parentFolderId = normalizeParentFolderId(req.body.parentFolderId);
    if (Number.isNaN(parentFolderId)) {
      return res.status(422).send({ message: "parentFolderId 无效。" });
    }
    if (parentFolderId) {
      const parent = await MaterialFolder.findByPk(parentFolderId);
      if (!parent || parent.materialTopicId !== topicId) {
        return res.status(422).send({ message: "目标文件夹不存在，或不属于同一主题的文件空间。" });
      }
    }

    const data = await MaterialFolder.create({
      materialTopicId: topicId,
      parentFolderId: parentFolderId || null,
      name,
    });
    return res.send(data);
  } catch (err) {
    return res.status(500).send({ message: err.message || "创建文件夹时发生错误。" });
  }
};

// GET /api/material-topics/:topicId/folders -- plain array, frontend
// assembles the tree client-side, same as folder.controller.js#findByPlan.
exports.findByTopic = async (req, res) => {
  try {
    const topicId = Number(req.params.topicId);
    if (!Number.isInteger(topicId) || topicId <= 0) {
      return res.status(422).send({ message: "主题 ID 无效。" });
    }
    const data = await MaterialFolder.findAll({ where: { materialTopicId: topicId }, order: [["id", "ASC"]] });
    return res.send(data);
  } catch (err) {
    return res.status(500).send({ message: err.message || "查询文件夹列表时发生错误。" });
  }
};

// PUT /api/material-folders/:id -- rename and/or move, admin-only.
exports.update = async (req, res) => {
  try {
    const folder = await MaterialFolder.findByPk(req.params.id);
    if (!folder) {
      return res.status(404).send({ message: `未找到文件夹 id=${req.params.id}。` });
    }

    const payload = {};

    if (req.body.name !== undefined) {
      const name = (req.body.name || "").trim();
      if (!name) return res.status(422).send({ message: "文件夹名称不能为空。" });
      payload.name = name;
    }

    if (req.body.parentFolderId !== undefined) {
      const parentFolderId = normalizeParentFolderId(req.body.parentFolderId);
      if (Number.isNaN(parentFolderId)) {
        return res.status(422).send({ message: "parentFolderId 无效。" });
      }
      if (parentFolderId) {
        if (parentFolderId === folder.id) {
          return res.status(422).send({ message: "不能将文件夹移动到自身。" });
        }
        const target = await MaterialFolder.findByPk(parentFolderId);
        if (!target || target.materialTopicId !== folder.materialTopicId) {
          return res.status(422).send({ message: "目标文件夹不存在，或不属于同一主题的文件空间。" });
        }
        const descendantIds = await collectFolderIdsInclusive(folder.id);
        if (descendantIds.includes(parentFolderId)) {
          return res.status(422).send({ message: "不能将文件夹移动到其自身的子文件夹中。" });
        }
      }
      payload.parentFolderId = parentFolderId || null;
    }

    if (Object.keys(payload).length === 0) {
      return res.status(422).send({ message: "未提供要更新的字段。" });
    }

    await MaterialFolder.update(payload, { where: { id: folder.id } });
    return res.send({ message: "文件夹更新成功。" });
  } catch (err) {
    return res.status(500).send({ message: err.message || `更新文件夹 id=${req.params.id} 时发生错误。` });
  }
};

// DELETE /api/material-folders/:id?confirmDelete=true -- admin-only,
// recursively removes every descendant folder and every artifact within them
// (row + physical file), same shape as folder.controller.js#delete.
exports.delete = async (req, res) => {
  if (!mustConfirm(req.query.confirmDelete)) {
    return res.status(400).send({
      message: "危险操作：将永久删除该文件夹及其中的所有文件和子文件夹。请使用 confirmDelete=true 重新提交。",
    });
  }

  try {
    const folder = await MaterialFolder.findByPk(req.params.id);
    if (!folder) {
      return res.status(404).send({ message: `未找到文件夹 id=${req.params.id}。` });
    }

    const folderIds = await collectFolderIdsInclusive(folder.id);
    const artifacts = await MaterialArtifact.findAll({ where: { folderId: { [Op.in]: folderIds } } });

    for (const artifact of artifacts) {
      if (artifact.attachmentPath && fs.existsSync(artifact.attachmentPath)) {
        try {
          fs.unlinkSync(artifact.attachmentPath);
        } catch (e) {
          console.error("删除文件夹内附件文件失败:", artifact.attachmentPath, e.message);
        }
      }
    }
    if (artifacts.length > 0) {
      await MaterialArtifact.destroy({ where: { id: { [Op.in]: artifacts.map((a) => a.id) } } });
    }

    // Folder-to-folder ON DELETE CASCADE (see models/index.js) removes every
    // descendant folder row in one go once the top folder is destroyed.
    await MaterialFolder.destroy({ where: { id: folder.id } });

    return res.send({ message: "文件夹删除成功。" });
  } catch (err) {
    return res.status(500).send({ message: err.message || `删除文件夹 id=${req.params.id} 时发生错误。` });
  }
};
