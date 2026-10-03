"use strict";

// chat_attachments -- files a user hands 欣欣助手 (picked, dropped or pasted
// into the panel, see copilotAttachments.js). Uploaded before the message
// that carries them exists, so message_id starts null and is filled in when
// the user actually sends; never-sent uploads are swept by
// chatRetention.js#purgeOrphanAttachments. The original document itself is
// not kept -- only its extracted text, which is what the model reads --
// except for images, whose (client-downscaled) bytes stay so the bubble can
// show them and a Word export can embed them. Cascades with its message,
// and so with its conversation's retention sweep.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("chat_attachments", {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      user_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: "users", key: "id" },
        onDelete: "CASCADE",
      },
      message_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: "chat_messages", key: "id" },
        onDelete: "CASCADE",
      },
      name: { type: Sequelize.STRING(255), allowNull: false },
      mime: { type: Sequelize.STRING(128), allowNull: true },
      size: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      kind: { type: Sequelize.ENUM("document", "image"), allowNull: false },
      extracted_text: { type: Sequelize.TEXT("long"), allowNull: true },
      image_data: { type: Sequelize.BLOB("medium"), allowNull: true },
      width: { type: Sequelize.INTEGER, allowNull: true },
      height: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex("chat_attachments", ["message_id"]);
    await queryInterface.addIndex("chat_attachments", ["user_id", "message_id"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("chat_attachments");
  },
};
