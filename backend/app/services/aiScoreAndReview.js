// AI 打分加点评 -- the AI menu's one page for AI scores and reviews:
// experts read it, admins (super included) can also run the batch that
// produces them. Every submitted plan is listed with its current AI
// evaluation (aiPlanEvaluation.js: the score and plan-scope review of its
// current content under the standard in effect) and whether that
// evaluation still needs a score and/or a review. The page filters and
// sorts client-side; a run is given the ids of the plans it shows, and each
// goes through ensureEvaluation -- one LLM turn producing just what's
// missing, with the 目标一致性与完整性核查 in that turn -- the same path
// 请AI点评 uses, so the two share one source of truth.
const db = require("../models");
const dashboard = require("./dashboard");
const aiReviewStandard = require("./aiReviewStandard");
const aiPlanEvaluation = require("./aiPlanEvaluation");

const { Op } = db.Sequelize;
const Plan = db.plan;
const Review = db.review;

const CONCURRENCY = 2;

const timeOf = (d) => (d ? new Date(d).getTime() : null);

// Every submitted, non-suspended plan (dashboard.js#buildRows, so 完成度
// and the score match 数据看板) with its newest AI score and review, the
// AI已点评/专家已点评 flags, and needsScore/needsReview from the same
// current-evaluation lookup ensureEvaluation uses.
async function listPlans(standard) {
  const rows = await dashboard.buildRows({ submittedOnly: true });
  if (rows.length === 0) return [];
  const planIds = rows.map((r) => r.planId);
  const [plans, aiReviews] = await Promise.all([
    Plan.findAll({ where: { id: { [Op.in]: planIds } }, attributes: ["id", "contentVersionAt"] }),
    Review.findAll({
      where: { planId: { [Op.in]: planIds }, reviewerType: "ai", sectionKey: null, lessonIndex: null },
      attributes: ["id", "planId", "content", "planVersionAt", "standardId", "createdAt"],
      order: [["id", "DESC"]],
    }),
  ]);
  const current = await aiPlanEvaluation.currentEvaluations(plans, standard);
  const versionOf = new Map(plans.map((p) => [Number(p.id), timeOf(p.contentVersionAt)]));
  const latestReview = new Map();
  aiReviews.forEach((r) => {
    if (!latestReview.has(Number(r.planId))) latestReview.set(Number(r.planId), r);
  });

  return rows.map((r) => {
    const rv = latestReview.get(r.planId);
    const cur = current.get(r.planId) || {};
    return {
      planId: r.planId,
      title: r.title,
      teacherName: r.teacherName,
      schoolCode: r.schoolCode,
      schoolName: r.schoolName,
      year: r.year,
      season: r.season,
      grade: r.grade,
      theme: r.theme,
      completion: r.completion,
      score: r.aiScore,
      review: rv
        ? {
            id: rv.id,
            content: rv.content,
            standardId: rv.standardId,
            createdAt: rv.createdAt,
            contentChanged: timeOf(rv.planVersionAt) !== versionOf.get(r.planId),
            outdatedStandard: !standard || Number(rv.standardId) !== Number(standard.id),
          }
        : null,
      aiReviewed: r.aiReviewed,
      expertReviewed: r.expertReviews.count > 0,
      needsScore: !!standard && !cur.score,
      needsReview: !cur.review,
    };
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
// under the same version even if 重新生成 lands mid-run. `planIds`: the
// plans the page shows (its filters applied); of those, the ones still
// needing a score or review are queued -- recomputed here, not trusted
// from the page.
async function startBatchInner({ userId, planIds }) {
  const standard = await aiReviewStandard.getLatestStandard();
  if (!standard) {
    const err = new Error("尚未制定 AI 点评标准，请先在「AI 点评标准」中生成。");
    err.status = 422;
    throw err;
  }
  const wanted = new Set((planIds || []).map(Number));
  const candidates = (await listPlans(standard)).filter((r) => wanted.has(r.planId));
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

module.exports = { listPlans, startBatch, getJobStatus };
