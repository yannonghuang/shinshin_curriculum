// AI plan evaluation -- the single source of truth for AI 打分 and AI 点评.
// A plan has one current AI evaluation (a score and a review of its current
// content under the standard in effect, see currentEvaluations), and the
// only way to produce either is ensureEvaluation, used by both 请AI点评
// (review.controller.js#createAiReview) and the AI 打分加点评 batch
// (aiScoreAndReview.js): it produces just what's missing, in ONE LLM turn,
// and nothing when the evaluation is already current.
//
// Plan scope only: every AI artifact (the standard, 打分, 点评) is about the
// 计划 -- the 课程设计方案 incl. 分课时设计 -- and every AI review is filed
// under 计划整体点评 (sectionKey null). 实施 (the per-lesson 实施记录) has
// no AI for now. The 目标一致性与完整性核查 (planConsistency.js) is always
// done inside that same turn rather than as a call of its own. The point is
// token economics: the plan content, the standard and the objectives are
// sent once per plan, whatever is asked of it.
//
// The one exception to "one turn": 请AI点评 (knowledgeTool, see
// evaluatePlan) may pull reference material from 学习资源库 over extra tool
// rounds, as it always could -- same prompt, same check, same output.
//
// Every prompt is assembled from the rule blocks below, so a score or review
// reads the same whichever combination produced it.
const db = require("../models");
const llmClient = require("./llmClient");
const agentLoop = require("./agentLoop");
const { searchKnowledgeTree, searchKnowledgeBaseToolDef } = require("./knowledgeRetrieve");
const { MANUAL_CATEGORY } = require("../constants/materialCategories");
const planContext = require("./planContext");
const planConsistency = require("./planConsistency");

const Review = db.review;
const AiPlanScore = db.aiPlanScore;
const Artifact = db.artifact;

const JSON_MARKER = "<<<JSON>>>";
const REVIEW_MARKER = "<<<REVIEW>>>";

// ---- Rule blocks ----

// Scoring: the plan's own content (plus the in-turn consistency check) is
// the only evidence -- a scoring turn never sees review history or an
// earlier score, so a score reflects the plan itself rather than a previous
// opinion of it.
const SCORING_RULES =
  "1. 只依据评分标准中的评分要点与等级描述打分，不要引入标准以外的评判依据；\n" +
  "2. 只依据课程材料中实际呈现的内容，信息缺失的部分按标准中的评分说明处理，不要臆测；\n" +
  "3. 每个维度先判定等级（level，须为该维度等级描述中的等级名称），再在该等级分数区间内给出分数（score，可含一位小数，不得超过该维度分值）；\n" +
  "4. rationale 用 1-3 句话说明打分理由，引用课程中的具体内容作为证据；\n" +
  "5. summary 用 2-4 句话总结该课程的主要优点与最需要改进之处；\n" +
  "dimensions 必须与评分标准的维度一一对应、顺序一致、名称一致。全文不得提及任何人名。\n";

const SCORING_CONSISTENCY_RULE =
  "6. 目标一致性与完整性核查发现的问题（未落实的总体目标、无对应的课时目标、未填写的目标或课时等），必须在评分标准中与学习目标、课程设计或其一致性/完整性相关的维度中体现为扣分，并在该维度的 rationale 中具体指出；" +
  "存在此类问题时 summary 也须提及。核查结果一致且完整时，不因此扣分。\n";

// Review: every AI 点评 is written against the AI 点评标准 in effect -- the
// same rubric AI 打分 scores with -- and stays qualitative (no score or
// level in the text; that's the score's job). The theme/locality part is
// the angle a generic rubric can't cover: specific to *this* plan's theme,
// grade and locality (buildBasicInfoLines' 学校/地区 line).
const REVIEW_SECTIONS =
  "【对照评分标准的点评】（主）：按评分标准的维度顺序逐一点评，每个维度以维度名称作小标题，依据该维度的评分要点与等级描述，指出课程材料中的具体亮点与不足（引用课程中的具体内容作为证据），并给出可操作的改进建议。材料中未涉及的维度简要说明缺失即可，不要臆测。正文中不要给出分数或等级。\n" +
  "【主题与本地特色相关建议】（次，2-3条要点）：结合本课程的具体主题、年级与学校/地区，给出只针对这个主题和这个地方才成立的建议——例如可利用的本地资源、这个主题特有的风险或机会、适合本地实际的案例或调整。避免泛泛而谈、换成任何主题都适用的内容。\n";

// Fallback only for when no AI 点评标准 has been generated yet, so a
// teacher's own 请AI点评 still works on a fresh install -- theme/locality
// first, generic methodology capped (human 专家 own that part).
const FALLBACK_REVIEW_SECTIONS =
  "【主题与本地特色相关建议】（主，约占篇幅的三分之二）：结合本课程的具体主题、年级与学校/地区，给出只针对这个主题和这个地方才成立的观察——例如可利用的本地资源、这个主题特有的风险或机会、适合本地实际的案例或调整建议。避免泛泛而谈、换成任何主题都适用的内容。\n" +
  "【通用教学方法提示】（次，1-2条要点即可）：如有明显的通用教学方法（目标达成、内容设计、可操作性等）问题再简要提及，这部分通常由人类专家把关，此处从简。\n";

const CONSISTENCY_REVIEW_SECTION =
  "【目标一致性与完整性】：依据本次核查结论，逐条指出未在任何课时落实的总体目标（建议在哪个课时补充落实）、在总体目标中找不到对应的课时目标（建议补入总体目标或调整该课时目标）、以及未填写的目标或课时，并给出具体修改建议；" +
  "目标一致且完整时，用一两句话确认即可。这部分控制在 300 字以内，不计入上面的字数要求。\n";

// With a score in the same turn, retrieved material must not leak into it:
// the score is the standard applied to the plan's own content, comparable
// across plans only if nothing else feeds it.
const KNOWLEDGE_TOOL_SCORE_RULE = "检索到的参考资料只能用于点评中的主题与本地特色建议，不得作为打分依据。\n";

const KNOWLEDGE_TOOL_HINT =
  "如果需要参考共享学习材料库中与该课程主题或所在地区相关的资料（例如同主题的其他课程案例、专家讲解等）来支撑你的点评，可以调用 search_knowledge_base 工具查询；不需要参考资料时无需调用。\n";

const REVIEW_RULES = "评判只依据评分标准与课程材料，不要引入标准以外的评判依据；全文不得提及任何人名。\n";
const FALLBACK_REVIEW_RULES = "全文不得提及任何人名。\n";

// The standard as readable text for the prompt -- the parts a reviewer or
// scorer judges by (dimensions, 评分要点, 等级描述, 评分说明); `basis`
// (which materials each dimension was derived from) is left out, it's
// provenance, not a criterion.
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

function scoreText(score) {
  const lines = [`【AI 打分结果】总分 ${score.totalScore}`];
  (score.dimensionScores || []).forEach((d) => lines.push(`- ${d.name}（${d.score}/${d.weight}，${d.level}）：${d.rationale}`));
  if (score.summary) lines.push(`总评：${score.summary}`);
  return lines.join("\n");
}

// ---- The single source of truth ----
//
// A plan has exactly one *current* AI evaluation: the score and the
// plan-scope AI review for its current content version under the standard
// in effect (for a review, the standard it was written against; null for a
// fallback review on an install with no standard). Where several rows
// qualify -- duplicates from before this was enforced -- the newest wins;
// the rest, and every row of older content or an older standard, are
// history. Every path that produces AI output goes through ensureEvaluation
// below, and every reader asks currentEvaluations, so the button (请AI点评)
// and the AI 打分加点评 batch can't diverge.

const Op = db.Sequelize.Op;
const timeOf = (d) => (d ? new Date(d).getTime() : null);

const planIncludes = [
  { model: db.templateVersion, as: "PlanTemplateVersion" },
  { model: db.templateVersion, as: "ExecutionTemplateVersion" },
  { model: db.user, as: "Teacher", include: [{ model: db.school, as: "School" }] },
];

// Loads a plan with everything an evaluation turn needs.
const loadPlan = (planId) => db.plan.findByPk(planId, { include: planIncludes });

// Map planId -> { score, review } (each the row or null) for the given
// plans (each needs `id` and `contentVersionAt`) under `standard` (null:
// no standard yet -- then no score can be current, and only a fallback
// review is).
async function currentEvaluations(plans, standard) {
  const out = new Map(plans.map((p) => [Number(p.id), { score: null, review: null }]));
  if (plans.length === 0) return out;
  const planIds = plans.map((p) => p.id);
  const standardId = standard ? standard.id : null;
  const [scores, reviews] = await Promise.all([
    standard
      ? AiPlanScore.findAll({ where: { planId: { [Op.in]: planIds }, standardId }, order: [["id", "DESC"]] })
      : [],
    Review.findAll({
      where: { planId: { [Op.in]: planIds }, reviewerType: "ai", sectionKey: null, lessonIndex: null, standardId },
      order: [["id", "DESC"]],
    }),
  ]);
  const versionOf = new Map(plans.map((p) => [Number(p.id), timeOf(p.contentVersionAt)]));
  const isCurrent = (row) => timeOf(row.planVersionAt) === versionOf.get(Number(row.planId));
  scores.forEach((s) => {
    const e = out.get(Number(s.planId));
    if (!e.score && isCurrent(s)) e.score = s;
  });
  reviews.forEach((r) => {
    const e = out.get(Number(r.planId));
    if (!e.review && isCurrent(r)) e.review = r;
  });
  return out;
}

async function currentEvaluation(plan, standard) {
  return (await currentEvaluations([plan], standard)).get(Number(plan.id));
}

// One evaluation per plan at a time, process-wide: the button and the batch
// (or two clicks) asking for the same plan at once would otherwise each
// produce their own copy. A waiter re-checks once the in-flight one is done
// and finds it current.
const inFlight = new Map();

async function withPlanLock(planId, fn) {
  const key = Number(planId);
  while (inFlight.has(key)) {
    try {
      await inFlight.get(key);
    } catch (e) {
      // The holder's failure is the holder's to report.
    }
  }
  const p = fn();
  inFlight.set(key, p);
  try {
    return await p;
  } finally {
    if (inFlight.get(key) === p) inFlight.delete(key);
  }
}

// Brings a plan's current evaluation up to date: produces only what's
// missing (score and/or review, in one turn -- see evaluatePlan) and
// nothing when both are current. Returns { score, review, generated }:
// the current pair after the call, and whether an LLM turn ran. The score
// is only ever produced under a standard. `want` narrows what's ensured
// ({ score, review }, both by default); the rest of `opts` goes to
// evaluatePlan (seenByTeacher, userId, knowledgeTool).
async function ensureEvaluation(plan, { standard, want = { score: true, review: true }, ...opts }) {
  return withPlanLock(plan.id, async () => {
    const cur = await currentEvaluation(plan, standard);
    const score = !!want.score && !!standard && !cur.score;
    const review = !!want.review && !cur.review;
    if (!score && !review) return { ...cur, generated: false };
    const made = await evaluatePlan(plan, { ...opts, score, review, standard, givenScore: cur.score });
    return { score: made.score || cur.score, review: made.review || cur.review, generated: true };
  });
}

// ---- The turn ----

const round1 = (n) => Math.round(n * 10) / 10;

// Maps the model's per-dimension output back onto the standard's own
// dimensions (by name, falling back to position) and clamps each score to
// [0, weight] -- the total is always computed here, never taken from the
// model, so it can't drift from the dimension scores.
function reconcileScore(standardContent, parsed) {
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

// Tasks are numbered in the order they appear, so the prompt reads the same
// shape whether it asks for one, two or three of them.
function buildSystemPrompt({ score, review, std, consistency, givenScore, withHistory, knowledgeTool }) {
  const tasks = [];
  if (consistency) tasks.push("目标一致性与完整性核查");
  if (score) tasks.push("逐维度打分");
  if (review) tasks.push("文字点评");
  const numerals = ["一", "二", "三"];
  const heading = (name) => `【${numerals[tasks.indexOf(name)]}、${name}】`;

  const parts = [
    `你是乡土课程评价专家。${std ? "请严格依据给定的「乡土课程 AI 点评评分标准」，" : "请"}对给出的乡土课程设计方案（含分课时设计）在同一次回复中完成：${tasks.join("、")}。\n`,
  ];
  // The findings are always written out as JSON first, even when only a
  // review is asked for: a check the model only "does in its head" was
  // measurably laxer (missed uncovered objectives a written-out one caught),
  // and writing it first makes the check identical in every mode. Not
  // stored -- it's the scaffold the score and the review build on.
  if (consistency) {
    parts.push(
      `${heading("目标一致性与完整性核查")}\n${planConsistency.INSTRUCTIONS}` +
        "核查结论写入 JSON 的 consistency，只列出问题：uncovered（未在任何课时中落实的总体目标，引用原文）、orphans（在总体目标中找不到对应的课时目标，写成“第N课时：目标原文”）、otherIssues（最多 3 条）；没有问题的项为空数组。" +
        `${[score && "打分", review && "点评"].filter(Boolean).join("与")}必须以该核查结论为准。\n`
    );
  }
  if (score) {
    parts.push(`${heading("逐维度打分")}要求：\n${SCORING_RULES}${consistency ? SCORING_CONSISTENCY_RULE : ""}`);
  }
  if (review) {
    const lines = [
      `${heading("文字点评")}用中文，${std ? "400-800" : "200-500"}字，使用如下标题分部分撰写：\n` +
        (std ? REVIEW_SECTIONS : FALLBACK_REVIEW_SECTIONS) +
        (consistency ? CONSISTENCY_REVIEW_SECTION : ""),
    ];
    if (score) lines.push("点评对各维度优劣的判断必须与本次打分一致。\n");
    if (givenScore) {
      lines.push(
        "课程材料前附有该课程依据同一评分标准完成的「AI 打分结果」，点评对各维度优劣的判断应与之保持一致，可引用其打分理由作为线索，但仍须引用课程中的具体内容作为证据；正文中不要复述分数或等级。\n"
      );
    }
    if (withHistory) lines.push("课程材料末尾附有此前的点评记录，请参考、避免重复此前已提出的意见，并可在此基础上继续深入。\n");
    lines.push(std ? REVIEW_RULES : FALLBACK_REVIEW_RULES);
    if (knowledgeTool) lines.push(KNOWLEDGE_TOOL_HINT);
    if (knowledgeTool && score) lines.push(KNOWLEDGE_TOOL_SCORE_RULE);
    parts.push(lines.join(""));
  }

  const format = ["输出格式：严格按以下格式输出，不要使用代码块标记，不要有其他文字：", ""];
  if (score || consistency) {
    const fields = [];
    if (consistency) fields.push('"consistency": {"uncovered": ["..."], "orphans": ["第1课时：..."], "otherIssues": ["..."]}');
    if (score) fields.push('"dimensions": [{"name": "...", "level": "良好", "score": 16, "rationale": "..."}], "summary": "..."');
    format.push(JSON_MARKER);
    format.push(`{${fields.join(", ")}}`);
  }
  if (review) {
    format.push(REVIEW_MARKER);
    format.push("（点评正文）");
  }
  parts.push(format.join("\n"));
  return parts.join("\n");
}

// The JSON part (consistency findings and/or the score) comes first, the
// review after REVIEW_MARKER. Only the score is read out of the JSON.
function parseReply(text, { score, review }) {
  const raw = (text || "").trim();
  const reviewAt = raw.indexOf(REVIEW_MARKER);
  const out = {};
  if (score) {
    const end = reviewAt >= 0 ? reviewAt : raw.length;
    const jsonPart = raw
      .slice(0, end)
      .replace(JSON_MARKER, "")
      .trim()
      .replace(/^```(?:json)?\s*|\s*```$/g, "")
      .trim();
    out.parsed = JSON.parse(jsonPart);
  }
  if (review) {
    // A review-only reply that skipped the marker is still just the review.
    // (With a JSON part in front, though, the marker is what separates them.)
    if (reviewAt < 0 && raw.includes(JSON_MARKER)) throw new Error("AI 回复缺少点评部分");
    out.review = (reviewAt >= 0 ? raw.slice(reviewAt + REVIEW_MARKER.length) : raw.replace(JSON_MARKER, "")).trim();
    if (!out.review) throw new Error("AI 回复的点评内容为空");
  }
  return out;
}

// One LLM turn -> an AiPlanScore and/or an AI Review, both stamped with the
// same content version and standard, written together only once the whole
// reply parses (a malformed reply leaves neither half).
//
// `plan` must be loaded with PlanTemplateVersion, ExecutionTemplateVersion
// and Teacher->School (see loadPlan). Options:
//   score        -- produce an AI 打分 (requires `standard`)
//   review       -- produce an AI 点评
//   standard     -- the AI 点评标准 to judge by; null only for a fallback
//                   review on an install with no standard yet
//   seenByTeacher, userId -- stored on the review / score rows
//   givenScore   -- the plan's current score, for a review-only turn to
//                   agree with (ensureEvaluation passes it)
//   knowledgeTool -- let the review search 学习资源库 over extra tool rounds
//                   (请AI点评); batches leave it off to stay at one call per
//                   plan. With a score in the same turn, retrieved material
//                   is barred from the score (KNOWLEDGE_TOOL_SCORE_RULE).
// A review-only turn is handed the plan's current score, if any, so the two
// agree, plus the review history (not new opinions to score by, but what a
// review shouldn't just repeat). A turn that scores sees neither.
async function evaluatePlan(
  plan,
  { score = false, review = false, standard, seenByTeacher = false, userId = null, knowledgeTool = false, givenScore: given = null }
) {
  if (!score && !review) throw new Error("evaluatePlan: nothing to do");
  const useTool = knowledgeTool && review;
  if (score && !standard) throw new Error("尚未制定 AI 点评标准，请先在「AI 点评标准」中生成。");
  // The 计划 only: the online design form incl. 分课时设计, or -- for an
  // upload-mode plan -- its uploaded design files.
  const artifacts = plan.planFormData ? [] : await Artifact.findAll({ where: { planId: plan.id, lessonIndex: null } });
  const contentText = await planContext.buildPlanContentText(plan, null, artifacts);

  const reviewOnly = review && !score;
  const givenScore = reviewOnly ? given : null;
  const history = reviewOnly ? await planContext.buildReviewHistoryText(plan.id) : "";
  const consistency = planConsistency.inputText(plan);

  const preamble = [standard && standardText(standard), givenScore && scoreText(givenScore), consistency].filter(Boolean);
  const userContent = `${preamble.length ? `${preamble.join("\n\n")}\n\n` : ""}课程材料：\n${contentText}${history}`;

  // Real replies run past their own 字 targets once markdown is counted, and
  // a truncated review is a stored, permanent artifact -- so generous.
  const maxTokens =
    (consistency ? 512 : 0) + (score ? 2048 : 0) + (review ? (standard ? 2560 : 1536) + (consistency ? 768 : 0) : 0);

  const request = {
    systemPrompt: buildSystemPrompt({
      score,
      review,
      std: standard,
      consistency,
      givenScore,
      withHistory: !!history,
      knowledgeTool: useTool,
    }),
    messages: [{ role: "user", content: userContent }],
    maxTokens,
    // The score must be reproducible -- same standard + same content, same
    // score; a review-only turn keeps the review's usual slight variety.
    temperature: score ? 0 : 0.3,
  };
  const result = useTool
    ? await agentLoop.runAgentLoop({
        ...request,
        tools: [searchKnowledgeBaseToolDef],
        // Knowledge-tree retrieval (see knowledgeRetrieve.js#searchKnowledgeTree).
        // A review is pedagogical, so 使用指南 (system usage docs) is left
        // out, and it must not attribute anything to a named person -- no
        // 主讲人, and person names stripped from source titles.
        executors: {
          search_knowledge_base: (args) =>
            searchKnowledgeTree(args.query, { excludeCategories: [MANUAL_CATEGORY], includeTopicMeta: false, redact: true }),
        },
      })
    : await llmClient.llmChat(request);

  const parsedReply = parseReply(result.text, { score, review });
  const scoreFields = score ? reconcileScore(standard.content, parsedReply.parsed) : null;

  return db.sequelize.transaction(async (transaction) => {
    const out = { score: null, review: null };
    if (scoreFields) {
      out.score = await AiPlanScore.create(
        {
          planId: plan.id,
          standardId: standard.id,
          ...scoreFields,
          aiModel: result.model,
          planVersionAt: plan.contentVersionAt,
          createdBy: userId || null,
        },
        { transaction }
      );
    }
    if (review) {
      out.review = await Review.create(
        {
          planId: plan.id,
          lessonIndex: null,
          reviewerType: "ai",
          reviewerId: null,
          sectionKey: null, // 计划整体点评
          score: null,
          content: parsedReply.review,
          aiModel: result.model,
          planVersionAt: plan.contentVersionAt,
          standardId: standard ? standard.id : null,
          teacherSeenAt: seenByTeacher ? new Date() : null,
        },
        { transaction }
      );
    }
    return out;
  });
}

// Callers go through ensureEvaluation; evaluatePlan (unconditional) stays
// internal so nothing can write around the single source of truth.
module.exports = {
  ensureEvaluation,
  currentEvaluations,
  loadPlan,
  standardText,
};
