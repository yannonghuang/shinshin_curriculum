// AI 打分: scores every submitted plan (see findScorablePlanIds) against
// the AI 点评标准 currently in effect (aiReviewStandard.js) -- the same
// rubric for every plan, so scores are comparable across plans. The plan's
// own content (design + every lesson's 实施记录, via planContext.js) is the
// only evidence; existing reviews (AI or expert) aren't fed to the scorer,
// so a score reflects the plan itself rather than a previous opinion of it.
// The one exception is the 目标一致性与完整性核查 (planConsistency.js) -- not
// an opinion but a structured reading of the design itself, fed to AI 点评
// too so both judge the plan's consistency from the same findings.
const db = require("../models");
const { Op } = db.Sequelize;
const Plan = db.plan;
const Review = db.review;
const AiPlanScore = db.aiPlanScore;
const AiReviewStandard = db.aiReviewStandard;
const llmClient = require("./llmClient");
const planContext = require("./planContext");
const planConsistency = require("./planConsistency");

const CONCURRENCY = 2;

// Rules 1-6 are shared with the combined 打分加点评 turn
// (aiScoreAndReview.js), so a score produced there follows the same rules.
const SCORING_RULES =
  "1. 只依据评分标准中的评分要点与等级描述打分，不要引入标准以外的评判依据；\n" +
  "2. 只依据课程材料中实际呈现的内容，信息缺失的部分按标准中的评分说明处理，不要臆测；\n" +
  "3. 每个维度先判定等级（level，须为该维度等级描述中的等级名称），再在该等级分数区间内给出分数（score，可含一位小数，不得超过该维度分值）；\n" +
  "4. rationale 用 1-3 句话说明打分理由，引用课程中的具体内容作为证据；\n" +
  "5. summary 用 2-4 句话总结该课程的主要优点与最需要改进之处；\n" +
  `6. 如课程材料前附有目标一致性与完整性核查：${planConsistency.PRINCIPLE}` +
  "核查发现的未落实的总体目标、无对应的课时目标、未填写的目标或课时等问题，必须在评分标准中与学习目标、课程设计或其一致性/完整性相关的维度中体现为扣分，并在该维度的 rationale 中具体指出；" +
  "存在此类问题时 summary 也须提及。核查结果显示一致且完整时，不因此扣分。\n" +
  "dimensions 必须与评分标准的维度一一对应、顺序一致、名称一致。全文不得提及任何人名。\n";

const SYSTEM_PROMPT =
  "你是乡土课程评价专家。请严格按照给定的「乡土课程 AI 点评评分标准」，对一份乡土课程（设计方案及各课时实施记录）逐维度打分。\n" +
  "要求：\n" +
  SCORING_RULES +
  "严格以 JSON 格式回复，不要包含其他文字或代码块标记：" +
  '{"dimensions": [{"name": "...", "level": "良好", "score": 16, "rationale": "..."}], "summary": "..."}';

const round1 = (n) => Math.round(n * 10) / 10;

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

// Maps the model's per-dimension output back onto the standard's own
// dimensions (by name, falling back to position) and clamps each score to
// [0, weight] -- the total is always computed here, never taken from the
// model, so it can't drift from the dimension scores.
function reconcile(standardContent, parsed) {
  const given = Array.isArray(parsed.dimensions) ? parsed.dimensions : [];
  const dimensionScores = standardContent.dimensions.map((d, i) => {
    const hit = given.find((g) => g && g.name === d.name) || given[i];
    if (!hit) throw new Error(`缺少维度「${d.name}」的评分`);
    const raw = Number(hit.score);
    if (!Number.isFinite(raw)) throw new Error(`维度「${d.name}」的分数无效`);
    return {
      name: d.name,
      weight: d.weight,
      score: round1(Math.min(Math.max(raw, 0), d.weight)),
      level: String(hit.level || "").trim(),
      rationale: String(hit.rationale || "").trim(),
    };
  });
  const totalScore = round1(dimensionScores.reduce((sum, d) => sum + d.score, 0));
  return { dimensionScores, totalScore, summary: String(parsed.summary || "").trim() };
}

async function scorePlan(planId, standard, userId) {
  const plan = await Plan.findByPk(planId, { include: planIncludes });
  if (!plan) throw new Error("课程不存在");

  const [planText, consistency] = await Promise.all([
    planContext.buildWholePlanContentText(plan),
    planConsistency.checkPlan(plan),
  ]);
  const consistencyText = planConsistency.reportText(consistency);
  const result = await llmClient.llmChat({
    systemPrompt: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `评分标准（版本 #${standard.id}）：\n${JSON.stringify(standard.content)}${consistencyText ? `\n\n${consistencyText}` : ""}\n\n课程材料：\n${planText}`,
      },
    ],
    maxTokens: 2048,
    temperature: 0, // same standard + same content should give the same score
  });

  const cleaned = (result.text || "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const { dimensionScores, totalScore, summary } = reconcile(standard.content, JSON.parse(cleaned));

  return AiPlanScore.create({
    planId,
    standardId: standard.id,
    totalScore,
    dimensionScores,
    summary,
    aiModel: result.model,
    planVersionAt: plan.contentVersionAt,
    createdBy: userId || null,
  });
}

// A plan is up to date when its newest score used this standard version and
// its content hasn't changed since -- rescoring it would just spend an LLM
// call to reproduce the same result.
function isUpToDate(latestScore, plan, standardId) {
  if (!latestScore || Number(latestScore.standardId) !== Number(standardId)) return false;
  const a = latestScore.planVersionAt ? new Date(latestScore.planVersionAt).getTime() : null;
  const b = plan.contentVersionAt ? new Date(plan.contentVersionAt).getTime() : null;
  return a === b;
}

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
  reconcile,
  SCORING_RULES,
};
