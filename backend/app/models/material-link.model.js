module.exports = (sequelize, Sequelize) => {
  const MaterialLink = sequelize.define(
    "materialLink",
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
      description: {
        type: Sequelize.STRING(255),
      },
      url: {
        type: Sequelize.STRING(1024),
        allowNull: false,
      },
    },
    {
      tableName: "material_links",
      freezeTableName: true,
    }
  );

  return MaterialLink;
};
