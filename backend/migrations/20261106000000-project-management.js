"use strict";

// 项目管理 -- a cloud file repository for admins' documents: ONE app-wide
// file space, organized however admins like with folders. Admin/super only,
// reads included (see project.routes.js).
//
// project_folders / project_artifacts -- same shape as share_folders/
// share_artifacts minus the owner key, so services/fileSpace.js (single-space
// mode) and lesson-file-manager.component.js serve them unchanged.
module.exports = {
  async up(queryInterface, Sequelize) {
    const timestamps = {
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    };

    await queryInterface.createTable("project_folders", {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      parent_folder_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: "project_folders", key: "id" },
        onDelete: "CASCADE",
      },
      name: { type: Sequelize.STRING(255), allowNull: false },
      ...timestamps,
    });

    await queryInterface.createTable("project_artifacts", {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      folder_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: "project_folders", key: "id" },
        onDelete: "SET NULL",
      },
      category: { type: Sequelize.STRING(64), allowNull: false },
      description: { type: Sequelize.STRING(1024), allowNull: true },
      attachment_path: { type: Sequelize.STRING(1024), allowNull: false },
      attachment_name: { type: Sequelize.STRING(255), allowNull: false },
      attachment_mime: { type: Sequelize.STRING(255), allowNull: true },
      attachment_size: { type: Sequelize.BIGINT, allowNull: true },
      type: { type: Sequelize.STRING(64), allowNull: false },
      ...timestamps,
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("project_artifacts");
    await queryInterface.dropTable("project_folders");
  },
};
