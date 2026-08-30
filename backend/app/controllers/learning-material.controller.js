const fs = require("fs");
const path = require("path");
const multer = require("multer");
const util = require("util");

const db = require("../models");
const LearningMaterial = db.learningMaterial;
const Op = db.Sequelize.Op;

const PLAN_THEMES = db.PLAN_THEMES;
const GRADE_OPTIONS = db.GRADE_OPTIONS;

const getPagination = (page, size) => {
  const limit = size ? +size : 20;
  const offset = page ? page * limit : 0;
  return { limit, offset };
};

// Pagination envelope shape per the plan's REST conventions:
// {totalItems, rows, totalPages, currentPage}
const getPagingData = (data, page, limit) => {
  const { count: totalItems, rows } = data;
  const currentPage = page ? +page : 0;
  const totalPages = Math.ceil(totalItems / limit);
  return { totalItems, rows, totalPages, currentPage };
};

const getMaterialDirectory = () => {
  const dir = path.join(`${__dirname}/../../upload`, "LearningMaterial");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, getMaterialDirectory());
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

// multer only touches multipart/form-data requests; a plain JSON body
// (used for the external-link creation path) passes through untouched.
const uploadSingle = util.promisify(multer({ storage }).single("file"));

const inferMime = (filename = "") => {
  const ext = path.extname(filename).toLowerCase();
  if ([".jpg", ".jpeg"].includes(ext)) return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".ppt") return "application/vnd.ms-powerpoint";
  if (ext === ".pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (ext === ".doc") return "application/msword";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if ([".mp4", ".m4v"].includes(ext)) return "video/mp4";
  return "application/octet-stream";
};

exports.create = async (req, res) => {
  try {
    await uploadSingle(req, res);

    const { title, description, theme, grade, externalUrl } = req.body;
    if (!title) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(422).send({ message: "标题不能为空。" });
    }

    if (theme !== undefined && theme !== null && theme !== "" && !PLAN_THEMES.includes(theme)) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(422).send({ message: "乡土主题 无效。" });
    }
    if (grade !== undefined && grade !== null && grade !== "" && !GRADE_OPTIONS.includes(grade)) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(422).send({ message: "年级 无效。" });
    }

    const payload = {
      title,
      description: description || null,
      theme: theme || null,
      grade: grade || null,
      uploadedBy: req.userId,
    };

    if (req.file) {
      payload.materialType = "file";
      payload.attachmentPath = path.resolve(req.file.path);
      payload.attachmentName = req.file.originalname;
      payload.attachmentMime = req.file.mimetype || inferMime(req.file.originalname);
      payload.attachmentSize = req.file.size;
    } else if (externalUrl) {
      payload.materialType = "link";
      payload.externalUrl = externalUrl;
    } else {
      return res.status(422).send({ message: "请上传文件，或提供外部链接地址 externalUrl。" });
    }

    const data = await LearningMaterial.create(payload);
    return res.send(data);
  } catch (err) {
    return res.status(500).send({
      message: err.message || "创建共享学习材料时发生错误。",
    });
  }
};

exports.findAll = async (req, res) => {
  try {
    const { page, size, keyword, theme, grade, materialType } = req.query;
    const { limit, offset } = getPagination(page, size);

    const condition = {
      [Op.and]: [
        keyword
          ? {
              [Op.or]: [
                { title: { [Op.like]: `%${keyword}%` } },
                { description: { [Op.like]: `%${keyword}%` } },
              ],
            }
          : null,
        theme ? { theme: { [Op.eq]: `${theme}` } } : null,
        grade ? { grade: { [Op.eq]: `${grade}` } } : null,
        materialType ? { materialType: { [Op.eq]: `${materialType}` } } : null,
      ],
    };

    const data = await LearningMaterial.findAndCountAll({
      where: condition,
      limit,
      offset,
      order: [["id", "DESC"]],
    });

    return res.send(getPagingData(data, page, limit));
  } catch (err) {
    return res.status(500).send({
      message: err.message || "查询共享学习材料列表时发生错误。",
    });
  }
};

exports.findOne = async (req, res) => {
  try {
    const data = await LearningMaterial.findByPk(req.params.id);
    if (!data) {
      return res.status(404).send({ message: `未找到共享学习材料 id=${req.params.id}。` });
    }
    return res.send(data);
  } catch (err) {
    return res.status(500).send({
      message: err.message || `查询共享学习材料 id=${req.params.id} 时发生错误。`,
    });
  }
};

exports.download = async (req, res) => {
  try {
    const data = await LearningMaterial.findByPk(req.params.id);
    if (!data) {
      return res.status(404).send({ message: `未找到共享学习材料 id=${req.params.id}。` });
    }
    if (data.materialType !== "file" || !data.attachmentPath) {
      return res.status(422).send({ message: "该共享学习材料是外部链接，无法下载，请使用 externalUrl。" });
    }
    if (!fs.existsSync(data.attachmentPath)) {
      return res.status(404).send({ message: "文件不存在。" });
    }
    return res.download(data.attachmentPath, data.attachmentName);
  } catch (err) {
    return res.status(500).send({
      message: err.message || `下载共享学习材料 id=${req.params.id} 时发生错误。`,
    });
  }
};

exports.update = async (req, res) => {
  try {
    await uploadSingle(req, res);
    const id = req.params.id;
    const data = await LearningMaterial.findByPk(id);
    if (!data) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(404).send({ message: `未找到共享学习材料 id=${id}。` });
    }

    const { title, description, theme, grade, externalUrl } = req.body;

    if (theme !== undefined && theme !== null && theme !== "" && !PLAN_THEMES.includes(theme)) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(422).send({ message: "乡土主题 无效。" });
    }
    if (grade !== undefined && grade !== null && grade !== "" && !GRADE_OPTIONS.includes(grade)) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(422).send({ message: "年级 无效。" });
    }

    const payload = {};
    if (title !== undefined) payload.title = title;
    if (description !== undefined) payload.description = description;
    if (theme !== undefined) payload.theme = theme || null;
    if (grade !== undefined) payload.grade = grade || null;

    const oldPath = data.attachmentPath;
    if (req.file) {
      payload.materialType = "file";
      payload.attachmentPath = path.resolve(req.file.path);
      payload.attachmentName = req.file.originalname;
      payload.attachmentMime = req.file.mimetype || inferMime(req.file.originalname);
      payload.attachmentSize = req.file.size;
      payload.externalUrl = null;
    } else if (externalUrl !== undefined) {
      payload.materialType = "link";
      payload.externalUrl = externalUrl;
      payload.attachmentPath = null;
      payload.attachmentName = null;
      payload.attachmentMime = null;
      payload.attachmentSize = null;
    }

    await LearningMaterial.update(payload, { where: { id } });

    if (req.file && oldPath && fs.existsSync(oldPath)) {
      try {
        fs.unlinkSync(oldPath);
      } catch (e) {
        console.error("删除旧文件失败:", oldPath, e.message);
      }
    }

    return res.send({ message: "共享学习材料更新成功。" });
  } catch (err) {
    return res.status(500).send({
      message: err.message || `更新共享学习材料 id=${req.params.id} 时发生错误。`,
    });
  }
};

exports.delete = async (req, res) => {
  const id = req.params.id;
  try {
    const data = await LearningMaterial.findByPk(id);
    if (!data) {
      return res.status(404).send({ message: `未找到共享学习材料 id=${id}。` });
    }

    await LearningMaterial.destroy({ where: { id } });

    if (data.attachmentPath && fs.existsSync(data.attachmentPath)) {
      try {
        fs.unlinkSync(data.attachmentPath);
      } catch (e) {
        console.error("删除文件失败:", data.attachmentPath, e.message);
      }
    }

    return res.send({ message: "共享学习材料删除成功。" });
  } catch (err) {
    return res.status(500).send({
      message: err.message || `删除共享学习材料 id=${id} 时发生错误。`,
    });
  }
};
