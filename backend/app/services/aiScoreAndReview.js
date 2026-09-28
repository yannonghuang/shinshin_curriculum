// AI 打分加点评 (super only): one background batch that brings every
// submitted plan (same scope as AI 打分 and bulk AI 点评) up to date on both
// -- a plan is queued when it lacks an up-to-date AI score (aiPlanScoring.js
// #isUpToDate: current standard, current content) or an up-to-date
// whole-plan AI review (aiPlanReview.js#findCandidates' reviewedCurrent).
//
// The point is token economics: a plan missing both gets ONE LLM turn
// (scoreAndReviewPlan) that does the 目标一致性与完整性核查, the scoring and
// the review together -- the plan content, the standard and the objectives
// are sent once instead of three times (check + score + review), with no
// knowledge-base tool rounds. A plan missing only one half falls back to
// that half's own path (aiPlanScoring.js#scorePlan, or
// aiPlanReview.js#generateAiReview handed the current score), rather than
// paying for output that would just duplicate an up-to-date row.
const db = require("../models");
const llmClient = require("./llmClient");
const planContext = require("./planContext");
const planConsistency = require("./planConsistency");
const aiReviewStandard = require("./aiReviewStandard");
const aiPlanScoring = require("./aiPlanScoring");
const aiPlanReview = require("./aiPlanReview");

const { Op } = db.Sequelize;
const Plan = db.plan;
const Review = db.review;
const AiPlanScore = db.aiPlanScore;

const CONCURRENCY = 2;

const JSON_MARKER = "<<<JSON>>>";
const REVIEW_MARKER = "<<<REVIEW>>>";

// Built from the same rule blocks as the single-purpose prompts
// (aiPlanScoring.js's SCORING_RULES, aiPlanReview.js's REVIEW_SECTIONS/
// REVIEW_RULES/CONSISTENCY_REVIEW_SECTION, planConsistency.js's
// INLINE_INSTRUCTIONS), so a combined score/review follows exactly the rules
// a separate one would. Two delimited parts rather than one JSON object:
// an 800字 markdown review inside a JSON string is where escaping breaks.
function systemPrompt(consistency) {
  const parts = [
    "你是乡土课程评价专家。请严格依据给定的「乡土课程 AI 点评评分标准」，对一份乡土课程（设计方案及各课时实施记录）在同一次回复中完成" +
      (consistency ? "目标一致性与完整性核查、逐维度打分和文字点评三项工作。\n" : "逐维度打分和文字点评两项工作。\n"),
  ];
  if (consistency) {
    parts.push(
      "【一、目标一致性与完整性核查】\n" +
        (consistency.inline
          ? `${planConsistency.INLINE_INSTRUCTIONS}\n`
          : "课程材料前已附核查结果，直接采用，JSON 中的 consistency 省略即可。\n")
    );
  }
  parts.push(`【${consistency ? "二" : "一"}、打分】要求：\n${aiPlanScoring.SCORING_RULES}`);
  parts.push(
    `【${consistency ? "三" : "二"}、点评】用中文，400-800字，使用如下标题分部分撰写：\n` +
      aiPlanReview.REVIEW_SECTIONS +
      (consistency ? aiPlanReview.CONSISTENCY_REVIEW_SECTION : "") +
      "点评对各维度优劣的判断必须与本次打分一致。\n" +
      aiPlanReview.REVIEW_RULES
  );
  parts.push(
    "输出格式：严格按以下两段输出，不要使用代码块标记，不要有其他文字：\n" +
      `${JSON_MARKER}\n` +
      `{${consistency && consistency.inline ? '"consistency": {"uncovered": ["..."], "orphans": ["第1课时：..."], "otherIssues": ["..."]}, ' : ""}` +
      '"dimensions": [{"name": "...", "level": "良好", "score": 16, "rationale": "..."}], "summary": "..."}\n' +
      `${REVIEW_MARKER}\n` +
      "（点评正文）"
  );
  return parts.join("\n");
}

function parseReply(text) {
  const raw = text || "";
  const at = raw.indexOf(REVIEW_MARKER);
  if (at < 0) throw new Error("AI 回复缺少点评部分");
  const jsonPart = raw
    .slice(0, at)
    .replace(JSON_MARKER, "")
    .trim()
    .replace(/^```(?:json)?\s*|\s*```$/g, "")
    .trim();
  const review = raw.slice(at + REVIEW_MARKER.length).trim();
  if (!review) throw new Error("AI 回复的点评内容为空");
  return { parsed: JSON.parse(jsonPart), review };
}

// One LLM turn -> one AiPlanScore + one whole-plan AI Review, both stamped
// with the same content version and standard. Both rows are written only
// once the whole reply parses, so a malformed reply leaves neither half.
// Review history isn't sent: the score must reflect the plan itself, not a
// previous opinion of it (see aiPlanScoring.js's header).
async function scoreAndReviewPlan(planId, standard, userId) {
  const plan = await aiPlanReview.loadPlan(planId);
  if (!plan) throw new Error("课程不存在");

  const planText = await planContext.buildWholePlanContentText(plan);
  const consistency = planConsistency.combinedTurnInput(plan);
  const preamble = [aiPlanReview.standardText(standard), consistency && consistency.text].filter(Boolean).join("\n\n");

  const result = await llmClient.llmChat({
    systemPrompt: systemPrompt(consistency),
    messages: [{ role: "user", content: `${preamble}\n\n课程材料：\n${planText}` }],
    // Score JSON (~2k) + review (~2.5k) + consistency part and findings.
    maxTokens: 6144,
    temperature: 0, // the score half must be reproducible, as in AI 打分
  });

  const { parsed, review } = parseReply(result.text);
  const { dimensionScores, totalScore, summary } = aiPlanScoring.reconcile(standard.content, parsed);

  return db.sequelize.transaction(async (transaction) => {
    const score = await AiPlanScore.create(
      {
        planId,
        standardId: standard.id,
        totalScore,
        dimensionScores,
        summary,
        aiModel: result.model,
        planVersionAt: plan.contentVersionAt,
        createdBy: userId || null,
      },
      { transaction }
    );
    const row = await Review.create(
      {
        planId,
        lessonIndex: null,
        reviewerType: "ai",
        reviewerId: null,
        sectionKey: aiPlanReview.WHOLE_PLAN_SECTION_KEY,
        score: null,
        content: review,
        aiModel: result.model,
        planVersionAt: plan.contentVersionAt,
        standardId: standard.id,
        teacherSeenAt: null,
      },
      { transaction }
    );
    return { score, review: row };
  });
}

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
        if (item.needsScore && item.needsReview) {
          setStep(item, "combined");
          await scoreAndReviewPlan(item.planId, standard, userId);
          current.combined += 1;
          current.scored += 1;
          current.reviewed += 1;
        } else if (item.needsScore) {
          setStep(item, "score");
          await aiPlanScoring.scorePlan(item.planId, standard, userId);
          current.scored += 1;
        } else {
          setStep(item, "review");
          const plan = await aiPlanReview.loadPlan(item.planId);
          if (!plan) throw new Error("课程不存在");
          // Its score is up to date (or it wouldn't be review-only), so
          // the review is handed it to agree with.
          const score = (await aiPlanScoring.latestScoresByPlan([item.planId])).get(item.planId);
          await aiPlanReview.generateAiReview(plan, { wholePlan: true, standard, score });
          current.reviewed += 1;
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

module.exports = { findCandidates, startBatch, getJobStatus, isRunning, scoreAndReviewPlan };
