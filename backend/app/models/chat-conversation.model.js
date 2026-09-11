module.exports = (sequelize, Sequelize) => {
  const ChatConversation = sequelize.define(
    "chatConversation",
    {
      id: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        autoIncrement: true,
      },
      userId: {
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      title: {
        type: Sequelize.STRING(255), // derived from the first user message, truncated
      },
      scopeKey: {
        // null = the general assistant conversation; 'plan:<id>'/'review:<id>'
        // scope a thread to one plan/review so switching between them doesn't
        // mix unrelated history -- see chat.controller.js#deriveScopeKey.
        type: Sequelize.STRING(64),
      },
      // Multi-level context compaction -- see chatCompaction.js. runningSummary
      // is a bounded, self-compacting prose summary of everything older than
      // the raw window fed to the model; factSheet is a structured, merged
      // (never silently dropped) record of durable decisions/constraints/open
      // questions from that same history. summarizedThroughMessageId is the
      // high-water mark: messages with id beyond it haven't been folded in
      // yet. All null until a conversation grows past the raw-window
      // threshold.
      runningSummary: {
        type: Sequelize.TEXT,
      },
      factSheet: {
        type: Sequelize.JSON,
      },
      summarizedThroughMessageId: {
        type: Sequelize.BIGINT,
      },
    },
    {
      tableName: "chat_conversations",
      freezeTableName: true,
    }
  );

  return ChatConversation;
};
