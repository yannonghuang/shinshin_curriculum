"use strict";

// Two review columns, see review.model.js:
//  - teacher_seen_at: every AI review so far was requested by the plan's own
//    teacher (bulk AI 点评 is new), so those are backfilled as seen;
//    expert/admin reviews stay NULL and will flash until the teacher opens
//    the 整体点评 view showing them.
//  - standard_id: the AI 点评标准 version an AI review was written against.
//    Left NULL for existing reviews -- they predate reviews following the
//    standard, so bulk AI 点评 counts them as out of date.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("reviews", "teacher_seen_at", { type: Sequelize.DATE, allowNull: true });
    await queryInterface.sequelize.query("UPDATE reviews SET teacher_seen_at = created_at WHERE reviewer_type = 'ai'");
    await queryInterface.addColumn("reviews", "standard_id", { type: Sequelize.BIGINT, allowNull: true });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("reviews", "standard_id");
    await queryInterface.removeColumn("reviews", "teacher_seen_at");
  },
};
