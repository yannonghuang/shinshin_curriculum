"use strict";

// 教师分享 优秀 flag: an expert/admin-curated mark on a share. Set by an
// expert or admin (PUT /api/shares/:id/excellent), and only ever shown to
// them -- teachers' responses leave it out (share.controller.js). Everyone
// starts unflagged.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("shares", "is_excellent", {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("shares", "is_excellent");
  },
};
