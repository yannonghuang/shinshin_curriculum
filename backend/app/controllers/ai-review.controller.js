// AI 点评 (expert/admin only -- see ai-review.routes.js). Generating the
// standard is a single LLM call over the whole 学习资源库 and can outlast a
// reverse proxy's read timeout, so it runs in the background:
// #generateStandard only kicks it off, and the page polls #getStandard until
// `generating` goes false.
const aiReviewStandard = require("../services/aiReviewStandard");
const aiPlanScoring = require("../services/aiPlanScoring");
const aiReviewStandardDoc = require("../services/aiReviewStandardDoc");
const aiScoreAndReview = require("../services/aiScoreAndReview");

// GET /api/ai-review/standard -- the active (newest) standard, or null if
// none has been generated yet, plus the background-generation status.
exports.getStandard = async (req, res) => {
  try {
    const standard = await aiReviewStandard.getLatestStandard();
    return res.send({ standard, ...aiReviewStandard.getStatus() });
  } catch (err) {
    return res.status(500).send({ message: err.message || "查询 AI 点评标准时发生错误。" });
  }
};

// GET /api/ai-review/standard/versions -- version history, newest first.
exports.listVersions = async (req, res) => {
  try {
    return res.send(await aiReviewStandard.listVersions());
  } catch (err) {
    return res.status(500).send({ message: err.message || "查询标准版本时发生错误。" });
  }
};

// GET /api/ai-review/standard/versions/:id
exports.getVersion = async (req, res) => {
  try {
    const standard = await aiReviewStandard.getStandard(req.params.id);
    if (!standard) return res.status(404).send({ message: "标准版本不存在。" });
    return res.send(standard);
  } catch (err) {
    return res.status(500).send({ message: err.message || "查询标准版本时发生错误。" });
  }
};

// GET /api/ai-review/standard/versions/:id/export -- that version as a
// Word document (see services/aiReviewStandardDoc.js).
exports.exportVersion = async (req, res) => {
  try {
    const standard = await aiReviewStandard.getStandard(req.params.id);
    if (!standard) return res.status(404).send({ message: "标准版本不存在。" });
    const buffer = await aiReviewStandardDoc.generateStandardDoc(standard);
    const fileName = encodeURIComponent(`AI点评标准_版本${standard.id}.docx`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="standard-${standard.id}.docx"; filename*=UTF-8''${fileName}`);
    return res.send(buffer);
  } catch (err) {
    return res.status(500).send({ message: err.message || "导出标准时发生错误。" });
  }
};

// POST /api/ai-review/standard/check { content, baseId } -- structural
// checks plus the AI's "out of the materials' basis" cautions for a pending
// human override, and a signature #saveRevision uses to accept these same
// cautions without re-running the check.
exports.checkRevision = async (req, res) => {
  try {
    return res.send(await aiReviewStandard.checkRevision({ content: req.body.content, baseId: req.body.baseId }));
  } catch (err) {
    return res.status(err.status || 500).send({ message: err.message || "核查标准修订时发生错误。" });
  }
};

// POST /api/ai-review/standard/revisions { content, baseId, changeNote,
// cautions, signature } -- saves a human override as the new active version.
exports.saveRevision = async (req, res) => {
  try {
    const { content, baseId, changeNote, cautions, signature } = req.body;
    const standard = await aiReviewStandard.saveRevision({
      content,
      baseId,
      changeNote,
      cautions,
      signature,
      userId: req.userId,
    });
    return res.send(standard);
  } catch (err) {
    return res.status(err.status || 500).send({ message: err.message || "保存标准修订时发生错误。" });
  }
};

// POST /api/ai-review/standard/generate -- starts (or joins) a background
// generation. Each completed run inserts a new standard version rather than
// overwriting, see ai-review-standard.model.js.
exports.generateStandard = async (req, res) => {
  try {
    aiReviewStandard.startGeneration(req.userId);
    return res.status(202).send(aiReviewStandard.getStatus());
  } catch (err) {
    return res.status(500).send({ message: err.message || "生成 AI 点评标准时发生错误。" });
  }
};

// GET /api/ai-review/scores -- every submitted plan with its newest AI
// score (read-only: scores are produced by 请AI点评 and AI 打分加点评).
exports.getScores = async (req, res) => {
  try {
    const [plans, standard] = await Promise.all([aiPlanScoring.listScores(), aiReviewStandard.getLatestStandard()]);
    return res.send({ plans, standard: standard ? { id: standard.id, content: standard.content } : null });
  } catch (err) {
    return res.status(500).send({ message: err.message || "查询 AI 打分结果时发生错误。" });
  }
};

// GET /api/ai-review/score-review?minCompletion=&maxCompletion=&minScore=&maxScore=
// -- every submitted plan flagged with whether its current AI evaluation
// still needs a score and/or a review and whether it's `matched` (passes
// the filters and needs something), plus the current/last AI 打分加点评
// batch status (admin and super).
exports.getScoreReviewCandidates = async (req, res) => {
  try {
    const standard = await aiReviewStandard.getLatestStandard();
    const plans = await aiScoreAndReview.findCandidates(standard, aiScoreAndReview.parseCriteria(req.query));
    return res.send({
      plans,
      job: aiScoreAndReview.getJobStatus(),
      standard: standard ? { id: standard.id, totalScore: standard.content.totalScore } : null,
    });
  } catch (err) {
    return res.status(500).send({ message: err.message || "查询 AI 打分加点评课程时发生错误。" });
  }
};

// POST /api/ai-review/score-review/run { minCompletion, maxCompletion,
// minScore, maxScore } -- starts the background batch bringing every
// matching plan's AI evaluation up to date; the matches are recomputed
// server-side with the same filters the preview used.
exports.runScoreReview = async (req, res) => {
  try {
    const job = await aiScoreAndReview.startBatch({ userId: req.userId, criteria: aiScoreAndReview.parseCriteria(req.body) });
    return res.status(202).send(job);
  } catch (err) {
    return res.status(err.status || 500).send({ message: err.message || "启动 AI 打分加点评时发生错误。" });
  }
};
