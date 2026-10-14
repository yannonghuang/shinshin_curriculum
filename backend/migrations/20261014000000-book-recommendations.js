"use strict";

// 课外读物推荐 (super-only) -- see services/bookRecommendation.js.
//
// book_profiles      -- the 图书检索 skill's local cache: one row per book
//                       (keyed by ISBN, else normalized title), its description
//                       as found on the web, renewed once stale.
// reading_guidances  -- the 指导检索 skill's local cache: one row per
//                       province, the structured 进校园课外读物 guidance and
//                       red lines found on the web, renewed once stale.
// book_recommendation_runs -- one uploaded book list checked for one school;
//                       input rows, progress and the stage-grouped result.
// agent_skill_notes  -- each skill's self-improvement notes (search
//                       strategies that worked, pitfalls), fed into its next
//                       prompt and revised after each run.
module.exports = {
  async up(queryInterface, Sequelize) {
    const timestamps = {
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    };

    await queryInterface.createTable("book_profiles", {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      lookup_key: { type: Sequelize.STRING(255), allowNull: false, unique: true },
      isbn: { type: Sequelize.STRING(32), allowNull: true },
      title: { type: Sequelize.STRING(255), allowNull: false },
      author: { type: Sequelize.STRING(255), allowNull: true },
      publisher: { type: Sequelize.STRING(255), allowNull: true },
      pub_year: { type: Sequelize.STRING(16), allowNull: true },
      found: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      profile: { type: Sequelize.JSON, allowNull: true },
      sources: { type: Sequelize.JSON, allowNull: true },
      ai_model: { type: Sequelize.STRING(128), allowNull: true },
      fetched_at: { type: Sequelize.DATE, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex("book_profiles", ["isbn"]);

    await queryInterface.createTable("reading_guidances", {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      province: { type: Sequelize.STRING(32), allowNull: false, unique: true },
      content: { type: Sequelize.JSON, allowNull: false },
      sources: { type: Sequelize.JSON, allowNull: true },
      ai_model: { type: Sequelize.STRING(128), allowNull: true },
      fetched_at: { type: Sequelize.DATE, allowNull: false },
      ...timestamps,
    });

    await queryInterface.createTable("book_recommendation_runs", {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      school_code: { type: Sequelize.INTEGER, allowNull: true },
      school_name: { type: Sequelize.STRING(255), allowNull: false },
      school_address: { type: Sequelize.STRING(255), allowNull: true },
      province: { type: Sequelize.STRING(32), allowNull: false },
      stages: { type: Sequelize.JSON, allowNull: false },
      file_name: { type: Sequelize.STRING(255), allowNull: true },
      books: { type: Sequelize.JSON, allowNull: false },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: "running" },
      progress: { type: Sequelize.JSON, allowNull: true },
      result: { type: Sequelize.JSON, allowNull: true },
      guidance_fetched_at: { type: Sequelize.DATE, allowNull: true },
      error: { type: Sequelize.TEXT, allowNull: true },
      created_by: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: "users", key: "id" },
        onDelete: "SET NULL",
      },
      finished_at: { type: Sequelize.DATE, allowNull: true },
      ...timestamps,
    });

    await queryInterface.createTable("agent_skill_notes", {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      skill: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      notes: { type: Sequelize.JSON, allowNull: false },
      revision: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      ...timestamps,
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("agent_skill_notes");
    await queryInterface.dropTable("book_recommendation_runs");
    await queryInterface.dropTable("reading_guidances");
    await queryInterface.dropTable("book_profiles");
  },
};
