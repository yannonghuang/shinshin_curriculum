"use strict";

// AI 点评标准 -- see ai-review-standard.model.js. Append-only: each
// (re)generation inserts a new row rather than overwriting, so a plan scored
// against an earlier standard can always be traced back to exactly the
// rubric it was scored with.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("ai_review_standards", {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      content: { type: Sequelize.JSON, allowNull: false },
      source_topic_ids: { type: Sequelize.JSON, allowNull: true },
      ai_model: { type: Sequelize.STRING(128), allowNull: true },
      created_by: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: "users", key: "id" },
        onDelete: "SET NULL",
      },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("ai_review_standards");
  },
};
