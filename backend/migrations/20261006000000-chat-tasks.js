"use strict";

// Async 欣欣小助手 turns (see chatTasks.js): every message is answered by a
// background task, and a turn that isn't done within a few seconds hands the
// teacher back a progress card instead of blocking the panel.
//   chat_tasks -- one row per answered user message: status, live progress
//                 steps, and the reply once it exists.
//   chat_messages.reply_to_message_id -- the user message an assistant reply
//                 answers. A slow answer can land after newer messages; this
//                 is what lets both the panel and the model's history put it
//                 back under its own question.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("chat_tasks", {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      conversation_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: "chat_conversations", key: "id" },
        onDelete: "CASCADE",
      },
      user_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: "users", key: "id" },
        onDelete: "CASCADE",
      },
      user_message_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: "chat_messages", key: "id" },
        onDelete: "CASCADE",
      },
      assistant_message_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: "chat_messages", key: "id" },
        onDelete: "SET NULL",
      },
      status: {
        type: Sequelize.ENUM("queued", "running", "done", "failed", "cancelled", "interrupted"),
        allowNull: false,
        defaultValue: "queued",
      },
      steps: { type: Sequelize.JSON, allowNull: true },
      error: { type: Sequelize.TEXT, allowNull: true },
      started_at: { type: Sequelize.DATE, allowNull: true },
      finished_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex("chat_tasks", ["conversation_id", "status"]);
    await queryInterface.addIndex("chat_tasks", ["status"]);

    await queryInterface.addColumn("chat_messages", "reply_to_message_id", {
      type: Sequelize.BIGINT,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("chat_messages", "reply_to_message_id");
    await queryInterface.dropTable("chat_tasks");
  },
};
