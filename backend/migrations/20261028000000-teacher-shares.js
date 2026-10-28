"use strict";

// 教师分享 -- teachers share their views on an admin-defined 话题 (e.g.
// "一堂乡土课程带来的影响"), each share carrying its own files.
//
// share_topics   -- the 话题, admin-curated. A topic with any share under it
//                   is locked (no rename/delete, see share-topic.controller.js);
//                   shares.share_topic_id's ON DELETE RESTRICT backs that up.
// shares         -- one teacher's share: author, optional related plan, title
//                   and 简介.
// share_folders / share_artifacts -- the share's files, a parallel copy of
//                   material_folders/material_artifacts keyed by share_id
//                   instead of material_topic_id, so lesson-file-manager.
//                   component.js serves them unchanged (same reasoning as
//                   20260905000000-materials-library.js for not generalizing
//                   the existing pair in place).
module.exports = {
  async up(queryInterface, Sequelize) {
    const timestamps = {
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    };

    await queryInterface.createTable("share_topics", {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      title: { type: Sequelize.STRING(255), allowNull: false },
      description: { type: Sequelize.TEXT, allowNull: true },
      created_by: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: "users", key: "id" },
        onDelete: "SET NULL",
      },
      ...timestamps,
    });

    await queryInterface.createTable("shares", {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      share_topic_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: "share_topics", key: "id" },
        onDelete: "RESTRICT",
      },
      author_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: "users", key: "id" },
        onDelete: "CASCADE",
      },
      related_plan_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: "plans", key: "id" },
        onDelete: "SET NULL",
      },
      title: { type: Sequelize.STRING(255), allowNull: false },
      summary: { type: Sequelize.TEXT, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex("shares", ["share_topic_id"]);
    await queryInterface.addIndex("shares", ["author_id"]);

    await queryInterface.createTable("share_folders", {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      share_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: "shares", key: "id" },
        onDelete: "CASCADE",
      },
      parent_folder_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: "share_folders", key: "id" },
        onDelete: "CASCADE",
      },
      name: { type: Sequelize.STRING(255), allowNull: false },
      ...timestamps,
    });

    await queryInterface.createTable("share_artifacts", {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      share_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: "shares", key: "id" },
        onDelete: "CASCADE",
      },
      folder_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: "share_folders", key: "id" },
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
    await queryInterface.dropTable("share_artifacts");
    await queryInterface.dropTable("share_folders");
    await queryInterface.dropTable("shares");
    await queryInterface.dropTable("share_topics");
  },
};
