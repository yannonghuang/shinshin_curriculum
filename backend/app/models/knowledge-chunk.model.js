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
      embedding: {
        type: Sequelize.JSON, // unused in v1, reserved for a future semantic-rerank pass
      },
    },
    {
      tableName: "knowledge_chunks",
      freezeTableName: true,
    }
  );

  return KnowledgeChunk;
};
