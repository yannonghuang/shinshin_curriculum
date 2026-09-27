"use strict";

// knowledge_chunks.embedding (reserved since the knowledge-base migration)
// is now filled -- see services/embeddings.js. embedding_model records which
// model produced it, so switching EMBEDDING_MODEL is detected and those
// chunks get re-embedded instead of being compared across incompatible
// vector spaces.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("knowledge_chunks", "embedding_model", { type: Sequelize.STRING(64), allowNull: true });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("knowledge_chunks", "embedding_model");
  },
};
