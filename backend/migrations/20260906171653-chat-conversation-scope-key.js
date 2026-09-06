"use strict";

// Adds scope_key to chat_conversations so a conversation can be scoped to
// something specific (e.g. 'plan:42', 'review:17') instead of every
// conversation being one single, ever-growing, global thread per user --
// see chat.controller.js's deriveScopeKey. NULL keeps meaning "the general
// assistant conversation," unaffected by this change.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("chat_conversations", "scope_key", {
      type: Sequelize.STRING(64),
      allowNull: true,
    });
    await queryInterface.addIndex("chat_conversations", ["user_id", "scope_key"]);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex("chat_conversations", ["user_id", "scope_key"]);
    await queryInterface.removeColumn("chat_conversations", "scope_key");
  },
};
