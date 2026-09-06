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
    },
    {
      tableName: "chat_conversations",
      freezeTableName: true,
    }
  );

  return ChatConversation;
};
