module.exports = (sequelize, Sequelize) => {
  // One row per generated AI 点评标准 (scoring rubric synthesized from
  // 学习资源库 -- see services/aiReviewStandard.js). The newest row is the
  // active standard; older rows are kept so every AI score can reference the
  // exact standard version it was produced under.
  const AiReviewStandard = sequelize.define(
    "aiReviewStandard",
    {
      id: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        autoIncrement: true,
      },
      content: {
        // { title, overview, totalScore, dimensions: [{ name, weight,
        //   description, criteria: [], levels: [{ range, descriptor }] }],
        //   scoringNotes: [] }
        type: Sequelize.JSON,
        allowNull: false,
      },
      sourceTopicIds: {
        type: Sequelize.JSON, // material_topics ids the standard was synthesized from
      },
      aiModel: {
        type: Sequelize.STRING(128),
      },
      createdBy: {
        // FK users; NULL if that user was later deleted. For an 'ai' row
        // it's only who clicked 生成 (audit, never displayed); for a 'human'
        // row it's the operator who revised it, shown alongside the version.
        type: Sequelize.BIGINT,
      },
      // 'ai' = synthesized from 学习资源库; 'human' = an expert/admin's
      // override of the version named by baseId.
      source: {
        type: Sequelize.ENUM("ai", "human"),
        allowNull: false,
        defaultValue: "ai",
      },
      baseId: {
        type: Sequelize.BIGINT, // the version a 'human' revision was edited from
      },
      changeNote: {
        type: Sequelize.TEXT, // operator's 修订说明
      },
      cautions: {
        // What the operator was shown and saved anyway -- { structural: [...],
        // ai: { summary, items: [{ dimension, severity, change, message }] } }
        // (see aiReviewStandard.js#checkRevision).
        type: Sequelize.JSON,
      },
    },
    {
      tableName: "ai_review_standards",
      freezeTableName: true,
    }
  );

  return AiReviewStandard;
};
