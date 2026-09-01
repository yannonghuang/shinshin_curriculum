module.exports = (sequelize, Sequelize) => {
  const Plan = sequelize.define(
    "plan",
    {
      id: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        autoIncrement: true,
      },
      teacherId: {
        type: Sequelize.BIGINT,
        allowNull: false,
      },
      title: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      theme: {
        type: Sequelize.STRING(255),
      },
      grade: {
        type: Sequelize.STRING(32),
      },
      year: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      plannedLessonCount: {
        type: Sequelize.INTEGER,
      },
      planMode: {
        type: Sequelize.ENUM("upload", "online"),
        allowNull: false,
      },
      planFormData: {
        type: Sequelize.JSON,
      },
      status: {
        type: Sequelize.ENUM("draft", "submitted", "reviewed"),
        allowNull: false,
        defaultValue: "draft",
      },
      isExcellentCase: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      curatorNote: {
        type: Sequelize.STRING(1024),
      },
      suspended: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
    },
    {
      tableName: "plans",
      freezeTableName: true,
    }
  );

  return Plan;
};
