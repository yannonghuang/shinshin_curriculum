module.exports = (sequelize, Sequelize) => {
  // One AI 打分 result: a plan scored against one specific AI 点评标准
  // version (see services/aiPlanEvaluation.js). A new score replaces the
  // plan's previous one, so a plan carries only its current score, traceable
  // to the exact standard and plan content it was produced from.
  const AiPlanScore = sequelize.define(
    "aiPlanScore",
    {
      id: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        autoIncrement: true,
      },
      planId: {
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      standardId: {
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      totalScore: {
        type: Sequelize.DECIMAL(5, 1),
        allowNull: false,
      },
      dimensionScores: {
        // [{ name, weight, score, level, rationale }], in the standard's order
        type: Sequelize.JSON,
        allowNull: false,
      },
      summary: {
        type: Sequelize.TEXT,
      },
      aiModel: {
        type: Sequelize.STRING(128),
      },
      // Snapshot of plans.content_version_at when scored -- a score whose
      // snapshot no longer matches the plan is stale (content edited since).
      planVersionAt: {
        type: Sequelize.DATE,
      },
      createdBy: {
        type: Sequelize.BIGINT, // who triggered the batch (audit only)
      },
    },
    {
      tableName: "ai_plan_scores",
      freezeTableName: true,
    }
  );

  return AiPlanScore;
};
