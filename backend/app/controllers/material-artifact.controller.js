const fs = require("fs");
const path = require("path");
const os = require("os");
const childProcess = require("child_process");
const multer = require("multer");
const util = require("util");

const db = require("../models");
const MaterialArtifact = db.materialArtifact;
const MaterialTopic = db.materialTopic;
const MaterialFolder = db.materialFolder;
const Op = db.Sequelize.Op;
const textExtract = require("../services/textExtract");
const knowledgeIngest = require("../services/knowledgeIngest");

// Word/PPT (and anything else filed under "Word文档" -- notably .pdf, which
// has no category of its own; see lesson-file-manager.component.js's
// inferCategoryFromFilename) get their real content extracted for the
// knowledge base; 图片/视频 have no text-extractable content (no OCR/vision
// model in this pipeline -- see review.controller.js's own precedent of the
// same tiering), so they contribute a metadata-only chunk instead
// (description + filename) rather than nothing at all.
const KB_EXTRACTABLE_CATEGORIES = ["Word文档", "课件PPT"];

// Defense-in-depth backstop, not the primary safety mechanism anymore --
// textExtract.js's PDF extraction now shells out to mutool (native MuPDF)
// rather than a JS PDF library, after a real 4.96MB image-heavy report
// measured ~800MB RSS / 8-17s through the old pdfjs-dist-based path and
// triggered a host-wide kernel OOM-kill on the small prod VM; the identical
// file through mutool is ~48MB peak / ~0.2s (see textExtract.js's header
// comment). This cap just guards against a genuinely oversized/pathological
// file still costing more than it should, falling back to the same
// metadata-only chunk 图片/视频 already get rather than nothing at all.
const PDF_MAX_EXTRACT_BYTES = 50 * 1024 * 1024;

const artifactKnowledgeText = async (attachmentPath, type, category, description, filename) => {
  const metaFallback = () => `${description || ""}\n${filename}`.trim();
  if (KB_EXTRACTABLE_CATEGORIES.includes(category)) {
    if (type === "pdf" && fs.statSync(attachmentPath).size > PDF_MAX_EXTRACT_BYTES) {
      return metaFallback();
    }
    return textExtract.extractTextFromFile(attachmentPath, type);
  }
  return metaFallback();
};

const ARTIFACT_CATEGORIES = ["Word文档", "课件PPT", "图片", "视频"];
const BULK_MAX_ZIP_BYTES = Number(process.env.MATERIAL_BULK_ZIP_MAX_BYTES || 1024 * 1024 * 1024); // 1GB default
const BULK_MAX_FILE_BYTES = Number(process.env.MATERIAL_BULK_FILE_MAX_BYTES || 512 * 1024 * 1024); // 512MB default
const BULK_DB_BATCH_SIZE = Number(process.env.MATERIAL_BULK_DB_BATCH_SIZE || 100);
const BULK_SKIPPED_REPORT_LIMIT = Number(process.env.MATERIAL_BULK_SKIPPED_REPORT_LIMIT || 200);

const mustConfirm = (value) => value === true || value === "true" || value === "1";

// backend/upload/MaterialTopic/<topicId>/<category>/<timestamp>-<name>
const getTopicDirectory = (topicId) => {
  const dir = path.join(`${__dirname}/../../upload`, "MaterialTopic", `${topicId}`);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
};

// Undefined -> "leave as-is" (caller decides the default); null/""/"root" ->
// root of that 主题's file space; else must be an existing folder id.
const normalizeFolderId = (value) => {
  if (value === undefined) return undefined;
  if (value === null || value === "" || value === "root") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : NaN;
};

// Validates folderId (if not null) belongs to the same topic the artifact
// is/will be filed under.
const validateFolderId = async (folderId, topicId) => {
  if (!folderId) return null;
  const folder = await MaterialFolder.findByPk(folderId);
  if (!folder || folder.materialTopicId !== topicId) {
    return "目标文件夹不存在，或不属于同一主题的文件空间。";
  }
  return null;
};

const getArtifactStorageDirectory = (topicId, category) => {
  const dir = path.join(getTopicDirectory(topicId), category);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
};

const moveIntoArtifactDirectory = (topicId, category, uploadedFile) => {
  const targetDir = getArtifactStorageDirectory(topicId, category);
  const targetPath = path.join(targetDir, path.basename(uploadedFile.path));
  moveFileAtomic(uploadedFile.path, targetPath);
  return path.resolve(targetPath);
};

// See artifact.controller.js's own fixOriginalNameEncoding for why this is
// needed -- multipart filenames arrive latin1-decoded by busboy/multer even
// though browsers send UTF-8.
const fixOriginalNameEncoding = (file) => {
  file.originalname = Buffer.from(file.originalname, "latin1").toString("utf8");
};

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    fixOriginalNameEncoding(file);
    const topicId = req.params.topicId || req.body.materialTopicId;
    cb(null, getTopicDirectory(topicId));
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

const uploadFields = util.promisify(
  multer({ storage }).fields([
    { name: "file", maxCount: 1 },
    { name: "files", maxCount: 50 },
  ])
);
const uploadBulkZip = util.promisify(
  multer({
    storage,
    limits: { fileSize: BULK_MAX_ZIP_BYTES },
  }).single("file")
);

const inferArtifactType = (filename = "") => {
  const ext = path.extname(filename).toLowerCase().replace(/^\./, "");
  return ext || "bin";
};

const inferMime = (filename = "") => {
  const ext = path.extname(filename).toLowerCase();
  if ([".jpg", ".jpeg"].includes(ext)) return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".doc") return "application/msword";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".ppt") return "application/vnd.ms-powerpoint";
  if (ext === ".pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if ([".mp4", ".m4v"].includes(ext)) return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".ogg") return "audio/ogg";
  return "application/octet-stream";
};

const listFilesRecursively = (rootDir) => {
  const files = [];
  if (!fs.existsSync(rootDir)) return files;

  const walk = (currentDir) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else files.push(fullPath);
    }
  };

  walk(rootDir);
  return files;
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

const resolveCategoryFromPathParts = (parts) => {
  for (let i = 0; i < parts.length; i += 1) {
    if (ARTIFACT_CATEGORIES.includes(parts[i])) {
      return { category: parts[i], categoryIndex: i };
    }
  }
  return { category: null, categoryIndex: -1 };
};

// POST /api/material-topics/:topicId/artifacts -- admin-only (route-gated).
exports.create = async (req, res) => {
  try {
    await uploadFields(req, res);

    const topicId = Number(req.params.topicId);
    const { description, category } = req.body;

    if (!Number.isInteger(topicId) || topicId <= 0) {
      return res.status(422).send({ message: "主题 ID 无效。" });
    }
    if (!ARTIFACT_CATEGORIES.includes(category)) {
      return res.status(422).send({
        message: "附件分类无效，必须是 Word文档/课件PPT/图片/视频 之一。",
      });
    }

    const folderId = normalizeFolderId(req.body.folderId);
    if (Number.isNaN(folderId)) {
      return res.status(422).send({ message: "folderId 无效。" });
    }

    const singleFile = req.files && req.files.file && req.files.file[0];
    const multiFiles = req.files && req.files.files ? req.files.files : [];

    if (!singleFile && multiFiles.length === 0) {
      return res.status(422).send({ message: "请上传附件文件。" });
    }

    const topic = await MaterialTopic.findByPk(topicId);
    if (!topic) {
      if (singleFile && fs.existsSync(singleFile.path)) fs.unlinkSync(singleFile.path);
      for (const f of multiFiles) {
        if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
      }
      return res.status(404).send({ message: "主题不存在。" });
    }

    if (folderId) {
      const folderError = await validateFolderId(folderId, topicId);
      if (folderError) {
        if (singleFile && fs.existsSync(singleFile.path)) fs.unlinkSync(singleFile.path);
        for (const f of multiFiles) {
          if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
        }
        return res.status(422).send({ message: folderError });
      }
    }

    const createOne = async (file) => {
      const attachmentPath = moveIntoArtifactDirectory(topicId, category, file);
      const type = inferArtifactType(file.originalname);
      const created = await MaterialArtifact.create({
        materialTopicId: topicId,
        folderId: folderId || null,
        description,
        category,
        type,
        attachmentPath,
        attachmentName: file.originalname,
        attachmentMime: file.mimetype,
        attachmentSize: file.size,
      });
      return created;
    };

    // Extraction (especially a real-world PDF -- see textExtract.js, and the
    // prod incident that motivated its timeout/memory guards) is the one
    // part of this request that can run long and CPU-heavy. Deliberately not
    // awaited before responding: the file is already safely saved by this
    // point, so an upload should never appear to hang on it, and other
    // requests shouldn't sit blocked behind this container's event loop
    // while it runs. Swallows its own errors -- same best-effort contract
    // knowledgeIngest itself already has -- since there's no response left
    // to report a failure on; it just means this file's content isn't
    // searchable yet.
    const ingestOne = async (created, file) => {
      try {
        const text = await artifactKnowledgeText(created.attachmentPath, created.type, category, description, file.originalname);
        await knowledgeIngest.ingestSource({
          sourceType: "material_artifact",
          sourceId: created.id,
          materialTopicId: topicId,
          text,
        });
      } catch (e) {
        console.error("附件知识库摄取失败（不影响附件本身的保存）:", e.message);
      }
    };

    // Single-file upload (field name "file") keeps the single-object response
    // shape; multi-drag upload (field name "files") returns an array. Skill
    // card regenerated once after every file in this request, not per-file --
    // an N-file drop shouldn't trigger N redundant LLM summarization calls.
    if (singleFile) {
      const data = await createOne(singleFile);
      res.send(data);
      ingestOne(data, singleFile).then(() => knowledgeIngest.regenerateSkillCard(topicId));
      return;
    }

    const created = [];
    for (const file of multiFiles) {
      created.push(await createOne(file));
    }
    res.send(created);
    (async () => {
      for (let i = 0; i < created.length; i++) {
        await ingestOne(created[i], multiFiles[i]);
      }
      await knowledgeIngest.regenerateSkillCard(topicId);
    })();
    return;
  } catch (err) {
    return res.status(500).send({
      message: err.message || "创建附件时发生错误。",
    });
  }
};

exports.bulkCreateFromZip = async (req, res) => {
  let uploadedZipPath = null;
  let extractDir = null;
  const createdFilePaths = [];
  const skipped = [];

  try {
    await uploadBulkZip(req, res);

    const topicId = Number(req.params.topicId);
    if (!Number.isInteger(topicId) || topicId <= 0) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(422).send({ message: "主题 ID 无效。" });
    }
    if (!req.file) {
      return res.status(422).send({ message: "请上传 zip 文件。" });
    }

    uploadedZipPath = req.file.path;
    if (path.extname(req.file.originalname || "").toLowerCase() !== ".zip") {
      if (fs.existsSync(uploadedZipPath)) fs.unlinkSync(uploadedZipPath);
      return res.status(422).send({ message: "仅支持 .zip 文件。" });
    }

    const topic = await MaterialTopic.findByPk(topicId);
    if (!topic) {
      if (fs.existsSync(uploadedZipPath)) fs.unlinkSync(uploadedZipPath);
      return res.status(404).send({ message: "主题不存在。" });
    }

    extractDir = fs.mkdtempSync(path.join(getTopicDirectory(topicId), "bulkzip-"));
    try {
      childProcess.execFileSync("unzip", ["-qq", uploadedZipPath, "-d", extractDir], { stdio: "pipe" });
    } catch (e) {
      if (fs.existsSync(uploadedZipPath)) fs.unlinkSync(uploadedZipPath);
      if (extractDir && fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
      return res.status(422).send({ message: "zip 解压失败，请确认文件格式正确。" });
    }

    const extractedFiles = listFilesRecursively(extractDir);
    const pendingRows = [];

    const flushPendingRows = async () => {
      if (pendingRows.length === 0) return { created: 0 };
      let created = 0;
      try {
        await MaterialArtifact.bulkCreate(
          pendingRows.map((r) => ({
            materialTopicId: r.materialTopicId,
            description: r.description,
            category: r.category,
            type: r.type,
            attachmentPath: r.attachmentPath,
            attachmentName: r.attachmentName,
            attachmentMime: r.attachmentMime,
            attachmentSize: r.attachmentSize,
          }))
        );
        created = pendingRows.length;
      } catch (e) {
        // Fall back to row-by-row to isolate bad rows without failing whole import.
        for (const row of pendingRows) {
          try {
            await MaterialArtifact.create({
              materialTopicId: row.materialTopicId,
              description: row.description,
              category: row.category,
              type: row.type,
              attachmentPath: row.attachmentPath,
              attachmentName: row.attachmentName,
              attachmentMime: row.attachmentMime,
              attachmentSize: row.attachmentSize,
            });
            created += 1;
          } catch (singleErr) {
            skipped.push({ path: row.sourcePath, reason: `数据库写入失败: ${singleErr.message}` });
            try {
              if (fs.existsSync(row.attachmentPath)) fs.unlinkSync(row.attachmentPath);
            } catch (removeErr) {
              console.error("删除失败文件失败:", row.attachmentPath, removeErr.message);
            }
          }
        }
      } finally {
        pendingRows.length = 0;
      }
      return { created };
    };

    let createdCount = 0;
    for (const extractedFilePath of extractedFiles) {
      const normalizedName = path.relative(extractDir, extractedFilePath).replace(/\\/g, "/");
      const parts = normalizedName.split("/").filter(Boolean);
      if (parts.length < 1) {
        skipped.push({ path: normalizedName, reason: "路径无效。" });
        continue;
      }
      if (parts[0] === "__MACOSX") continue;
      if (parts.some((x) => x === ".DS_Store")) continue;

      const { category, categoryIndex } = resolveCategoryFromPathParts(parts);
      if (!category) {
        skipped.push({ path: normalizedName, reason: "不支持的分类目录。" });
        continue;
      }
      if (categoryIndex >= parts.length - 1) {
        skipped.push({ path: normalizedName, reason: "分类目录下未找到文件。" });
        continue;
      }

      const originalName = path.basename(extractedFilePath);
      const safeOriginalName = path.basename(originalName);
      if (!safeOriginalName) {
        skipped.push({ path: normalizedName, reason: "文件名无效。" });
        continue;
      }

      const st = fs.statSync(extractedFilePath);
      if (st.size > BULK_MAX_FILE_BYTES) {
        skipped.push({ path: normalizedName, reason: `文件过大，超过 ${BULK_MAX_FILE_BYTES} bytes。` });
        continue;
      }

      const storedName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${safeOriginalName}`;
      const targetPath = path.join(getArtifactStorageDirectory(topicId, category), storedName);
      moveFileAtomic(extractedFilePath, targetPath);
      createdFilePaths.push(targetPath);

      pendingRows.push({
        sourcePath: normalizedName,
        materialTopicId: topicId,
        description: "",
        category,
        type: inferArtifactType(safeOriginalName),
        attachmentPath: path.resolve(targetPath),
        attachmentName: safeOriginalName,
        attachmentMime: inferMime(safeOriginalName),
        attachmentSize: st.size,
      });

      if (pendingRows.length >= BULK_DB_BATCH_SIZE) {
        const batchResult = await flushPendingRows();
        createdCount += batchResult.created;
      }
    }

    const finalBatchResult = await flushPendingRows();
    createdCount += finalBatchResult.created;

    if (uploadedZipPath && fs.existsSync(uploadedZipPath)) fs.unlinkSync(uploadedZipPath);
    if (extractDir && fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });

    return res.send({
      message: "批量导入完成。",
      createdCount,
      skippedCount: skipped.length,
      skipped: skipped.slice(0, BULK_SKIPPED_REPORT_LIMIT),
      skippedTruncated: skipped.length > BULK_SKIPPED_REPORT_LIMIT,
    });
  } catch (err) {
    for (const p of createdFilePaths) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch (removeErr) {
        console.error("异常回滚时删除文件失败:", p, removeErr.message);
      }
    }
    if (uploadedZipPath && fs.existsSync(uploadedZipPath)) {
      try {
        fs.unlinkSync(uploadedZipPath);
      } catch (e) {
        console.error("删除上传的 zip 失败:", uploadedZipPath, e.message);
      }
    }
    if (extractDir && fs.existsSync(extractDir)) {
      try {
        fs.rmSync(extractDir, { recursive: true, force: true });
      } catch (e) {
        console.error("删除解压目录失败:", extractDir, e.message);
      }
    }
    if (err && err.code === "LIMIT_FILE_SIZE") {
      return res.status(422).send({
        message: `zip 文件过大，超过 ${BULK_MAX_ZIP_BYTES} bytes。`,
      });
    }
    return res.status(500).send({
      message: err.message || "批量导入附件时发生错误。",
    });
  }
};

exports.findByTopic = async (req, res) => {
  try {
    const topicId = Number(req.params.topicId);
    if (!Number.isInteger(topicId) || topicId <= 0) {
      return res.status(422).send({ message: "主题 ID 无效。" });
    }

    const data = await MaterialArtifact.findAll({
      where: { materialTopicId: topicId },
      order: [["id", "DESC"]],
    });
    return res.send(data);
  } catch (err) {
    return res.status(500).send({
      message: err.message || "查询附件列表时发生错误。",
    });
  }
};

exports.findOne = async (req, res) => {
  try {
    const data = await MaterialArtifact.findByPk(req.params.id);
    if (!data) {
      return res.status(404).send({ message: `未找到附件 id=${req.params.id}。` });
    }
    return res.send(data);
  } catch (err) {
    return res.status(500).send({
      message: err.message || `查询附件 id=${req.params.id} 时发生错误。`,
    });
  }
};

// GET /api/material-artifacts/:id/download -- deliberately no auth
// middleware, matching /api/artifacts/:id/download -- usable directly as a
// raw <img>/<video> src for thumbnails.
exports.download = async (req, res) => {
  try {
    const data = await MaterialArtifact.findByPk(req.params.id);
    if (!data) {
      return res.status(404).send({ message: `未找到附件 id=${req.params.id}。` });
    }
    if (!fs.existsSync(data.attachmentPath)) {
      return res.status(404).send({ message: "附件文件不存在。" });
    }

    return res.download(data.attachmentPath, data.attachmentName);
  } catch (err) {
    return res.status(500).send({
      message: err.message || `下载附件 id=${req.params.id} 时发生错误。`,
    });
  }
};

exports.downloadByTopic = async (req, res) => {
  let tmpRootDir = null;
  let stagingDir = null;
  let zipPath = null;

  try {
    const topicId = Number(req.params.topicId);
    if (!Number.isInteger(topicId) || topicId <= 0) {
      return res.status(422).send({ message: "主题 ID 无效。" });
    }

    const topic = await MaterialTopic.findByPk(topicId);
    if (!topic) {
      return res.status(404).send({ message: "主题不存在。" });
    }

    const artifacts = await MaterialArtifact.findAll({
      where: { materialTopicId: topicId },
      attributes: ["id", "category", "attachmentName", "attachmentPath"],
      order: [["id", "ASC"]],
    });

    if (!artifacts || artifacts.length === 0) {
      return res.status(404).send({ message: "该主题暂无可下载附件。" });
    }

    tmpRootDir = fs.mkdtempSync(path.join(os.tmpdir(), `material-topic-${topicId}-artifacts-`));
    stagingDir = path.join(tmpRootDir, "files");
    fs.mkdirSync(stagingDir, { recursive: true });

    let stagedCount = 0;
    for (const artifact of artifacts) {
      if (!artifact.attachmentPath || !fs.existsSync(artifact.attachmentPath)) continue;
      const safeName = path.basename(artifact.attachmentName || `artifact-${artifact.id}`);
      const folderName = ARTIFACT_CATEGORIES.includes(artifact.category) ? artifact.category : "未分类";
      const folderPath = path.join(stagingDir, folderName);
      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
      }
      const stagedName = `${artifact.id}-${safeName}`;
      const stagedPath = path.join(folderPath, stagedName);
      fs.copyFileSync(artifact.attachmentPath, stagedPath);
      stagedCount += 1;
    }

    if (stagedCount === 0) {
      return res.status(404).send({ message: "附件文件不存在或已丢失，无法打包下载。" });
    }

    zipPath = path.join(tmpRootDir, `material-topic-${topicId}-artifacts.zip`);
    childProcess.execFileSync("zip", ["-q", "-r", zipPath, "."], {
      cwd: stagingDir,
      stdio: "pipe",
    });

    res.download(zipPath, `material-topic-${topicId}-artifacts.zip`, (err) => {
      if (err) {
        console.error("批量下载 zip 响应失败:", err.message);
      }
      if (tmpRootDir && fs.existsSync(tmpRootDir)) {
        try {
          fs.rmSync(tmpRootDir, { recursive: true, force: true });
        } catch (e) {
          console.error("删除批量下载临时目录失败:", tmpRootDir, e.message);
        }
      }
    });
  } catch (err) {
    if (tmpRootDir && fs.existsSync(tmpRootDir)) {
      try {
        fs.rmSync(tmpRootDir, { recursive: true, force: true });
      } catch (e) {
        console.error("异常时删除批量下载临时目录失败:", tmpRootDir, e.message);
      }
    }
    return res.status(500).send({
      message: err.message || "批量下载附件时发生错误。",
    });
  }
};

// POST /api/material-topics/:topicId/artifacts/download-selection -- zips an
// arbitrary mixed selection of top-level files (artifactIds) and folders
// (folderIds), same shape as artifact.controller.js#downloadSelection.
exports.downloadSelection = async (req, res) => {
  let tmpRootDir = null;
  let stagingDir = null;
  let zipPath = null;

  try {
    const topicId = Number(req.params.topicId);
    if (!Number.isInteger(topicId) || topicId <= 0) {
      return res.status(422).send({ message: "主题 ID 无效。" });
    }

    const topic = await MaterialTopic.findByPk(topicId);
    if (!topic) {
      return res.status(404).send({ message: "主题不存在。" });
    }

    const toIdList = (value) =>
      (Array.isArray(value) ? value : [])
        .map((v) => Number(v))
        .filter((n) => Number.isInteger(n) && n > 0);
    const artifactIds = toIdList(req.body.artifactIds);
    const folderIds = toIdList(req.body.folderIds);

    if (artifactIds.length === 0 && folderIds.length === 0) {
      return res.status(422).send({ message: "未选择任何文件或文件夹。" });
    }

    const [allFolders, selectedArtifacts, selectedFolders] = await Promise.all([
      MaterialFolder.findAll({ where: { materialTopicId: topicId }, attributes: ["id", "name", "parentFolderId"] }),
      artifactIds.length
        ? MaterialArtifact.findAll({
            where: { id: { [Op.in]: artifactIds }, materialTopicId: topicId },
            attributes: ["id", "attachmentName", "attachmentPath"],
          })
        : [],
      folderIds.length
        ? MaterialFolder.findAll({
            where: { id: { [Op.in]: folderIds }, materialTopicId: topicId },
            attributes: ["id", "name"],
          })
        : [],
    ]);

    if (folderIds.length > 0 && selectedFolders.length !== folderIds.length) {
      return res.status(422).send({ message: "部分文件夹不存在，或不属于同一主题的文件空间。" });
    }

    const childrenByParentId = new Map();
    for (const f of allFolders) {
      const key = f.parentFolderId || null;
      if (!childrenByParentId.has(key)) childrenByParentId.set(key, []);
      childrenByParentId.get(key).push(f);
    }

    tmpRootDir = fs.mkdtempSync(path.join(os.tmpdir(), `material-topic-${topicId}-selection-`));
    stagingDir = path.join(tmpRootDir, "files");
    fs.mkdirSync(stagingDir, { recursive: true });

    let stagedCount = 0;
    const stageFile = (dirPath, artifact) => {
      if (!artifact.attachmentPath || !fs.existsSync(artifact.attachmentPath)) return;
      if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
      const safeName = path.basename(artifact.attachmentName || `artifact-${artifact.id}`);
      let target = path.join(dirPath, safeName);
      if (fs.existsSync(target)) target = path.join(dirPath, `${artifact.id}-${safeName}`);
      fs.copyFileSync(artifact.attachmentPath, target);
      stagedCount += 1;
    };

    const stageFolderRecursive = async (folder, destDir) => {
      let folderDir = path.join(destDir, path.basename(folder.name || "") || `folder-${folder.id}`);
      if (fs.existsSync(folderDir) && !fs.statSync(folderDir).isDirectory()) {
        folderDir = path.join(destDir, `${folder.id}-${path.basename(folder.name || "folder")}`);
      }
      fs.mkdirSync(folderDir, { recursive: true });

      const filesInFolder = await MaterialArtifact.findAll({
        where: { folderId: folder.id, materialTopicId: topicId },
        attributes: ["id", "attachmentName", "attachmentPath"],
      });
      for (const artifact of filesInFolder) {
        stageFile(folderDir, artifact);
      }

      const children = childrenByParentId.get(folder.id) || [];
      for (const child of children) {
        // eslint-disable-next-line no-await-in-loop
        await stageFolderRecursive(child, folderDir);
      }
    };

    for (const folder of selectedFolders) {
      // eslint-disable-next-line no-await-in-loop
      await stageFolderRecursive(folder, stagingDir);
    }
    for (const artifact of selectedArtifacts) {
      stageFile(stagingDir, artifact);
    }

    if (stagedCount === 0) {
      fs.rmSync(tmpRootDir, { recursive: true, force: true });
      return res.status(404).send({ message: "所选内容中没有可下载的文件。" });
    }

    zipPath = path.join(tmpRootDir, `material-topic-${topicId}-selection.zip`);
    childProcess.execFileSync("zip", ["-q", "-r", zipPath, "."], {
      cwd: stagingDir,
      stdio: "pipe",
    });

    res.download(zipPath, `material-topic-${topicId}-selection.zip`, (err) => {
      if (err) {
        console.error("选定项打包下载响应失败:", err.message);
      }
      if (tmpRootDir && fs.existsSync(tmpRootDir)) {
        try {
          fs.rmSync(tmpRootDir, { recursive: true, force: true });
        } catch (e) {
          console.error("删除选定项下载临时目录失败:", tmpRootDir, e.message);
        }
      }
    });
  } catch (err) {
    if (tmpRootDir && fs.existsSync(tmpRootDir)) {
      try {
        fs.rmSync(tmpRootDir, { recursive: true, force: true });
      } catch (e) {
        console.error("异常时删除选定项下载临时目录失败:", tmpRootDir, e.message);
      }
    }
    return res.status(500).send({
      message: err.message || "打包下载所选内容时发生错误。",
    });
  }
};

// PUT /api/material-artifacts/:id -- admin-only (route-gated), no ownership
// check needed (unlike artifact.controller.js#update's owner-only rule --
// this library has no owner concept, only admin-vs-everyone-else).
exports.update = async (req, res) => {
  try {
    await uploadFields(req, res);
    const id = req.params.id;
    const artifact = await MaterialArtifact.findByPk(id);
    const singleFile = req.files && req.files.file && req.files.file[0];

    if (!artifact) {
      if (singleFile && fs.existsSync(singleFile.path)) fs.unlinkSync(singleFile.path);
      return res.status(404).send({ message: `未找到附件 id=${id}。` });
    }

    const payload = {
      description: req.body.description !== undefined ? req.body.description : artifact.description,
      category: req.body.category !== undefined ? req.body.category : artifact.category,
      type: artifact.type,
    };

    if (!ARTIFACT_CATEGORIES.includes(payload.category)) {
      if (singleFile && fs.existsSync(singleFile.path)) fs.unlinkSync(singleFile.path);
      return res.status(422).send({
        message: "附件分类无效，必须是 Word文档/课件PPT/图片/视频 之一。",
      });
    }

    const folderId = normalizeFolderId(req.body.folderId);
    if (Number.isNaN(folderId)) {
      if (singleFile && fs.existsSync(singleFile.path)) fs.unlinkSync(singleFile.path);
      return res.status(422).send({ message: "folderId 无效。" });
    }
    if (folderId !== undefined) {
      const folderError = await validateFolderId(folderId, artifact.materialTopicId);
      if (folderError) {
        if (singleFile && fs.existsSync(singleFile.path)) fs.unlinkSync(singleFile.path);
        return res.status(422).send({ message: folderError });
      }
      payload.folderId = folderId;
    }

    const oldPath = artifact.attachmentPath;
    if (singleFile) {
      payload.attachmentPath = moveIntoArtifactDirectory(artifact.materialTopicId, payload.category, singleFile);
      payload.attachmentName = singleFile.originalname;
      payload.attachmentMime = singleFile.mimetype;
      payload.attachmentSize = singleFile.size;
      payload.type = inferArtifactType(singleFile.originalname);
    } else if (oldPath && fs.existsSync(oldPath)) {
      const filename = path.basename(oldPath);
      const targetDir = getArtifactStorageDirectory(artifact.materialTopicId, payload.category);
      const targetPath = path.join(targetDir, filename);
      if (path.resolve(targetPath) !== path.resolve(oldPath)) {
        moveFileAtomic(oldPath, targetPath);
        payload.attachmentPath = path.resolve(targetPath);
      }
    }

    await MaterialArtifact.update(payload, { where: { id } });

    if (singleFile && oldPath && fs.existsSync(oldPath)) {
      try {
        fs.unlinkSync(oldPath);
      } catch (e) {
        console.error("删除旧附件文件失败:", oldPath, e.message);
      }
    }

    const finalPath = payload.attachmentPath || oldPath;
    const finalName = payload.attachmentName || artifact.attachmentName;
    res.send({ message: "附件更新成功。" });

    // See the create handler's ingestOne comment -- same reasoning, not
    // awaited before responding.
    (async () => {
      try {
        const text = await artifactKnowledgeText(finalPath, payload.type, payload.category, payload.description, finalName);
        await knowledgeIngest.ingestSource({
          sourceType: "material_artifact",
          sourceId: artifact.id,
          materialTopicId: artifact.materialTopicId,
          text,
        });
        await knowledgeIngest.regenerateSkillCard(artifact.materialTopicId);
      } catch (e) {
        console.error("附件知识库摄取失败（不影响附件本身的更新）:", e.message);
      }
    })();
    return;
  } catch (err) {
    return res.status(500).send({
      message: err.message || `更新附件 id=${req.params.id} 时发生错误。`,
    });
  }
};

exports.delete = async (req, res) => {
  const id = req.params.id;
  if (!mustConfirm(req.query.confirmDelete)) {
    return res.status(400).send({
      message: "危险操作：将永久删除该附件。请使用 confirmDelete=true 重新提交。",
    });
  }

  try {
    const data = await MaterialArtifact.findByPk(id);
    if (!data) {
      return res.status(404).send({ message: `未找到附件 id=${id}。` });
    }

    // Explicit cleanup -- source_id is polymorphic, so the DB can't cascade
    // "delete chunks where source_type='material_artifact' AND
    // source_id=this artifact" on its own.
    await knowledgeIngest.deleteSourceChunks({ sourceType: "material_artifact", sourceId: data.id });
    await MaterialArtifact.destroy({ where: { id } });

    if (data.attachmentPath && fs.existsSync(data.attachmentPath)) {
      try {
        fs.unlinkSync(data.attachmentPath);
      } catch (e) {
        console.error("删除附件文件失败:", data.attachmentPath, e.message);
      }
    }

    return res.send({ message: "附件删除成功。" });
  } catch (err) {
    return res.status(500).send({
      message: err.message || `删除附件 id=${id} 时发生错误。`,
    });
  }
};

// Exposed for tests / advanced callers.
exports.getTopicDirectory = getTopicDirectory;
exports.getArtifactStorageDirectory = getArtifactStorageDirectory;
