const db = require("../models");
const ChatConversation = db.chatConversation;
const ChatMessage = db.chatMessage;
const Plan = db.plan;
const Review = db.review;
const { QueryTypes } = db.Sequelize;
const agentLoop = require("../services/agentLoop");
const { searchKnowledgeBase, searchKnowledgeBaseToolDef } = require("../services/knowledgeRetrieve");
const { getPlanDetailsToolDef, getPlanDetails } = require("../services/planContext");

// How many past turns feed back into the model as conversation context --
// caps token usage/cost as a thread grows long, rather than sending its
// entire history on every turn. HISTORY_VIEW_LIMIT is separate and more
// generous -- it's what a human browsing a past thread sees (getById), not
// what gets replayed into the model.
const HISTORY_TURNS = 10;
const HISTORY_VIEW_LIMIT = 100;
const TITLE_MAX_LEN = 40;

// A conversation idle longer than this is never resumed as "current" --
// coming back to the same plan/review (or the general assistant) after a day
// away starts fresh instead of reviving a stale thread. This only changes
// what counts as "current"; the old conversation's rows aren't touched here
// -- actual deletion is a separate, longer-window sweep (see
// chatRetention.js), since "don't resume this" and "delete this" are
// different questions with different acceptable timeframes. It also has no
// bearing on listConversations/getConversationById below -- those show
// every retained thread regardless of this window, since browsing history
// on purpose is a different action than passively landing on a page.
const CONVERSATION_FRESH_START_MS = 24 * 60 * 60 * 1000;

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

// The reverse of deriveScopeKey -- used when continuing an explicitly-
// selected past conversation (sendMessageToConversation below): that
// thread's own context should always be what it was originally about
// (e.g. Plan A), never wherever the user happens to be browsing right now
// (e.g. Plan B's page), which is the whole point of picking it from a list
// instead of just landing on "current".
const parseScopeKeyToPageContext = (scopeKey) => {
  if (!scopeKey) return undefined;
  if (scopeKey.startsWith("review:")) return { reviewId: Number(scopeKey.slice("review:".length)) };
  if (scopeKey.startsWith("plan:")) return { planId: Number(scopeKey.slice("plan:".length)) };
  return undefined;
};

// "Session" here is just "this user's most recent conversation row *for this
// scope*" -- the app has no session infra of its own (stateless JWT + DB
// throughout), so this is the whole mechanism: lazily create one if none
// exists yet for that (userId, scopeKey) pair, or if the one that exists has
// gone stale (see CONVERSATION_FRESH_START_MS).
const getOrCreateCurrentConversation = async (userId, scopeKey) => {
  let conversation = await ChatConversation.findOne({ where: { userId, scopeKey }, order: [["id", "DESC"]] });
  if (conversation) {
    // Last actual activity, not the conversation row's own updatedAt --
    // creating the row doesn't get touched by adding messages to it, so the
    // row's own timestamp would never reflect a real conversation's activity.
    const lastMessage = await ChatMessage.findOne({
      where: { conversationId: conversation.id },
      order: [["id", "DESC"]],
      attributes: ["createdAt"],
    });
    const lastActivity = lastMessage ? lastMessage.createdAt : conversation.createdAt;
    if (Date.now() - new Date(lastActivity).getTime() > CONVERSATION_FRESH_START_MS) {
      conversation = null; // stale -- fall through to start a fresh one
    }
  }
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
    const plan = await Plan.findByPk(review.planId, { attributes: ["id", "title", "contentVersionAt"] });
    const planLine = plan ? `课程设计《${plan.title}》(planId: ${plan.id})` : `课程设计 (planId: ${review.planId})`;
    // The review's own text is a frozen snapshot of what the AI said at the
    // time (review.planVersionAt) -- if the plan has since been edited
    // (contentVersionAt moved on, the same staleness check
    // review.controller.js#delete already uses to lock old reviews against
    // deletion), that feedback may no longer match what's actually in the
    // plan today. Surfaced here so neither the model nor the teacher acts on
    // stale feedback without realizing it might be stale.
    const isStale =
      plan && review.planVersionAt && new Date(review.planVersionAt).getTime() !== new Date(plan.contentVersionAt).getTime();
    const staleNote = isStale ? "\n注意：该点评基于该课程设计的旧版本，课程内容可能已发生变化，回答时请提醒教师这一点。" : "";
    return (
      `\n\n教师当前正在讨论关于${planLine}的一条点评：\n${review.content}\n` +
      `如需查看该课程设计的详细内容，可调用 get_plan_details 工具（planId=${review.planId}）。${staleNote}`
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

// Shared by both sendMessage (current-scope-resolved) and
// sendMessageToConversation (an explicitly-picked past thread) -- appends
// the user/assistant turn to whichever conversation row and pageContext the
// caller already resolved.
const appendTurn = async (conversation, content, pageContext) => {
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

  return { userMessage, assistantMessage };
};

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

    const { userMessage, assistantMessage } = await appendTurn(conversation, content, pageContext);
    return res.send({ userMessage, assistantMessage });
  } catch (err) {
    return res.status(500).send({ message: err.message || "发送消息时发生错误。" });
  }
};

// GET /api/chat/conversations -- lists every retained conversation for this
// user ("revisit all threads"), regardless of CONVERSATION_FRESH_START_MS --
// deliberately browsing history is a different action than passively landing
// on "current" for a page, so the 24h rule doesn't apply here. Each row's
// scopeKey is resolved into a human label (batch-fetching the referenced
// plans/reviews, not one query per row) and ordered by actual last activity,
// same "last message, or creation time if none" rule as everywhere else.
exports.listConversations = async (req, res) => {
  try {
    const conversations = await ChatConversation.findAll({ where: { userId: req.userId }, order: [["id", "DESC"]] });
    if (conversations.length === 0) return res.send([]);

    const conversationIds = conversations.map((c) => c.id);
    const lastActivityRows = await db.sequelize.query(
      `SELECT conversation_id, MAX(created_at) AS last_activity FROM chat_messages WHERE conversation_id IN (:ids) GROUP BY conversation_id`,
      { replacements: { ids: conversationIds }, type: QueryTypes.SELECT }
    );
    const lastActivityById = new Map(lastActivityRows.map((r) => [r.conversation_id, r.last_activity]));

    const planIds = new Set();
    const reviewIds = new Set();
    for (const c of conversations) {
      if (c.scopeKey && c.scopeKey.startsWith("plan:")) planIds.add(Number(c.scopeKey.slice("plan:".length)));
      if (c.scopeKey && c.scopeKey.startsWith("review:")) reviewIds.add(Number(c.scopeKey.slice("review:".length)));
    }
    const reviews = reviewIds.size
      ? await Review.findAll({ where: { id: Array.from(reviewIds) }, attributes: ["id", "planId"] })
      : [];
    for (const r of reviews) planIds.add(r.planId);
    const reviewPlanById = new Map(reviews.map((r) => [r.id, r.planId]));
    const plans = planIds.size ? await Plan.findAll({ where: { id: Array.from(planIds) }, attributes: ["id", "title"] }) : [];
    const planTitleById = new Map(plans.map((p) => [p.id, p.title]));

    const results = conversations.map((c) => {
      let label = "通用助手";
      if (c.scopeKey && c.scopeKey.startsWith("plan:")) {
        const planId = Number(c.scopeKey.slice("plan:".length));
        label = planTitleById.has(planId) ? `课程设计《${planTitleById.get(planId)}》` : "课程设计（已删除）";
      } else if (c.scopeKey && c.scopeKey.startsWith("review:")) {
        const reviewId = Number(c.scopeKey.slice("review:".length));
        const planId = reviewPlanById.get(reviewId);
        label = planId && planTitleById.has(planId) ? `点评讨论 · 《${planTitleById.get(planId)}》` : "点评讨论（已删除）";
      }
      return {
        id: c.id,
        scopeKey: c.scopeKey,
        title: c.title,
        label,
        lastActivity: lastActivityById.get(c.id) || c.createdAt,
      };
    });
    results.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

    return res.send(results);
  } catch (err) {
    return res.status(500).send({ message: err.message || "加载对话列表失败。" });
  }
};

// GET /api/chat/conversations/:id -- full history for one specific,
// explicitly-picked conversation (from the list above). Ownership-checked
// (userId must match); returns 404 rather than another user's data for a
// conversation id that isn't this user's.
exports.getConversationById = async (req, res) => {
  try {
    const conversation = await ChatConversation.findOne({ where: { id: req.params.id, userId: req.userId } });
    if (!conversation) return res.status(404).send({ message: "未找到该对话。" });
    const messages = await ChatMessage.findAll({
      where: { conversationId: conversation.id },
      order: [["id", "DESC"]],
      limit: HISTORY_VIEW_LIMIT,
    });
    return res.send({ conversation, messages: messages.reverse() });
  } catch (err) {
    return res.status(500).send({ message: err.message || "加载对话失败。" });
  }
};

// POST /api/chat/conversations/:id/messages -- continues an explicitly-
// picked past conversation (as opposed to sendMessage, which always targets
// whatever "current" resolves to for the caller's own page). pageContext is
// derived from *that conversation's own* scopeKey, not from whatever the
// client is currently browsing -- picking an old Plan A thread while sitting
// on Plan B's page should still answer with Plan A's context.
exports.sendMessageToConversation = async (req, res) => {
  try {
    const content = (req.body.content || "").trim();
    if (!content) {
      return res.status(422).send({ message: "消息内容不能为空。" });
    }

    const conversation = await ChatConversation.findOne({ where: { id: req.params.id, userId: req.userId } });
    if (!conversation) return res.status(404).send({ message: "未找到该对话。" });

    const pageContext = parseScopeKeyToPageContext(conversation.scopeKey);
    const { userMessage, assistantMessage } = await appendTurn(conversation, content, pageContext);
    return res.send({ userMessage, assistantMessage });
  } catch (err) {
    return res.status(500).send({ message: err.message || "发送消息时发生错误。" });
  }
};

// DELETE /api/chat/conversations/:id -- lets a teacher manually clear a
// thread from their own history list, rather than waiting on the 7-day
// retention sweep (chatRetention.js) or the 24h fresh-start rule. Ownership-
// checked; cascades to the conversation's messages via the FK.
exports.deleteConversation = async (req, res) => {
  try {
    const conversation = await ChatConversation.findOne({ where: { id: req.params.id, userId: req.userId } });
    if (!conversation) return res.status(404).send({ message: "未找到该对话。" });
    await ChatConversation.destroy({ where: { id: conversation.id } });
    return res.send({ message: "对话已删除。" });
  } catch (err) {
    return res.status(500).send({ message: err.message || "删除对话时发生错误。" });
  }
};
