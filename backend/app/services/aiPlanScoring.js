// AI 打分: scores every submitted plan (see findScorablePlanIds) against
// the AI 点评标准 currently in effect (aiReviewStandard.js) -- the same
// rubric for every plan, so scores are comparable across plans. Each score
// is a single score-only turn of aiPlanEvaluation.js (the same engine AI 点评
// and AI打分加点评 use), which also does the 目标一致性与完整性核查 in that
// turn; the plan's own content is the only evidence -- existing reviews
// aren't fed to the scorer, so a score reflects the plan itself rather than
// a previous opinion of it.
const db = require("../models");
const { Op } = db.Sequelize;
const Plan = db.plan;
const Review = db.review;
const AiPlanScore = db.aiPlanScore;
const AiReviewStandard = db.aiReviewStandard;
const aiPlanEvaluation = require("./aiPlanEvaluation");

const CONCURRENCY = 2;

const planIncludes = [
  { model: db.templateVersion, as: "PlanTemplateVersion" },
  { model: db.templateVersion, as: "ExecutionTemplateVersion" },
  { model: db.user, as: "Teacher", include: [{ model: db.school, as: "School" }] },
];

// In scope: every submitted plan -- "submitted" in the same sense as
// plan.controller.js#findAll's restrictToSubmitted (status past draft, i.e.
// submitted or already reviewed) -- minus suspended ones, which an admin
// has taken out of circulation.
async function findScorablePlanIds() {
  const rows = await Plan.findAll({
    attributes: ["id"],
    where: { status: { [Op.ne]: "draft" }, suspended: false },
    raw: true,
  });
  return rows.map((r) => Number(r.id));
}

async function scorePlan(planId, standard, userId) {
  const plan = await Plan.findByPk(planId, { include: planIncludes });
  if (!plan) throw new Error("课程不存在");
  const { score } = await aiPlanEvaluation.evaluatePlan(plan, { score: true, standard, userId });
  return score;
}

// A plan is up to date when its newest score used this standard version and
// its content hasn't changed since -- rescoring it would just spend an LLM
// call to reproduce the same result.
const { isUpToDate } = aiPlanEvaluation;

async function latestScoresByPlan(planIds) {
  if (planIds.length === 0) return new Map();
  const rows = await AiPlanScore.findAll({ where: { planId: { [Op.in]: planIds } }, order: [["id", "DESC"]] });
  const map = new Map();
  for (const r of rows) if (!map.has(Number(r.planId))) map.set(Number(r.planId), r);
  return map;
}

// Process-wide batch state -- one batch at a time (a second trigger while
// one runs just reports the running one), polled by the AI 打分 page.
let job = null;

function getJobStatus() {
  if (!job) return null;
  const { promise, ...status } = job;
  return status;
}

// Guards the gap between a trigger and `job` being set (the awaits below) --
// without it two quick clicks could both pass the `running` check and start
// two batches over the same plans.
let starting = null;

function startBatch(options) {
  if (job && job.running) return Promise.resolve(getJobStatus());
  if (!starting) starting = startBatchInner(options).finally(() => (starting = null));
  return starting;
}

// Always incremental: only plans with no score yet, a score from an older
// standard version, or content edited since their last score are queued.
// There's deliberately no "force" -- scoring runs at temperature 0, so
// re-scoring an unchanged plan against the same standard just reproduces
// the same result at the cost of an LLM call per plan.
async function startBatchInner({ userId }) {
  const standard = await AiReviewStandard.findOne({ order: [["id", "DESC"]] });
  if (!standard) {
    const err = new Error("尚未制定 AI 点评标准，请先在「AI 点评标准」中生成。");
    err.status = 422;
    throw err;
  }

  const planIds = await findScorablePlanIds();
  const plans = planIds.length ? await Plan.findAll({ where: { id: { [Op.in]: planIds } } }) : [];
  const latest = await latestScoresByPlan(planIds);
  const queue = plans.filter((p) => !isUpToDate(latest.get(Number(p.id)), p, standard.id)).map((p) => p.id);

  job = {
    running: true,
    standardId: standard.id,
    total: plans.length,
    queued: queue.length,
    skipped: plans.length - queue.length,
    done: 0,
    failed: 0,
    errors: [],
    // Plans being scored right now -- a single plan takes about a minute,
    // so without this the page would sit at "0 / N" looking stuck.
    inProgress: [],
    startedAt: new Date(),
    finishedAt: null,
  };
  const current = job;
  if (queue.length === 0) {
    // Nothing to score -- finish right away so the caller gets a completed
    // job back, not a "running" one the page would briefly show a progress
    // bar for.
    current.running = false;
    current.finishedAt = new Date();
    return getJobStatus();
  }

  const worker = async () => {
    while (queue.length > 0) {
      const planId = queue.shift();
      const plan = plans.find((p) => Number(p.id) === Number(planId));
      const title = plan ? plan.title : "";
      current.inProgress.push({ planId, title });
      try {
        await scorePlan(planId, standard, userId);
        current.done += 1;
      } catch (e) {
        current.failed += 1;
        current.errors.push({ planId, title, message: e.message });
        console.error(`AI 打分失败（课程 #${planId}）:`, e.message);
      } finally {
        current.inProgress = current.inProgress.filter((p) => p.planId !== planId);
      }
    }
  };

  current.promise = Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker)).finally(() => {
    current.running = false;
    current.finishedAt = new Date();
  });

  return getJobStatus();
}

// Every in-scope plan with its newest score (null if never scored), for
// the AI 打分 table.
async function listScores() {
  const planIds = await findScorablePlanIds();
  if (planIds.length === 0) return [];
  const plans = await Plan.findAll({
    where: { id: { [Op.in]: planIds } },
    attributes: ["id", "title", "theme", "grade", "year", "season", "status", "contentVersionAt"],
    include: [
      {
        model: db.user,
        as: "Teacher",
        attributes: ["id", "username", "chineseName"],
        include: [{ model: db.school, as: "School", attributes: ["code", "name"] }],
      },
    ],
  });
  const latest = await latestScoresByPlan(planIds);
  // Same derivation as plan.controller.js#findAll's aiReviewed/
  // expertReviewed, for the AI 打分 page's AI已点评/专家已点评 toggles.
  const reviewRows = await Review.findAll({
    attributes: ["planId", "reviewerType"],
    where: { planId: { [Op.in]: planIds }, reviewerType: { [Op.in]: ["ai", "expert"] } },
    raw: true,
  });
  const aiReviewedIds = new Set(reviewRows.filter((r) => r.reviewerType === "ai").map((r) => Number(r.planId)));
  const expertReviewedIds = new Set(reviewRows.filter((r) => r.reviewerType === "expert").map((r) => Number(r.planId)));

  return plans
    .map((p) => {
      const s = latest.get(Number(p.id));
      return {
        planId: p.id,
        title: p.title,
        theme: p.theme,
        grade: p.grade,
        year: p.year,
        season: p.season,
        status: p.status,
        aiReviewed: aiReviewedIds.has(Number(p.id)),
        expertReviewed: expertReviewedIds.has(Number(p.id)),
        teacherName: p.Teacher ? p.Teacher.chineseName || p.Teacher.username : "",
        schoolCode: p.Teacher && p.Teacher.School ? p.Teacher.School.code : null,
        schoolName: p.Teacher && p.Teacher.School ? p.Teacher.School.name : "",
        score: s
          ? {
              id: s.id,
              standardId: s.standardId,
              totalScore: Number(s.totalScore),
              dimensionScores: s.dimensionScores,
              summary: s.summary,
              aiModel: s.aiModel,
              createdAt: s.createdAt,
              contentChanged:
                (s.planVersionAt ? new Date(s.planVersionAt).getTime() : null) !==
                (p.contentVersionAt ? new Date(p.contentVersionAt).getTime() : null),
            }
          : null,
      };
    })
    .sort((a, b) => (b.score ? b.score.totalScore : -1) - (a.score ? a.score.totalScore : -1));
}

module.exports = {
  startBatch,
  getJobStatus,
  listScores,
  scorePlan,
  isUpToDate,
  latestScoresByPlan,
};
