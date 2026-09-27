"use strict";

// Human revision of AI 点评标准 -- see ai-review-standard.model.js. Existing
// rows are all AI-generated, hence the 'ai' default.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("ai_review_standards", "source", {
      type: Sequelize.ENUM("ai", "human"),
      allowNull: false,
      defaultValue: "ai",
    });
    await queryInterface.addColumn("ai_review_standards", "base_id", {
      type: Sequelize.BIGINT,
      allowNull: true,
    });
    await queryInterface.addColumn("ai_review_standards", "change_note", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn("ai_review_standards", "cautions", {
      type: Sequelize.JSON,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("ai_review_standards", "cautions");
    await queryInterface.removeColumn("ai_review_standards", "change_note");
    await queryInterface.removeColumn("ai_review_standards", "base_id");
    await queryInterface.removeColumn("ai_review_standards", "source");
  },
};
