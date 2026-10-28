const fs = require("fs");
const path = require("path");
const os = require("os");
const childProcess = require("child_process");
const multer = require("multer");
const util = require("util");

const db = require("../models");
const ShareFolder = db.shareFolder;
const ShareArtifact = db.shareArtifact;
const Share = db.share;
const Op = db.Sequelize.Op;
const { getShareDirectory, loadEditableShare } = require("../services/teacherShare");

// A share's folders and files -- the endpoints lesson-file-manager.component.js
// drives, same shapes as material-folder.controller.js/material-artifact.
// controller.js, scoped by shareId. Reads are open to every logged-in user;
// every change requires the share's author or an admin (loadEditableShare).
// Unlike 学习资源库, nothing here feeds the knowledge base.

const ARTIFACT_CATEGORIES = ["Word文档", "课件PPT", "图片", "视频"];

const mustConfirm = (value) => value === true || value === "true" || value === "1";

// Undefined -> leave as-is; null/""/"root" -> root of the share's file
// space; else must be an existing folder id (NaN = invalid).
const normalizeFolderId = (value) => {
  if (value === undefined) return undefined;
  if (value === null || value === "" || value === "root") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : NaN;
};

const folderInShare = async (folderId, shareId) => {
  const folder = await ShareFolder.findByPk(folderId);
  return !!folder && String(folder.shareId) === String(shareId);
};

const collectFolderIdsInclusive = async (rootId) => {
  const ids = [rootId];
  let frontier = [rootId];
  while (frontier.length > 0) {
    const children = await ShareFolder.findAll({ where: { parentFolderId: { [Op.in]: frontier } }, attributes: ["id"] });
    frontier = children.map((c) => c.id);
    ids.push(...frontier);
  }
  return ids;
};

const removeFile = (filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      console.error("删除分享附件文件失败:", filePath, e.message);
    }
  }
};

const moveFileAtomic = (fromPath, toPath) => {
  try {
    fs.renameSync(fromPath, toPath);
  } catch (e) {
    if (e && e.code === "EXDEV") {
      fs.copyFileSync(fromPath, toPath);
      fs.unlinkSync(fromPath);
      return;
    }
    throw e;
  }
};

const moveIntoCategoryDirectory = (shareId, category, uploadedFile) => {
  const dir = path.join(getShareDirectory(shareId), category);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const targetPath = path.join(dir, path.basename(uploadedFile.path));
  moveFileAtomic(uploadedFile.path, targetPath);
  return path.resolve(targetPath);
};

const inferArtifactType = (filename = "") => path.extname(filename).toLowerCase().replace(/^\./, "") || "bin";

// Multer writes into a staging dir before the share (and the caller's right
// to change it) is checked -- the handlers delete the upload on any refusal.
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Multipart filenames arrive latin1-decoded; see artifact.controller.js.
    file.originalname = Buffer.from(file.originalname, "latin1").toString("utf8");
    const dir = path.join(`${__dirname}/../../upload`, "Share", "_incoming");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${file.originalname}`),
});
const uploadFields = util.promisify(
  multer({ storage }).fields([
    { name: "file", maxCount: 1 },
    { name: "files", maxCount: 50 },
  ])
);

// ---------------------------------------------------------------------------
// Folders

exports.findFolders = async (req, res) => {
  try {
    const data = await ShareFolder.findAll({ where: { shareId: Number(req.params.shareId) }, order: [["id", "ASC"]] });
    return res.send(data);
  } catch (err) {
    return res.status(500).send({ message: err.message || "查询文件夹列表时发生错误。" });
  }
};

exports.createFolder = async (req, res) => {
  try {
    const { share, status, message } = await loadEditableShare(req, req.params.shareId);
    if (!share) return res.status(status).send({ message });
    const name = (req.body.name || "").trim();
    if (!name) return res.status(422).send({ message: "文件夹名称不能为空。" });
    const parentFolderId = normalizeFolderId(req.body.parentFolderId);
    if (Number.isNaN(parentFolderId)) return res.status(422).send({ message: "parentFolderId 无效。" });
    if (parentFolderId && !(await folderInShare(parentFolderId, share.id))) {
      return res.status(422).send({ message: "目标文件夹不存在，或不属于同一分享。" });
    }
    const data = await ShareFolder.create({ shareId: share.id, parentFolderId: parentFolderId || null, name });
    return res.send(data);
  } catch (err) {
    return res.status(500).send({ message: err.message || "创建文件夹时发生错误。" });
  }
};

// Rename and/or move.
exports.updateFolder = async (req, res) => {
  try {
    const folder = await ShareFolder.findByPk(req.params.id);
    if (!folder) return res.status(404).send({ message: `未找到文件夹 id=${req.params.id}。` });
    const { share, status, message } = await loadEditableShare(req, folder.shareId);
    if (!share) return res.status(status).send({ message });

    const payload = {};
    if (req.body.name !== undefined) {
      const name = (req.body.name || "").trim();
      if (!name) return res.status(422).send({ message: "文件夹名称不能为空。" });
      payload.name = name;
    }
    if (req.body.parentFolderId !== undefined) {
      const parentFolderId = normalizeFolderId(req.body.parentFolderId);
      if (Number.isNaN(parentFolderId)) return res.status(422).send({ message: "parentFolderId 无效。" });
      if (parentFolderId) {
        if (!(await folderInShare(parentFolderId, share.id))) {
          return res.status(422).send({ message: "目标文件夹不存在，或不属于同一分享。" });
        }
        if ((await collectFolderIdsInclusive(folder.id)).includes(parentFolderId)) {
          return res.status(422).send({ message: "不能将文件夹移动到其自身或其子文件夹中。" });
        }
      }
      payload.parentFolderId = parentFolderId || null;
    }
    if (Object.keys(payload).length === 0) return res.status(422).send({ message: "未提供要更新的字段。" });
    await folder.update(payload);
    return res.send({ message: "文件夹更新成功。" });
  } catch (err) {
    return res.status(500).send({ message: err.message || "更新文件夹时发生错误。" });
  }
};

// Recursive: every descendant folder and every file within them.
exports.deleteFolder = async (req, res) => {
  if (!mustConfirm(req.query.confirmDelete)) {
    return res.status(400).send({
      message: "危险操作：将永久删除该文件夹及其中的所有文件和子文件夹。请使用 confirmDelete=true 重新提交。",
    });
  }
  try {
    const folder = await ShareFolder.findByPk(req.params.id);
    if (!folder) return res.status(404).send({ message: `未找到文件夹 id=${req.params.id}。` });
    const { share, status, message } = await loadEditableShare(req, folder.shareId);
    if (!share) return res.status(status).send({ message });

    const folderIds = await collectFolderIdsInclusive(folder.id);
    const artifacts = await ShareArtifact.findAll({ where: { folderId: { [Op.in]: folderIds } } });
    artifacts.forEach((a) => removeFile(a.attachmentPath));
    if (artifacts.length > 0) await ShareArtifact.destroy({ where: { id: { [Op.in]: artifacts.map((a) => a.id) } } });
    // Folder-to-folder ON DELETE CASCADE removes the descendant folder rows.
    await folder.destroy();
    return res.send({ message: "文件夹删除成功。" });
  } catch (err) {
    return res.status(500).send({ message: err.message || "删除文件夹时发生错误。" });
  }
};

// ---------------------------------------------------------------------------
// Files

exports.findArtifacts = async (req, res) => {
  try {
    const data = await ShareArtifact.findAll({ where: { shareId: Number(req.params.shareId) }, order: [["id", "DESC"]] });
    return res.send(data);
  } catch (err) {
    return res.status(500).send({ message: err.message || "查询附件列表时发生错误。" });
  }
};

exports.findArtifact = async (req, res) => {
  try {
    const data = await ShareArtifact.findByPk(req.params.id);
    if (!data) return res.status(404).send({ message: `未找到附件 id=${req.params.id}。` });
    return res.send(data);
  } catch (err) {
    return res.status(500).send({ message: err.message || "查询附件时发生错误。" });
  }
};

// Upload: field "file" (one, object response) or "files" (many, array).
exports.createArtifact = async (req, res) => {
  let uploaded = [];
  try {
    await uploadFields(req, res);
    const singleFile = req.files && req.files.file && req.files.file[0];
    uploaded = singleFile ? [singleFile] : (req.files && req.files.files) || [];
    const refuse = (code, message) => {
      uploaded.forEach((f) => removeFile(f.path));
      return res.status(code).send({ message });
    };

    const { share, status, message } = await loadEditableShare(req, req.params.shareId);
    if (!share) return refuse(status, message);
    if (uploaded.length === 0) return refuse(422, "请上传附件文件。");
    const { category, description } = req.body;
    if (!ARTIFACT_CATEGORIES.includes(category)) return refuse(422, "附件分类无效，必须是 Word文档/课件PPT/图片/视频 之一。");
    const folderId = normalizeFolderId(req.body.folderId);
    if (Number.isNaN(folderId)) return refuse(422, "folderId 无效。");
    if (folderId && !(await folderInShare(folderId, share.id))) return refuse(422, "目标文件夹不存在，或不属于同一分享。");

    const created = [];
    for (const file of uploaded) {
      created.push(
        await ShareArtifact.create({
          shareId: share.id,
          folderId: folderId || null,
          description,
          category,
          type: inferArtifactType(file.originalname),
          attachmentPath: moveIntoCategoryDirectory(share.id, category, file),
          attachmentName: file.originalname,
          attachmentMime: file.mimetype,
          attachmentSize: file.size,
        })
      );
    }
    return res.send(singleFile ? created[0] : created);
  } catch (err) {
    uploaded.forEach((f) => removeFile(f.path));
    return res.status(500).send({ message: err.message || "上传附件时发生错误。" });
  }
};

// Metadata edit, move (folderId), and/or replace the file (field "file").
exports.updateArtifact = async (req, res) => {
  let singleFile = null;
  try {
    await uploadFields(req, res);
    singleFile = req.files && req.files.file && req.files.file[0];
    const refuse = (code, message) => {
      if (singleFile) removeFile(singleFile.path);
      return res.status(code).send({ message });
    };

    const artifact = await ShareArtifact.findByPk(req.params.id);
    if (!artifact) return refuse(404, `未找到附件 id=${req.params.id}。`);
    const { share, status, message } = await loadEditableShare(req, artifact.shareId);
    if (!share) return refuse(status, message);

    const payload = {
      description: req.body.description !== undefined ? req.body.description : artifact.description,
      category: req.body.category !== undefined ? req.body.category : artifact.category,
    };
    if (!ARTIFACT_CATEGORIES.includes(payload.category)) return refuse(422, "附件分类无效，必须是 Word文档/课件PPT/图片/视频 之一。");
    const folderId = normalizeFolderId(req.body.folderId);
    if (Number.isNaN(folderId)) return refuse(422, "folderId 无效。");
    if (folderId !== undefined) {
      if (folderId && !(await folderInShare(folderId, share.id))) return refuse(422, "目标文件夹不存在，或不属于同一分享。");
      payload.folderId = folderId;
    }

    const oldPath = artifact.attachmentPath;
    if (singleFile) {
      payload.attachmentPath = moveIntoCategoryDirectory(share.id, payload.category, singleFile);
      payload.attachmentName = singleFile.originalname;
      payload.attachmentMime = singleFile.mimetype;
      payload.attachmentSize = singleFile.size;
      payload.type = inferArtifactType(singleFile.originalname);
    }
    await artifact.update(payload);
    if (singleFile) removeFile(oldPath);
    return res.send({ message: "附件更新成功。" });
  } catch (err) {
    if (singleFile) removeFile(singleFile.path);
    return res.status(500).send({ message: err.message || "更新附件时发生错误。" });
  }
};

exports.deleteArtifact = async (req, res) => {
  if (!mustConfirm(req.query.confirmDelete)) {
    return res.status(400).send({ message: "危险操作：将永久删除该附件。请使用 confirmDelete=true 重新提交。" });
  }
  try {
    const artifact = await ShareArtifact.findByPk(req.params.id);
    if (!artifact) return res.status(404).send({ message: `未找到附件 id=${req.params.id}。` });
    const { share, status, message } = await loadEditableShare(req, artifact.shareId);
    if (!share) return res.status(status).send({ message });
    await artifact.destroy();
    removeFile(artifact.attachmentPath);
    return res.send({ message: "附件删除成功。" });
  } catch (err) {
    return res.status(500).send({ message: err.message || "删除附件时发生错误。" });
  }
};

// No auth, matching /api/material-artifacts/:id/download -- the file
// manager uses it directly as an <img>/<video> src.
exports.download = async (req, res) => {
  try {
    const data = await ShareArtifact.findByPk(req.params.id);
    if (!data) return res.status(404).send({ message: `未找到附件 id=${req.params.id}。` });
    if (!fs.existsSync(data.attachmentPath)) return res.status(404).send({ message: "附件文件不存在。" });
    return res.download(data.attachmentPath, data.attachmentName);
  } catch (err) {
    return res.status(500).send({ message: err.message || "下载附件时发生错误。" });
  }
};

// Zips a mixed selection of files (artifactIds) and folders (folderIds,
// recursively), same as material-artifact.controller.js#downloadSelection.
exports.downloadSelection = async (req, res) => {
  let tmpRootDir = null;
  const cleanup = () => {
    if (tmpRootDir && fs.existsSync(tmpRootDir)) {
      try {
        fs.rmSync(tmpRootDir, { recursive: true, force: true });
      } catch (e) {
        console.error("删除分享打包下载临时目录失败:", tmpRootDir, e.message);
      }
    }
  };
  try {
    const shareId = Number(req.params.shareId);
    if (!(await Share.findByPk(shareId, { attributes: ["id"] }))) return res.status(404).send({ message: "分享不存在。" });

    const toIdList = (value) => (Array.isArray(value) ? value : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const artifactIds = toIdList(req.body.artifactIds);
    const folderIds = toIdList(req.body.folderIds);
    if (artifactIds.length === 0 && folderIds.length === 0) return res.status(422).send({ message: "未选择任何文件或文件夹。" });

    const [allFolders, allArtifacts] = await Promise.all([
      ShareFolder.findAll({ where: { shareId }, attributes: ["id", "name", "parentFolderId"] }),
      ShareArtifact.findAll({ where: { shareId }, attributes: ["id", "folderId", "attachmentName", "attachmentPath"] }),
    ]);
    const selectedFolders = allFolders.filter((f) => folderIds.includes(Number(f.id)));
    if (selectedFolders.length !== folderIds.length) {
      return res.status(422).send({ message: "部分文件夹不存在，或不属于同一分享。" });
    }

    tmpRootDir = fs.mkdtempSync(path.join(os.tmpdir(), `share-${shareId}-selection-`));
    const stagingDir = path.join(tmpRootDir, "files");
    fs.mkdirSync(stagingDir, { recursive: true });

    let stagedCount = 0;
    const stageFile = (dirPath, artifact) => {
      if (!artifact.attachmentPath || !fs.existsSync(artifact.attachmentPath)) return;
      fs.mkdirSync(dirPath, { recursive: true });
      const safeName = path.basename(artifact.attachmentName || `artifact-${artifact.id}`);
      let target = path.join(dirPath, safeName);
      if (fs.existsSync(target)) target = path.join(dirPath, `${artifact.id}-${safeName}`);
      fs.copyFileSync(artifact.attachmentPath, target);
      stagedCount += 1;
    };
    const stageFolder = (folder, destDir) => {
      let folderDir = path.join(destDir, path.basename(folder.name || "") || `folder-${folder.id}`);
      if (fs.existsSync(folderDir) && !fs.statSync(folderDir).isDirectory()) {
        folderDir = path.join(destDir, `${folder.id}-${path.basename(folder.name || "folder")}`);
      }
      fs.mkdirSync(folderDir, { recursive: true });
      allArtifacts.filter((a) => String(a.folderId) === String(folder.id)).forEach((a) => stageFile(folderDir, a));
      allFolders.filter((f) => String(f.parentFolderId) === String(folder.id)).forEach((child) => stageFolder(child, folderDir));
    };

    selectedFolders.forEach((f) => stageFolder(f, stagingDir));
    allArtifacts.filter((a) => artifactIds.includes(Number(a.id))).forEach((a) => stageFile(stagingDir, a));

    if (stagedCount === 0) {
      cleanup();
      return res.status(404).send({ message: "所选内容中没有可下载的文件。" });
    }

    const zipPath = path.join(tmpRootDir, `share-${shareId}-selection.zip`);
    childProcess.execFileSync("zip", ["-q", "-r", zipPath, "."], { cwd: stagingDir, stdio: "pipe" });
    res.download(zipPath, `share-${shareId}-selection.zip`, (err) => {
      if (err) console.error("分享打包下载响应失败:", err.message);
      cleanup();
    });
  } catch (err) {
    cleanup();
    return res.status(500).send({ message: err.message || "打包下载所选内容时发生错误。" });
  }
};
