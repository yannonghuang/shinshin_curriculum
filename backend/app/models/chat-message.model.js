module.exports = (sequelize, Sequelize) => {
  const ChatMessage = sequelize.define(
    "chatMessage",
    {
      id: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        autoIncrement: true,
      },
      conversationId: {
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      role: {
        type: Sequelize.ENUM("user", "assistant", "tool"),
        allowNull: false,
      },
      content: {
        type: Sequelize.TEXT,
      },
      toolCallId: {
        type: Sequelize.STRING(64), // only set for role='tool' -- the OpenAI tool-result message convention
      },
      retrievedChunkIds: {
        type: Sequelize.JSON, // audit trail for a "参考资料" footer under assistant replies
      },
      replyToMessageId: {
        // the user message this assistant reply answers -- a slow (background)
        // answer can arrive after newer messages; see chatTasks.js
        type: Sequelize.BIGINT,
      },
    },
    {
      tableName: "chat_messages",
      freezeTableName: true,
      updatedAt: false, // messages are append-only, never edited in place
    }
  );

  return ChatMessage;
};
