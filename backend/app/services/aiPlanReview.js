// AI 点评 generation, shared by the teacher's own per-plan request
// (review.controller.js#createAiReview) and the admin's bulk AI 点评 below --
// both write the same kind of Review row from the same prompt, so a bulk
// review reads exactly like one the teacher asked for.
//
// Bulk AI 点评 (admin only): a background batch writing a whole-plan
// (实施整体点评 scope) AI review for every submitted plan matching the
// admin's criteria on 完成度 and AI 打分 -- see #findCandidates.
const db = require("../models");
const planContext = require("./planContext");
const agentLoop = require("./agentLoop");
const dashboard = require("./dashboard");
const aiReviewStandard = require("./aiReviewStandard");
const planConsistency = require("./planConsistency");
const { searchKnowledgeTree, searchKnowledgeBaseToolDef } = require("./knowledgeRetrieve");
const { MANUAL_CATEGORY } = require("../constants/materialCategories");

const { Op } = db.Sequelize;
const Plan = db.plan;
const Review = db.review;
const Artifact = db.artifact;

const CONCURRENCY = 2;
const WHOLE_PLAN_SECTION_KEY = "IMPLEMENTATION_OVERALL";

const KNOWLEDGE_TOOL_HINT =
  "如果需要参考共享学习材料库中与该课程主题或所在地区相关的资料（例如同主题的其他课程案例、专家讲解等）来支撑你的点评，可以调用 search_knowledge_base 工具查询；不需要参考资料时无需调用。";

// Every AI 点评 is written against the AI 点评标准 in effect -- the same
// rubric AI 打分 scores with (aiPlanScoring.js), so a review and a score
// of the same plan judge it by the same dimensions. The review stays
// qualitative: it names strengths/gaps per dimension but gives no score or
// level, which is AI 打分's job -- two numbers from two separate calls
// could otherwise disagree. The theme/locality part is kept (as the
// secondary part now) since that's the angle a generic rubric can't cover:
// specific to *this* plan's theme, grade and locality (surfaced in the
// content via buildBasicInfoLines' 学校/地区 line, once `plan` is loaded
// with the Teacher->School include -- see planIncludes).
//
// The section specs are shared with the combined 打分加点评 turn
// (aiScoreAndReview.js), so a review written there reads exactly like one
// written here.
const REVIEW_SECTIONS =
  "【对照评分标准的点评】（主）：按评分标准的维度顺序逐一点评，每个维度以维度名称作小标题，依据该维度的评分要点与等级描述，指出课程材料中的具体亮点与不足（引用课程中的具体内容作为证据），并给出可操作的改进建议。材料中未涉及的维度简要说明缺失即可，不要臆测。正文中不要给出分数或等级。\n" +
  "【主题与本地特色相关建议】（次，2-3条要点）：结合本课程的具体主题、年级与学校/地区，给出只针对这个主题和这个地方才成立的建议——例如可利用的本地资源、这个主题特有的风险或机会、适合本地实际的案例或调整。避免泛泛而谈、换成任何主题都适用的内容。\n";

const REVIEW_RULES = "评判只依据评分标准与课程材料，不要引入标准以外的评判依据；全文不得提及任何人名。\n";

// The closing consistency part, see planConsistency.js.
const CONSISTENCY_REVIEW_SECTION =
  "【目标一致性与完整性】：逐条指出未在任何课时落实的总体目标（建议在哪个课时补充落实）、在总体目标中找不到对应的课时目标（建议补入总体目标或调整该课时目标）、以及未填写的目标或课时，并给出具体修改建议；" +
  "目标一致且完整时，用一两句话确认即可。这部分控制在 300 字以内，不计入上面的字数要求。\n";

const STANDARD_REVIEW_SYSTEM_PROMPT =
  "你是乡土课程教学专家。请依据给定的「乡土课程 AI 点评评分标准」，对以下课程设计/实施记录做点评，用中文回复，400-800字，分成两部分，并使用如下标题：\n" +
  REVIEW_SECTIONS +
  "打分由「AI 打分」另行完成。\n" +
  REVIEW_RULES +
  KNOWLEDGE_TOOL_HINT;

// Fallback only for when no AI 点评标准 has been generated yet, so a
// teacher's own 请AI点评 still works on a fresh install -- the pre-standard
// prompt, theme/locality first with generic methodology capped (human 专家
// own that part).
const FALLBACK_REVIEW_SYSTEM_PROMPT =
  "你是乡土课程教学专家，请对以下课程设计/实施记录做点评，用中文回复，200-500字，分成两部分，并使用如下标题：\n" +
  "【主题与本地特色相关建议】（主，约占篇幅的三分之二）：结合本课程的具体主题、年级与学校/地区，给出只针对这个主题和这个地方才成立的观察——例如可利用的本地资源、这个主题特有的风险或机会、适合本地实际的案例或调整建议。避免泛泛而谈、换成任何主题都适用的内容。\n" +
  "【通用教学方法提示】（次，1-2条要点即可）：如有明显的通用教学方法（目标达成、内容设计、可操作性等）问题再简要提及，这部分通常由人类专家把关，此处从简。\n" +
  KNOWLEDGE_TOOL_HINT;

// Appended to either prompt when a 目标一致性与完整性核查 report is in the
// content (design and whole-plan scopes, see generateAiReview) -- the same
// findings AI 打分 deducts on (aiPlanScoring.js), so the review names the
// gaps the score reflects.
const CONSISTENCY_REVIEW_ADDENDUM =
  `\n另外，课程材料前附有「目标一致性与完整性核查结果」。核查原则：${planConsistency.PRINCIPLE}` +
  "请依据核查结果，在正文最后增加一部分，使用如下标题：\n" +
  CONSISTENCY_REVIEW_SECTION;

// Appended when the caller passes a current AI 打分 result for this same
// content (the combined 打分加点评 batch, for a plan whose score is up to
// date but review isn't) -- so the review's per-dimension judgement agrees
// with the score instead of two separate calls disagreeing.
const SCORE_CONTEXT_ADDENDUM =
  "\n课程材料前还附有该课程依据同一评分标准完成的「AI 打分结果」。点评对各维度优劣的判断应与打分结果保持一致，可引用其打分理由作为线索，但仍须引用课程中的具体内容作为证据；正文中不要复述分数或等级。";

function scoreText(score) {
  const lines = [`【AI 打分结果】总分 ${score.totalScore}`];
  (score.dimensionScores || []).forEach((d) =>
    lines.push(`- ${d.name}（${d.score}/${d.weight}，${d.level}）：${d.rationale}`)
  );
  if (score.summary) lines.push(`总评：${score.summary}`);
  return lines.join("\n");
}

// The standard as readable text for the prompt -- the parts a reviewer
// judges by (dimensions, 评分要点, 等级描述, 评分说明); `basis` (which
// materials each dimension was derived from) is left out, it's provenance,
// not a criterion.
function standardText(standard) {
  const c = standard.content;
  const lines = [`评分标准（版本 #${standard.id}）：${c.title || ""}`];
  if (c.overview) lines.push(c.overview);
  c.dimensions.forEach((d, i) => {
    lines.push(`\n维度${i + 1}：${d.name}（${d.weight} 分）${d.description ? `——${d.description}` : ""}`);
    (d.criteria || []).forEach((cr) => lines.push(`- 评分要点：${cr}`));
    (d.levels || []).forEach((lv) => lines.push(`- ${lv.label}（${lv.range}）：${lv.descriptor}`));
  });
  if ((c.scoringNotes || []).length) {
    lines.push("\n评分说明：");
    c.scoringNotes.forEach((n) => lines.push(`- ${n}`));
  }
  return lines.join("\n");
}

const planIncludes = [
  { model: db.templateVersion, as: "PlanTemplateVersion" },
  { model: db.templateVersion, as: "ExecutionTemplateVersion" },
  { model: db.user, as: "Teacher", include: [{ model: db.school, as: "School" }] },
];

const loadPlan = (planId) => Plan.findByPk(planId, { include: planIncludes });

// `plan` must be loaded with planIncludes. wholePlan=true is 实施/整体点评's
// scope -- combined design + every lesson's execution content (see
// planContext.js#buildWholePlanContentText), lessonIndex ignored.
// seenByTeacher: the teacher asked for this review themselves, so it isn't
// "new" to them (see review.model.js's teacherSeenAt). `standard` defaults
// to the one in effect; the version used is stored on the review
// (standardId, null for a fallback-prompt review).
// `score` (optional): an AiPlanScore row for this plan's current content,
// see SCORE_CONTEXT_ADDENDUM. Design and whole-plan scopes also get the
// 目标一致性与完整性核查 report; a single lesson's 实施记录 review doesn't --
// the check is about the design as a whole.
async function generateAiReview(plan, { wholePlan, lessonIndex, seenByTeacher, standard, score }) {
  const planId = plan.id;
  // Started up front so its LLM call overlaps the content building below;
  // a failure only drops the report (checkPlan already degrades on AI
  // errors), and never surfaces as an unhandled rejection if an await below
  // throws first.
  const consistencyPromise = (wholePlan || !lessonIndex ? planConsistency.checkPlan(plan) : Promise.resolve(null)).catch((e) => {
    console.error(`目标一致性核查失败（课程 #${planId}）:`, e.message);
    return null;
  });
  const std = standard === undefined ? await aiReviewStandard.getLatestStandard() : standard;
  let userContent;
  if (wholePlan) {
    userContent = await planContext.buildWholePlanContentText(plan);
  } else {
    let artifacts = [];
    if (lessonIndex) {
      artifacts = await Artifact.findAll({ where: { planId, lessonIndex } });
    } else if (!plan.planFormData) {
      artifacts = await Artifact.findAll({ where: { planId, lessonIndex: null } });
    }
    userContent = await planContext.buildPlanContentText(plan, lessonIndex, artifacts);
  }

  // "Entire current state" also means the plan's full review history, not
  // just its content -- otherwise every AI-review request writes as if
  // from a blank slate, unaware of what a human expert (or the AI's own
  // prior run) already said. See planContext.js#buildReviewHistoryText.
  userContent += await planContext.buildReviewHistoryText(planId);
  const consistencyText = planConsistency.reportText(await consistencyPromise);
  const preamble = [std && standardText(std), score && scoreText(score), consistencyText].filter(Boolean);
  if (preamble.length) userContent = `${preamble.join("\n\n")}\n\n课程材料：\n${userContent}`;
  let systemPrompt = std ? STANDARD_REVIEW_SYSTEM_PROMPT : FALLBACK_REVIEW_SYSTEM_PROMPT;
  if (score) systemPrompt += SCORE_CONTEXT_ADDENDUM;
  if (consistencyText) systemPrompt += CONSISTENCY_REVIEW_ADDENDUM;

  // Routed through the agent loop rather than a plain llmChat call so the
  // model can decide for itself whether this plan/lesson's content
  // warrants pulling in reference material from 共享学习材料库, instead of
  // every review being force-fed the same retrieval regardless of
  // relevance (see knowledgeRetrieve.js's searchKnowledgeBaseToolDef).
  const result = await agentLoop.runAgentLoop({
    systemPrompt,
    messages: [{ role: "user", content: userContent }],
    tools: [searchKnowledgeBaseToolDef],
    // Knowledge-tree retrieval (see knowledgeRetrieve.js#searchKnowledgeTree).
    // A review is pedagogical, so 使用指南 (system usage docs) is left out,
    // and it must not attribute anything to a named person -- no 主讲人,
    // and person names stripped from source titles.
    executors: {
      search_knowledge_base: (args) =>
        searchKnowledgeTree(args.query, { excludeCategories: [MANUAL_CATEGORY], includeTopicMeta: false, redact: true }),
    },
    // The system prompt asks for 200-500字, but real replies sometimes run
    // past their own target once markdown formatting is counted -- a
    // margin here matters more than in the old plain-text case, since a
    // truncated review is a *stored*, permanent artifact with no
    // edit-and-resave path, not a live reply the user can just ask again.
    // Sized for the standard-based prompt's 400-800字 (per-dimension
    // subheadings add markdown overhead on top).
    // +768 for the 【目标一致性与完整性】 part (≤300字 plus list markup).
    maxTokens: (std ? 2560 : 1536) + (consistencyText ? 768 : 0),
    temperature: 0.3,
  });

  return Review.create({
    planId,
    lessonIndex: wholePlan ? null : lessonIndex,
    reviewerType: "ai",
    reviewerId: null,
    sectionKey: wholePlan ? WHOLE_PLAN_SECTION_KEY : null,
    score: null,
    content: result.text,
    aiModel: result.model,
    planVersionAt: plan.contentVersionAt,
    standardId: std ? std.id : null,
    teacherSeenAt: seenByTeacher ? new Date() : null,
  });
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
    // Default on: a plan whose current content already has a whole-plan
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
// -- plus whether it already has a whole-plan AI review that's up to date
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
      where: { planId: { [Op.in]: planIds }, reviewerType: "ai", sectionKey: WHOLE_PLAN_SECTION_KEY },
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
        await generateAiReview(plan, { wholePlan: true, standard });
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
  standardText,
  REVIEW_SECTIONS,
  REVIEW_RULES,
  CONSISTENCY_REVIEW_SECTION,
  WHOLE_PLAN_SECTION_KEY,
};
