module.exports = (sequelize, Sequelize) => {
  const ChatAttachment = sequelize.define(
    "chatAttachment",
    {
      id: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        autoIncrement: true,
      },
      userId: {
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      messageId: {
        type: Sequelize.BIGINT, // null until the user sends the message carrying it
      },
      name: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      mime: {
        type: Sequelize.STRING(128),
      },
      size: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      kind: {
        type: Sequelize.ENUM("document", "image"),
        allowNull: false,
      },
      extractedText: {
        type: Sequelize.TEXT("long"), // what the model reads -- see copilotAttachments.js
      },
      imageData: {
        type: Sequelize.BLOB("medium"), // images only; documents keep just their text
      },
      width: {
        type: Sequelize.INTEGER,
      },
      height: {
        type: Sequelize.INTEGER,
      },
    },
    {
      tableName: "chat_attachments",
      freezeTableName: true,
      updatedAt: false,
    }
  );

  return ChatAttachment;
};
