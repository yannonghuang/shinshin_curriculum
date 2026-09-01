const db = require("../models");
const Review = db.review;
const Plan = db.plan;
const Artifact = db.artifact;
const User = db.user;
const llmClient = require("../services/llmClient");

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

    const data = await Review.create({
      planId,
      lessonIndex: normalizeLessonIndex(req.body.lessonIndex),
      reviewerType: "expert",
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

const buildAiReviewPrompt = (plan, lessonIndex, artifacts) => {
  const systemPrompt =
    "你是乡土课程教学专家，请对以下课程设计/实施记录整体做点评，从目标达成、内容设计、可操作性、创新性等维度给出优点、不足和改进建议，用中文回复，200-500字。";

  const lines = [];
  lines.push(`课程标题：${plan.title || ""}`);
  if (plan.theme) lines.push(`乡土主题：${plan.theme}`);
  if (plan.grade) lines.push(`年级：${plan.grade}`);
  if (plan.plannedLessonCount) lines.push(`预计课时：${plan.plannedLessonCount}`);

  if (lessonIndex) {
    lines.push(`\n本次点评针对第 ${lessonIndex} 课时的乡土课程实施记录。`);
    if (artifacts && artifacts.length > 0) {
      lines.push("该课时已上传的实施记录文件：");
      for (const a of artifacts) {
        lines.push(`- [${a.category}] ${a.attachmentName}${a.description ? "：" + a.description : ""}`);
      }
    } else {
      lines.push("该课时暂无已上传的实施记录文件。");
    }
  } else if (plan.planFormData) {
    lines.push("\n以下是该课程设计方案的在线填写内容（JSON）：");
    lines.push(JSON.stringify(plan.planFormData, null, 2));
  } else if (artifacts && artifacts.length > 0) {
    lines.push("\n该课程设计未使用在线表单填写，已上传的课程设计文件：");
    for (const a of artifacts) {
      lines.push(`- [${a.category}] ${a.attachmentName}${a.description ? "：" + a.description : ""}`);
    }
  } else {
    lines.push("\n该课程设计暂无在线表单内容或上传文件。");
  }

  return { systemPrompt, userContent: lines.join("\n") };
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

    const plan = await Plan.findByPk(planId);
    if (!plan) {
      return res.status(404).send({ message: "乡土课程设计不存在。" });
    }

    // Owner-only, no admin bypass -- matches plan.controller.js#update and
    // #generateDoc's content-authoring rule: requesting an AI review is part
    // of working on one's own case, not a management action.
    if (plan.teacherId !== req.userId) {
      return res.status(403).send({ message: "只能为本人创建的乡土课程设计请求 AI 点评。" });
    }

    const lessonIndex = normalizeLessonIndex(req.body.lessonIndex);

    let artifacts = [];
    if (lessonIndex) {
      artifacts = await Artifact.findAll({ where: { planId, lessonIndex } });
    } else if (!plan.planFormData) {
      artifacts = await Artifact.findAll({ where: { planId, lessonIndex: null } });
    }

    const { systemPrompt, userContent } = buildAiReviewPrompt(plan, lessonIndex, artifacts);

    const result = await llmClient.llmChat({
      systemPrompt,
      messages: [{ role: "user", content: userContent }],
      maxTokens: 1024,
      temperature: 0.3,
    });

    const data = await Review.create({
      planId,
      lessonIndex,
      reviewerType: "ai",
      reviewerId: null,
      sectionKey: null,
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
