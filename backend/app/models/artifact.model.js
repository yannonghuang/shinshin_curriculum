module.exports = (sequelize, Sequelize) => {
  const Artifact = sequelize.define(
    "artifact",
    {
      id: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        autoIncrement: true,
      },
      planId: {
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      lessonIndex: {
        type: Sequelize.INTEGER, // NULL = plan-level file; 1..N = that lesson's tab
      },
      folderId: {
        type: Sequelize.BIGINT, // NULL = root of that 课时's file space; see folder.model.js
      },
      category: {
        type: Sequelize.STRING(64),
        allowNull: false, // '课程设计文件' | '实施记录文件' | '课件PPT' | '图片' | '视频'
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
      tableName: "artifacts",
      freezeTableName: true,
    }
  );

  return Artifact;
};
