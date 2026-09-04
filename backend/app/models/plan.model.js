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
      season: {
        type: Sequelize.ENUM("秋季", "春季"), // nullable -- see models/index.js's PLAN_SEASONS comment
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
      // Structured per-课时 实施记录 template answers, keyed by lesson index
      // -- a sparse array like planFormData.lessons, e.g.
      // [{ index: 1, lessonGoals: "...", ... }]. Field keys come from
      // whichever schema executionTemplateVersionId points at.
      executionFormData: {
        type: Sequelize.JSON,
      },
      // Which template_versions row this plan's WHY/WHAT/HOW-equivalent
      // form/doc/extraction and its 实施记录-equivalent one are pinned to,
      // stamped once at creation time (see plan.controller.js#create) --
      // never re-resolved later, so editing a template doesn't change how
      // an already-created plan renders. See models/templateVersion.model.js.
      planTemplateVersionId: {
        type: Sequelize.BIGINT,
      },
      executionTemplateVersionId: {
        type: Sequelize.BIGINT,
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
      suspended: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      // Bumped explicitly by plan.controller.js#update only when actual case
      // content changes (title/theme/.../planFormData/status) -- deliberately
      // NOT the same as the plain `updated_at` column, which MySQL's ON
      // UPDATE CURRENT_TIMESTAMP bumps for every write, including an admin's
      // isExcellentCase/suspend toggle. Reviews snapshot this
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
