const fs = require("fs");
const path = require("path");

const db = require("../models");
const { authJwt } = require("../middleware");

// 教师分享's shared rules, used by share.controller.js and share-file.
// controller.js alike: anyone logged in reads; a share's author or an admin
// changes it (the share itself, its folders and its files).

// backend/upload/Share/<shareId>/<category>/<timestamp>-<name>
const getShareDirectory = (shareId) => {
  const dir = path.join(`${__dirname}/../../upload`, "Share", `${shareId}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const canEditShare = async (req, share) =>
  String(share.authorId) === String(req.userId) || (await authJwt.hasAdminRole(req));

// Resolves the share and checks the caller may change it. Returns { share }
// or { status, message } for the handler to send as-is.
const loadEditableShare = async (req, shareId) => {
  const id = Number(shareId);
  if (!Number.isInteger(id) || id <= 0) return { status: 422, message: "分享 ID 无效。" };
  const share = await db.share.findByPk(id);
  if (!share) return { status: 404, message: "分享不存在。" };
  if (!(await canEditShare(req, share))) return { status: 403, message: "只有分享的作者或管理员可以修改此分享。" };
  return { share };
};

// Removes a share's every physical file and its upload directory, then the
// row -- folder/artifact rows go with it via FK ON DELETE CASCADE.
const deleteShareRecord = async (share) => {
  const artifacts = await db.shareArtifact.findAll({ where: { shareId: share.id }, attributes: ["attachmentPath"] });
  for (const a of artifacts) {
    if (a.attachmentPath && fs.existsSync(a.attachmentPath)) {
      try {
        fs.unlinkSync(a.attachmentPath);
      } catch (e) {
        console.error("删除分享附件文件失败:", a.attachmentPath, e.message);
      }
    }
  }
  const dir = path.join(`${__dirname}/../../upload`, "Share", `${share.id}`);
  if (fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      console.error("删除分享上传目录失败:", dir, e.message);
    }
  }
  await db.share.destroy({ where: { id: share.id } });
};

module.exports = { getShareDirectory, canEditShare, loadEditableShare, deleteShareRecord };
