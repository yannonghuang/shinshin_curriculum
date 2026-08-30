module.exports = (sequelize, Sequelize) => {
  const Review = sequelize.define(
    "review",
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
      lessonIndex: {
        type: Sequelize.INTEGER, // NULL = review of the whole plan; else that lesson
      },
      reviewerType: {
        type: Sequelize.ENUM("expert", "ai"),
        allowNull: false,
      },
      reviewerId: {
        type: Sequelize.BIGINT, // FK users; NULL when reviewerType='ai'
      },
      sectionKey: {
        type: Sequelize.STRING(64), // 'WHY'|'WHAT'|'HOW'|free text; expert-only
      },
      score: {
        type: Sequelize.DECIMAL(4, 1),
      },
      content: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      aiModel: {
        type: Sequelize.STRING(128), // e.g. 'qwen3.8-max' when reviewerType='ai'
      },
    },
    {
      tableName: "reviews",
      freezeTableName: true,
    }
  );

  return Review;
};
