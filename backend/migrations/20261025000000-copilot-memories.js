"use strict";

// 欣欣小助手's per-user memory (copilotUserProfile.js) -- durable facts and
// preferences a user shared, carried into every later conversation.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("copilot_memories", {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      user_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: "users", key: "id" },
        onDelete: "CASCADE",
      },
      content: { type: Sequelize.STRING(500), allowNull: false },
      source_conversation_id: { type: Sequelize.BIGINT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex("copilot_memories", ["user_id"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("copilot_memories");
  },
};
