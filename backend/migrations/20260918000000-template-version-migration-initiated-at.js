"use strict";

// Adds template_versions.migration_initiated_at -- see templateVersion.
// model.js's comment. Nullable/no default: NULL means "an admin has never
// clicked 发起迁移 for this version", set once on the first click.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("template_versions", "migration_initiated_at", {
      type: Sequelize.DATE,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("template_versions", "migration_initiated_at");
  },
};
