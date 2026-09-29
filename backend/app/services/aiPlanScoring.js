// AI 打分 (read-only list): every submitted plan with its newest AI score
// against the AI 点评标准 -- the same rubric for every plan, so scores are
// comparable across plans. Scores are produced only through
// aiPlanEvaluation.js#ensureEvaluation (请AI点评 and AI打分加点评); the
// newest score of a plan is its current one while its content and the
// standard are unchanged, older rows are history.
const db = require("../models");
const { Op } = db.Sequelize;
const Plan = db.plan;
const Review = db.review;
const AiPlanScore = db.aiPlanScore;

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

// Newest score per plan -- "newest wins" among duplicates (see
// aiPlanEvaluation.js's single-source-of-truth note).
async function latestScoresByPlan(planIds) {
  if (planIds.length === 0) return new Map();
  const rows = await AiPlanScore.findAll({ where: { planId: { [Op.in]: planIds } }, order: [["id", "DESC"]] });
  const map = new Map();
  for (const r of rows) if (!map.has(Number(r.planId))) map.set(Number(r.planId), r);
  return map;
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

module.exports = { listScores };
