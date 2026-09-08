"use strict";

// Adds plans.student_count/instructor_name as dedicated columns alongside
// the existing grade/planned_lesson_count, rather than exposing them
// through the generic template field-schema mechanism -- see
// templateParser.js's EXCLUDED_TOP_LEVEL_LABELS and dynamicDocGenerator.js's
// `meta` list, which the 2026 template's "基本信息" heading section maps to.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("plans", "student_count", {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn("plans", "instructor_name", {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("plans", "instructor_name");
    await queryInterface.removeColumn("plans", "student_count");
  },
};
