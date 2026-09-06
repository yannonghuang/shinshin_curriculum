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
    },
    {
      tableName: "chat_conversations",
      freezeTableName: true,
    }
  );

  return ChatConversation;
};
