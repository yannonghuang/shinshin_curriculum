const aiPlanReview = require("../services/aiPlanReview");
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

// Create an expert review (POST /api/plans/:planId/reviews)
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

    const data = await Review.create({
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
  try {
    const planId = Number(req.params.planId);
    if (!Number.isInteger(planId) || planId <= 0) {
      return res.status(422).send({ message: "乡土课程设计 ID 无效。" });
    }

    const plan = await aiPlanReview.loadPlan(planId);
    if (!plan) {
      return res.status(404).send({ message: "乡土课程设计不存在。" });
    }

    // The owning teacher may request one on their own plan (part of working
    // on one's own case); an admin or expert may too, but only once the plan
    // is submitted and not suspended -- the same plans bulk AI 点评 covers
    // (see aiPlanReview.js#findCandidates). A draft is still the teacher's
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

    // Generation itself is shared with the admin's bulk AI 点评, see
    // services/aiPlanReview.js.
    const data = await aiPlanReview.generateAiReview(plan, {
      // Only the owner asking for it themselves has "seen" it -- one an
      // admin/expert triggered is new to the teacher and flashes for them.
      seenByTeacher: isOwner,
      // An interactive 请AI点评 may search 学习资源库 for reference material
      // (bulk/batch reviews stay at one LLM call per plan).
      knowledgeTool: true,
      // ...and scores the plan in the same turn if it has no up-to-date AI
      // score. Only the review is returned -- the score is for experts and
      // admins, never teachers (the owner included).
      scoreIfMissing: true,
      userId: req.userId,
    });

    return res.send(data);
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

    const where = { planId };
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
      { where: { id: { [db.Sequelize.Op.in]: ids }, planId, teacherSeenAt: null } }
    );
    return res.send({ updated });
  } catch (err) {
    return res.status(500).send({ message: err.message || "标记点评已读时发生错误。" });
  }
};

// "super" inherits every admin privilege, including deleting any review
// regardless of authorship.
// AI 打分 rides along on the AI review rows it belongs to -- the score for
// the same plan content version and standard, i.e. the one produced in (or
// current at) that review's turn -- shown in the review list's 评分 column,
// which teachers don't see. Only experts and admins get it (teachers,
// the owner included, never receive an AI score from any endpoint), with
// the same plan scope as 数据看板: admins any plan, experts only submitted,
// non-suspended ones.
async function attachAiScores(planId, rows, userId) {
  const plain = rows.map((r) => r.get({ plain: true }));
  const aiRows = plain.filter((r) => r.reviewerType === "ai" && r.lessonIndex === null);
  if (!userId || aiRows.length === 0) return plain;
  const isAdmin = await isAdminRequester(userId);
  if (!isAdmin) {
    if (!(await isExpertRequester(userId))) return plain;
    const plan = await Plan.findByPk(planId, { attributes: ["status", "suspended"] });
    if (!plan || plan.status === "draft" || plan.suspended) return plain;
  }
  const scores = await db.aiPlanScore.findAll({ where: { planId }, order: [["id", "DESC"]] });
  const time = (d) => (d ? new Date(d).getTime() : null);
  aiRows.forEach((r) => {
    const s = scores.find(
      (x) => Number(x.standardId) === Number(r.standardId) && time(x.planVersionAt) === time(r.planVersionAt)
    );
    if (s) {
      r.aiScore = {
        totalScore: Number(s.totalScore),
        dimensionScores: s.dimensionScores,
        summary: s.summary,
        standardId: s.standardId,
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
    // intact. See plan.model.js/review.model.js.
    const plan = await Plan.findByPk(review.planId);
    if (
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
