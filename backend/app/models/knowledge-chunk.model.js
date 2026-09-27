module.exports = (sequelize, Sequelize) => {
  const KnowledgeChunk = sequelize.define(
    "knowledgeChunk",
    {
      id: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        autoIncrement: true,
      },
      sourceType: {
        type: Sequelize.ENUM("material_artifact", "material_link", "material_topic_meta"),
        allowNull: false,
      },
      sourceId: {
        // Polymorphic -- see sourceType; never a Sequelize association, just
        // a plain id looked up against whichever table sourceType names.
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      materialTopicId: {
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      chunkIndex: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      content: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      // Page/slide range of the source file this chunk came from (see
      // textExtract.js#extractSegmentsFromFile); NULL for page-less sources.
      pageFrom: {
        type: Sequelize.INTEGER,
      },
      pageTo: {
        type: Sequelize.INTEGER,
      },
      // Chunk-level semantic vector (services/embeddings.js) and the model
      // that produced it -- vectors from different models aren't comparable.
      embedding: {
        type: Sequelize.JSON,
      },
      embeddingModel: {
        type: Sequelize.STRING(64),
      },
    },
    {
      tableName: "knowledge_chunks",
      freezeTableName: true,
    }
  );

  return KnowledgeChunk;
};
