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
      // 学生人数/执教人 -- part of the template's "基本信息" heading section but
      // rendered/edited like grade/plannedLessonCount (dedicated columns,
      // hardcoded `meta` list on generation) rather than through the generic
      // field-schema mechanism -- see templateParser.js's EXCLUDED_TOP_LEVEL_LABELS.
      studentCount: {
        type: Sequelize.INTEGER,
      },
      instructorName: {
        type: Sequelize.STRING(255),
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
      // Per-segment counterpart to contentVersionAt, bumped only for the
      // segment(s) whose own content actually changed on a given update --
      // see plan.controller.js#update's diffing. Keyed by sectionKey for
      // WHY/WHAT/HOW, or "<sectionKey>:<lessonIndex>" for LESSON_DESIGN and
      // EXECUTION_RECORD (both keyed per-lesson). Reviews snapshot the
      // relevant entry at creation time (reviews.segment_version_at) so a
      // review can be flagged as superseded only when its own segment was
      // edited, not merely because some other part of the plan changed --
      // see review-list.component.js.
      segmentVersionAt: {
        type: Sequelize.JSON,
        allowNull: false,
        defaultValue: {},
      },
    },
    {
      tableName: "plans",
      freezeTableName: true,
    }
  );

  return Plan;
};
