"use strict";

// 种子教师: an admin-curated importance flag on a teacher account. Set by
// admin/super (PUT /api/auth/users/:id/seed), shown to them in the
// 全部乡土课程 explorer; experts and admins can narrow plans to seed teachers'
// (GET /api/plans?seedTeacher=true), super can filter 用户管理 by it.
// Everyone starts unflagged.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("users", "is_seed", {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("users", "is_seed");
  },
};
