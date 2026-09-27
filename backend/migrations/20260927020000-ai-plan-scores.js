"use strict";

// AI 打分 results -- see ai-plan-score.model.js.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("ai_plan_scores", {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      plan_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: "plans", key: "id" },
        onDelete: "CASCADE",
      },
      standard_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: "ai_review_standards", key: "id" },
      },
      total_score: { type: Sequelize.DECIMAL(5, 1), allowNull: false },
      dimension_scores: { type: Sequelize.JSON, allowNull: false },
      summary: { type: Sequelize.TEXT, allowNull: true },
      ai_model: { type: Sequelize.STRING(128), allowNull: true },
      plan_version_at: { type: Sequelize.DATE, allowNull: true },
      created_by: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: "users", key: "id" },
        onDelete: "SET NULL",
      },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex("ai_plan_scores", ["plan_id"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("ai_plan_scores");
  },
};
