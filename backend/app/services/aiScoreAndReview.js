// AI 打分加点评 (admin and super): the one batch that produces AI output --
// it brings every submitted plan matching the page's filters up to date on
// its current AI evaluation (aiPlanEvaluation.js: the score and plan-scope
// review for its current content under the standard in effect). What a plan
// needs is decided by the same lookup the button (请AI点评) uses, and each
// plan goes through ensureEvaluation -- one LLM turn producing just what's
// missing, with the 目标一致性与完整性核查 in that turn -- so the two paths
// share one source of truth and can't duplicate each other's work.
const db = require("../models");
const dashboard = require("./dashboard");
const aiReviewStandard = require("./aiReviewStandard");
const aiPlanEvaluation = require("./aiPlanEvaluation");

const { Op } = db.Sequelize;
const Plan = db.plan;
const Review = db.review;

const CONCURRENCY = 2;

const timeOf = (d) => (d ? new Date(d).getTime() : null);

// Blank/absent bounds mean "no limit". Completion is a 0-100 percentage,
// the AI score 0..满分 -- out-of-range bounds are clamped by the
// comparisons themselves, not rejected.
function parseCriteria(raw = {}) {
  const num = (v) => {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    minCompletion: num(raw.minCompletion),
    maxCompletion: num(raw.maxCompletion),
    minScore: num(raw.minScore),
    maxScore: num(raw.maxScore),
  };
}

// Any AI-score bound excludes unscored plans -- "score ≥ 60" can't be
// judged for a plan with no score.
function passesFilters(row, c) {
  const pct = row.completion.overall;
  if (c.minCompletion !== null && pct < c.minCompletion) return false;
  if (c.maxCompletion !== null && pct > c.maxCompletion) return false;
  if (c.minScore !== null || c.maxScore !== null) {
    if (!row.aiScore) return false;
    if (c.minScore !== null && row.aiScore.totalScore < c.minScore) return false;
    if (c.maxScore !== null && row.aiScore.totalScore > c.maxScore) return false;
  }
  return true;
}

// Every submitted, non-suspended plan (dashboard.js#buildRows, so 完成度
// and the newest AI score match 数据看板) with its newest AI review for
// display, whether its current evaluation still lacks a score and/or a
// review, and `matched`: passes the filters AND needs something. Both the
// page's preview and the batch select plans through here, so what's
// previewed is what runs.
async function findCandidates(standard, criteria) {
  const rows = await dashboard.buildRows({ submittedOnly: true });
  if (rows.length === 0) return [];
  const planIds = rows.map((r) => r.planId);
  const [plans, aiReviews] = await Promise.all([
    Plan.findAll({ where: { id: { [Op.in]: planIds } }, attributes: ["id", "contentVersionAt"] }),
    Review.findAll({
      where: { planId: { [Op.in]: planIds }, reviewerType: "ai", sectionKey: null, lessonIndex: null },
      attributes: ["planId", "planVersionAt", "standardId", "createdAt"],
      order: [["id", "DESC"]],
      raw: true,
    }),
  ]);
  const current = await aiPlanEvaluation.currentEvaluations(plans, standard);
  const versionOf = new Map(plans.map((p) => [Number(p.id), timeOf(p.contentVersionAt)]));
  const latestReview = new Map();
  aiReviews.forEach((r) => {
    if (!latestReview.has(Number(r.planId))) latestReview.set(Number(r.planId), r);
  });

  return rows.map((r) => {
    const review = latestReview.get(r.planId);
    const cur = current.get(r.planId) || {};
    const row = {
      planId: r.planId,
      title: r.title,
      teacherName: r.teacherName,
      schoolName: r.schoolName,
      year: r.year,
      season: r.season,
      grade: r.grade,
      theme: r.theme,
      completion: r.completion,
      aiScore: r.aiScore ? { totalScore: r.aiScore.totalScore, outdatedStandard: r.aiScore.outdatedStandard } : null,
      lastAiReview: review
        ? {
            createdAt: review.createdAt,
            standardId: review.standardId,
            contentChanged: timeOf(review.planVersionAt) !== versionOf.get(r.planId),
            outdatedStandard: !standard || Number(review.standardId) !== Number(standard.id),
          }
        : null,
      needsScore: !!standard && !cur.score,
      needsReview: !cur.review,
    };
    row.matched = passesFilters(row, criteria) && (row.needsScore || row.needsReview);
    return row;
  });
}

// Process-wide batch state -- one batch at a time (a second trigger while
// one runs just reports the running one), polled by the page.
let job = null;
let starting = null;

function getJobStatus() {
  if (!job) return null;
  const { promise, ...status } = job;
  return status;
}

function startBatch(options) {
  if (job && job.running) return Promise.resolve(getJobStatus());
  if (!starting) starting = startBatchInner(options).finally(() => (starting = null));
  return starting;
}

// The standard is fixed at batch start, so every row a batch writes is
// under the same version even if 重新生成 lands mid-run.
async function startBatchInner({ userId, criteria }) {
  const standard = await aiReviewStandard.getLatestStandard();
  if (!standard) {
    const err = new Error("尚未制定 AI 点评标准，请先在「AI 点评标准」中生成。");
    err.status = 422;
    throw err;
  }
  const candidates = await findCandidates(standard, criteria);
  const queue = candidates
    .filter((r) => r.matched)
    .map((r) => ({ planId: r.planId, title: r.title, needsScore: r.needsScore, needsReview: r.needsReview }));

  job = {
    running: true,
    standardId: standard.id,
    criteria,
    total: candidates.length,
    queued: queue.length,
    scoreQueued: queue.filter((q) => q.needsScore).length,
    reviewQueued: queue.filter((q) => q.needsReview).length,
    // Plans whose score and review came from one combined turn (counted in
    // scored and reviewed too).
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
        const plan = await aiPlanEvaluation.loadPlan(item.planId);
        if (!plan) throw new Error("课程不存在");
        // ensureEvaluation re-checks under the plan's lock -- if a 请AI点评
        // click filled in a half since the preview, it isn't redone.
        const before = { score: item.needsScore, review: item.needsReview };
        const result = await aiPlanEvaluation.ensureEvaluation(plan, { standard, userId, want: before });
        if (result.generated) {
          if (before.score && before.review) current.combined += 1;
          if (before.score) current.scored += 1;
          if (before.review) current.reviewed += 1;
        }
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

module.exports = { parseCriteria, findCandidates, startBatch, getJobStatus };
