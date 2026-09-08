"use strict";

// Adds per-segment revision tracking alongside the existing plan-wide
// content_version_at/plan_version_at pair (see plan.model.js/review.model.js).
// Today, editing ANY part of a plan (say, HOW) bumps content_version_at,
// which then marks EVERY earlier review -- including one on an untouched
// segment like WHY -- as "历史版本（课程内容已被后续修改）" in
// review-list.component.js. plans.segment_version_at tracks each segment's
// own last-edited timestamp (see plan.controller.js#update's diffing), and
// reviews.segment_version_at snapshots the reviewed segment's value at
// review-creation time, so the UI can flag only the reviews whose own
// segment was actually edited since.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("plans", "segment_version_at", {
      type: Sequelize.JSON,
      allowNull: false,
      defaultValue: {},
    });
    await queryInterface.addColumn("reviews", "segment_version_at", {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("reviews", "segment_version_at");
    await queryInterface.removeColumn("plans", "segment_version_at");
  },
};
