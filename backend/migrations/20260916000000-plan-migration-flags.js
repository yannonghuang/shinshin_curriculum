"use strict";

// Adds plans.needs_migration/needs_manual_migration_review -- see
// plan.model.js's comments on both, and templateMigration.js for the
// field-matching logic that drives them. Both default false so every
// existing plan starts unaffected.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("plans", "needs_migration", {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.addColumn("plans", "needs_manual_migration_review", {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("plans", "needs_manual_migration_review");
    await queryInterface.removeColumn("plans", "needs_migration");
  },
};
