module.exports = (sequelize, Sequelize) => {
  const MaterialTopic = sequelize.define(
    "materialTopic",
    {
      id: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        autoIncrement: true,
      },
      year: {
        type: Sequelize.INTEGER,
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
