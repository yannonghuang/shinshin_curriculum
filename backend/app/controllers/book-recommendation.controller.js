const util = require("util");
const multer = require("multer");
const bookRecommendation = require("../services/bookRecommendation");
const bookRecommendationExport = require("../services/bookRecommendationExport");

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const uploadSingle = util.promisify(multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } }).single("file"));

const fail = (res, err, fallback) => res.status(err.status || 500).send({ message: err.message || fallback });

// GET /api/book-recommendations/options -- stages for the form, plus each
// school's province (fixed, from its address) and default stages.
exports.options = async (req, res) => {
  try {
    const db = require("../models");
    const schools = await db.school.findAll({ order: [["code", "ASC"]] });
    return res.send({
      stages: bookRecommendation.STAGES,
      schools: schools.map((s) => ({
        code: s.code,
        name: s.name,
        address: s.address,
        province: bookRecommendation.provinceOf(s),
        stages: bookRecommendation.stagesOf(s),
      })),
    });
  } catch (err) {
    return fail(res, err, "加载选项时发生错误。");
  }
};

// POST /api/book-recommendations/runs (multipart: file, schoolCode,
// stages as a JSON array) -- parses the book list and starts a background
// run for the school's own province; poll GET .../runs/:id.
exports.start = async (req, res) => {
  try {
    await uploadSingle(req, res);
    if (!req.file) return res.status(422).send({ message: "请上传书目文件。" });
    const fileName = Buffer.from(req.file.originalname, "latin1").toString("utf8");
    const books = await bookRecommendation.parseBookList(req.file.buffer, fileName);
    let stages = [];
    try {
      stages = JSON.parse(req.body.stages || "[]");
    } catch (e) {
      stages = [];
    }
    const run = await bookRecommendation.startRun({
      userId: req.userId,
      schoolCode: Number(req.body.schoolCode),
      stages,
      fileName,
      books,
    });
    return res.status(202).send({ id: run.id, bookCount: books.length });
  } catch (err) {
    if (err.code === "LIMIT_FILE_SIZE") return res.status(422).send({ message: "文件不能超过 5MB。" });
    return fail(res, err, "启动课外读物推荐时发生错误。");
  }
};

exports.list = async (req, res) => {
  try {
    return res.send(await bookRecommendation.listRuns());
  } catch (err) {
    return fail(res, err, "加载推荐记录时发生错误。");
  }
};

exports.get = async (req, res) => {
  try {
    return res.send(await bookRecommendation.getRun(req.params.id));
  } catch (err) {
    return fail(res, err, "加载推荐结果时发生错误。");
  }
};

exports.rerun = async (req, res) => {
  try {
    const run = await bookRecommendation.rerun(req.params.id, req.userId);
    return res.status(202).send({ id: run.id });
  } catch (err) {
    return fail(res, err, "重新运行时发生错误。");
  }
};

exports.delete = async (req, res) => {
  try {
    await bookRecommendation.deleteRun(req.params.id);
    return res.send({ message: "已删除。" });
  } catch (err) {
    return fail(res, err, "删除时发生错误。");
  }
};

// GET /api/book-recommendations/runs/:id/export?format=xlsx|docx
exports.export = async (req, res) => {
  try {
    const run = await bookRecommendation.getRun(req.params.id);
    if (run.status !== "done" || !run.result) return res.status(422).send({ message: "该次推荐尚未完成。" });
    const docx = req.query.format === "docx";
    const buffer = docx ? await bookRecommendationExport.buildDocument(run) : await bookRecommendationExport.buildWorkbook(run);
    const ext = docx ? "docx" : "xlsx";
    const fileName = encodeURIComponent(`课外读物推荐_${run.schoolName}_${run.id}.${ext}`);
    res.setHeader(
      "Content-Type",
      docx
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="book-recommendation-${run.id}.${ext}"; filename*=UTF-8''${fileName}`);
    return res.send(Buffer.from(buffer));
  } catch (err) {
    return fail(res, err, "导出时发生错误。");
  }
};

// GET /api/book-recommendations/guidances -- the cached provincial rules.
exports.guidances = async (req, res) => {
  try {
    return res.send(await bookRecommendation.listGuidances());
  } catch (err) {
    return fail(res, err, "加载地方规定时发生错误。");
  }
};

// POST /api/book-recommendations/guidances/refresh { province }
exports.refreshGuidance = async (req, res) => {
  try {
    bookRecommendation.refreshGuidance(String((req.body && req.body.province) || ""));
    return res.status(202).send({ message: "已开始重新检索。" });
  } catch (err) {
    return fail(res, err, "重新检索地方规定时发生错误。");
  }
};

// GET /api/book-recommendations/skills -- the skills' self-improvement notes.
exports.skills = async (req, res) => {
  try {
    return res.send(await bookRecommendation.getSkillNotes());
  } catch (err) {
    return fail(res, err, "加载技能经验时发生错误。");
  }
};
