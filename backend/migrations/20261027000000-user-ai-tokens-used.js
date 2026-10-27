"use strict";

// Backs the admin user list's "AI 用量" column: the accumulated DashScope
// tokens (input + output, chat + web search + embeddings) spent on this
// user's behalf -- maintained by services/aiUsage.js#recordUsage. Starts at
// 0 for everyone; usage before this migration wasn't recorded anywhere.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("users", "ai_tokens_used", {
      type: Sequelize.BIGINT,
      allowNull: false,
      defaultValue: 0,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("users", "ai_tokens_used");
  },
};
