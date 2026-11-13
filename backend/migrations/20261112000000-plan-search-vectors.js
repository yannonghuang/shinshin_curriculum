"use strict";

// 全部乡土课程's 语义搜索 (services/planSearch.js): one row per non-empty
// plan field (课程设计 section fields and each 课时's fields), holding the
// field's text and its embedding, so a search ranks plans in-process
// without any LLM call.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("plan_search_vectors", {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      plan_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: "plans", key: "id" },
        onDelete: "CASCADE",
      },
      // "s0.f2" (section field) or "L3.f4" (第3课时's field f4).
      part_key: { type: Sequelize.STRING(64), allowNull: false },
      label: { type: Sequelize.STRING(255), allowNull: false },
      content: { type: Sequelize.TEXT, allowNull: false },
      content_hash: { type: Sequelize.STRING(64), allowNull: false },
      // Normalized float32 vectors back to back -- the whole field's, then
      // its ~200-char windows' (see planSearch.js). Binary: as JSON, prod's
      // ~10k vectors would take ~220 MB and as much again to parse.
      vectors: { type: Sequelize.BLOB("medium"), allowNull: false },
      dims: { type: Sequelize.INTEGER, allowNull: false },
      embedding_model: { type: Sequelize.STRING(64), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex("plan_search_vectors", ["plan_id", "part_key"], { unique: true });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("plan_search_vectors");
  },
};
