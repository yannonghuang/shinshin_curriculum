"use strict";

// Replaces the old flat 共享学习材料库 (learning_materials: one row = one
// file-or-link) with a Year -> Theme(主题) tree: material_topics holds each
// Theme's 基本信息, material_links its 材料链接 rows, and material_folders/
// material_artifacts are a parallel copy of folders/artifacts (see
// folder.model.js/artifact.model.js) minus lesson_index -- material contents
// is one flat file tree per Theme, no per-lesson concept needed. Kept as a
// separate pair of tables rather than generalizing folders/artifacts
// in place: those are NOT NULL on plan_id (and folders.lesson_index), and
// plan_id is threaded through ~15 call sites in artifact.controller.js --
// reusing them here would mean a wide refactor of code the Plan feature
// depends on today, for no benefit specific to this feature.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("material_topics", {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      year: { type: Sequelize.INTEGER, allowNull: false },
      theme: { type: Sequelize.STRING(255), allowNull: false },
      lecturer: { type: Sequelize.STRING(255), allowNull: true },
      comment: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.createTable("material_links", {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      material_topic_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: "material_topics", key: "id" },
        onDelete: "CASCADE",
      },
      description: { type: Sequelize.STRING(255), allowNull: true },
      url: { type: Sequelize.STRING(1024), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.createTable("material_folders", {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      material_topic_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: "material_topics", key: "id" },
        onDelete: "CASCADE",
      },
      parent_folder_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: "material_folders", key: "id" },
        onDelete: "CASCADE",
      },
      name: { type: Sequelize.STRING(255), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.createTable("material_artifacts", {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      material_topic_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: "material_topics", key: "id" },
        onDelete: "CASCADE",
      },
      folder_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: "material_folders", key: "id" },
        onDelete: "SET NULL",
      },
      category: { type: Sequelize.STRING(64), allowNull: false },
      description: { type: Sequelize.STRING(1024), allowNull: true },
      attachment_path: { type: Sequelize.STRING(1024), allowNull: false },
      attachment_name: { type: Sequelize.STRING(255), allowNull: false },
      attachment_mime: { type: Sequelize.STRING(255), allowNull: true },
      attachment_size: { type: Sequelize.BIGINT, allowNull: true },
      type: { type: Sequelize.STRING(64), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.dropTable("learning_materials");
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.createTable("learning_materials", {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      title: { type: Sequelize.STRING(255), allowNull: false },
      description: { type: Sequelize.TEXT, allowNull: true },
      material_type: { type: Sequelize.ENUM("file", "link"), allowNull: false },
      attachment_path: { type: Sequelize.STRING(1024), allowNull: true },
      attachment_name: { type: Sequelize.STRING(255), allowNull: true },
      attachment_mime: { type: Sequelize.STRING(255), allowNull: true },
      attachment_size: { type: Sequelize.BIGINT, allowNull: true },
      external_url: { type: Sequelize.STRING(1024), allowNull: true },
      theme: { type: Sequelize.STRING(255), allowNull: true },
      grade: { type: Sequelize.STRING(32), allowNull: true },
      uploaded_by: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: "users", key: "id" },
        onDelete: "SET NULL",
      },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.dropTable("material_artifacts");
    await queryInterface.dropTable("material_folders");
    await queryInterface.dropTable("material_links");
    await queryInterface.dropTable("material_topics");
  },
};
