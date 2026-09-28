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

    // Owner-only, no admin bypass -- matches plan.controller.js#update's
    // content-authoring rule: requesting an AI review is part of working on
    // one's own case, not a management action.
    if (plan.teacherId !== req.userId) {
      return res.status(403).send({ message: "只能为本人创建的乡土课程设计请求 AI 点评。" });
    }

    // scope="implementation" is 实施/整体点评's AI review -- "on both
    // sections" per the comment-scoping spec, i.e. combined design + every
    // lesson's execution content, not just one lessonIndex (see
    // planContext.js#buildWholePlanContentText). lessonIndex is meaningless
    // in that case and ignored.
    const isWholePlanScope = req.body.scope === "implementation";
    const lessonIndex = isWholePlanScope ? null : normalizeLessonIndex(req.body.lessonIndex);

    // Generation itself is shared with the admin's bulk AI 点评, see
    // services/aiPlanReview.js.
    const data = await aiPlanReview.generateAiReview(plan, {
      wholePlan: isWholePlanScope,
      lessonIndex,
      seenByTeacher: true,
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

    const data = await Review.findAll({
      where,
      include: [{ model: User, as: "Reviewer", attributes: ["id", "username", "chineseName"], required: false }],
      order: [["id", "DESC"]],
    });

    return res.send(data);
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
