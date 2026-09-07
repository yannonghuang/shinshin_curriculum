const fs = require("fs");
const path = require("path");
const multer = require("multer");
const util = require("util");

const db = require("../models");
const TemplateVersion = db.templateVersion;
const Plan = db.plan;
const Op = db.Sequelize.Op;
const templateParser = require("../services/templateParser");
const dynamicDocGenerator = require("../services/dynamicDocGenerator");

const mustConfirm = (value) => value === true || value === "true" || value === "1";

// Display title + filename for a blank download of each known template_key
// -- only cosmetic (the schema itself, not this map, is what stays in sync
// with whatever's active; see downloadBlank below), so a future template_key
// with no entry here just falls back to the key itself rather than failing.
const TEMPLATE_DISPLAY_NAMES = {
  plan_design: "乡土课程设计方案模版",
  lesson_execution: "课时实施记录模版",
};

// backend/upload/Templates/<templateKey>/<timestamp>-<name> -- mirrors
// artifact.controller.js's getArtifactStorageDirectory/getPlanDirectory
// convention (local disk + a DB row pointing at the absolute path).
const getTemplateDirectory = (templateKey) => {
  const dir = path.join(`${__dirname}/../../upload`, "Templates", `${templateKey}`);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
};

// See artifact.controller.js's identical fixOriginalNameEncoding -- multer/
// busboy decode multipart filenames as latin1 by default even though
// browsers send UTF-8, so a Chinese filename arrives mojibake unless
// corrected here, before anything downstream reads file.originalname.
const fixOriginalNameEncoding = (file) => {
  file.originalname = Buffer.from(file.originalname, "latin1").toString("utf8");
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fixOriginalNameEncoding(file);
    cb(null, getTemplateDirectory(req.params.templateKey));
  },
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const uploadSingle = util.promisify(multer({ storage }).single("file"));

// POST /api/admin/templates/:templateKey -- admin-only. Parses the
// uploaded reference .docx (services/templateParser.js) and, if it found at
// least one field, creates the next version for this template_key -- but
// deliberately does NOT activate it. Parsing is automatic (no
// review/edit-before-publish step -- see the dynamic-templates plan's
// "fully automatic, no review" scope), but going live is a separate,
// manual act: an admin reviews the parsed field list (see 查看字段 on this
// screen) and explicitly promotes it via #activate below when ready. A
// parse finding zero fields is rejected (422) outright, the one case where
// not even a draft version gets created.
exports.upload = async (req, res) => {
  try {
    await uploadSingle(req, res);
  } catch (err) {
    return res.status(500).send({ message: err.message || "文件上传失败。" });
  }
  if (!req.file) {
    return res.status(422).send({ message: "请选择要上传的 .docx 模板文件。" });
  }

  const templateKey = req.params.templateKey;
  let schema;
  try {
    schema = templateParser.parseTemplateDocx(req.file.path);
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    return res.status(422).send({ message: err.message || "模板解析失败。" });
  }

  try {
    const latest = await TemplateVersion.findOne({
      where: { templateKey },
      order: [["version", "DESC"]],
    });
    const nextVersion = latest ? latest.version + 1 : 1;

    const created = await TemplateVersion.create({
      templateKey,
      version: nextVersion,
      schemaJson: schema,
      sourceFilePath: path.resolve(req.file.path),
      sourceFileName: req.file.originalname,
      isActive: false,
      createdBy: req.userId,
    });

    return res.send(created);
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    return res.status(500).send({ message: err.message || "创建模板版本时发生错误。" });
  }
};

// GET /api/admin/templates/:templateKey -- admin-only, version history.
exports.list = async (req, res) => {
  try {
    const versions = await TemplateVersion.findAll({
      where: { templateKey: req.params.templateKey },
      include: [{ model: db.user, as: "Uploader", attributes: ["id", "username", "chineseName"] }],
      order: [["version", "DESC"]],
    });
    return res.send(versions);
  } catch (err) {
    return res.status(500).send({ message: err.message || "查询模板版本时发生错误。" });
  }
};

// PUT /api/admin/templates/:templateKey/versions/:id/activate -- admin-only.
// The only way a version ever goes live -- #upload above deliberately
// leaves a freshly parsed version inactive, so every promotion (a brand
// new upload, or rolling back to an older one) goes through this same
// atomic deactivate-the-current-one-then-activate-this-one step. Plans
// already pinned to *any* version are unaffected either way (see
// templateVersion.model.js's header comment).
exports.activate = async (req, res) => {
  const t = await db.sequelize.transaction();
  try {
    const version = await TemplateVersion.findByPk(req.params.id, { transaction: t });
    if (!version || version.templateKey !== req.params.templateKey) {
      await t.rollback();
      return res.status(404).send({ message: `未找到模板版本 id=${req.params.id}。` });
    }
    if (version.isActive) {
      await t.rollback();
      return res.send(version);
    }

    await TemplateVersion.update(
      { isActive: false },
      { where: { templateKey: req.params.templateKey, isActive: true }, transaction: t }
    );
    await version.update({ isActive: true }, { transaction: t });

    await t.commit();
    return res.send(version);
  } catch (err) {
    await t.rollback();
    return res.status(500).send({ message: err.message || "启用模板版本时发生错误。" });
  }
};

// PUT /api/admin/templates/:templateKey/versions/:id/note -- admin-only,
// free-text notes, e.g. why a version was published or rolled back to.
exports.updateNote = async (req, res) => {
  try {
    const version = await TemplateVersion.findByPk(req.params.id);
    if (!version || version.templateKey !== req.params.templateKey) {
      return res.status(404).send({ message: `未找到模板版本 id=${req.params.id}。` });
    }
    await version.update({ notes: req.body.notes || null });
    return res.send(version);
  } catch (err) {
    return res.status(500).send({ message: err.message || "保存备注时发生错误。" });
  }
};

// DELETE /api/admin/templates/:templateKey/versions/:id?confirmDelete=true
// -- admin-only. Blocked for the currently active version (promote another
// one first -- a template_key must never end up with zero usable versions)
// and for any version a plan is still pinned to (deleting it would silently
// blank that plan's form/doc -- see templateVersion.model.js's pinning
// comment), which together mean only a superseded, unreferenced version can
// ever actually be deleted. Removes the uploaded source file from disk too,
// if any (NULL for the hand-authored seed versions).
exports.remove = async (req, res) => {
  if (!mustConfirm(req.query.confirmDelete)) {
    return res.status(400).send({ message: "危险操作：将永久删除该模板版本。请使用 confirmDelete=true 重新提交。" });
  }
  try {
    const version = await TemplateVersion.findByPk(req.params.id);
    if (!version || version.templateKey !== req.params.templateKey) {
      return res.status(404).send({ message: `未找到模板版本 id=${req.params.id}。` });
    }
    if (version.isActive) {
      return res.status(409).send({ message: "不能删除当前启用的模板版本，请先启用其他版本。" });
    }
    const inUse = await Plan.count({
      where: { [Op.or]: [{ planTemplateVersionId: version.id }, { executionTemplateVersionId: version.id }] },
    });
    if (inUse > 0) {
      return res.status(409).send({ message: `仍有 ${inUse} 个乡土课程设计使用该模板版本，无法删除。` });
    }

    if (version.sourceFilePath) {
      fs.unlink(version.sourceFilePath, () => {});
    }
    await version.destroy();
    return res.send({ message: "模板版本已删除。" });
  } catch (err) {
    return res.status(500).send({ message: err.message || "删除模板版本时发生错误。" });
  }
};

// GET /api/templates/:templateKey/active -- any authenticated caller (used
// when creating a new plan, before it has its own pinned version yet).
exports.getActive = async (req, res) => {
  try {
    const version = await TemplateVersion.findOne({ where: { templateKey: req.params.templateKey, isActive: true } });
    if (!version) {
      return res.status(404).send({ message: `未找到模板 ${req.params.templateKey} 的启用版本。` });
    }
    return res.send(version);
  } catch (err) {
    return res.status(500).send({ message: err.message || "查询模板时发生错误。" });
  }
};

// GET /api/templates/:templateKey/blank-doc -- the currently active
// version's document, streamed back for the "下载乡土课程设计方案模版"/
// "下载乡土课程实施记录模版" buttons on the plans list. If that version came
// from an upload (sourceFilePath set, see #upload above), this returns the
// original .docx bytes as-is -- so what a user downloads is byte-identical
// to what an admin uploaded, not a regenerated approximation. Only the
// hand-authored seed versions (no file on disk) fall back to rendering a
// blank .docx on the fly from schemaJson with every field "（未填写）", same
// engine plan.controller.js#renderDoc/renderExecutionDoc use for a plan
// that hasn't filled in a field yet.
exports.downloadBlank = async (req, res) => {
  try {
    const templateKey = req.params.templateKey;
    const version = await TemplateVersion.findOne({ where: { templateKey, isActive: true } });
    if (!version) {
      return res.status(404).send({ message: `未找到模板 ${templateKey} 的启用版本。` });
    }

    const docTitle = TEMPLATE_DISPLAY_NAMES[templateKey] || templateKey;

    if (version.sourceFilePath) {
      if (!fs.existsSync(version.sourceFilePath)) {
        return res.status(404).send({ message: "模板源文件已丢失。" });
      }
      return res.download(version.sourceFilePath, version.sourceFileName || `${docTitle}.docx`);
    }

    const buffer = await dynamicDocGenerator.generateDoc({
      docTitle,
      schema: version.schemaJson,
      answers: {},
    });

    res.set({
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(docTitle)}.docx`,
    });
    return res.send(buffer);
  } catch (err) {
    return res.status(500).send({ message: err.message || "生成模板文件时发生错误。" });
  }
};

// GET /api/admin/templates/:templateKey/versions/:id/download -- admin-only,
// the actual file behind one version row (not just the active one, unlike
// #downloadBlank below). If this version came from an upload (sourceFilePath
// set, see #upload above), streams back the original .docx as-is; the
// hand-authored seed versions have no file on disk, so for those it falls
// back to the same on-the-fly regeneration #downloadBlank uses, rendered
// from *this* version's schemaJson rather than whichever is currently active.
exports.download = async (req, res) => {
  try {
    const version = await TemplateVersion.findByPk(req.params.id);
    if (!version || version.templateKey !== req.params.templateKey) {
      return res.status(404).send({ message: `未找到模板版本 id=${req.params.id}。` });
    }

    if (version.sourceFilePath) {
      if (!fs.existsSync(version.sourceFilePath)) {
        return res.status(404).send({ message: "模板源文件已丢失。" });
      }
      return res.download(version.sourceFilePath, version.sourceFileName || `${req.params.templateKey}-v${version.version}.docx`);
    }

    const docTitle = `${TEMPLATE_DISPLAY_NAMES[req.params.templateKey] || req.params.templateKey}-v${version.version}`;
    const buffer = await dynamicDocGenerator.generateDoc({
      docTitle,
      schema: version.schemaJson,
      answers: {},
    });
    res.set({
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(docTitle)}.docx`,
    });
    return res.send(buffer);
  } catch (err) {
    return res.status(500).send({ message: err.message || "下载模板版本时发生错误。" });
  }
};

// GET /api/templates/versions/:id -- resolves one specific pinned version
// (a plan's own plan_template_version_id/execution_template_version_id),
// regardless of whether it's still the active one.
exports.getVersion = async (req, res) => {
  try {
    const version = await TemplateVersion.findByPk(req.params.id);
    if (!version) {
      return res.status(404).send({ message: `未找到模板版本 id=${req.params.id}。` });
    }
    return res.send(version);
  } catch (err) {
    return res.status(500).send({ message: err.message || "查询模板版本时发生错误。" });
  }
};
