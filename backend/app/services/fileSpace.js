const fs = require("fs");
const path = require("path");
const os = require("os");
const childProcess = require("child_process");
const multer = require("multer");
const util = require("util");

const db = require("../models");
const Op = db.Sequelize.Op;

// A generic cloud file space -- folders and files owned by one parent row
// (a 教师分享 share, a 项目管理 project, ...), the endpoint shapes
// lesson-file-manager.component.js drives (same as material-folder.
// controller.js/material-artifact.controller.js, which predate this and
// carry knowledge-base hooks of their own).
//
// createFileSpaceController({...}) returns every folder/file handler for
// one such space:
//   Folder / Artifact / Owner  -- the Sequelize models; Folder and Artifact
//                                 each carry an `ownerKey` column
//   ownerKey                   -- e.g. "shareId"
//   ownerParam                 -- the route param naming the owner, e.g.
//                                 "shareId" in /api/shares/:shareId/folders
//   label                      -- the owner's Chinese name for messages, e.g.
//                                 "分享" ("目标文件夹不存在，或不属于同一分享。")
//   uploadSubdir               -- files live at backend/upload/<uploadSubdir>/
//                                 <ownerId>/<category>/<timestamp>-<name>
//   zipPrefix                  -- download-selection's zip name prefix
//   loadEditableOwner(req, id) -- resolves the owner and checks the caller
//                                 may change it: { owner } or
//                                 { status, message }
// Read access (who may list/download) is the route's own middleware.
//
// Single-space mode: leave out ownerKey/ownerParam/Owner/loadEditableOwner
// and the whole table pair is one app-wide space (项目管理), its files at
// backend/upload/<uploadSubdir>/<category>/...; access is then entirely the
// routes' middleware.

const ARTIFACT_CATEGORIES = ["Word文档", "课件PPT", "图片", "视频"];
const UPLOAD_ROOT = path.join(__dirname, "..", "..", "upload");

const mustConfirm = (value) => value === true || value === "true" || value === "1";

// Undefined -> leave as-is; null/""/"root" -> root of the owner's file
// space; else must be an existing folder id (NaN = invalid).
const normalizeFolderId = (value) => {
  if (value === undefined) return undefined;
  if (value === null || value === "" || value === "root") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : NaN;
};

const removeFile = (filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      console.error("删除附件文件失败:", filePath, e.message);
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

const inferArtifactType = (filename = "") => path.extname(filename).toLowerCase().replace(/^\./, "") || "bin";

// backend/upload/<uploadSubdir>/<ownerId>, or just <uploadSubdir> for a
// single-space controller (no owner).
const ownerDirectory = (uploadSubdir, ownerId) =>
  ownerId == null ? path.join(UPLOAD_ROOT, uploadSubdir) : path.join(UPLOAD_ROOT, uploadSubdir, `${ownerId}`);

// The one "owner" of a single-space controller -- no id, no checks.
const SINGLE_SPACE_OWNER = { owner: { id: null } };

const createFileSpaceController = ({
  Folder,
  Artifact,
  Owner = null,
  ownerKey = null,
  ownerParam = null,
  label = null, // owner spaces only
  uploadSubdir,
  zipPrefix,
  loadEditableOwner = async () => SINGLE_SPACE_OWNER,
}) => {
  const wrongSpaceMessage = ownerKey ? `目标文件夹不存在，或不属于同一${label}。` : "目标文件夹不存在。";

  // WHERE fragment / create attributes pinning a row to its owner ({} for a
  // single space).
  const scope = (ownerId) => (ownerKey ? { [ownerKey]: ownerId } : {});
  const ownerIdOf = (row) => (ownerKey ? row[ownerKey] : null);
  const requestOwnerId = (req) => (ownerParam ? Number(req.params[ownerParam]) : null);

  const folderInOwner = async (folderId, ownerId) => {
    const folder = await Folder.findByPk(folderId);
    return !!folder && (!ownerKey || String(folder[ownerKey]) === String(ownerId));
  };

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

  const moveIntoCategoryDirectory = (ownerId, category, uploadedFile) => {
    const dir = path.join(ownerDirectory(uploadSubdir, ownerId), category);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const targetPath = path.join(dir, path.basename(uploadedFile.path));
    moveFileAtomic(uploadedFile.path, targetPath);
    return path.resolve(targetPath);
  };

  // Multer writes into a staging dir before the owner (and the caller's
  // right to change it) is checked -- the handlers delete the upload on any
  // refusal.
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      // Multipart filenames arrive latin1-decoded; see artifact.controller.js.
      file.originalname = Buffer.from(file.originalname, "latin1").toString("utf8");
      const dir = path.join(UPLOAD_ROOT, uploadSubdir, "_incoming");
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

  const c = {};

  // -------------------------------------------------------------------------
  // Folders

  c.findFolders = async (req, res) => {
    try {
      const data = await Folder.findAll({ where: scope(requestOwnerId(req)), order: [["id", "ASC"]] });
      return res.send(data);
    } catch (err) {
      return res.status(500).send({ message: err.message || "查询文件夹列表时发生错误。" });
    }
  };

  c.createFolder = async (req, res) => {
    try {
      const { owner, status, message } = await loadEditableOwner(req, requestOwnerId(req));
      if (!owner) return res.status(status).send({ message });
      const name = (req.body.name || "").trim();
      if (!name) return res.status(422).send({ message: "文件夹名称不能为空。" });
      const parentFolderId = normalizeFolderId(req.body.parentFolderId);
      if (Number.isNaN(parentFolderId)) return res.status(422).send({ message: "parentFolderId 无效。" });
      if (parentFolderId && !(await folderInOwner(parentFolderId, owner.id))) {
        return res.status(422).send({ message: wrongSpaceMessage });
      }
      const data = await Folder.create({ ...scope(owner.id), parentFolderId: parentFolderId || null, name });
      return res.send(data);
    } catch (err) {
      return res.status(500).send({ message: err.message || "创建文件夹时发生错误。" });
    }
  };

  // Rename and/or move.
  c.updateFolder = async (req, res) => {
    try {
      const folder = await Folder.findByPk(req.params.id);
      if (!folder) return res.status(404).send({ message: `未找到文件夹 id=${req.params.id}。` });
      const { owner, status, message } = await loadEditableOwner(req, ownerIdOf(folder));
      if (!owner) return res.status(status).send({ message });

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
          if (!(await folderInOwner(parentFolderId, owner.id))) {
            return res.status(422).send({ message: wrongSpaceMessage });
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
  c.deleteFolder = async (req, res) => {
    if (!mustConfirm(req.query.confirmDelete)) {
      return res.status(400).send({
        message: "危险操作：将永久删除该文件夹及其中的所有文件和子文件夹。请使用 confirmDelete=true 重新提交。",
      });
    }
    try {
      const folder = await Folder.findByPk(req.params.id);
      if (!folder) return res.status(404).send({ message: `未找到文件夹 id=${req.params.id}。` });
      const { owner, status, message } = await loadEditableOwner(req, ownerIdOf(folder));
      if (!owner) return res.status(status).send({ message });

      const folderIds = await collectFolderIdsInclusive(folder.id);
      const artifacts = await Artifact.findAll({ where: { folderId: { [Op.in]: folderIds } } });
      artifacts.forEach((a) => removeFile(a.attachmentPath));
      if (artifacts.length > 0) await Artifact.destroy({ where: { id: { [Op.in]: artifacts.map((a) => a.id) } } });
      // Folder-to-folder ON DELETE CASCADE removes the descendant folder rows.
      await folder.destroy();
      return res.send({ message: "文件夹删除成功。" });
    } catch (err) {
      return res.status(500).send({ message: err.message || "删除文件夹时发生错误。" });
    }
  };

  // -------------------------------------------------------------------------
  // Files

  c.findArtifacts = async (req, res) => {
    try {
      const data = await Artifact.findAll({ where: scope(requestOwnerId(req)), order: [["id", "DESC"]] });
      return res.send(data);
    } catch (err) {
      return res.status(500).send({ message: err.message || "查询附件列表时发生错误。" });
    }
  };

  c.findArtifact = async (req, res) => {
    try {
      const data = await Artifact.findByPk(req.params.id);
      if (!data) return res.status(404).send({ message: `未找到附件 id=${req.params.id}。` });
      return res.send(data);
    } catch (err) {
      return res.status(500).send({ message: err.message || "查询附件时发生错误。" });
    }
  };

  // Upload: field "file" (one, object response) or "files" (many, array).
  c.createArtifact = async (req, res) => {
    let uploaded = [];
    try {
      await uploadFields(req, res);
      const singleFile = req.files && req.files.file && req.files.file[0];
      uploaded = singleFile ? [singleFile] : (req.files && req.files.files) || [];
      const refuse = (code, message) => {
        uploaded.forEach((f) => removeFile(f.path));
        return res.status(code).send({ message });
      };

      const { owner, status, message } = await loadEditableOwner(req, requestOwnerId(req));
      if (!owner) return refuse(status, message);
      if (uploaded.length === 0) return refuse(422, "请上传附件文件。");
      const { category, description } = req.body;
      if (!ARTIFACT_CATEGORIES.includes(category)) return refuse(422, "附件分类无效，必须是 Word文档/课件PPT/图片/视频 之一。");
      const folderId = normalizeFolderId(req.body.folderId);
      if (Number.isNaN(folderId)) return refuse(422, "folderId 无效。");
      if (folderId && !(await folderInOwner(folderId, owner.id))) return refuse(422, wrongSpaceMessage);

      const created = [];
      for (const file of uploaded) {
        created.push(
          await Artifact.create({
            ...scope(owner.id),
            folderId: folderId || null,
            description,
            category,
            type: inferArtifactType(file.originalname),
            attachmentPath: moveIntoCategoryDirectory(owner.id, category, file),
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
  c.updateArtifact = async (req, res) => {
    let singleFile = null;
    try {
      await uploadFields(req, res);
      singleFile = req.files && req.files.file && req.files.file[0];
      const refuse = (code, message) => {
        if (singleFile) removeFile(singleFile.path);
        return res.status(code).send({ message });
      };

      const artifact = await Artifact.findByPk(req.params.id);
      if (!artifact) return refuse(404, `未找到附件 id=${req.params.id}。`);
      const { owner, status, message } = await loadEditableOwner(req, ownerIdOf(artifact));
      if (!owner) return refuse(status, message);

      const payload = {
        description: req.body.description !== undefined ? req.body.description : artifact.description,
        category: req.body.category !== undefined ? req.body.category : artifact.category,
      };
      if (!ARTIFACT_CATEGORIES.includes(payload.category)) return refuse(422, "附件分类无效，必须是 Word文档/课件PPT/图片/视频 之一。");
      const folderId = normalizeFolderId(req.body.folderId);
      if (Number.isNaN(folderId)) return refuse(422, "folderId 无效。");
      if (folderId !== undefined) {
        if (folderId && !(await folderInOwner(folderId, owner.id))) return refuse(422, wrongSpaceMessage);
        payload.folderId = folderId;
      }

      const oldPath = artifact.attachmentPath;
      if (singleFile) {
        payload.attachmentPath = moveIntoCategoryDirectory(owner.id, payload.category, singleFile);
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

  c.deleteArtifact = async (req, res) => {
    if (!mustConfirm(req.query.confirmDelete)) {
      return res.status(400).send({ message: "危险操作：将永久删除该附件。请使用 confirmDelete=true 重新提交。" });
    }
    try {
      const artifact = await Artifact.findByPk(req.params.id);
      if (!artifact) return res.status(404).send({ message: `未找到附件 id=${req.params.id}。` });
      const { owner, status, message } = await loadEditableOwner(req, ownerIdOf(artifact));
      if (!owner) return res.status(status).send({ message });
      await artifact.destroy();
      removeFile(artifact.attachmentPath);
      return res.send({ message: "附件删除成功。" });
    } catch (err) {
      return res.status(500).send({ message: err.message || "删除附件时发生错误。" });
    }
  };

  c.download = async (req, res) => {
    try {
      const data = await Artifact.findByPk(req.params.id);
      if (!data) return res.status(404).send({ message: `未找到附件 id=${req.params.id}。` });
      if (!fs.existsSync(data.attachmentPath)) return res.status(404).send({ message: "附件文件不存在。" });
      return res.download(data.attachmentPath, data.attachmentName);
    } catch (err) {
      return res.status(500).send({ message: err.message || "下载附件时发生错误。" });
    }
  };

  // Zips a mixed selection of files (artifactIds) and folders (folderIds,
  // recursively), same as material-artifact.controller.js#downloadSelection.
  c.downloadSelection = async (req, res) => {
    let tmpRootDir = null;
    const cleanup = () => {
      if (tmpRootDir && fs.existsSync(tmpRootDir)) {
        try {
          fs.rmSync(tmpRootDir, { recursive: true, force: true });
        } catch (e) {
          console.error("删除打包下载临时目录失败:", tmpRootDir, e.message);
        }
      }
    };
    try {
      const ownerId = requestOwnerId(req);
      if (Owner && !(await Owner.findByPk(ownerId, { attributes: ["id"] }))) return res.status(404).send({ message: `${label}不存在。` });
      const namePrefix = ownerId == null ? zipPrefix : `${zipPrefix}-${ownerId}`;

      const toIdList = (value) => (Array.isArray(value) ? value : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      const artifactIds = toIdList(req.body.artifactIds);
      const folderIds = toIdList(req.body.folderIds);
      if (artifactIds.length === 0 && folderIds.length === 0) return res.status(422).send({ message: "未选择任何文件或文件夹。" });

      const [allFolders, allArtifacts] = await Promise.all([
        Folder.findAll({ where: scope(ownerId), attributes: ["id", "name", "parentFolderId"] }),
        Artifact.findAll({ where: scope(ownerId), attributes: ["id", "folderId", "attachmentName", "attachmentPath"] }),
      ]);
      const selectedFolders = allFolders.filter((f) => folderIds.includes(Number(f.id)));
      if (selectedFolders.length !== folderIds.length) {
        return res.status(422).send({ message: ownerKey ? `部分文件夹不存在，或不属于同一${label}。` : "部分文件夹不存在。" });
      }

      tmpRootDir = fs.mkdtempSync(path.join(os.tmpdir(), `${namePrefix}-selection-`));
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

      const zipName = `${namePrefix}-selection.zip`;
      const zipPath = path.join(tmpRootDir, zipName);
      childProcess.execFileSync("zip", ["-q", "-r", zipPath, "."], { cwd: stagingDir, stdio: "pipe" });
      res.download(zipPath, zipName, (err) => {
        if (err) console.error("打包下载响应失败:", err.message);
        cleanup();
      });
    } catch (err) {
      cleanup();
      return res.status(500).send({ message: err.message || "打包下载所选内容时发生错误。" });
    }
  };

  return c;
};

module.exports = { createFileSpaceController, ownerDirectory, ARTIFACT_CATEGORIES };
