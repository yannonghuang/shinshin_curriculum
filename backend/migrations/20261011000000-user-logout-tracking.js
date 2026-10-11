"use strict";

// Backs the admin user list's "在线" and "退出时间" columns.
//
// last_logout_at / last_logout_type record how the user's most recent
// session ended: "manual" (explicit 退出登录, written by signout) or
// "timeout" (the sliding inactivity window lapsed -- nothing tells the
// server when that happens, so it's written retroactively by the next
// signin; until then the list derives it from last_activity_at, see
// auth.controller.js's sessionStatusOf).
//
// Backfill: before this, signout overwrote last_login with the sign-out
// time and cleared last_activity_at, so a row with last_login set and
// last_activity_at NULL is (almost always) one whose last session ended in
// an explicit sign-out at last_login.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("users", "last_logout_at", {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn("users", "last_logout_type", {
      type: Sequelize.STRING(16),
      allowNull: true,
    });
    await queryInterface.sequelize.query(
      "UPDATE users SET last_logout_at = last_login, last_logout_type = 'manual' " +
        "WHERE last_login IS NOT NULL AND last_activity_at IS NULL"
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("users", "last_logout_type");
    await queryInterface.removeColumn("users", "last_logout_at");
  },
};
