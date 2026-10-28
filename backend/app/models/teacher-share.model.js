// 教师分享 -- see migrations/20261028000000-teacher-shares.js. ShareFolder/
// ShareArtifact mirror material-folder.model.js/material-artifact.model.js
// with shareId in place of materialTopicId.
module.exports = (sequelize, Sequelize) => {
  const ShareTopic = sequelize.define(
    "shareTopic",
    {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      title: { type: Sequelize.STRING(255), allowNull: false }, // 话题
      description: { type: Sequelize.TEXT },
      createdBy: { type: Sequelize.BIGINT },
    },
    { tableName: "share_topics", freezeTableName: true }
  );

  const Share = sequelize.define(
    "share",
    {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      shareTopicId: { type: Sequelize.BIGINT, allowNull: false },
      authorId: { type: Sequelize.BIGINT, allowNull: false },
      relatedPlanId: { type: Sequelize.BIGINT },
      title: { type: Sequelize.STRING(255), allowNull: false },
      summary: { type: Sequelize.TEXT }, // 简介
    },
    { tableName: "shares", freezeTableName: true }
  );

  const ShareFolder = sequelize.define(
    "shareFolder",
    {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      shareId: { type: Sequelize.BIGINT, allowNull: false },
      parentFolderId: { type: Sequelize.BIGINT }, // NULL = root of the share's file space
      name: { type: Sequelize.STRING(255), allowNull: false },
    },
    { tableName: "share_folders", freezeTableName: true }
  );

  const ShareArtifact = sequelize.define(
    "shareArtifact",
    {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      shareId: { type: Sequelize.BIGINT, allowNull: false },
      folderId: { type: Sequelize.BIGINT }, // NULL = root of the share's file space
      category: { type: Sequelize.STRING(64), allowNull: false }, // 'Word文档' | '课件PPT' | '图片' | '视频'
      description: { type: Sequelize.STRING(1024) },
      attachmentPath: { type: Sequelize.STRING(1024), allowNull: false },
      attachmentName: { type: Sequelize.STRING(255), allowNull: false },
      attachmentMime: { type: Sequelize.STRING(255) },
      attachmentSize: { type: Sequelize.BIGINT },
      type: { type: Sequelize.STRING(64), allowNull: false }, // lowercased file extension
    },
    { tableName: "share_artifacts", freezeTableName: true }
  );

  return { ShareTopic, Share, ShareFolder, ShareArtifact };
};
