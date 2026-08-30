module.exports = (sequelize, Sequelize) => {
  const LearningMaterial = sequelize.define(
    "learning_material",
    {
      id: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        autoIncrement: true,
      },
      title: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      description: {
        type: Sequelize.TEXT,
      },
      materialType: {
        type: Sequelize.ENUM("file", "link"),
        allowNull: false,
      },
      attachmentPath: {
        type: Sequelize.STRING(1024),
      },
      attachmentName: {
        type: Sequelize.STRING(255),
      },
      attachmentMime: {
        type: Sequelize.STRING(255),
      },
      attachmentSize: {
        type: Sequelize.BIGINT,
      },
      externalUrl: {
        type: Sequelize.STRING(1024), // 视频链接
      },
      theme: {
        type: Sequelize.STRING(255),
      },
      grade: {
        type: Sequelize.STRING(32),
      },
      uploadedBy: {
        type: Sequelize.BIGINT,
      },
    },
    {
      tableName: "learning_materials",
      freezeTableName: true,
    }
  );

  return LearningMaterial;
};
