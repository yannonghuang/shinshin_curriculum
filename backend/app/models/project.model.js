// 项目管理 -- see migrations/20261106000000-project-management.js. One
// app-wide file space: ProjectFolder/ProjectArtifact mirror
// teacher-share.model.js's ShareFolder/ShareArtifact minus the owner key.
module.exports = (sequelize, Sequelize) => {
  const ProjectFolder = sequelize.define(
    "projectFolder",
    {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      parentFolderId: { type: Sequelize.BIGINT }, // NULL = root of 项目管理
      name: { type: Sequelize.STRING(255), allowNull: false },
    },
    { tableName: "project_folders", freezeTableName: true }
  );

  const ProjectArtifact = sequelize.define(
    "projectArtifact",
    {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      folderId: { type: Sequelize.BIGINT }, // NULL = root of 项目管理
      category: { type: Sequelize.STRING(64), allowNull: false }, // 'Word文档' | '课件PPT' | '图片' | '视频'
      description: { type: Sequelize.STRING(1024) },
      attachmentPath: { type: Sequelize.STRING(1024), allowNull: false },
      attachmentName: { type: Sequelize.STRING(255), allowNull: false },
      attachmentMime: { type: Sequelize.STRING(255) },
      attachmentSize: { type: Sequelize.BIGINT },
      type: { type: Sequelize.STRING(64), allowNull: false }, // lowercased file extension
    },
    { tableName: "project_artifacts", freezeTableName: true }
  );

  return { ProjectFolder, ProjectArtifact };
};
