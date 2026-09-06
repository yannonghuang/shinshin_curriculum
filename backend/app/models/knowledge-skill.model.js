module.exports = (sequelize, Sequelize) => {
  const KnowledgeSkill = sequelize.define(
    "knowledgeSkill",
    {
      id: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        autoIncrement: true,
      },
      materialTopicId: {
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      title: {
        type: Sequelize.STRING(255),
      },
      summary: {
        type: Sequelize.TEXT,
      },
      keyPoints: {
        type: Sequelize.JSON, // list of strings
      },
      tags: {
        type: Sequelize.JSON, // list of strings
      },
      sourceType: {
        type: Sequelize.ENUM("ai", "admin"),
        allowNull: false,
        defaultValue: "ai",
      },
      reviewed: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
    },
    {
      tableName: "knowledge_skills",
      freezeTableName: true,
    }
  );

  return KnowledgeSkill;
};
