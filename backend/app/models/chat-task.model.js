module.exports = (sequelize, Sequelize) => {
  // One background run of 欣欣小助手 answering one user message -- see
  // chatTasks.js.
  const ChatTask = sequelize.define(
    "chatTask",
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
      userId: {
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      userMessageId: {
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      assistantMessageId: {
        type: Sequelize.BIGINT, // set once the reply exists
      },
      status: {
        type: Sequelize.ENUM("queued", "running", "done", "failed", "cancelled", "interrupted"),
        allowNull: false,
        defaultValue: "queued",
      },
      steps: {
        type: Sequelize.JSON, // [{ label, status: "running" | "done", startedAt, endedAt }]
      },
      error: {
        type: Sequelize.TEXT,
      },
      startedAt: {
        type: Sequelize.DATE,
      },
      finishedAt: {
        type: Sequelize.DATE,
      },
    },
    {
      tableName: "chat_tasks",
      freezeTableName: true,
    }
  );

  return ChatTask;
};
