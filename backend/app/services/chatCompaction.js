const db = require("../models");
const ChatMessage = db.chatMessage;
const ChatConversation = db.chatConversation;
const Op = db.Sequelize.Op;
const llmClient = require("./llmClient");
const copilotAttachments = require("./copilotAttachments");

// Multi-level context compaction ("LCM") for chat threads -- replaces pure
// truncation (chat.controller.js's HISTORY_TURNS window used to be the only
// thing standing between a long conversation and its early turns vanishing
// outright) with a bounded rolling summary plus a merged structured fact
// sheet covering everything older than the raw window.
//
// RAW_WINDOW_MESSAGES must track chat.controller.js's HISTORY_TURNS*2
// (messages, not turns) -- kept as its own constant here rather than
// imported across the controller/service boundary, same convention as
// chatRetention.js's RETENTION_DAYS vs chat.controller.js's
// CONVERSATION_FRESH_START_MS (cross-referenced by comment, not by import).
const RAW_WINDOW_MESSAGES = 20;
// How many of the oldest not-yet-summarized messages get folded in per
// compaction cycle. Compaction only triggers once there are more than
// RAW_WINDOW_MESSAGES + COMPACTION_BATCH_MESSAGES messages still
// unsummarized, and folds in exactly COMPACTION_BATCH_MESSAGES of them --
// batching this way means the extra LLM call happens roughly once per 10
// turns, not on every single turn once the conversation is long.
const COMPACTION_BATCH_MESSAGES = 20;
const COMPACTION_TRIGGER_MESSAGES = RAW_WINDOW_MESSAGES + COMPACTION_BATCH_MESSAGES;

const EMPTY_FACT_SHEET = { decisions: [], constraints: [], openQuestions: [] };

// Regenerated (not appended-to) each cycle -- the model gets the *old*
// summary/fact sheet plus the new batch and returns a fresh, merged version
// of both, so the summary self-compacts (stays ~300字) instead of growing
// unboundedly, while the fact sheet only grows for genuinely new durable
// facts and otherwise carries old ones forward verbatim.
const COMPACTION_SYSTEM_PROMPT =
  "你是对话上下文压缩助手。给定此前的摘要、已确认的关键信息表（JSON），以及一段新增的对话内容，请更新它们，" +
  '严格以 JSON 格式回复，不要包含其他文字或代码块标记：{"summary": "...", "factSheet": {"decisions": ["..."], "constraints": ["..."], "openQuestions": ["..."]}}。\n' +
  "summary：将旧摘要与新对话内容合并为一段新摘要，300字以内，只保留仍然重要的信息，不要逐条罗列每一轮对话。\n" +
  "factSheet：在旧的 factSheet 基础上合并新对话中出现的确定性信息（已作出的决定、已知的限制或约束、尚待解决的问题）。" +
  "除非新对话明确推翻或取代了某条旧信息，否则不要删除旧信息；已经解决的 openQuestions 应移到 decisions 而不是继续留在 openQuestions 中。";

// One conversation's own batch only -- never reads or merges another
// conversation's messages/summary/fact sheet. Each chat_conversations row is
// already scoped to a single userId (see chat.controller.js), so a teacher's
// compacted memory stays exactly as private as their raw messages always
// were; this function must preserve that by construction, not by an
// additional check.
async function compactConversationInner(conversationId) {
  try {
    const conversation = await ChatConversation.findByPk(conversationId);
    if (!conversation) return { ok: false, reason: "not_found" };

    const unsummarized = await ChatMessage.findAll({
      where: { conversationId, id: { [Op.gt]: conversation.summarizedThroughMessageId || 0 } },
      order: [["id", "ASC"]],
    });
    if (unsummarized.length <= COMPACTION_TRIGGER_MESSAGES) return { ok: false, reason: "not_due" };

    const batch = unsummarized.slice(0, unsummarized.length - RAW_WINDOW_MESSAGES);
    if (batch.length === 0) return { ok: false, reason: "not_due" };

    // Attachments fold in too (much shorter than in a live turn) -- once a
    // turn leaves the raw window, this summary is the only trace of a file
    // the teacher shared.
    const attachmentsByMessage = await copilotAttachments.loadForMessages(
      batch.filter((m) => m.role === "user").map((m) => m.id),
      { withText: true }
    );
    const batchText = batch
      .map(
        (m) =>
          `${m.role === "user" ? "教师" : "助手"}：${m.content}` +
          copilotAttachments.renderForModel(attachmentsByMessage.get(m.id), { perAttachment: 2000, perTurn: 4000 })
      )
      .join("\n");
    const oldFactSheet = conversation.factSheet || EMPTY_FACT_SHEET;
    const userContent =
      `旧摘要：\n${conversation.runningSummary || "（无）"}\n\n` +
      `旧关键信息表（JSON）：\n${JSON.stringify(oldFactSheet)}\n\n` +
      `新增对话内容：\n${batchText}`;

    const result = await llmClient.llmChat({
      systemPrompt: COMPACTION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      maxTokens: 800,
      temperature: 0.2,
    });

    let parsed;
    try {
      const cleaned = (result.text || "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error("对话上下文压缩：解析 JSON 失败，跳过本次压缩。", e.message);
      return { ok: false, reason: "parse_error" };
    }

    await conversation.update({
      runningSummary: typeof parsed.summary === "string" ? parsed.summary : conversation.runningSummary,
      factSheet: parsed.factSheet && typeof parsed.factSheet === "object" ? parsed.factSheet : oldFactSheet,
      summarizedThroughMessageId: batch[batch.length - 1].id,
    });
    return { ok: true };
  } catch (e) {
    // Best-effort, same as knowledgeIngest.js#regenerateSkillCardInner -- a
    // failed compaction just leaves the conversation's existing
    // summary/fact sheet in place (and the raw window still covers recent
    // turns), never blocks the actual chat reply that triggered the check.
    console.error("对话上下文压缩失败（不影响本轮回复）:", e.message);
    return { ok: false, reason: "error", message: e.message };
  }
}

// Per-conversation tail-promise queue, same pattern as
// knowledgeIngest.js's skillCardQueues -- avoids two near-simultaneous turns
// on the same conversation both reading "not due yet" before either writes
// back, or both trying to compact the same batch. Takes a plain
// conversationId (not a loaded row) and re-fetches inside
// compactConversationInner, same reason knowledgeIngest.js's
// regenerateSkillCard does: by the time a queued call actually runs, an
// earlier call in the same queue may have already updated the row.
const compactionQueues = new Map();

function maybeCompact(conversationId) {
  const tail = (compactionQueues.get(conversationId) || Promise.resolve()).catch(() => {});
  const run = tail.then(() => compactConversationInner(conversationId));
  compactionQueues.set(conversationId, run.catch(() => {}));
  return run;
}

// Renders layers 1 (runningSummary) and 2 (factSheet) as system-prompt text,
// appended after the fixed system prompt and before any page-context
// addition (see chat.controller.js#appendTurn) -- layer 0 (the raw recent
// messages) is passed separately as `messages`, unchanged from before this
// feature existed. Returns "" for a conversation that hasn't hit the
// compaction threshold yet (both columns still null), so a short
// conversation's prompt is byte-for-byte what it always was.
function renderCompactedContext(conversation) {
  const parts = [];
  const factSheet = conversation.factSheet;
  if (factSheet) {
    const { decisions = [], constraints = [], openQuestions = [] } = factSheet;
    const lines = [];
    if (decisions.length) lines.push(`已确定：${decisions.join("；")}`);
    if (constraints.length) lines.push(`限制/约束：${constraints.join("；")}`);
    if (openQuestions.length) lines.push(`尚待解决：${openQuestions.join("；")}`);
    if (lines.length) parts.push(`\n\n此前对话已确认的关键信息：\n${lines.join("\n")}`);
  }
  if (conversation.runningSummary) {
    parts.push(`\n\n此前对话摘要：${conversation.runningSummary}`);
  }
  return parts.join("");
}

module.exports = { maybeCompact, renderCompactedContext, RAW_WINDOW_MESSAGES, COMPACTION_BATCH_MESSAGES };
