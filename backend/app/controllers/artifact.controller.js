const fs = require("fs");
const path = require("path");
const os = require("os");
const childProcess = require("child_process");
const multer = require("multer");
const util = require("util");

const db = require("../models");
const Artifact = db.artifact;
const Plan = db.plan;

const ARTIFACT_CATEGORIES = ["课程设计文件", "实施记录文件", "课件PPT", "图片", "视频"];
const LESSON_FOLDER_REGEX = /^lesson-(\d+)$/;
const BULK_MAX_ZIP_BYTES = Number(process.env.PLAN_BULK_ZIP_MAX_BYTES || 1024 * 1024 * 1024); // 1GB default
const BULK_MAX_FILE_BYTES = Number(process.env.PLAN_BULK_FILE_MAX_BYTES || 512 * 1024 * 1024); // 512MB default
const BULK_DB_BATCH_SIZE = Number(process.env.PLAN_BULK_DB_BATCH_SIZE || 100);
const BULK_SKIPPED_REPORT_LIMIT = Number(process.env.PLAN_BULK_SKIPPED_REPORT_LIMIT || 200);

const mustConfirm = (value) => value === true || value === "true" || value === "1";

// backend/upload/Plan/<planId>/<category>/[lesson-<n>/]<timestamp>-<name>
const getPlanDirectory = (planId) => {
  const dir = path.join(`${__dirname}/../../upload`, "Plan", `${planId}`);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
};

const normalizeLessonIndex = (lessonIndex) => {
  if (lessonIndex === undefined || lessonIndex === null || lessonIndex === "") return null;
  const n = Number(lessonIndex);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const lessonFolderName = (lessonIndex) => {
  const n = normalizeLessonIndex(lessonIndex);
  return n ? `lesson-${n}` : null;
};

const getArtifactStorageDirectory = (planId, category, lessonIndex) => {
  const segments = [getPlanDirectory(planId), category];
  const folder = lessonFolderName(lessonIndex);
  if (folder) segments.push(folder);
  const dir = path.join(...segments);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
};

const moveIntoArtifactDirectory = (planId, category, lessonIndex, uploadedFile) => {
  const targetDir = getArtifactStorageDirectory(planId, category, lessonIndex);
  const targetPath = path.join(targetDir, path.basename(uploadedFile.path));
  moveFileAtomic(uploadedFile.path, targetPath);
  return path.resolve(targetPath);
};

// multipart/form-data never declares a charset for filenames, and busboy
// (which multer uses under the hood) decodes them as latin1 by default --
// browsers actually send UTF-8, so any non-ASCII filename (Chinese, etc.)
// arrives mojibake unless corrected. Re-decoding the latin1 bytes as UTF-8
// recovers the original. Mutating `file` here (destination runs before
// filename, and both run before the controller sees req.file/req.files)
// fixes it everywhere downstream in one place: the stored attachmentName
// and the on-disk filename both read file.originalname after this.
const fixOriginalNameEncoding = (file) => {
  file.originalname = Buffer.from(file.originalname, "latin1").toString("utf8");
};

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    fixOriginalNameEncoding(file);
    // Multer processes multipart fields in order; category/lessonIndex may
    // not be populated yet when this callback runs, so — like shinshin's
    // artifact.controller.js — files land in the plan's top-level directory
    // first and are moved into their category/lesson subfolder afterwards
    // (see moveIntoArtifactDirectory), once req.body is fully available.
    const planId = req.params.planId || req.body.planId;
    cb(null, getPlanDirectory(planId));
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

const resolveLessonIndexFromPathParts = (parts, categoryIndex) => {
  if (categoryIndex < 0 || categoryIndex >= parts.length - 2) return null;
  const candidate = parts[categoryIndex + 1];
  const m = LESSON_FOLDER_REGEX.exec(candidate);
  return m ? Number(m[1]) : null;
};

exports.create = async (req, res) => {
  try {
    await uploadFields(req, res);

    const planId = Number(req.params.planId);
    const { description, category } = req.body;
    const lessonIndex = normalizeLessonIndex(req.body.lessonIndex);

    if (!Number.isInteger(planId) || planId <= 0) {
      return res.status(422).send({ message: "乡土课程设计 ID 无效。" });
    }
    if (!ARTIFACT_CATEGORIES.includes(category)) {
      return res.status(422).send({
        message: "附件分类无效，必须是 课程设计文件/实施记录文件/课件PPT/图片/视频 之一。",
      });
    }

    const singleFile = req.files && req.files.file && req.files.file[0];
    const multiFiles = req.files && req.files.files ? req.files.files : [];

    if (!singleFile && multiFiles.length === 0) {
      return res.status(422).send({ message: "请上传附件文件。" });
    }

    const plan = await Plan.findByPk(planId);
    if (!plan) {
      if (singleFile && fs.existsSync(singleFile.path)) fs.unlinkSync(singleFile.path);
      for (const f of multiFiles) {
        if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
      }
      return res.status(404).send({ message: "乡土课程设计不存在。" });
    }

    // Owner-only, matching plan.controller.js#update's content-editing rule --
    // uploading an artifact edits the case's content, so no admin bypass.
    if (plan.teacherId !== req.userId) {
      if (singleFile && fs.existsSync(singleFile.path)) fs.unlinkSync(singleFile.path);
      for (const f of multiFiles) {
        if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
      }
      return res.status(403).send({ message: "只能为本人创建的乡土课程设计上传附件。" });
    }

    const createOne = async (file) => {
      const attachmentPath = moveIntoArtifactDirectory(planId, category, lessonIndex, file);
      return Artifact.create({
        planId,
        lessonIndex,
        description,
        category,
        type: inferArtifactType(file.originalname),
        attachmentPath,
        attachmentName: file.originalname,
        attachmentMime: file.mimetype,
        attachmentSize: file.size,
      });
    };

    // Single-file upload (field name "file") keeps the single-object response
    // shape; multi-drag upload (field name "files") returns an array.
    if (singleFile) {
      const data = await createOne(singleFile);
      return res.send(data);
    }

    const created = [];
    for (const file of multiFiles) {
      created.push(await createOne(file));
    }
    return res.send(created);
  } catch (err) {
    return res.status(500).send({
      message: err.message || "创建附件时发生错误。",
    });
  }
};

// Reusable creation path for files produced server-side (e.g. the generated
// plan .docx) so they register through the exact same Artifact.create shape
// as manual uploads, per the plan.
exports.registerArtifactFile = async ({ planId, lessonIndex = null, category, description = null, buffer, originalName, mimeType }) => {
  const normalizedLessonIndex = normalizeLessonIndex(lessonIndex);
  const dir = getArtifactStorageDirectory(planId, category, normalizedLessonIndex);
  const storedName = `${Date.now()}-${originalName}`;
  const targetPath = path.join(dir, storedName);
  fs.writeFileSync(targetPath, buffer);
  const stat = fs.statSync(targetPath);

  return Artifact.create({
    planId,
    lessonIndex: normalizedLessonIndex,
    description,
    category,
    type: inferArtifactType(originalName),
    attachmentPath: path.resolve(targetPath),
    attachmentName: originalName,
    attachmentMime: mimeType || inferMime(originalName),
    attachmentSize: stat.size,
  });
};

exports.bulkCreateFromZip = async (req, res) => {
  let uploadedZipPath = null;
  let extractDir = null;
  const createdFilePaths = [];
  const skipped = [];

  try {
    await uploadBulkZip(req, res);

    const planId = Number(req.params.planId);
    if (!Number.isInteger(planId) || planId <= 0) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(422).send({ message: "乡土课程设计 ID 无效。" });
    }
    if (!req.file) {
      return res.status(422).send({ message: "请上传 zip 文件。" });
    }

    uploadedZipPath = req.file.path;
    if (path.extname(req.file.originalname || "").toLowerCase() !== ".zip") {
      if (fs.existsSync(uploadedZipPath)) fs.unlinkSync(uploadedZipPath);
      return res.status(422).send({ message: "仅支持 .zip 文件。" });
    }

    const plan = await Plan.findByPk(planId);
    if (!plan) {
      if (fs.existsSync(uploadedZipPath)) fs.unlinkSync(uploadedZipPath);
      return res.status(404).send({ message: "乡土课程设计不存在。" });
    }

    if (plan.teacherId !== req.userId) {
      if (fs.existsSync(uploadedZipPath)) fs.unlinkSync(uploadedZipPath);
      return res.status(403).send({ message: "只能为本人创建的乡土课程设计上传附件。" });
    }

    extractDir = fs.mkdtempSync(path.join(getPlanDirectory(planId), "bulkzip-"));
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
        await Artifact.bulkCreate(
          pendingRows.map((r) => ({
            planId: r.planId,
            lessonIndex: r.lessonIndex,
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
            await Artifact.create({
              planId: row.planId,
              lessonIndex: row.lessonIndex,
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

      const lessonIndex = resolveLessonIndexFromPathParts(parts, categoryIndex);

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
      const targetPath = path.join(getArtifactStorageDirectory(planId, category, lessonIndex), storedName);
      moveFileAtomic(extractedFilePath, targetPath);
      createdFilePaths.push(targetPath);

      pendingRows.push({
        sourcePath: normalizedName,
        planId,
        lessonIndex,
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

exports.findByPlan = async (req, res) => {
  try {
    const planId = Number(req.params.planId);
    if (!Number.isInteger(planId) || planId <= 0) {
      return res.status(422).send({ message: "乡土课程设计 ID 无效。" });
    }

    const where = { planId };
    if (req.query.lessonIndex !== undefined) {
      if (req.query.lessonIndex === "" || req.query.lessonIndex === "null") {
        where.lessonIndex = null;
      } else {
        const n = Number(req.query.lessonIndex);
        if (!Number.isInteger(n)) {
          return res.status(422).send({ message: "lessonIndex 无效。" });
        }
        where.lessonIndex = n;
      }
    }

    const data = await Artifact.findAll({
      where,
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
    const data = await Artifact.findByPk(req.params.id);
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

exports.download = async (req, res) => {
  try {
    const data = await Artifact.findByPk(req.params.id);
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

exports.downloadByPlan = async (req, res) => {
  let tmpRootDir = null;
  let stagingDir = null;
  let zipPath = null;

  try {
    const planId = Number(req.params.planId);
    if (!Number.isInteger(planId) || planId <= 0) {
      return res.status(422).send({ message: "乡土课程设计 ID 无效。" });
    }

    const plan = await Plan.findByPk(planId);
    if (!plan) {
      return res.status(404).send({ message: "乡土课程设计不存在。" });
    }

    const artifacts = await Artifact.findAll({
      where: { planId },
      attributes: ["id", "category", "lessonIndex", "attachmentName", "attachmentPath"],
      order: [["id", "ASC"]],
    });

    if (!artifacts || artifacts.length === 0) {
      return res.status(404).send({ message: "该乡土课程设计暂无可下载附件。" });
    }

    tmpRootDir = fs.mkdtempSync(path.join(os.tmpdir(), `plan-${planId}-artifacts-`));
    stagingDir = path.join(tmpRootDir, "files");
    fs.mkdirSync(stagingDir, { recursive: true });

    let stagedCount = 0;
    for (const artifact of artifacts) {
      if (!artifact.attachmentPath || !fs.existsSync(artifact.attachmentPath)) continue;
      const safeName = path.basename(artifact.attachmentName || `artifact-${artifact.id}`);
      const folderName = ARTIFACT_CATEGORIES.includes(artifact.category) ? artifact.category : "未分类";
      const lessonFolder = lessonFolderName(artifact.lessonIndex);
      const folderPath = lessonFolder
        ? path.join(stagingDir, folderName, lessonFolder)
        : path.join(stagingDir, folderName);
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

    zipPath = path.join(tmpRootDir, `plan-${planId}-artifacts.zip`);
    childProcess.execFileSync("zip", ["-q", "-r", zipPath, "."], {
      cwd: stagingDir,
      stdio: "pipe",
    });

    res.download(zipPath, `plan-${planId}-artifacts.zip`, (err) => {
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

exports.update = async (req, res) => {
  try {
    await uploadFields(req, res);
    const id = req.params.id;
    const artifact = await Artifact.findByPk(id);
    const singleFile = req.files && req.files.file && req.files.file[0];

    if (!artifact) {
      if (singleFile && fs.existsSync(singleFile.path)) fs.unlinkSync(singleFile.path);
      return res.status(404).send({ message: `未找到附件 id=${id}。` });
    }

    const parentPlan = await Plan.findByPk(artifact.planId);
    if (!parentPlan || parentPlan.teacherId !== req.userId) {
      if (singleFile && fs.existsSync(singleFile.path)) fs.unlinkSync(singleFile.path);
      return res.status(403).send({ message: "只能修改本人创建的乡土课程设计的附件。" });
    }

    const payload = {
      description: req.body.description !== undefined ? req.body.description : artifact.description,
      category: req.body.category !== undefined ? req.body.category : artifact.category,
      lessonIndex:
        req.body.lessonIndex !== undefined ? normalizeLessonIndex(req.body.lessonIndex) : artifact.lessonIndex,
      type: artifact.type,
    };

    if (!ARTIFACT_CATEGORIES.includes(payload.category)) {
      if (singleFile && fs.existsSync(singleFile.path)) fs.unlinkSync(singleFile.path);
      return res.status(422).send({
        message: "附件分类无效，必须是 课程设计文件/实施记录文件/课件PPT/图片/视频 之一。",
      });
    }

    const oldPath = artifact.attachmentPath;
    if (singleFile) {
      payload.attachmentPath = moveIntoArtifactDirectory(artifact.planId, payload.category, payload.lessonIndex, singleFile);
      payload.attachmentName = singleFile.originalname;
      payload.attachmentMime = singleFile.mimetype;
      payload.attachmentSize = singleFile.size;
      payload.type = inferArtifactType(singleFile.originalname);
    } else if (oldPath && fs.existsSync(oldPath)) {
      const filename = path.basename(oldPath);
      const targetDir = getArtifactStorageDirectory(artifact.planId, payload.category, payload.lessonIndex);
      const targetPath = path.join(targetDir, filename);
      if (path.resolve(targetPath) !== path.resolve(oldPath)) {
        moveFileAtomic(oldPath, targetPath);
        payload.attachmentPath = path.resolve(targetPath);
      }
    }

    await Artifact.update(payload, { where: { id } });

    if (singleFile && oldPath && fs.existsSync(oldPath)) {
      try {
        fs.unlinkSync(oldPath);
      } catch (e) {
        console.error("删除旧附件文件失败:", oldPath, e.message);
      }
    }

    return res.send({ message: "附件更新成功。" });
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
    const data = await Artifact.findByPk(id);
    if (!data) {
      return res.status(404).send({ message: `未找到附件 id=${id}。` });
    }

    const parentPlan = await Plan.findByPk(data.planId);
    if (!parentPlan || parentPlan.teacherId !== req.userId) {
      return res.status(403).send({ message: "只能删除本人创建的乡土课程设计的附件。" });
    }

    await Artifact.destroy({ where: { id } });

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
exports.getPlanDirectory = getPlanDirectory;
exports.getArtifactStorageDirectory = getArtifactStorageDirectory;
