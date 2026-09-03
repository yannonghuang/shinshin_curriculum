const fs = require("fs");

const db = require("../models");
const Folder = db.folder;
const Artifact = db.artifact;
const Plan = db.plan;
const Op = db.Sequelize.Op;

const mustConfirm = (value) => value === true || value === "true" || value === "1";

const normalizeLessonIndex = (lessonIndex) => {
  const n = Number(lessonIndex);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// Undefined -> "leave as-is" (caller decides the default); null/""/"root" -> root
// of that 课时's file space; else must be an existing folder id.
const normalizeParentFolderId = (value) => {
  if (value === undefined) return undefined;
  if (value === null || value === "" || value === "root") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : NaN; // NaN signals "invalid, not just absent"
};

// Every descendant folder id of `rootId` (inclusive), via repeated
// level-by-level queries rather than a recursive CTE -- folder trees here are
// expected to stay small (a single 课时's file space), and this keeps the
// query portable/simple to reason about, matching the rest of this codebase's
// preference for plain JS traversal over DB-side recursion.
const collectFolderIdsInclusive = async (rootId) => {
  const ids = [rootId];
  let frontier = [rootId];
  while (frontier.length > 0) {
    const children = await Folder.findAll({ where: { parentFolderId: { [Op.in]: frontier } }, attributes: ["id"] });
    frontier = children.map((c) => c.id);
    ids.push(...frontier);
  }
  return ids;
};

const loadOwnedFolder = async (id, userId) => {
  const folder = await Folder.findByPk(id);
  if (!folder) return { error: { status: 404, message: `未找到文件夹 id=${id}。` } };
  const plan = await Plan.findByPk(folder.planId);
  if (!plan || plan.teacherId !== userId) {
    return { error: { status: 403, message: "只能操作本人创建的乡土课程设计中的文件夹。" } };
  }
  return { folder, plan };
};

// POST /api/plans/:planId/folders
exports.create = async (req, res) => {
  try {
    const planId = Number(req.params.planId);
    if (!Number.isInteger(planId) || planId <= 0) {
      return res.status(422).send({ message: "乡土课程设计 ID 无效。" });
    }

    const lessonIndex = normalizeLessonIndex(req.body.lessonIndex);
    if (!lessonIndex) {
      return res.status(422).send({ message: "lessonIndex 无效 -- 文件夹只能创建在某一课时的文件空间中。" });
    }

    const name = (req.body.name || "").trim();
    if (!name) {
      return res.status(422).send({ message: "文件夹名称不能为空。" });
    }

    const plan = await Plan.findByPk(planId);
    if (!plan) {
      return res.status(404).send({ message: "乡土课程设计不存在。" });
    }
    if (plan.teacherId !== req.userId) {
      return res.status(403).send({ message: "只能为本人创建的乡土课程设计新建文件夹。" });
    }

    const parentFolderId = normalizeParentFolderId(req.body.parentFolderId);
    if (Number.isNaN(parentFolderId)) {
      return res.status(422).send({ message: "parentFolderId 无效。" });
    }
    if (parentFolderId) {
      const parent = await Folder.findByPk(parentFolderId);
      if (!parent || parent.planId !== planId || parent.lessonIndex !== lessonIndex) {
        return res.status(422).send({ message: "目标文件夹不存在，或不属于同一课时的文件空间。" });
      }
    }

    const data = await Folder.create({ planId, lessonIndex, parentFolderId: parentFolderId || null, name });
    return res.send(data);
  } catch (err) {
    return res.status(500).send({ message: err.message || "创建文件夹时发生错误。" });
  }
};

// GET /api/plans/:planId/folders?lessonIndex=N
// Plain array, like artifact.controller.js#findByPlan -- a flat list the
// frontend assembles into a tree client-side (folder counts per 课时 are
// small, no pagination contract needed).
exports.findByPlan = async (req, res) => {
  try {
    const planId = Number(req.params.planId);
    if (!Number.isInteger(planId) || planId <= 0) {
      return res.status(422).send({ message: "乡土课程设计 ID 无效。" });
    }

    const where = { planId };
    const lessonIndex = normalizeLessonIndex(req.query.lessonIndex);
    if (!lessonIndex) {
      return res.status(422).send({ message: "lessonIndex 无效。" });
    }
    where.lessonIndex = lessonIndex;

    const data = await Folder.findAll({ where, order: [["id", "ASC"]] });
    return res.send(data);
  } catch (err) {
    return res.status(500).send({ message: err.message || "查询文件夹列表时发生错误。" });
  }
};

// PUT /api/folders/:id -- rename (name) and/or move (parentFolderId), either
// or both in one request.
exports.update = async (req, res) => {
  try {
    const { folder, error } = await loadOwnedFolder(req.params.id, req.userId);
    if (error) return res.status(error.status).send({ message: error.message });

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
        const target = await Folder.findByPk(parentFolderId);
        if (!target || target.planId !== folder.planId || target.lessonIndex !== folder.lessonIndex) {
          return res.status(422).send({ message: "目标文件夹不存在，或不属于同一课时的文件空间。" });
        }
        // Cycle check: the target can't be one of this folder's own descendants.
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

    await Folder.update(payload, { where: { id: folder.id } });
    return res.send({ message: "文件夹更新成功。" });
  } catch (err) {
    return res.status(500).send({ message: err.message || `更新文件夹 id=${req.params.id} 时发生错误。` });
  }
};

// DELETE /api/folders/:id?confirmDelete=true -- recursively removes every
// descendant folder and every artifact within them (row + physical file),
// mirroring artifact.controller.js#delete's own confirm-then-remove shape.
exports.delete = async (req, res) => {
  if (!mustConfirm(req.query.confirmDelete)) {
    return res.status(400).send({
      message: "危险操作：将永久删除该文件夹及其中的所有文件和子文件夹。请使用 confirmDelete=true 重新提交。",
    });
  }

  try {
    const { folder, error } = await loadOwnedFolder(req.params.id, req.userId);
    if (error) return res.status(error.status).send({ message: error.message });

    const folderIds = await collectFolderIdsInclusive(folder.id);
    const artifacts = await Artifact.findAll({ where: { folderId: { [Op.in]: folderIds } } });

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
      await Artifact.destroy({ where: { id: { [Op.in]: artifacts.map((a) => a.id) } } });
    }

    // Folder-to-folder ON DELETE CASCADE (see models/index.js) removes every
    // descendant folder row in one go once the top folder is destroyed.
    await Folder.destroy({ where: { id: folder.id } });

    return res.send({ message: "文件夹删除成功。" });
  } catch (err) {
    return res.status(500).send({ message: err.message || `删除文件夹 id=${req.params.id} 时发生错误。` });
  }
};
