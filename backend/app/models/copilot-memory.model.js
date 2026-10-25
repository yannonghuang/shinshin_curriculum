module.exports = (sequelize, Sequelize) => {
  // One thing 欣欣小助手 remembers about one user across conversations -- a
  // preference, a standing fact about their teaching, an ongoing goal. Saved
  // by the model's remember tool when the user states it (or asks it to
  // remember), or by the user themselves from the panel's 记忆 view; shown
  // to and editable by that user only. See copilotUserProfile.js.
  const CopilotMemory = sequelize.define(
    "copilotMemory",
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
      content: {
        type: Sequelize.STRING(500),
        allowNull: false,
      },
      // Who wrote it: 'chat' (the assistant, during a reply), 'manual' (the
      // user, in 记忆), 'auto' (copilotMemoryExtractor.js's background pass,
      // shown as 自动 in 记忆).
      origin: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: "chat",
      },
      // The conversation it was learned in (null = added by hand in 记忆).
      sourceConversationId: {
        type: Sequelize.BIGINT,
      },
    },
    {
      tableName: "copilot_memories",
      freezeTableName: true,
    }
  );

  return CopilotMemory;
};
