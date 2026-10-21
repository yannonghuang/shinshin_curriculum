"use strict";

// 回收站 for plans -- deleting a plan now only stamps deleted_at (Sequelize
// paranoid mode, see plan.model.js); its folders/artifacts/reviews/AI scores
// and attachment files stay put until it's restored, permanently deleted
// from the 回收站, or swept by planTrash.js#purgeExpired once past
// TRASH_RETENTION_DAYS.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("plans", "deleted_at", {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addIndex("plans", ["deleted_at"]);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex("plans", ["deleted_at"]);
    await queryInterface.removeColumn("plans", "deleted_at");
  },
};
