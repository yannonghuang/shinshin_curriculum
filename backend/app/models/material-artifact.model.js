module.exports = (sequelize, Sequelize) => {
  const MaterialArtifact = sequelize.define(
    "materialArtifact",
    {
      id: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        autoIncrement: true,
      },
      materialTopicId: {
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      folderId: {
        type: Sequelize.BIGINT, // NULL = root of that 主题's file space
      },
      category: {
        type: Sequelize.STRING(64),
        allowNull: false, // 'Word文档' | '课件PPT' | '图片' | '视频'
      },
      description: {
        type: Sequelize.STRING(1024),
      },
      attachmentPath: {
        type: Sequelize.STRING(1024),
        allowNull: false,
      },
      attachmentName: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      attachmentMime: {
        type: Sequelize.STRING(255),
      },
      attachmentSize: {
        type: Sequelize.BIGINT,
      },
      type: {
        type: Sequelize.STRING(64),
        allowNull: false, // lowercased file extension
      },
    },
    {
      tableName: "material_artifacts",
      freezeTableName: true,
    }
  );

  return MaterialArtifact;
};
