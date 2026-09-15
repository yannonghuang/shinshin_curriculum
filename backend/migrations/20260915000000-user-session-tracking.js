"use strict";

// Backs the "15 minutes of inactivity" sliding session-expiry feature (see
// authJwt.js#verifyToken, which reissues a renewed JWT on every
// authenticated request and persists last_activity_at here) and the admin
// user list's new "累计登录时长" column.
//
// last_activity_at is internal bookkeeping, not directly surfaced in the
// UI: it's the last time this user's token was renewed, used to (a) let a
// token naturally expire 15 minutes after the last real request (not just
// a fixed time since login), and (b) let signin/signout retroactively add
// a session's elapsed time to total_login_time even when that session
// ended by inactivity timeout rather than an explicit sign-out (see
// auth.controller.js's signin/signout).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("users", "total_login_time", {
      type: Sequelize.INTEGER, // accumulated seconds across every session
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn("users", "last_activity_at", {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("users", "last_activity_at");
    await queryInterface.removeColumn("users", "total_login_time");
  },
};
