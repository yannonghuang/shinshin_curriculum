"use strict";

// Generalizes material_topics.year (INTEGER, the 学习资源库 tree's top-level
// grouping key) into a free-form text `category` -- see
// material-topic.model.js's comment. Existing rows keep their numeric year
// value as a string (e.g. "2026"), unaffected functionally since the column
// was only ever used for display/grouping/sorting, never arithmetic (see
// material-topic.controller.js).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.renameColumn("material_topics", "year", "category");
    await queryInterface.changeColumn("material_topics", "category", {
      type: Sequelize.STRING(255),
      allowNull: false,
    });
  },

  // Best-effort: any category value that isn't a plain integer string (any
  // free-text category entered after this migration) can't round-trip back
  // into an INTEGER column and becomes NULL, which then violates the
  // original NOT NULL constraint -- CAST(... AS UNSIGNED) fails silently to
  // NULL for non-numeric input in MySQL's non-strict mode, but any rows that
  // do end up NULL will still block the changeColumn below in strict mode.
  // Accepted tradeoff for a down-migration of a deliberately-lossy type
  // change; only run this down if you're prepared to fix up/delete such rows
  // first.
  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(
      "UPDATE material_topics SET category = '0' WHERE category NOT REGEXP '^[0-9]+$'"
    );
    await queryInterface.changeColumn("material_topics", "category", {
      type: Sequelize.INTEGER,
      allowNull: false,
    });
    await queryInterface.renameColumn("material_topics", "category", "year");
  },
};
