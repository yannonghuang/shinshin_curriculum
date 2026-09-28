// AI 打分加点评 (super only): one background batch that brings every
// submitted plan (same scope as AI 打分 and bulk AI 点评) up to date on both
// -- a plan is queued when it lacks an up-to-date AI score (current
// standard, current content) or an up-to-date whole-plan AI review
// (aiPlanReview.js#findCandidates' reviewedCurrent).
//
// Every queued plan costs exactly ONE LLM turn (aiPlanEvaluation.js)
// asking for just what it's missing -- score and review together, or only
// the one half -- with the 目标一致性与完整性核查 done in the same turn.
const db = require("../models");
const aiReviewStandard = require("./aiReviewStandard");
const aiPlanScoring = require("./aiPlanScoring");
const aiPlanReview = require("./aiPlanReview");
const aiPlanEvaluation = require("./aiPlanEvaluation");

const { Op } = db.Sequelize;
const Plan = db.plan;

const CONCURRENCY = 2;

// Every submitted plan with whether it needs a score and/or a review --
// what the page previews is exactly what a run queues.
async function findCandidates(standardId) {
  const rows = await aiPlanReview.findCandidates(aiPlanReview.parseCriteria({}), standardId);
  if (rows.length === 0) return [];
  const planIds = rows.map((r) => r.planId);
  const [plans, latest] = await Promise.all([
    Plan.findAll({ where: { id: { [Op.in]: planIds } }, attributes: ["id", "contentVersionAt"] }),
    aiPlanScoring.latestScoresByPlan(planIds),
  ]);
  const planById = new Map(plans.map((p) => [Number(p.id), p]));
  return rows.map((r) => {
    const score = latest.get(r.planId);
    const plan = planById.get(r.planId);
    const needsScore = !standardId || !plan || !aiPlanScoring.isUpToDate(score, plan, standardId);
    return {
      planId: r.planId,
      title: r.title,
      teacherName: r.teacherName,
      schoolName: r.schoolName,
      year: r.year,
      season: r.season,
      grade: r.grade,
      theme: r.theme,
      completion: r.completion,
      aiScore: score ? { totalScore: Number(score.totalScore), createdAt: score.createdAt } : null,
      lastAiReview: r.lastAiReview,
      needsScore,
      needsReview: !r.reviewedCurrent,
    };
  });
}

// Process-wide batch state -- one batch at a time, polled by the page.
// Same shape and lifecycle as aiPlanScoring.js's / aiPlanReview.js's jobs.
let job = null;
let starting = null;

function getJobStatus() {
  if (!job) return null;
  const { promise, ...status } = job;
  return status;
}

function isRunning() {
  return !!(job && job.running) || !!starting;
}

function conflict(message) {
  const err = new Error(message);
  err.status = 409;
  return err;
}

function startBatch(options) {
  if (job && job.running) return Promise.resolve(getJobStatus());
  if (!starting) starting = startBatchInner(options).finally(() => (starting = null));
  return starting;
}

// The standard is fixed at batch start, as in the other two batches.
async function startBatchInner({ userId }) {
  // The other two batches write the same rows -- running alongside one
  // would score/review the same plans twice.
  const scoring = aiPlanScoring.getJobStatus();
  const reviewing = aiPlanReview.getJobStatus();
  if (scoring && scoring.running) throw conflict("「AI 打分」批量任务正在进行，请待其完成后再试。");
  if (reviewing && reviewing.running) throw conflict("批量「AI 点评」任务正在进行，请待其完成后再试。");

  const standard = await aiReviewStandard.getLatestStandard();
  if (!standard) {
    const err = new Error("尚未制定 AI 点评标准，请先在「AI 点评标准」中生成。");
    err.status = 422;
    throw err;
  }
  const candidates = await findCandidates(standard.id);
  const queue = candidates
    .filter((r) => r.needsScore || r.needsReview)
    .map((r) => ({ planId: r.planId, title: r.title, needsScore: r.needsScore, needsReview: r.needsReview }));

  job = {
    running: true,
    standardId: standard.id,
    total: candidates.length,
    queued: queue.length,
    scoreQueued: queue.filter((q) => q.needsScore).length,
    reviewQueued: queue.filter((q) => q.needsReview).length,
    // Plans that went through the one combined turn (counted in both
    // scored and reviewed too).
    combinedQueued: queue.filter((q) => q.needsScore && q.needsReview).length,
    combined: 0,
    scored: 0,
    reviewed: 0,
    done: 0,
    failed: 0,
    errors: [],
    // { planId, title, step: "combined" | "score" | "review" } -- a plan
    // takes a minute or two, so the page shows what it's doing.
    inProgress: [],
    startedAt: new Date(),
    finishedAt: null,
  };
  const current = job;
  if (queue.length === 0) {
    current.running = false;
    current.finishedAt = new Date();
    return getJobStatus();
  }

  const setStep = (item, step) => {
    current.inProgress = current.inProgress
      .filter((p) => p.planId !== item.planId)
      .concat(step ? [{ planId: item.planId, title: item.title, step }] : []);
  };

  const worker = async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      try {
        setStep(item, item.needsScore && item.needsReview ? "combined" : item.needsScore ? "score" : "review");
        const plan = await aiPlanReview.loadPlan(item.planId);
        if (!plan) throw new Error("课程不存在");
        await aiPlanEvaluation.evaluatePlan(plan, { score: item.needsScore, review: item.needsReview, standard, userId });
        if (item.needsScore && item.needsReview) current.combined += 1;
        if (item.needsScore) current.scored += 1;
        if (item.needsReview) current.reviewed += 1;
        current.done += 1;
      } catch (e) {
        current.failed += 1;
        current.errors.push({ planId: item.planId, title: item.title, message: e.message });
        console.error(`AI 打分加点评失败（课程 #${item.planId}）:`, e.message);
      } finally {
        setStep(item, null);
      }
    }
  };

  current.promise = Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker)).finally(() => {
    current.running = false;
    current.finishedAt = new Date();
  });

  return getJobStatus();
}

module.exports = { findCandidates, startBatch, getJobStatus, isRunning };
