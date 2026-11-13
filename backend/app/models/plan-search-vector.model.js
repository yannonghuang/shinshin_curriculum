module.exports = (sequelize, Sequelize) => {
  // One embedded field of one plan, for 全部乡土课程's 语义搜索 -- see
  // services/planSearch.js. Rebuilt from the plan itself whenever the
  // field's text (content_hash) or the embedding scheme changes.
  const PlanSearchVector = sequelize.define(
    "planSearchVector",
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
      // "s0.f2" (section field) or "L3.f4" (第3课时's field f4).
      partKey: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      label: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      content: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      contentHash: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      // Normalized float32 vectors back to back: the whole field's first,
      // then its windows' -- see planSearch.js#encodeVectors.
      vectors: {
        type: Sequelize.BLOB("medium"),
        allowNull: false,
      },
      dims: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      embeddingModel: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
    },
    {
      tableName: "plan_search_vectors",
      freezeTableName: true,
    }
  );

  return PlanSearchVector;
};
