"use strict";

// reviews.status -- 'saved' is an expert/admin's draft (保存点评), visible
// only to its author until submitted; 'submitted' is every review as it
// has always been. Existing rows are all submitted -- see review.model.js.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("reviews", "status", {
      type: Sequelize.ENUM("saved", "submitted"),
      allowNull: false,
      defaultValue: "submitted",
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("reviews", "status");
  },
};
