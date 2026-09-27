module.exports = (sequelize, Sequelize) => {
  // Source-level node of the knowledge tree (services/knowledgeTree.js):
  // one per material file/link/topic-meta, between the topic's skill card
  // above and the source's verbatim knowledge_chunks below. Regenerated
  // whenever the source is re-ingested (knowledgeIngest.js#ingestSource).
  const KnowledgeSourceSummary = sequelize.define(
    "knowledgeSourceSummary",
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
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      materialTopicId: {
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      title: {
        type: Sequelize.STRING(512), // file name / link description
      },
      summary: {
        type: Sequelize.TEXT,
      },
      // "What's in here" inventory, written for routing rather than gist --
      // [{ kind, label, chunkFrom, chunkTo }], kind one of rubric | case |
      // method | concept | data | other, chunkFrom/To being chunk_index
      // values of this source's knowledge_chunks. This is what lets e.g. a
      // weighted evaluation table on page 39 of a lecture deck be found and
      // quoted verbatim even when the deck's gist summary never mentions it.
      contents: {
        type: Sequelize.JSON,
      },
      chunkCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      charCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      aiModel: {
        type: Sequelize.STRING(128), // NULL when the source was small enough to be its own summary
      },
    },
    {
      tableName: "knowledge_source_summaries",
      freezeTableName: true,
    }
  );

  return KnowledgeSourceSummary;
};
