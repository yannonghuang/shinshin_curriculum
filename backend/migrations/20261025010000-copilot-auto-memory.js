"use strict";

// Automatic memory (copilotMemoryExtractor.js): a background pass over idle
// conversations saves what's worth remembering about the user, on top of
// what the assistant saves mid-reply.
//   - copilot_memories.origin: who wrote it -- 'chat' (the assistant, during
//     a reply), 'manual' (the user, in 记忆), 'auto' (the background pass).
//   - chat_conversations.memory_reviewed_through_message_id: the pass's
//     high-water mark, so each message is reviewed once.
//   - copilot_user_settings: per-user switches; auto_memory turns the
//     background pass off for that user.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("copilot_memories", "origin", {
      type: Sequelize.STRING(16),
      allowNull: false,
      defaultValue: "chat",
    });
    await queryInterface.addColumn("chat_conversations", "memory_reviewed_through_message_id", {
      type: Sequelize.BIGINT,
      allowNull: true,
    });
    await queryInterface.createTable("copilot_user_settings", {
      user_id: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        references: { model: "users", key: "id" },
        onDelete: "CASCADE",
      },
      auto_memory: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("copilot_user_settings");
    await queryInterface.removeColumn("chat_conversations", "memory_reviewed_through_message_id");
    await queryInterface.removeColumn("copilot_memories", "origin");
  },
};
