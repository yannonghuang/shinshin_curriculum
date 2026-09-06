const db = require("../models");
const ChatConversation = db.chatConversation;
const ChatMessage = db.chatMessage;
const Plan = db.plan;
const Review = db.review;
const agentLoop = require("../services/agentLoop");
const { searchKnowledgeBase, searchKnowledgeBaseToolDef } = require("../services/knowledgeRetrieve");
const { getPlanDetailsToolDef, getPlanDetails } = require("../services/planContext");

// How many past turns feed back into the model as conversation context --
// caps token usage/cost as a thread grows long, rather than sending its
// entire history on every turn.
const HISTORY_TURNS = 10;
const TITLE_MAX_LEN = 40;

const COPILOT_SYSTEM_PROMPT =
  "你是「乡土课程项目实施与案例分享系统」的助手，帮助教师解答关于乡土课程设计、实施与共享学习材料库的问题。" +
  "如有需要，可调用 search_knowledge_base 工具查询共享学习材料库中的相关参考资料；不需要参考资料时无需调用。用中文简明清晰地回复。";

// Scopes a conversation to whatever the user is currently looking at, so
// switching between plans (or leaving a review discussion) doesn't drag
// unrelated history along -- reviewId implies its own plan, so it takes
// precedence; a bare planId scopes to the plan generally; no pageContext at
// all falls back to the one general-assistant conversation (scopeKey: null),
// same as before this existed.
const deriveScopeKey = (pageContext) => {
  if (!pageContext) return null;
  if (pageContext.reviewId) return `review:${pageContext.reviewId}`;
  if (pageContext.planId) return `plan:${pageContext.planId}`;
  return null;
};

// "Session" here is just "this user's most recent conversation row *for this
// scope*" -- the app has no session infra of its own (stateless JWT + DB
// throughout), so this is the whole mechanism: lazily create one if none
// exists yet for that (userId, scopeKey) pair.
const getOrCreateCurrentConversation = async (userId, scopeKey) => {
  let conversation = await ChatConversation.findOne({ where: { userId, scopeKey }, order: [["id", "DESC"]] });
  if (!conversation) {
    conversation = await ChatConversation.create({ userId, scopeKey });
  }
  return conversation;
};

// Builds the extra system-prompt text (and any tools/executors) a given
// pageContext contributes -- a lightweight pointer either way, not the full
// plan content (see get_plan_details's own comment for why). reviewId also
// injects the review's own (short, already-generated) text directly, since
// unlike a whole plan's content there's no reason to make the model fetch
// something 200-500 characters long on demand.
const buildContextAddition = async (pageContext) => {
  if (!pageContext) return "";
  if (pageContext.reviewId) {
    const review = await Review.findByPk(pageContext.reviewId);
    if (!review) return "";
    const plan = await Plan.findByPk(review.planId, { attributes: ["id", "title"] });
    const planLine = plan ? `课程设计《${plan.title}》(planId: ${plan.id})` : `课程设计 (planId: ${review.planId})`;
    return (
      `\n\n教师当前正在讨论关于${planLine}的一条点评：\n${review.content}\n` +
      `如需查看该课程设计的详细内容，可调用 get_plan_details 工具（planId=${review.planId}）。`
    );
  }
  if (pageContext.planId) {
    const plan = await Plan.findByPk(pageContext.planId, { attributes: ["id", "title"] });
    if (!plan) return "";
    return `\n\n教师当前正在查看课程设计《${plan.title}》(planId: ${plan.id})，如与问题相关，可调用 get_plan_details 工具查看详细内容。`;
  }
  return "";
};

const normalizePageContextQuery = (query) => ({
  planId: query.planId ? Number(query.planId) : undefined,
  reviewId: query.reviewId ? Number(query.reviewId) : undefined,
});

// GET /api/chat/conversations/current?planId=&reviewId=
exports.getCurrent = async (req, res) => {
  try {
    const pageContext = normalizePageContextQuery(req.query);
    const scopeKey = deriveScopeKey(pageContext);
    const conversation = await getOrCreateCurrentConversation(req.userId, scopeKey);
    const messages = await ChatMessage.findAll({
      where: { conversationId: conversation.id },
      order: [["id", "DESC"]],
      limit: HISTORY_TURNS * 2,
    });
    return res.send({ conversation, messages: messages.reverse() });
  } catch (err) {
    return res.status(500).send({ message: err.message || "加载对话失败。" });
  }
};

// POST /api/chat/conversations/new -- explicit "新对话" reset, scoped the
// same way as GET .../current so it starts a fresh thread for whatever the
// user is currently looking at, not a fresh *global* thread.
exports.startNew = async (req, res) => {
  try {
    const scopeKey = deriveScopeKey(req.body.pageContext);
    const conversation = await ChatConversation.create({ userId: req.userId, scopeKey });
    return res.send({ conversation, messages: [] });
  } catch (err) {
    return res.status(500).send({ message: err.message || "创建新对话失败。" });
  }
};

// POST /api/chat/conversations/current/messages
// body: { content, pageContext?: { planId?, reviewId? } } -- pageContext is
// looked up server-side (not trusted verbatim from the client) so the system
// prompt reflects the plan/review's actual current data, not whatever the
// client claims.
exports.sendMessage = async (req, res) => {
  try {
    const content = (req.body.content || "").trim();
    if (!content) {
      return res.status(422).send({ message: "消息内容不能为空。" });
    }

    const pageContext = req.body.pageContext;
    const scopeKey = deriveScopeKey(pageContext);
    const conversation = await getOrCreateCurrentConversation(req.userId, scopeKey);

    const userMessage = await ChatMessage.create({ conversationId: conversation.id, role: "user", content });
    if (!conversation.title) {
      await conversation.update({ title: content.slice(0, TITLE_MAX_LEN) });
    }

    const priorMessages = await ChatMessage.findAll({
      where: { conversationId: conversation.id },
      order: [["id", "DESC"]],
      limit: HISTORY_TURNS * 2,
    });
    const history = priorMessages.reverse().map((m) => ({ role: m.role, content: m.content }));

    let systemPrompt = COPILOT_SYSTEM_PROMPT;
    try {
      systemPrompt += await buildContextAddition(pageContext);
    } catch (e) {
      console.error("加载当前课程设计/点评上下文失败（不影响消息发送）:", e.message);
    }

    const result = await agentLoop.runAgentLoop({
      systemPrompt,
      messages: history,
      tools: [searchKnowledgeBaseToolDef, getPlanDetailsToolDef],
      executors: {
        search_knowledge_base: (args) => searchKnowledgeBase(args.query),
        get_plan_details: (args) => getPlanDetails(args),
      },
      // Higher than review's own cap -- a chat reply routinely runs long
      // (structured markdown with tables/sections, especially once
      // get_plan_details content is in play), and a truncated reply mid-
      // sentence is worse here than in a stored review, since the user is
      // reading it live and there's no edit-and-resave path to fix it.
      maxTokens: 2048,
      temperature: 0.3,
    });

    const assistantMessage = await ChatMessage.create({
      conversationId: conversation.id,
      role: "assistant",
      content: result.text,
      retrievedChunkIds: result.toolCallLog.length > 0 ? result.toolCallLog : null,
    });

    return res.send({ userMessage, assistantMessage });
  } catch (err) {
    return res.status(500).send({ message: err.message || "发送消息时发生错误。" });
  }
};
