"use strict";

// The part of a plan a question was asked about (copilotFocus.js) -- set on
// a user message sent from a field's / section's 问欣欣小助手 menu on the plan
// page. Kept on the message itself, not just the in-memory task context, so
// a 重试 still knows what was asked about, later turns replay with their
// own focus, and the panel can label the bubble.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("chat_messages", "focus", {
      type: Sequelize.JSON,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("chat_messages", "focus");
  },
};
