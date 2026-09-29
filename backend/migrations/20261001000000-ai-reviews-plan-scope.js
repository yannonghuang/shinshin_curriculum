"use strict";

// AI 点评 is plan scope only (see services/aiPlanEvaluation.js): every AI
// review belongs under 计划整体点评 (section_key NULL, lesson_index NULL).
// AI reviews written before that -- by bulk AI 点评, AI打分加点评 or the
// 实施整体点评 button -- were filed under 实施整体点评
// (section_key 'IMPLEMENTATION_OVERALL'); this moves them over. Expert/admin
// reviews there are untouched.
//
// No down: once moved, a formerly-实施 AI review can't be told apart from a
// 计划 one, and nothing depends on the old placement.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      "UPDATE reviews SET section_key = NULL WHERE reviewer_type = 'ai' AND section_key = 'IMPLEMENTATION_OVERALL' AND lesson_index IS NULL"
    );
  },

  async down() {},
};
