// One row per published version of a "template" (a runtime-editable field
// schema that drives an online-fill form + its on-the-fly .docx generation
// + its upload-extraction). Seeded with two template_key values --
// 'plan_design' (WHY/WHAT/HOW) and 'lesson_execution' (实施记录) -- but the
// mechanism itself doesn't hardcode those strings anywhere; a future
// template_key just needs its own seed row the same way these two do (see
// schema.sql). Exactly one row per template_key has isActive=true at a
// time; plans.planTemplateVersionId/executionTemplateVersionId pin a plan
// to whichever version was active when it was created, so editing a
// template later never changes how an existing plan renders/generates.
module.exports = (sequelize, Sequelize) => {
  const TemplateVersion = sequelize.define(
    "template_version",
    {
      id: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        autoIncrement: true,
      },
      templateKey: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      version: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      // { sections: [ { key, label, fields: [ { key, label, group } ] } ] }
      // -- see services/templateParser.js (auto-parsed versions) and
      // schema.sql's seed INSERTs (the two hand-authored v1 versions).
      // Named schemaJson, not schema -- SCHEMA is a MySQL reserved word.
      schemaJson: {
        type: Sequelize.JSON,
        allowNull: false,
      },
      // NULL for the hand-authored seed versions -- only versions produced
      // by an admin's upload have a source file on disk.
      sourceFilePath: {
        type: Sequelize.STRING(1024),
      },
      sourceFileName: {
        type: Sequelize.STRING(255),
      },
      isActive: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      createdBy: {
        type: Sequelize.BIGINT,
      },
      // Free-text admin note on this version (e.g. why it was published, or
      // why it was rolled back to) -- purely informational, never read by
      // the parser/form/doc-generation side.
      notes: {
        type: Sequelize.TEXT,
      },
      // Set once, the first time an admin clicks 发起迁移 for this version
      // (template.controller.js#migrate) -- never cleared, even once every
      // dependent plan has migrated away and the button itself disappears
      // (dependentPlanCount hits 0). That button is otherwise idempotent by
      // design (safe to click again for plans added to this version later),
      // so it carries no "already triggered" signal of its own -- this
      // timestamp is what lets the admin UI tell the two apart instead of
      // guessing from whether the button is still showing.
      migrationInitiatedAt: {
        type: Sequelize.DATE,
      },
    },
    {
      tableName: "template_versions",
      freezeTableName: true,
    }
  );

  return TemplateVersion;
};
