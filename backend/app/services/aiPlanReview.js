// AI 点评 generation, shared by the teacher's own per-plan request
// (review.controller.js#createAiReview) and the admin's bulk AI 点评 below --
// both write the same kind of Review row from the same prompt, so a bulk
// review reads exactly like one the teacher asked for.
//
// Every AI 点评 goes through aiPlanEvaluation.js (the same engine AI 打分
// and AI打分加点评 use), which also does the 目标一致性与完整性核查 in the
// same turn. Bulk AI 点评 is one LLM call per plan; a teacher's own
// 请AI点评 (knowledgeTool) may additionally search 学习资源库 over extra
// tool rounds, as it always could.
//
// Plan scope only: an AI review is about the 计划 (课程设计方案 incl.
// 分课时设计) and is filed under 计划整体点评 (sectionKey null, lessonIndex
// null); 实施 has no AI for now.
//
// Bulk AI 点评 (admin only): a background batch writing a plan-scope AI
// review for every submitted plan matching the admin's criteria on
// 完成度 and AI 打分 -- see #findCandidates.
const db = require("../models");
const dashboard = require("./dashboard");
const aiReviewStandard = require("./aiReviewStandard");
const aiPlanEvaluation = require("./aiPlanEvaluation");

const { Op } = db.Sequelize;
const Plan = db.plan;
const Review = db.review;

const CONCURRENCY = 2;

const planIncludes = [
  { model: db.templateVersion, as: "PlanTemplateVersion" },
  { model: db.templateVersion, as: "ExecutionTemplateVersion" },
  { model: db.user, as: "Teacher", include: [{ model: db.school, as: "School" }] },
];

const loadPlan = (planId) => Plan.findByPk(planId, { include: planIncludes });

// `plan` must be loaded with planIncludes. seenByTeacher: the teacher asked for this review themselves, so it isn't
// "new" to them (see review.model.js's teacherSeenAt). `standard` defaults
// to the one in effect; the version used is stored on the review
// (standardId, null for a fallback-prompt review). knowledgeTool: see
// aiPlanEvaluation.js#evaluatePlan.
//
// scoreIfMissing (请AI点评): when the plan has no up-to-date AI score
// (current standard, current content), the same turn scores it too -- the
// score is stored for experts/admins only (AI 打分, 数据看板, the plan
// page's AI 打分 panel) and never returned here, so the caller -- possibly
// the owning teacher -- only ever gets the review back.
async function generateAiReview(plan, { seenByTeacher, standard, knowledgeTool = false, scoreIfMissing = false, userId = null }) {
  const std = standard === undefined ? await aiReviewStandard.getLatestStandard() : standard;
  const score = scoreIfMissing && !!std && !(await aiPlanEvaluation.currentScore(plan, std));
  const { review } = await aiPlanEvaluation.evaluatePlan(plan, {
    score,
    review: true,
    standard: std,
    seenByTeacher,
    knowledgeTool,
    userId,
  });
  return review;
}

// ---- Bulk AI 点评 ----

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
    // Default on: a plan whose current content already has a plan-scope
    // AI review written against the current standard would just get a
    // second one saying much the same.
    skipReviewed: !(raw.skipReviewed === false || raw.skipReviewed === "false" || raw.skipReviewed === "0"),
  };
}

// Any AI-score bound excludes unscored plans -- "score ≥ 60" can't be
// judged for a plan with no score.
function matches(row, c) {
  const pct = row.completion.overall;
  if (c.minCompletion !== null && pct < c.minCompletion) return false;
  if (c.maxCompletion !== null && pct > c.maxCompletion) return false;
  if (c.minScore !== null || c.maxScore !== null) {
    if (!row.aiScore) return false;
    if (c.minScore !== null && row.aiScore.totalScore < c.minScore) return false;
    if (c.maxScore !== null && row.aiScore.totalScore > c.maxScore) return false;
  }
  if (c.skipReviewed && row.reviewedCurrent) return false;
  return true;
}

// Every submitted, non-suspended plan (same scope as AI 打分, see
// aiPlanScoring.js#findScorablePlanIds) with its 完成度 and newest AI
// score -- built from dashboard.js#buildRows so the numbers match 数据看板
// -- plus whether it already has a plan-scope AI review that's up to date
// (written on its current content, against the standard in effect),
// flagged `matched` against the criteria. Both the page's preview and the
// batch itself select plans through here, so what's previewed is what runs.
async function findCandidates(criteria, standardId) {
  const rows = await dashboard.buildRows({ submittedOnly: true });
  if (rows.length === 0) return [];
  const planIds = rows.map((r) => r.planId);
  const [plans, aiReviews] = await Promise.all([
    Plan.findAll({ where: { id: { [Op.in]: planIds } }, attributes: ["id", "contentVersionAt"], raw: true }),
    Review.findAll({
      where: { planId: { [Op.in]: planIds }, reviewerType: "ai", sectionKey: null, lessonIndex: null },
      attributes: ["planId", "planVersionAt", "standardId", "createdAt"],
      order: [["id", "DESC"]],
      raw: true,
    }),
  ]);
  const versionOf = new Map(plans.map((p) => [Number(p.id), timeOf(p.contentVersionAt)]));
  const latestReview = new Map();
  aiReviews.forEach((r) => {
    if (!latestReview.has(Number(r.planId))) latestReview.set(Number(r.planId), r);
  });

  return rows.map((r) => {
    const review = latestReview.get(r.planId);
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
            outdatedStandard: Number(review.standardId) !== Number(standardId),
          }
        : null,
    };
    row.reviewedCurrent = !!row.lastAiReview && !row.lastAiReview.contentChanged && !row.lastAiReview.outdatedStandard;
    row.matched = matches(row, criteria);
    return row;
  });
}

// Process-wide batch state -- one batch at a time, polled by the page.
// Same shape and lifecycle as aiPlanScoring.js's job.
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

// The standard is fixed at batch start, so every review in one batch is
// written against the same version even if 重新生成 lands mid-run.
async function startBatchInner({ criteria }) {
  const standard = await aiReviewStandard.getLatestStandard();
  if (!standard) {
    const err = new Error("尚未制定 AI 点评标准，请先在「AI 点评标准」中生成。");
    err.status = 422;
    throw err;
  }
  const queue = (await findCandidates(criteria, standard.id))
    .filter((r) => r.matched)
    .map((r) => ({ planId: r.planId, title: r.title }));

  job = {
    running: true,
    criteria,
    standardId: standard.id,
    queued: queue.length,
    done: 0,
    failed: 0,
    errors: [],
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

  const worker = async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      current.inProgress.push(item);
      try {
        const plan = await loadPlan(item.planId);
        if (!plan) throw new Error("课程不存在");
        await generateAiReview(plan, { standard });
        current.done += 1;
      } catch (e) {
        current.failed += 1;
        current.errors.push({ ...item, message: e.message });
        console.error(`批量 AI 点评失败（课程 #${item.planId}）:`, e.message);
      } finally {
        current.inProgress = current.inProgress.filter((p) => p.planId !== item.planId);
      }
    }
  };

  current.promise = Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker)).finally(() => {
    current.running = false;
    current.finishedAt = new Date();
  });

  return getJobStatus();
}

module.exports = {
  loadPlan,
  generateAiReview,
  parseCriteria,
  findCandidates,
  startBatch,
  getJobStatus,
};
