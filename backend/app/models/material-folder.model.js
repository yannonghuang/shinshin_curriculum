module.exports = (sequelize, Sequelize) => {
  const MaterialFolder = sequelize.define(
    "materialFolder",
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
      parentFolderId: {
        type: Sequelize.BIGINT, // NULL = root of that 主题's file space
      },
      name: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
    },
    {
      tableName: "material_folders",
      freezeTableName: true,
    }
  );

  return MaterialFolder;
};
