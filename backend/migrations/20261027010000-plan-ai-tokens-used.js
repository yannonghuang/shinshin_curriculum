"use strict";

// Backs the 数据看板's "AI 用量" column: the accumulated DashScope tokens
// spent on this plan -- its AI 打分/点评 and 欣欣小助手 turns about it --
// maintained by services/aiUsage.js#recordUsage. Starts at 0; earlier usage
// wasn't recorded anywhere.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("plans", "ai_tokens_used", {
      type: Sequelize.BIGINT,
      allowNull: false,
      defaultValue: 0,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("plans", "ai_tokens_used");
  },
};
