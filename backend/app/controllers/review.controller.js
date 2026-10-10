const aiPlanEvaluation = require("../services/aiPlanEvaluation");
const aiReviewStandard = require("../services/aiReviewStandard");
const { segmentKeyForReview } = require("../services/segmentVersion");

const db = require("../models");
const Review = db.review;
const Plan = db.plan;
const User = db.user;

const normalizeLessonIndex = (lessonIndex) => {
  if (lessonIndex === undefined || lessonIndex === null || lessonIndex === "") return null;
  const n = Number(lessonIndex);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// Create an expert review (POST /api/plans/:planId/reviews). body.status:
//  - "saved" (保存点评): upserts the requester's one draft for this spot
//    (plan + sectionKey + lessonIndex) -- see review.model.js's status.
//  - "submitted" (提交点评, the default): creates the review, and drops the
//    requester's draft for the same spot in the same transaction, since the
//    form being submitted is that draft.
exports.create = async (req, res) => {
  try {
    const planId = Number(req.params.planId);
    if (!Number.isInteger(planId) || planId <= 0) {
      return res.status(422).send({ message: "乡土课程设计 ID 无效。" });
    }

    const { content, score, sectionKey } = req.body;
    if (!content) {
      return res.status(422).send({ message: "点评内容不能为空。" });
    }
    const status = req.body.status === undefined ? "submitted" : req.body.status;
    if (status !== "saved" && status !== "submitted") {
      return res.status(422).send({ message: "点评状态无效。" });
    }

    const plan = await Plan.findByPk(planId);
    if (!plan) {
      return res.status(404).send({ message: "乡土课程设计不存在。" });
    }

    // The route (isExpertOrAdmin) lets either role through, but the two
    // shouldn't read as the same "专家点评" badge -- an admin submitting a
    // review here is a manager's opinion, not a domain expert's, so it's
    // tagged distinctly (see review.model.js's reviewerType comment). expert
    // wins if someone happens to hold both roles.
    const reviewerType = (await isExpertRequester(req.userId)) ? "expert" : "admin";

    const reviewLessonIndex = normalizeLessonIndex(req.body.lessonIndex);
    // Falls back to the plan-wide contentVersionAt when this segment has no
    // recorded entry yet (e.g. content untouched since before this feature
    // shipped) -- matches the pre-existing plan-level behavior until the
    // segment's first individually-tracked edit. See segmentVersion.js.
    const segmentKey = segmentKeyForReview(sectionKey || null, reviewLessonIndex);
    const segmentVersionAt = segmentKey
      ? (plan.segmentVersionAt && plan.segmentVersionAt[segmentKey]) || plan.contentVersionAt
      : null;

    const fields = {
      planId,
      lessonIndex: reviewLessonIndex,
      reviewerType,
      reviewerId: req.userId,
      sectionKey: sectionKey || null,
      score: score !== undefined && score !== null && score !== "" ? Number(score) : null,
      content,
      aiModel: null,
      planVersionAt: plan.contentVersionAt,
      segmentVersionAt,
      status,
    };
    const draftWhere = {
      planId,
      reviewerId: req.userId,
      sectionKey: fields.sectionKey,
      lessonIndex: reviewLessonIndex,
      status: "saved",
    };

    const data = await db.sequelize.transaction(async (transaction) => {
      const draft = await Review.findOne({ where: draftWhere, transaction, lock: transaction.LOCK.UPDATE });
      if (status === "saved") {
        return draft ? draft.update(fields, { transaction }) : Review.create(fields, { transaction });
      }
      if (draft) await draft.destroy({ transaction });
      return Review.create(fields, { transaction });
    });

    return res.send(data);
  } catch (err) {
    return res.status(500).send({
      message: err.message || "创建点评时发生错误。",
    });
  }
};

// Trigger an AI review (POST /api/plans/:planId/reviews/ai). Runs
// synchronously — a single DashScope call, no streaming needed for a
// written review.
exports.createAiReview = async (req, res) => {
  const startedAt = new Date();
  try {
    const planId = Number(req.params.planId);
    if (!Number.isInteger(planId) || planId <= 0) {
      return res.status(422).send({ message: "乡土课程设计 ID 无效。" });
    }

    const plan = await aiPlanEvaluation.loadPlan(planId);
    if (!plan) {
      return res.status(404).send({ message: "乡土课程设计不存在。" });
    }

    // The owning teacher may request one on their own plan (part of working
    // on one's own case); an admin or expert may too, but only once the plan
    // is submitted and not suspended -- the same plans AI 打分加点评 covers
    // (see aiScoreAndReview.js#listPlans). A draft is still the teacher's
    // work in progress, not yet up for review.
    const isOwner = plan.teacherId === req.userId;
    if (!isOwner) {
      const isReviewer = (await isAdminRequester(req.userId)) || (await isExpertRequester(req.userId));
      if (!isReviewer) {
        return res.status(403).send({ message: "只能为本人创建的乡土课程设计请求 AI 点评。" });
      }
      if (plan.status === "draft" || plan.suspended) {
        return res.status(403).send({ message: "只能为已提交的乡土课程设计请求 AI 点评。" });
      }
    }

    // AI 点评 is plan scope only (计划整体点评) -- 实施 has no AI for now.
    if (req.body.scope === "implementation") {
      return res.status(422).send({ message: "实施整体点评暂不提供 AI 点评。" });
    }

    // The plan's single current AI evaluation (aiPlanEvaluation.js): when
    // its current content already has a review (and score) under the
    // standard in effect -- whether from an earlier click or from
    // AI 打分加点评 -- that one is returned and nothing is generated; else
    // one turn produces just what's missing. Only the review is returned --
    // the score is for experts and admins, never teachers (the owner
    // included).
    const standard = await aiReviewStandard.getLatestStandard();
    const result = await aiPlanEvaluation.ensureEvaluation(plan, {
      standard,
      // Only the owner asking for it themselves has "seen" it -- one an
      // admin/expert triggered is new to the teacher and flashes for them.
      seenByTeacher: isOwner,
      // An interactive 请AI点评 may search 学习资源库 for reference material
      // (the batch stays at one LLM call per plan).
      knowledgeTool: true,
      userId: req.userId,
    });

    // alreadyCurrent: nothing new was written for the review -- the page
    // says so instead of "generated".
    const review = result.review.get({ plain: true });
    return res.send({ ...review, alreadyCurrent: !result.generated || review.createdAt < startedAt });
  } catch (err) {
    return res.status(500).send({
      message: err.message || "生成 AI 点评时发生错误。",
    });
  }
};

// GET /api/plans/:planId/reviews?lessonIndex=
// Plain array, not the paginated {totalItems,rows,...} envelope: reviews are a
// plan/lesson-scoped sub-resource (like artifacts), typically few per plan, and
// the frontend's review-list.component.js/review.service.js consume this as a
// plain list — kept consistent with artifact.controller.js#findByPlan.
exports.findByPlan = async (req, res) => {
  try {
    const planId = Number(req.params.planId);
    if (!Number.isInteger(planId) || planId <= 0) {
      return res.status(422).send({ message: "乡土课程设计 ID 无效。" });
    }

    // A saved (draft) review is its author's alone -- see review.model.js.
    const where = {
      planId,
      [db.Sequelize.Op.or]: [{ status: "submitted" }, ...(req.userId ? [{ status: "saved", reviewerId: req.userId }] : [])],
    };
    if (req.query.lessonIndex !== undefined) {
      if (req.query.lessonIndex === "" || req.query.lessonIndex === "null") {
        where.lessonIndex = null;
      } else {
        const n = Number(req.query.lessonIndex);
        if (!Number.isInteger(n)) {
          return res.status(422).send({ message: "lessonIndex 无效。" });
        }
        where.lessonIndex = n;
      }
    }

    const rows = await Review.findAll({
      where,
      include: [{ model: User, as: "Reviewer", attributes: ["id", "username", "chineseName"], required: false }],
      order: [["id", "DESC"]],
    });

    return res.send(await attachAiScores(planId, rows, req.userId));
  } catch (err) {
    return res.status(500).send({
      message: err.message || "查询点评列表时发生错误。",
    });
  }
};

// POST /api/plans/:planId/reviews/seen { reviewIds } -- the plan's own
// teacher has now seen these reviews in a 整体点评 view (see
// review.model.js's teacherSeenAt). Which reviews a view shows is decided
// by review-list.component.js's scope filter, so the page sends the ids it
// displayed rather than this re-deriving the scope. A no-op for anyone but
// the owning teacher -- an admin or expert opening the plan mustn't clear
// the teacher's "new review" flash.
exports.markSeen = async (req, res) => {
  try {
    const planId = Number(req.params.planId);
    if (!Number.isInteger(planId) || planId <= 0) {
      return res.status(422).send({ message: "乡土课程设计 ID 无效。" });
    }
    const plan = await Plan.findByPk(planId, { attributes: ["id", "teacherId"] });
    if (!plan) {
      return res.status(404).send({ message: "乡土课程设计不存在。" });
    }
    const ids = (Array.isArray(req.body.reviewIds) ? req.body.reviewIds : []).map(Number).filter(Number.isInteger);
    if (plan.teacherId !== req.userId || ids.length === 0) {
      return res.send({ updated: 0 });
    }
    const [updated] = await Review.update(
      { teacherSeenAt: new Date() },
      { where: { id: { [db.Sequelize.Op.in]: ids }, planId, status: "submitted", teacherSeenAt: null } }
    );
    return res.send({ updated });
  } catch (err) {
    return res.status(500).send({ message: err.message || "标记点评已读时发生错误。" });
  }
};

// "super" inherits every admin privilege, including deleting any review
// regardless of authorship.
// AI 设计分数 (AI 打分) rides along on the AI review rows it belongs to -- a
// score of the same plan content version, i.e. of exactly the content that
// review saw: preferably one under the review's own standard (the one
// produced in, or current at, that review's turn), otherwise the newest
// score of that content version -- a review written before any standard
// existed, or one whose content was later scored under a newer standard,
// still shows how that content scored. A score of a later version is never
// attached to an earlier review, so a row's 内容已更新 tag speaks for its
// score too. Each score carries its standard's 满分 and per-dimension 考察要点
// for the row's tooltip. Sent to the plan's owner (any of their plans) and
// to admins (any plan) and experts (submitted, non-suspended plans -- the
// same scope as 数据看板); peer teachers never receive an AI score.
async function attachAiScores(planId, rows, userId) {
  const plain = rows.map((r) => r.get({ plain: true }));
  const aiRows = plain.filter((r) => r.reviewerType === "ai" && r.lessonIndex === null && !r.sectionKey);
  if (!userId || aiRows.length === 0) return plain;
  const plan = await Plan.findByPk(planId, { attributes: ["teacherId", "status", "suspended"] });
  if (!plan) return plain;
  if (plan.teacherId !== userId && !(await isAdminRequester(userId))) {
    if (!(await isExpertRequester(userId))) return plain;
    if (plan.status === "draft" || plan.suspended) return plain;
  }
  const scores = await db.aiPlanScore.findAll({ where: { planId }, order: [["id", "DESC"]] });
  const standardIds = [...new Set(scores.map((x) => x.standardId).filter(Boolean))];
  const standards = standardIds.length
    ? await db.aiReviewStandard.findAll({ where: { id: { [db.Sequelize.Op.in]: standardIds } }, attributes: ["id", "content"] })
    : [];
  const contentById = new Map(standards.map((st) => [Number(st.id), st.content || {}]));
  const time = (d) => (d ? new Date(d).getTime() : null);
  aiRows.forEach((r) => {
    const sameContent = scores.filter((x) => time(x.planVersionAt) === time(r.planVersionAt));
    const s = sameContent.find((x) => Number(x.standardId) === Number(r.standardId)) || sameContent[0];
    if (s) {
      const content = contentById.get(Number(s.standardId)) || {};
      r.aiScore = {
        totalScore: Number(s.totalScore),
        maxScore: content.totalScore || null,
        dimensionScores: s.dimensionScores,
        summary: s.summary,
        standardId: s.standardId,
        standardTitle: content.title || null,
        criteria: (content.dimensions || []).map((d) => ({ name: d.name, weight: d.weight, criteria: d.criteria || [] })),
        scoredAt: s.createdAt,
      };
    }
  });
  return plain;
}

const isAdminRequester = async (userId) => {
  const user = await User.findByPk(userId);
  if (!user) return false;
  const roles = await user.getRoles();
  return roles.some((r) => r.name === "admin" || r.name === "super");
};

const isExpertRequester = async (userId) => {
  const user = await User.findByPk(userId);
  if (!user) return false;
  const roles = await user.getRoles();
  return roles.some((r) => r.name === "expert");
};

// DELETE /api/reviews/:id (authJwt.verifyToken-gated at the route -- ownership
// and the not-superseded rule are enforced here, not just hidden in the UI).
exports.delete = async (req, res) => {
  const id = req.params.id;

  try {
    const review = await Review.findByPk(id);
    if (!review) {
      return res.status(404).send({ message: `未找到点评 id=${id}。` });
    }

    // Only the review's own author may delete it (AI reviews have no
    // reviewerId, so only admin can remove those) -- previously the route had
    // no ownership check at all, only the frontend hid the button.
    const isAuthor = review.reviewerId !== null && review.reviewerId === req.userId;
    if (!isAuthor && !(await isAdminRequester(req.userId))) {
      return res.status(403).send({ message: "只能删除本人撰写的点评。" });
    }

    // Once the plan's content has moved on (a later edit bumped
    // contentVersionAt past this review's snapshot), the review is part of
    // the historical record for a superseded version -- lock it against
    // deletion, even for its own author or admin, so that history stays
    // intact. See plan.model.js/review.model.js. A saved draft was never
    // part of that record, so its author may always discard it.
    const plan = await Plan.findByPk(review.planId);
    if (
      review.status === "submitted" &&
      plan &&
      review.planVersionAt &&
      new Date(review.planVersionAt).getTime() !== new Date(plan.contentVersionAt).getTime()
    ) {
      return res.status(403).send({
        message: "课程内容已被后续修改，该点评对应的版本已成为历史记录，不能删除。",
      });
    }

    const num = await Review.destroy({ where: { id } });
    if (num === 1) {
      return res.send({ message: "点评删除成功。" });
    }
    return res.status(404).send({ message: `未找到点评 id=${id}，或点评已被删除。` });
  } catch (err) {
    return res.status(500).send({
      message: err.message || `删除点评 id=${id} 时发生错误。`,
    });
  }
};
