module.exports = (sequelize, Sequelize) => {
  const Folder = sequelize.define(
    "folder",
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
        type: Sequelize.INTEGER, // always set -- folders are scoped to one 课时's file space, never plan-level
        allowNull: false,
      },
      parentFolderId: {
        type: Sequelize.BIGINT, // NULL = root of that 课时's file space
      },
      name: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
    },
    {
      tableName: "folders",
      freezeTableName: true,
    }
  );

  return Folder;
};
