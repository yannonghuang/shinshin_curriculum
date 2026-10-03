const db = require("../models");

// How long a conversation's *data* is kept at all, independent of the much
// shorter CONVERSATION_FRESH_START_MS in chat.controller.js -- "stop
// resuming this" and "delete this" are different questions: a thread idle
// for a day shouldn't be silently revived, but it's still worth keeping
// around for a while in case it's ever looked at again.
const RETENTION_DAYS = 7;

// Deletes every chat_conversations row (cascading to its chat_messages, via
// the FK's ON DELETE CASCADE) whose most recent activity -- its last
// message, or its own creation time if it was created but never messaged --
// is older than RETENTION_DAYS. A LEFT JOIN against each conversation's own
// latest message (not a per-row subquery) so this stays one query regardless
// of how many conversations/messages have accumulated.
//
// Run from a plain in-process interval (see server.js), not a cron job or
// external scheduler -- this app has no other scheduled-task infrastructure,
// and one more moving deployment piece isn't worth it for a daily sweep.
async function purgeStaleConversations() {
  const [result] = await db.sequelize.query(
    `DELETE c FROM chat_conversations c
     LEFT JOIN (
       SELECT conversation_id, MAX(created_at) AS last_activity
       FROM chat_messages
       GROUP BY conversation_id
     ) m ON m.conversation_id = c.id
     WHERE COALESCE(m.last_activity, c.created_at) < DATE_SUB(NOW(), INTERVAL ${RETENTION_DAYS} DAY)`
  );
  return result.affectedRows || 0;
}

// Uploads to 欣欣助手 that were never sent (the panel closed, the chip's ×
// failed, the tab died) -- a sent attachment has a message_id and goes with
// its conversation above. A day is long past any upload still about to be
// sent.
async function purgeOrphanAttachments() {
  const [result] = await db.sequelize.query(
    `DELETE FROM chat_attachments WHERE message_id IS NULL AND created_at < DATE_SUB(NOW(), INTERVAL 1 DAY)`
  );
  return result.affectedRows || 0;
}

module.exports = { purgeStaleConversations, purgeOrphanAttachments, RETENTION_DAYS };
