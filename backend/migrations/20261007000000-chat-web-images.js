"use strict";

// Photos 欣欣小助手 found on the web for a conversation (find_photos, see
// copilotActions.js / webImages.js) -- downloaded once and served from here,
// not hotlinked: many image hosts refuse cross-site requests, and the
// teacher's browser never contacts the third-party site. Goes with its
// conversation (retention sweep, 删除 in 历史).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("chat_web_images", {
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
      page_url: { type: Sequelize.STRING(2048), allowNull: false },
      page_title: { type: Sequelize.STRING(255), allowNull: true },
      site: { type: Sequelize.STRING(128), allowNull: true },
      image_url: { type: Sequelize.STRING(2048), allowNull: false },
      mime: { type: Sequelize.STRING(32), allowNull: false },
      data: { type: Sequelize.BLOB("medium"), allowNull: false },
      width: { type: Sequelize.INTEGER, allowNull: true },
      height: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex("chat_web_images", ["conversation_id"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("chat_web_images");
  },
};
