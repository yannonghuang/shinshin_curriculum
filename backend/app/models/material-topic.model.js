module.exports = (sequelize, Sequelize) => {
  const MaterialTopic = sequelize.define(
    "materialTopic",
    {
      id: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        autoIncrement: true,
      },
      // Top-level grouping label in 学习资源库's tree (see
      // material-topic.controller.js#findAll's ORDER BY and
      // materials-library.component.js's topicsByCategory) -- free-form
      // user text, not necessarily a year, despite most existing rows
      // holding one (e.g. "2026") from before this was generalized.
      category: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      theme: {
        type: Sequelize.STRING(255), // 主题
        allowNull: false,
      },
      lecturer: {
        type: Sequelize.STRING(255), // 主讲人
      },
      comment: {
        type: Sequelize.TEXT,
      },
    },
    {
      tableName: "material_topics",
      freezeTableName: true,
    }
  );

  return MaterialTopic;
};
