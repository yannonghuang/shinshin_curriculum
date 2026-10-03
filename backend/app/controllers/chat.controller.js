const db = require("../models");
const ChatConversation = db.chatConversation;
const ChatMessage = db.chatMessage;
const Plan = db.plan;
const Review = db.review;
const { QueryTypes, Op } = db.Sequelize;
const agentLoop = require("../services/agentLoop");
const copilotActions = require("../services/copilotActions");
const chatCompaction = require("../services/chatCompaction");
const llmClient = require("../services/llmClient");

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

// Same primary/secondary framing as review.controller.js's
// AI_REVIEW_SYSTEM_PROMPT: when a question concerns a specific plan/review
// (its theme, grade, locality are surfaced via get_plan_details, see
// planContext.js#buildBasicInfoLines), lead with what's specific to that
// theme and place -- generic teaching-methodology advice stays available but
// brief, since that's the human专家's primary lane.
const COPILOT_SYSTEM_PROMPT =
  "你是「乡土课程项目实施与案例分享系统」的助手，帮助教师解答关于乡土课程设计、实施与共享学习材料库的问题。" +
  "如果问题涉及某个具体的课程设计，请优先给出结合该课程具体主题、年级与学校/地区的针对性建议（本地资源、主题特有的注意事项等）；" +
  "通用教学方法方面的建议可以提及，但请保持简短，这类问题通常由人类专家给出更全面的指导。" +
  "如有需要，可调用 search_knowledge_base 工具查询共享学习材料库中的相关参考资料（可结合课程主题或所在地区检索）；不需要参考资料时无需调用。用中文简明清晰地回复。";

// Appended after COPILOT_SYSTEM_PROMPT -- 欣欣助手 can also *do* things on
// the user's behalf through copilotActions.js's role-filtered tools, so the
// model needs to know when to act, how to turn a drafted plan into the
// template's own fields, and that confirm-tier actions aren't done until the
// user clicks.
const ROLE_LABELS = { teacher: "教师", expert: "专家", admin: "管理员", super: "超级管理员" };
const buildActionPrompt = ({ roles, labels, apiCount }) =>
  `\n\n当前用户角色：${roles.map((r) => ROLE_LABELS[r] || r).join("、") || "未知"}。` +
  `你可以通过工具直接代表用户执行系统操作，范围仅限于该用户自己的权限。专用工具：${labels.join("、")}；` +
  `此外还可通过 list_available_apis 查看、通过 call_api 调用该用户有权使用的全部 ${apiCount} 个系统接口。优先使用专用工具，没有合适的专用工具时再用 call_api。` +
  "规则：" +
  "1. 用户明确要求执行某个操作时（如「把刚才的草案建成新的课程设计」「把第二课时的实施记录填上」），直接调用相应工具完成，不要让用户自己去手动操作；用户只是咨询或讨论时，不要擅自修改任何数据。" +
  "2. 新建或修改课程设计内容前，先调用 get_plan_template 获取字段清单，再把对话中的草案内容逐项填入对应字段 key（尽量完整保留草案原文，不要压缩成摘要）；分课时内容填入 lessons，不要放进其他字段；草案中没有对应内容的字段留空。" +
  "标题、主题、年级、课时数等基本信息能从对话中确定就填写，主题与年级必须取自模板返回的选项，无法确定的留空，不要编造。" +
  "3. 不要编造课程设计 ID 或主题 ID：需要时先用 list_plans、list_material_topics 等工具查询；指代不明时先向用户确认是哪一个。" +
  "4. 工具返回 pendingConfirmation 时，该操作尚未执行，请简要说明将要执行的操作并提示用户点击对话框中的「确认执行」按钮；绝不能声称已经完成。" +
  "5. 操作完成后简要说明结果（如新建课程设计的标题）；工具返回 error 时如实告知原因，不要假装成功。" +
  // A thread started before these tools existed may hold earlier "I can't
  // save/upload that" replies -- left unchecked, the model stays consistent
  // with its own history instead of using what it can do now.
  "6. 以当前可用的工具为准：即使本对话早先的回复说过无法上传、保存或执行某操作，现在只要有相应工具就直接执行。「上传/保存/录入草稿到系统」即指新建（或更新）课程设计。";

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
// Last actual activity, not the conversation row's own updatedAt -- creating
// the row doesn't get touched by adding messages to it, so the row's own
// timestamp would never reflect a real conversation's activity.
const lastActivityOf = async (conversation) => {
  const lastMessage = await ChatMessage.findOne({
    where: { conversationId: conversation.id },
    order: [["id", "DESC"]],
    attributes: ["createdAt"],
  });
  return new Date(lastMessage ? lastMessage.createdAt : conversation.createdAt).getTime();
};

// The user's most recent still-fresh conversation in which 欣欣助手 created or
// changed this plan (see copilotActions.js's `changed.planIds`) -- e.g. the
// general thread where a draft was just built into plan X. That thread
// already holds everything about plan X, so opening plan X's page continues
// it instead of starting an empty plan-scoped one (see
// getOrCreateCurrentConversation).
const findActionLinkedConversation = async (userId, planId) => {
  const conversations = await ChatConversation.findAll({ where: { userId }, attributes: ["id"] });
  if (conversations.length === 0) return null;
  const messages = await ChatMessage.findAll({
    where: {
      conversationId: { [Op.in]: conversations.map((c) => c.id) },
      role: "assistant",
      retrievedChunkIds: { [Op.ne]: null },
      createdAt: { [Op.gte]: new Date(Date.now() - CONVERSATION_FRESH_START_MS) },
    },
    attributes: ["conversationId", "retrievedChunkIds"],
    order: [["id", "DESC"]],
  });
  const linked = messages.find(
    (m) =>
      Array.isArray(m.retrievedChunkIds) &&
      m.retrievedChunkIds.some((e) => {
        const ids = e && e.output && e.output.changed && e.output.changed.planIds;
        return Array.isArray(ids) && ids.some((id) => Number(id) === Number(planId));
      })
  );
  return linked ? ChatConversation.findByPk(linked.conversationId) : null;
};

const getOrCreateCurrentConversation = async (userId, scopeKey) => {
  let conversation = await ChatConversation.findOne({ where: { userId, scopeKey }, order: [["id", "DESC"]] });
  let lastActivity = conversation ? await lastActivityOf(conversation) : 0;
  if (conversation && Date.now() - lastActivity > CONVERSATION_FRESH_START_MS) {
    conversation = null; // stale -- fall through to start a fresh one
  }

  // A plan page also counts a conversation that acted on this plan as one of
  // its own, whichever is more recently active -- so a draft built into a
  // plan from the general assistant (or from another plan's page) carries
  // straight on when the teacher opens that plan, by link or from the list.
  // An explicit 新对话 on the plan page creates a newer plan-scoped row,
  // which then wins as usual.
  if (scopeKey && scopeKey.startsWith("plan:")) {
    const linked = await findActionLinkedConversation(userId, Number(scopeKey.slice("plan:".length)));
    if (linked && (!conversation || (await lastActivityOf(linked)) > lastActivity)) {
      conversation = linked;
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

// Admin-only "分享到共享知识库" draft step (see chat.routes.js's share-draft
// route) -- same strict-JSON knowledge-card shape as
// knowledgeIngest.js#regenerateSkillCardInner's prompt, so the resulting
// draft is a drop-in payload for the existing
// PUT /api/material-topics/:id/skill (material-topic.controller.js#updateSkill).
const SHARE_DRAFT_SYSTEM_PROMPT =
  "你是共享知识库的整理助手。请阅读以下管理员与AI智能体对话的内容（可能是摘要与关键信息，也可能是原始对话），" +
  "从中提炼出已经讨论并达成一致、值得分享给所有教师参考的内容，整理成一张知识卡片。" +
  '严格以 JSON 格式回复，不要包含其他文字或代码块标记：{"title": "...", "summary": "...", "keyPoints": ["...", "..."], "tags": ["...", "..."]}。' +
  "summary 控制在150字以内，keyPoints 3-5条，tags 3-6个关键词。";

const normalizePageContextQuery = (query) => ({
  planId: query.planId ? Number(query.planId) : undefined,
  reviewId: query.reviewId ? Number(query.reviewId) : undefined,
});

// Continuing an AI review's own discussion (opened via review-list.
// component.js's 讨论 button, review-scoped pageContext.reviewId) is
// reserved to the plan's owning teacher -- matches createAiReview's own
// owner-only check above and review-list.component.js's canTriggerAi gate
// on showing that button at all. Enforced here too (not just hidden client-
// side) since every entry point that can establish a review-scoped
// conversation (getCurrent's auto-create, startNew, sendMessage) accepts a
// client-supplied reviewId. A bare planId pageContext (the general co-pilot,
// not opened from a specific review) is unaffected -- broader browsing of a
// plan's own content already has no ownership restriction elsewhere in this
// app (see plan.controller.js#findAll's cross-teacher visibility), and this
// gate only concerns the review-discussion affordance itself.
const assertReviewOwnership = async (userId, reviewId) => {
  const review = await Review.findByPk(reviewId, { attributes: ["id", "planId"] });
  if (!review) {
    const err = new Error("未找到该点评。");
    err.status = 404;
    throw err;
  }
  const plan = await Plan.findByPk(review.planId, { attributes: ["id", "teacherId"] });
  if (!plan || plan.teacherId !== userId) {
    const err = new Error("只能查看本人创建的乡土课程设计的点评讨论。");
    err.status = 403;
    throw err;
  }
};

// Only a message's text is replayed as history, not its tool results -- so
// without this, the turn after "建成新的课程设计" wouldn't know which planId
// it just created, or whether a proposed action is still awaiting the
// user's 确认. Read-only lookups (search/list/get) are left out; only
// actions that wrote something or are pending get a line. Goes into the
// system prompt rather than onto the replayed messages themselves -- the
// model otherwise starts imitating the note's format in its own replies.
const ACTION_STATUS_LABELS = { pending: "待用户确认", confirmed: "已执行", cancelled: "已取消", failed: "执行失败" };
const renderActionLog = (messages) => {
  const notes = [];
  for (const message of messages) {
    const log = message.role === "assistant" && Array.isArray(message.retrievedChunkIds) ? message.retrievedChunkIds : [];
    for (const e of log) {
      const o = e && e.output;
      if (!o || !(o.changed || o.pendingConfirmation)) continue;
      if (o.pendingConfirmation) notes.push(`- ${o.summary}（${ACTION_STATUS_LABELS[o.status] || o.status}）`);
      else notes.push(`- ${e.name}${o.planId ? ` planId=${o.planId}` : ""}${o.title ? `《${o.title}》` : ""}（已执行）`);
    }
  }
  return notes.length > 0 ? `\n\n本对话中近期由你代用户发起的操作（系统记录，仅供参考，回复中不要复述此列表）：\n${notes.join("\n")}` : "";
};

// Shared by both sendMessage (current-scope-resolved) and
// sendMessageToConversation (an explicitly-picked past thread) -- appends
// the user/assistant turn to whichever conversation row and pageContext the
// caller already resolved.
const appendTurn = async (conversation, content, pageContext) => {
  const userMessage = await ChatMessage.create({ conversationId: conversation.id, role: "user", content });
  if (!conversation.title) {
    await conversation.update({ title: content.slice(0, TITLE_MAX_LEN) });
  }

  // Multi-level context compaction ("LCM") -- a no-op fast-path under the
  // threshold (see chatCompaction.js's RAW_WINDOW_MESSAGES/
  // COMPACTION_BATCH_MESSAGES), so this costs nothing on the common
  // short-conversation case. `conversation` is reloaded afterward since
  // compactConversationInner updates its own freshly-fetched instance of
  // this row, not the one already held here.
  await chatCompaction.maybeCompact(conversation.id);
  await conversation.reload();

  const priorMessages = await ChatMessage.findAll({
    where: { conversationId: conversation.id },
    order: [["id", "DESC"]],
    limit: HISTORY_TURNS * 2,
  });
  priorMessages.reverse();
  const history = priorMessages.map((m) => ({ role: m.role, content: m.content || "" }));

  // Only the actions this user's roles grant -- see copilotActions.js.
  const toolset = await copilotActions.buildToolset(conversation.userId);

  let systemPrompt =
    COPILOT_SYSTEM_PROMPT +
    buildActionPrompt(toolset) +
    renderActionLog(priorMessages) +
    chatCompaction.renderCompactedContext(conversation);
  try {
    systemPrompt += await buildContextAddition(pageContext);
  } catch (e) {
    console.error("加载当前课程设计/点评上下文失败（不影响消息发送）:", e.message);
  }

  const result = await agentLoop.runAgentLoop({
    systemPrompt,
    messages: history,
    tools: toolset.tools,
    executors: toolset.executors,
    // An action usually takes a lookup first (get_plan_template / list_plans)
    // then the write itself, sometimes a follow-up fix after a validation
    // error -- 3 rounds (review's own cap) leaves no room for that.
    maxRounds: 6,
    // Higher than review's own cap -- a chat reply routinely runs long
    // (structured markdown with tables/sections, especially once
    // get_plan_details content is in play), and a truncated reply mid-
    // sentence is worse here than in a stored review, since the user is
    // reading it live and there's no edit-and-resave path to fix it. Doubled
    // again for actions: create_plan/update_plan carry a whole drafted plan
    // as tool-call arguments, which count against the same budget.
    maxTokens: 4096,
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
    if (pageContext.reviewId) await assertReviewOwnership(req.userId, pageContext.reviewId);
    const scopeKey = deriveScopeKey(pageContext);
    const conversation = await getOrCreateCurrentConversation(req.userId, scopeKey);
    const messages = await ChatMessage.findAll({
      where: { conversationId: conversation.id },
      order: [["id", "DESC"]],
      limit: HISTORY_TURNS * 2,
    });
    return res.send({ conversation, messages: messages.reverse() });
  } catch (err) {
    return res.status(err.status || 500).send({ message: err.message || "加载对话失败。" });
  }
};

// POST /api/chat/conversations/new -- explicit "新对话" reset, scoped the
// same way as GET .../current so it starts a fresh thread for whatever the
// user is currently looking at, not a fresh *global* thread.
exports.startNew = async (req, res) => {
  try {
    const pageContext = req.body.pageContext;
    if (pageContext && pageContext.reviewId) await assertReviewOwnership(req.userId, pageContext.reviewId);
    const scopeKey = deriveScopeKey(pageContext);
    const conversation = await ChatConversation.create({ userId: req.userId, scopeKey });
    return res.send({ conversation, messages: [] });
  } catch (err) {
    return res.status(err.status || 500).send({ message: err.message || "创建新对话失败。" });
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
    if (pageContext && pageContext.reviewId) await assertReviewOwnership(req.userId, pageContext.reviewId);
    const scopeKey = deriveScopeKey(pageContext);
    const conversation = await getOrCreateCurrentConversation(req.userId, scopeKey);

    const { userMessage, assistantMessage } = await appendTurn(conversation, content, pageContext);
    return res.send({ userMessage, assistantMessage });
  } catch (err) {
    return res.status(err.status || 500).send({ message: err.message || "发送消息时发生错误。" });
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

// POST /api/chat/conversations/:id/share-draft -- admin-only (route-gated).
// Turns this conversation's own compacted context (falling back to its raw
// recent messages if compaction hasn't triggered yet, see chatCompaction.js)
// into a *draft* knowledge-card payload for the admin to review/edit --
// nothing is written to the shared knowledge base here. Saving is still the
// existing PUT /api/material-topics/:id/skill, so "an admin explicitly
// decides to share" stays a real, reviewable step rather than anything
// automatic or silent (see the knowledge-scope design in the plan for this
// feature: teacher conversations are never shared; only an admin's own
// conversation, and only on this explicit action).
exports.shareDraft = async (req, res) => {
  try {
    const conversation = await ChatConversation.findOne({ where: { id: req.params.id, userId: req.userId } });
    if (!conversation) return res.status(404).send({ message: "未找到该对话。" });

    let sourceText = "";
    if (conversation.runningSummary || conversation.factSheet) {
      const factSheet = conversation.factSheet || {};
      const factLines = [
        ...(factSheet.decisions || []).map((d) => `决定：${d}`),
        ...(factSheet.constraints || []).map((c) => `约束：${c}`),
      ];
      sourceText = [conversation.runningSummary, ...factLines].filter(Boolean).join("\n");
    }
    if (!sourceText) {
      const messages = await ChatMessage.findAll({
        where: { conversationId: conversation.id },
        order: [["id", "DESC"]],
        limit: HISTORY_TURNS * 2,
      });
      sourceText = messages
        .reverse()
        .map((m) => `${m.role === "user" ? "管理员" : "助手"}：${m.content}`)
        .join("\n");
    }
    if (!sourceText.trim()) {
      return res.status(422).send({ message: "该对话暂无内容，无法生成分享草稿。" });
    }

    const result = await llmClient.llmChat({
      systemPrompt: SHARE_DRAFT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: sourceText }],
      maxTokens: 800,
      temperature: 0.2,
    });

    let parsed;
    try {
      const cleaned = (result.text || "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return res.status(500).send({ message: "生成分享草稿失败：AI 返回内容解析失败，请稍后重试。" });
    }

    return res.send({
      title: parsed.title || conversation.title || "",
      summary: parsed.summary || "",
      keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [],
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    });
  } catch (err) {
    return res.status(500).send({ message: err.message || "生成分享草稿时发生错误。" });
  }
};

// Guards against a double-click running the same confirmed action twice --
// a plain in-memory Set is enough here, same single-Node-process reasoning
// as authJwt.js's lastPersistedActivity.
const actionsInFlight = new Set();

// Shared by confirmAction/cancelAction: resolves one pending action proposed
// in one of this user's own assistant messages (see copilotActions.js's
// confirm tier -- the proposal lives in that message's toolCallLog).
const loadPendingAction = async (userId, messageId, actionId) => {
  const message = await ChatMessage.findByPk(messageId);
  const conversation = message && (await ChatConversation.findOne({ where: { id: message.conversationId, userId } }));
  if (!conversation) {
    const err = new Error("未找到该消息。");
    err.status = 404;
    throw err;
  }
  const log = Array.isArray(message.retrievedChunkIds) ? message.retrievedChunkIds : [];
  const index = log.findIndex((e) => e && e.output && e.output.actionId === actionId);
  if (index === -1) {
    const err = new Error("未找到该待确认操作。");
    err.status = 404;
    throw err;
  }
  if (log[index].output.status !== "pending") {
    const err = new Error("该操作已处理，不能重复执行。");
    err.status = 409;
    throw err;
  }
  return { message, conversation, log, index };
};

// Rewrites one log entry's output in place and posts a short assistant
// follow-up, so the outcome is both visible in the panel and part of the
// history the model sees on the next turn (it otherwise only knows it
// *proposed* the action).
const settlePendingAction = async ({ message, conversation, log, index }, outputPatch, followUpText, followUpLog) => {
  const nextLog = log.map((e, i) => (i === index ? { ...e, output: { ...e.output, ...outputPatch } } : e));
  message.set("retrievedChunkIds", nextLog);
  message.changed("retrievedChunkIds", true);
  await message.save();
  const followUp = await ChatMessage.create({
    conversationId: conversation.id,
    role: "assistant",
    content: followUpText,
    retrievedChunkIds: followUpLog || null,
  });
  return { message, followUp };
};

// POST /api/chat/messages/:messageId/actions/:actionId/confirm -- the user's
// own 确认执行 click on a pending co-pilot action. This, not the model, is
// what actually runs a confirm-tier action.
exports.confirmAction = async (req, res) => {
  const lockKey = `${req.params.messageId}:${req.params.actionId}`;
  if (actionsInFlight.has(lockKey)) return res.status(409).send({ message: "该操作正在执行中。" });
  actionsInFlight.add(lockKey);
  try {
    const pending = await loadPendingAction(req.userId, req.params.messageId, req.params.actionId);
    const entry = pending.log[pending.index];
    const args = entry.arguments ? JSON.parse(entry.arguments) : {};
    const summary = entry.output.summary;
    try {
      const { result } = await copilotActions.runConfirmedAction(req.userId, entry.name, args);
      return res.send(
        await settlePendingAction(pending, { status: "confirmed", result }, `已执行：${summary}。`, [
          { name: entry.name, arguments: entry.arguments, output: result },
        ])
      );
    } catch (e) {
      return res.send(await settlePendingAction(pending, { status: "failed", error: e.message }, `执行失败：${summary}。原因：${e.message}`));
    }
  } catch (err) {
    return res.status(err.status || 500).send({ message: err.message || "执行操作时发生错误。" });
  } finally {
    actionsInFlight.delete(lockKey);
  }
};

// POST /api/chat/messages/:messageId/actions/:actionId/cancel
exports.cancelAction = async (req, res) => {
  try {
    const pending = await loadPendingAction(req.userId, req.params.messageId, req.params.actionId);
    const summary = pending.log[pending.index].output.summary;
    return res.send(await settlePendingAction(pending, { status: "cancelled" }, `已取消：${summary}。`));
  } catch (err) {
    return res.status(err.status || 500).send({ message: err.message || "取消操作时发生错误。" });
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
