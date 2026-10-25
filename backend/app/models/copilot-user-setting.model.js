module.exports = (sequelize, Sequelize) => {
  // Per-user 欣欣小助手 switches. No row = defaults.
  const CopilotUserSetting = sequelize.define(
    "copilotUserSetting",
    {
      userId: {
        type: Sequelize.BIGINT,
        primaryKey: true,
      },
      // The background memory pass (copilotMemoryExtractor.js) -- on unless
      // the user turned it off in 记忆.
      autoMemory: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    },
    {
      tableName: "copilot_user_settings",
      freezeTableName: true,
    }
  );

  return CopilotUserSetting;
};
