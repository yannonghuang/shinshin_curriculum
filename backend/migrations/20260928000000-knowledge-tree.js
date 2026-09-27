"use strict";

// Knowledge tree (see services/knowledgeTree.js):
//   - knowledge_chunks.page_from/page_to: which page(s)/slide(s) of the
//     source file a chunk came from (NULL for page-less sources -- .docx,
//     links, topic meta -- and for chunks ingested before this existed).
//   - knowledge_source_summaries: the per-source node between a topic's
//     skill card and its verbatim chunks -- a summary plus a "contents"
//     inventory whose items point at exact chunks.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("knowledge_chunks", "page_from", { type: Sequelize.INTEGER, allowNull: true });
    await queryInterface.addColumn("knowledge_chunks", "page_to", { type: Sequelize.INTEGER, allowNull: true });

    await queryInterface.createTable("knowledge_source_summaries", {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      source_type: {
        type: Sequelize.ENUM("material_artifact", "material_link", "material_topic_meta"),
        allowNull: false,
      },
      source_id: { type: Sequelize.BIGINT, allowNull: false },
      material_topic_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: "material_topics", key: "id" },
        onDelete: "CASCADE",
      },
      title: { type: Sequelize.STRING(512), allowNull: true },
      summary: { type: Sequelize.TEXT, allowNull: true },
      contents: { type: Sequelize.JSON, allowNull: true },
      chunk_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      char_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      ai_model: { type: Sequelize.STRING(128), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex("knowledge_source_summaries", ["source_type", "source_id"], {
      unique: true,
      name: "knowledge_source_summaries_source",
    });
    await queryInterface.addIndex("knowledge_source_summaries", ["material_topic_id"]);

    // Standards record which library material they were built from.
    await queryInterface.addColumn("ai_review_standards", "retrieval", { type: Sequelize.JSON, allowNull: true });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("ai_review_standards", "retrieval");
    await queryInterface.dropTable("knowledge_source_summaries");
    await queryInterface.removeColumn("knowledge_chunks", "page_to");
    await queryInterface.removeColumn("knowledge_chunks", "page_from");
  },
};
