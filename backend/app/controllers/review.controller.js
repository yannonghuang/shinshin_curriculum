const dynamicDocGenerator = require("../services/dynamicDocGenerator");
const textExtract = require("../services/textExtract");

const db = require("../models");
const Review = db.review;
const Plan = db.plan;
const Artifact = db.artifact;
const User = db.user;
const TemplateVersion = db.templateVersion;
const agentLoop = require("../services/agentLoop");
const { searchKnowledgeBase, searchKnowledgeBaseToolDef } = require("../services/knowledgeRetrieve");

const findExecutionRecord = (plan, lessonIndex) => {
  const records = Array.isArray(plan.executionFormData) ? plan.executionFormData : [];
  return records.find((r) => Number(r.index) === Number(lessonIndex)) || {};
};

// Schema-agnostic (field keys come from whichever template_versions row is
// active, not a fixed list) -- any non-empty answer, ignoring the sparse
// array's own `index` bookkeeping key, counts as "has content".
const hasAnswerContent = (record) =>
  Object.entries(record || {}).some(([key, value]) => key !== "index" && value != null && String(value).trim() !== "");

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

// Which uploaded artifact's actual *content* (not just its filename) gets
// read into an AI review prompt, in order of precedence: Word > PPT > photos
// > videos. The AI review model (see llmClient.js) is text-only -- no vision
// support -- so only Word/PPT can really be read; a photo or video "wins" the
// precedence over a lower tier that isn't present, but never contributes
// extracted text of its own, matching the deliberate text-only scope here
// (adding real image analysis would mean switching to a vision-capable
// DashScope model for this call, a separate decision). Only the modern
// XML-based formats (.docx/.pptx) are extractable; a legacy .doc/.ppt in the
// winning tier still counts toward that tier -- so its presence doesn't fall
// through to a lower type -- it just contributes no text of its own.
const WORD_EXTS = ["docx"];
const PPT_EXTS = ["pptx"];
const MAX_EXTRACTED_CHARS = 6000; // keeps the prompt bounded regardless of how many/how large the winning tier's files are

// .docx/.pptx extraction itself lives in textExtract.js (shared with the
// knowledge-base ingestion pipeline); this just adapts it to an Artifact row.
const extractArtifactText = async (artifact) => textExtract.extractTextFromFile(artifact.attachmentPath, artifact.type);

// Picks the highest-precedence tier with at least one artifact present, and
// extracts as much of its files' text as fits in MAX_EXTRACTED_CHARS
// (truncating the last file included, if any, rather than dropping it
// entirely). Returns null if there are no artifacts at all.
const buildPrecedenceExtract = async (artifacts) => {
  const tiers = [
    { label: "Word 文档", match: (a) => WORD_EXTS.includes((a.type || "").toLowerCase()) },
    { label: "PPT 课件", match: (a) => PPT_EXTS.includes((a.type || "").toLowerCase()) },
    { label: "照片", match: (a) => a.category === "图片" },
    { label: "视频", match: (a) => a.category === "视频" },
  ];
  for (const tier of tiers) {
    const matched = artifacts.filter(tier.match);
    if (matched.length === 0) continue;

    const parts = [];
    let used = 0;
    for (const artifact of matched) {
      const text = await extractArtifactText(artifact);
      if (!text) continue;
      const remaining = MAX_EXTRACTED_CHARS - used;
      if (remaining <= 0) break;
      const slice = text.length > remaining ? `${text.slice(0, remaining)}……（内容过长，已截断）` : text;
      parts.push(`【${artifact.attachmentName}】\n${slice}`);
      used += slice.length;
    }
    return { tierLabel: tier.label, matchedCount: matched.length, extractedCount: parts.length, text: parts.join("\n\n") };
  }
  return null;
};

const buildAiReviewPrompt = async (plan, lessonIndex, artifacts) => {
  const systemPrompt =
    "你是乡土课程教学专家，请对以下课程设计/实施记录整体做点评，从目标达成、内容设计、可操作性、创新性等维度给出优点、不足和改进建议，用中文回复，200-500字。" +
    "如果需要参考共享学习材料库中与该课程主题相关的资料（例如同主题的其他课程案例、专家讲解等）来支撑你的点评，可以调用 search_knowledge_base 工具查询；不需要参考资料时无需调用。";

  const lines = [];
  lines.push(`课程标题：${plan.title || ""}`);
  if (plan.theme) lines.push(`乡土主题：${plan.theme}`);
  if (plan.grade) lines.push(`年级：${plan.grade}`);
  if (plan.plannedLessonCount) lines.push(`预计课时：${plan.plannedLessonCount}`);

  const appendArtifactSection = async (introLine, listIntro) => {
    lines.push(introLine);
    lines.push(listIntro);
    for (const a of artifacts) {
      lines.push(`- [${a.category}] ${a.attachmentName}${a.description ? "：" + a.description : ""}`);
    }
    const extract = await buildPrecedenceExtract(artifacts);
    if (extract && extract.text) {
      lines.push(`\n以下是优先级最高的一类已上传文件（${extract.tierLabel}，共 ${extract.matchedCount} 个，已提取 ${extract.extractedCount} 个的文字内容）：`);
      lines.push(extract.text);
    }
  };

  if (lessonIndex) {
    lines.push(`\n本次点评针对第 ${lessonIndex} 课时的乡土课程实施记录。`);

    // 实施记录 (the online-fill form, see 课程实施文件's 上传/下载/预览 --
    // plan.controller.js#renderExecutionDoc) is preferred over 支撑材料
    // (uploaded files) when both exist: render the same on-the-fly .docx
    // 课程实施文件's 下载/预览 would produce and read that back as the
    // primary section, same pattern as the plan-level planFormData branch
    // below, then still append 支撑材料 as secondary/supplementary context
    // rather than discarding it outright.
    const record = findExecutionRecord(plan, lessonIndex);
    const hasRecord = hasAnswerContent(record);
    if (hasRecord) {
      try {
        const buffer = await dynamicDocGenerator.generateDoc({
          docTitle: `课时实施记录 · 第${lessonIndex}课时`,
          schema: plan.ExecutionTemplateVersion ? plan.ExecutionTemplateVersion.schemaJson : { sections: [] },
          answers: record,
        });
        const docText = await textExtract.extractDocxTextFromBuffer(buffer);
        lines.push("以下是该课时的实施记录（在线填写，优先参考）：");
        lines.push(docText || "（文档内容为空）");
      } catch (e) {
        console.error("AI 点评：生成课时实施记录文档失败。", e.message);
      }
    }

    if (artifacts && artifacts.length > 0) {
      await appendArtifactSection("", hasRecord ? "补充上传的支撑材料：" : "该课时已上传的支撑材料：");
    } else if (!hasRecord) {
      lines.push("该课时暂无实施记录或已上传的支撑材料文件。");
    }
  } else if (plan.planFormData) {
    // Render the same on-the-fly .docx the 课程设计文件 panel's 下载/预览
    // commands would produce (see plan.controller.js#renderDoc) and read
    // that back, rather than dumping the raw planFormData JSON -- the AI
    // reviews exactly what a human reader would download/preview, and
    // nothing is persisted here either. Falls back to the raw JSON if
    // rendering/extraction fails for any reason.
    try {
      const buffer = await dynamicDocGenerator.generateDoc({
        docTitle: "乡土课程设计方案",
        schema: plan.PlanTemplateVersion ? plan.PlanTemplateVersion.schemaJson : { sections: [] },
        answers: plan.planFormData,
      });
      const docText = await textExtract.extractDocxTextFromBuffer(buffer);
      lines.push("\n以下是该课程设计方案文档内容：");
      lines.push(docText || "（文档内容为空）");
    } catch (e) {
      console.error("AI 点评：生成课程设计文档失败，回退为原始表单数据。", e.message);
      lines.push("\n以下是该课程设计方案的在线填写内容（JSON）：");
      lines.push(JSON.stringify(plan.planFormData, null, 2));
    }
  } else if (artifacts && artifacts.length > 0) {
    await appendArtifactSection("", "该课程设计未使用在线表单填写，已上传的课程设计文件：");
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

    const lessonIndex = normalizeLessonIndex(req.body.lessonIndex);

    let artifacts = [];
    if (lessonIndex) {
      artifacts = await Artifact.findAll({ where: { planId, lessonIndex } });
    } else if (!plan.planFormData) {
      artifacts = await Artifact.findAll({ where: { planId, lessonIndex: null } });
    }

    const { systemPrompt, userContent } = await buildAiReviewPrompt(plan, lessonIndex, artifacts);

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
