const planContext = require("../services/planContext");

const db = require("../models");
const Review = db.review;
const Plan = db.plan;
const Artifact = db.artifact;
const User = db.user;
const TemplateVersion = db.templateVersion;
const agentLoop = require("../services/agentLoop");
const { searchKnowledgeBase, searchKnowledgeBaseToolDef } = require("../services/knowledgeRetrieve");

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

    const data = await Review.create({
      planId,
      lessonIndex: normalizeLessonIndex(req.body.lessonIndex),
      reviewerType,
      reviewerId: req.userId,
      sectionKey: sectionKey || null,
      score: score !== undefined && score !== null && score !== "" ? Number(score) : null,
      content,
      aiModel: null,
      planVersionAt: plan.contentVersionAt,
    });

    return res.send(data);
  } catch (err) {
    return res.status(500).send({
      message: err.message || "创建点评时发生错误。",
    });
  }
};

// Fixed across every AI-review scope (single lesson, whole design, or the
// combined design+every-lesson scope below) -- only the user content varies.
const AI_REVIEW_SYSTEM_PROMPT =
  "你是乡土课程教学专家，请对以下课程设计/实施记录整体做点评，从目标达成、内容设计、可操作性、创新性等维度给出优点、不足和改进建议，用中文回复，200-500字。" +
  "如果需要参考共享学习材料库中与该课程主题相关的资料（例如同主题的其他课程案例、专家讲解等）来支撑你的点评，可以调用 search_knowledge_base 工具查询；不需要参考资料时无需调用。";

// Content-rendering itself lives in planContext.js (shared with the
// co-pilot's own pageContext awareness, see chat.controller.js) -- this just
// pairs it with the review-specific system prompt.
const buildAiReviewPrompt = async (plan, lessonIndex, artifacts) => ({
  systemPrompt: AI_REVIEW_SYSTEM_PROMPT,
  userContent: await planContext.buildPlanContentText(plan, lessonIndex, artifacts),
});

// Trigger an AI review (POST /api/plans/:planId/reviews/ai). Runs
// synchronously — a single DashScope call, no streaming needed for a
// written review.
exports.createAiReview = async (req, res) => {
  try {
    const planId = Number(req.params.planId);
    if (!Number.isInteger(planId) || planId <= 0) {
      return res.status(422).send({ message: "乡土课程设计 ID 无效。" });
    }

    const plan = await Plan.findByPk(planId, {
      include: [
        { model: TemplateVersion, as: "PlanTemplateVersion" },
        { model: TemplateVersion, as: "ExecutionTemplateVersion" },
      ],
    });
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

    const systemPrompt = AI_REVIEW_SYSTEM_PROMPT;
    let userContent;
    if (isWholePlanScope) {
      userContent = await planContext.buildWholePlanContentText(plan);
    } else {
      let artifacts = [];
      if (lessonIndex) {
        artifacts = await Artifact.findAll({ where: { planId, lessonIndex } });
      } else if (!plan.planFormData) {
        artifacts = await Artifact.findAll({ where: { planId, lessonIndex: null } });
      }
      ({ userContent } = await buildAiReviewPrompt(plan, lessonIndex, artifacts));
    }

    // Routed through the agent loop rather than a plain llmChat call so the
    // model can decide for itself whether this plan/lesson's content
    // warrants pulling in reference material from 共享学习材料库, instead of
    // every review being force-fed the same retrieval regardless of
    // relevance (see knowledgeRetrieve.js's searchKnowledgeBaseToolDef).
    const result = await agentLoop.runAgentLoop({
      systemPrompt,
      messages: [{ role: "user", content: userContent }],
      tools: [searchKnowledgeBaseToolDef],
      executors: { search_knowledge_base: (args) => searchKnowledgeBase(args.query) },
      // The system prompt asks for 200-500字, but real replies sometimes run
      // past their own target once markdown formatting is counted -- a
      // margin here matters more than in the old plain-text case, since a
      // truncated review is a *stored*, permanent artifact with no
      // edit-and-resave path, not a live reply the user can just ask again.
      maxTokens: 1536,
      temperature: 0.3,
    });

    const data = await Review.create({
      planId,
      lessonIndex,
      reviewerType: "ai",
      reviewerId: null,
      sectionKey: isWholePlanScope ? "IMPLEMENTATION_OVERALL" : null,
      score: null,
      content: result.text,
      aiModel: result.model,
      planVersionAt: plan.contentVersionAt,
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

const isAdminRequester = async (userId) => {
  const user = await User.findByPk(userId);
  if (!user) return false;
  const roles = await user.getRoles();
  return roles.some((r) => r.name === "admin");
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
