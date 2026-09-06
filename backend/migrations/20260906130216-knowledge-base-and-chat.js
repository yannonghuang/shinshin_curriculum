"use strict";

// Turns 共享学习材料库 from pure file storage into an actual knowledge base:
// knowledge_skills is the curated tier (one AI-generated, admin-reviewable
// card per material_topic -- title/summary/key points/tags), knowledge_chunks
// is the raw deterministic-extraction fallback tier (FULLTEXT-searchable),
// and chat_conversations/chat_messages back the slide-in co-pilot (a
// tool-calling agent loop, see agentLoop.js -- role='tool' messages are the
// OpenAI/DashScope tool-result message convention).
//
// `WITH PARSER ngram` on every FULLTEXT index here -- MySQL's default
// FULLTEXT parser splits on whitespace, which never occurs within Chinese
// text (no word boundaries), so a plain FULLTEXT index would only ever match
// whole runs of non-Chinese text. ngram indexes overlapping 2-character
// windows instead, which is the standard fix for CJK full-text search in
// MySQL without a separate search engine.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("knowledge_skills", {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      material_topic_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: "material_topics", key: "id" },
        onDelete: "CASCADE",
      },
      title: { type: Sequelize.STRING(255), allowNull: true },
      summary: { type: Sequelize.TEXT, allowNull: true },
      key_points: { type: Sequelize.JSON, allowNull: true },
      tags: { type: Sequelize.JSON, allowNull: true },
      source_type: { type: Sequelize.ENUM("ai", "admin"), allowNull: false, defaultValue: "ai" },
      reviewed: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    // One skill card per topic -- regenerateSkillCard() upserts against this.
    await queryInterface.addConstraint("knowledge_skills", {
      fields: ["material_topic_id"],
      type: "unique",
      name: "uq_knowledge_skills_topic",
    });
    await queryInterface.sequelize.query(
      "ALTER TABLE knowledge_skills ADD FULLTEXT INDEX ft_knowledge_skills_title_summary (title, summary) WITH PARSER ngram"
    );

    await queryInterface.createTable("knowledge_chunks", {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      source_type: {
        type: Sequelize.ENUM("material_artifact", "material_link", "material_topic_meta"),
        allowNull: false,
      },
      // Polymorphic -- points at material_artifacts/material_links/material_topics
      // depending on source_type, so this can't be a real DB-level FK; deletion
      // cleanup is handled explicitly in each owning controller instead (see
      // knowledgeIngest.js).
      source_id: { type: Sequelize.BIGINT, allowNull: false },
      material_topic_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: "material_topics", key: "id" },
        onDelete: "CASCADE",
      },
      chunk_index: { type: Sequelize.INTEGER, allowNull: false },
      content: { type: Sequelize.TEXT, allowNull: false },
      embedding: { type: Sequelize.JSON, allowNull: true }, // unused in v1, reserved for a future semantic-rerank pass
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex("knowledge_chunks", ["material_topic_id"]);
    await queryInterface.addIndex("knowledge_chunks", ["source_type", "source_id"]);
    await queryInterface.sequelize.query(
      "ALTER TABLE knowledge_chunks ADD FULLTEXT INDEX ft_knowledge_chunks_content (content) WITH PARSER ngram"
    );

    await queryInterface.createTable("chat_conversations", {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      user_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: "users", key: "id" },
        onDelete: "CASCADE",
      },
      title: { type: Sequelize.STRING(255), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex("chat_conversations", ["user_id"]);

    await queryInterface.createTable("chat_messages", {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      conversation_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: "chat_conversations", key: "id" },
        onDelete: "CASCADE",
      },
      role: { type: Sequelize.ENUM("user", "assistant", "tool"), allowNull: false },
      content: { type: Sequelize.TEXT, allowNull: true },
      tool_call_id: { type: Sequelize.STRING(64), allowNull: true }, // only for role='tool' -- the OpenAI tool-result message convention
      retrieved_chunk_ids: { type: Sequelize.JSON, allowNull: true }, // audit trail for a "参考资料" footer
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });
    await queryInterface.addIndex("chat_messages", ["conversation_id"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("chat_messages");
    await queryInterface.dropTable("chat_conversations");
    await queryInterface.dropTable("knowledge_chunks");
    await queryInterface.dropTable("knowledge_skills");
  },
};
