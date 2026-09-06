const db = require("../models");
const ChatConversation = db.chatConversation;
const ChatMessage = db.chatMessage;
const Plan = db.plan;
const agentLoop = require("../services/agentLoop");
const { searchKnowledgeBase, searchKnowledgeBaseToolDef } = require("../services/knowledgeRetrieve");

// How many past turns feed back into the model as conversation context --
// caps token usage/cost as a thread grows long, rather than sending its
// entire history on every turn.
const HISTORY_TURNS = 10;
const TITLE_MAX_LEN = 40;

const COPILOT_SYSTEM_PROMPT =
  "你是「乡土课程项目实施与案例分享系统」的助手，帮助教师解答关于乡土课程设计、实施与共享学习材料库的问题。" +
  "如有需要，可调用 search_knowledge_base 工具查询共享学习材料库中的相关参考资料；不需要参考资料时无需调用。用中文简明清晰地回复。";

// "Session" here is just "this user's most recent conversation row" -- the
// app has no session infra of its own (stateless JWT + DB throughout), so
// this is the whole mechanism: lazily create one if none exists yet.
const getOrCreateCurrentConversation = async (userId) => {
  let conversation = await ChatConversation.findOne({ where: { userId }, order: [["id", "DESC"]] });
  if (!conversation) {
    conversation = await ChatConversation.create({ userId });
  }
  return conversation;
};

// GET /api/chat/conversations/current
exports.getCurrent = async (req, res) => {
  try {
    const conversation = await getOrCreateCurrentConversation(req.userId);
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

// POST /api/chat/conversations/new -- explicit "新对话" reset.
exports.startNew = async (req, res) => {
  try {
    const conversation = await ChatConversation.create({ userId: req.userId });
    return res.send({ conversation, messages: [] });
  } catch (err) {
    return res.status(500).send({ message: err.message || "创建新对话失败。" });
  }
};

// POST /api/chat/conversations/current/messages
// body: { content, pageContext?: { planId } } -- pageContext is looked up
// server-side (not trusted verbatim from the client) so the system prompt
// reflects the plan's actual current title, not whatever the client claims.
exports.sendMessage = async (req, res) => {
  try {
    const content = (req.body.content || "").trim();
    if (!content) {
      return res.status(422).send({ message: "消息内容不能为空。" });
    }

    const conversation = await getOrCreateCurrentConversation(req.userId);

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
    const planId = req.body.pageContext && req.body.pageContext.planId;
    if (planId) {
      const plan = await Plan.findByPk(planId, { attributes: ["title"] });
      if (plan) systemPrompt += `\n教师当前正在查看课程设计《${plan.title}》，如与问题相关可结合此上下文回答。`;
    }

    const result = await agentLoop.runAgentLoop({
      systemPrompt,
      messages: history,
      tools: [searchKnowledgeBaseToolDef],
      executors: { search_knowledge_base: (args) => searchKnowledgeBase(args.query) },
      maxTokens: 1024,
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
