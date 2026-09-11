"use strict";

// Adds the multi-level context-compaction columns to chat_conversations --
// see chatCompaction.js. Replaces the previous pure-truncation behavior
// (only the last HISTORY_TURNS raw messages ever reached the model) with a
// rolling prose summary (running_summary) plus a merged structured fact
// sheet (fact_sheet) covering everything older than the raw window, and a
// high-water mark (summarized_through_message_id) recording how far that
// compaction has progressed so the next cycle knows which messages are still
// unfolded. All nullable -- an untouched/short conversation simply never
// populates them, same as before this migration.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("chat_conversations", "running_summary", {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn("chat_conversations", "fact_sheet", {
      type: Sequelize.JSON,
      allowNull: true,
    });
    await queryInterface.addColumn("chat_conversations", "summarized_through_message_id", {
      type: Sequelize.BIGINT,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("chat_conversations", "summarized_through_message_id");
    await queryInterface.removeColumn("chat_conversations", "fact_sheet");
    await queryInterface.removeColumn("chat_conversations", "running_summary");
  },
};
