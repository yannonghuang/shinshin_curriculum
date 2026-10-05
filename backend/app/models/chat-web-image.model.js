module.exports = (sequelize, Sequelize) => {
  // A web photo found by find_photos, stored for serving -- see the
  // chat_web_images migration for why it's copied rather than hotlinked.
  const ChatWebImage = sequelize.define(
    "chatWebImage",
    {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      conversationId: { type: Sequelize.BIGINT, allowNull: false },
      userId: { type: Sequelize.BIGINT, allowNull: false },
      pageUrl: { type: Sequelize.STRING(2048), allowNull: false },
      pageTitle: { type: Sequelize.STRING(255) },
      site: { type: Sequelize.STRING(128) },
      imageUrl: { type: Sequelize.STRING(2048), allowNull: false },
      mime: { type: Sequelize.STRING(32), allowNull: false }, // from the bytes (webImages.js#sniffImage), never the remote header
      data: { type: Sequelize.BLOB("medium"), allowNull: false },
      width: { type: Sequelize.INTEGER },
      height: { type: Sequelize.INTEGER },
    },
    { tableName: "chat_web_images", freezeTableName: true, updatedAt: false }
  );
  return ChatWebImage;
};
