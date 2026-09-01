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
      // Bumped explicitly by plan.controller.js#update only when actual case
      // content changes (title/theme/.../planFormData/status) -- deliberately
      // NOT the same as the plain `updated_at` column, which MySQL's ON
      // UPDATE CURRENT_TIMESTAMP bumps for every write, including an admin's
      // curatorNote/isExcellentCase/suspend toggle. Reviews snapshot this
      // value at creation time (reviews.plan_version_at) so two reviews with
      // an identical snapshot were both written in the same interval between
      // consecutive content edits -- see review-list.component.js's grouping.
      contentVersionAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
    },
    {
      tableName: "plans",
      freezeTableName: true,
    }
  );

  return Plan;
};
