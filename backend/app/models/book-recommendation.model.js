// 课外读物推荐 (super-only) tables -- see migrations/20261014000000-book-recommendations.js
// for what each one holds, and services/bookRecommendation.js for how they're used.
module.exports = (sequelize, Sequelize) => {
  const BookProfile = sequelize.define(
    "bookProfile",
    {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      lookupKey: { type: Sequelize.STRING(255), allowNull: false, unique: true },
      isbn: { type: Sequelize.STRING(32) },
      title: { type: Sequelize.STRING(255), allowNull: false },
      author: { type: Sequelize.STRING(255) },
      publisher: { type: Sequelize.STRING(255) },
      pubYear: { type: Sequelize.STRING(16) },
      found: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      // { summary, themes[], readingLevel, suggestedStages[], concerns[] }
      profile: { type: Sequelize.JSON },
      sources: { type: Sequelize.JSON }, // [{ title, url, site }]
      aiModel: { type: Sequelize.STRING(128) },
      fetchedAt: { type: Sequelize.DATE },
    },
    { tableName: "book_profiles", freezeTableName: true }
  );

  const ReadingGuidance = sequelize.define(
    "readingGuidance",
    {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      province: { type: Sequelize.STRING(32), allowNull: false, unique: true },
      // { documents[], principles[], redLines[], stageGuidance{}, localNotes[] }
      content: { type: Sequelize.JSON, allowNull: false },
      sources: { type: Sequelize.JSON },
      aiModel: { type: Sequelize.STRING(128) },
      fetchedAt: { type: Sequelize.DATE, allowNull: false },
    },
    { tableName: "reading_guidances", freezeTableName: true }
  );

  const BookRecommendationRun = sequelize.define(
    "bookRecommendationRun",
    {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      schoolCode: { type: Sequelize.INTEGER },
      schoolName: { type: Sequelize.STRING(255), allowNull: false },
      schoolAddress: { type: Sequelize.STRING(255) },
      province: { type: Sequelize.STRING(32), allowNull: false },
      stages: { type: Sequelize.JSON, allowNull: false }, // stage keys, see STAGES
      fileName: { type: Sequelize.STRING(255) },
      books: { type: Sequelize.JSON, allowNull: false }, // [{ title, isbn, publisher, year, author }]
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: "running" }, // running | done | failed
      progress: { type: Sequelize.JSON }, // { step, searched, total }
      result: { type: Sequelize.JSON }, // see bookRecommendation.js#assembleResult
      guidanceFetchedAt: { type: Sequelize.DATE },
      error: { type: Sequelize.TEXT },
      createdBy: { type: Sequelize.BIGINT },
      finishedAt: { type: Sequelize.DATE },
    },
    { tableName: "book_recommendation_runs", freezeTableName: true }
  );

  const AgentSkillNotes = sequelize.define(
    "agentSkillNotes",
    {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      skill: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      notes: { type: Sequelize.JSON, allowNull: false }, // list of strings
      revision: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: "agent_skill_notes", freezeTableName: true }
  );

  return { BookProfile, ReadingGuidance, BookRecommendationRun, AgentSkillNotes };
};
