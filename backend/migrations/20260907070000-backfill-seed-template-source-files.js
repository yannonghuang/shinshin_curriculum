"use strict";

const fs = require("fs");
const path = require("path");

// The two v1 template_versions rows (schema.sql's seed INSERTs) were
// hand-authored from real reference .docx files, but those files were never
// attached as source_file_path/source_file_name -- so template.controller.js
// #download/#downloadBlank had no choice but to regenerate a look-alike
// .docx from schema_json instead of serving the actual original document
// (see the "结构相同但不是同一份文件" complaint this fixes). The original
// files are checked into app/seed-assets/templates/ (inside the Docker
// build context, unlike the repo-root curriculum_template/ they came from)
// so this migration -- which runs on every backend start, dev and prod
// alike, see deploy.md -- can copy them into the same upload/Templates/
// <templateKey>/ storage #upload uses, then backfill the two rows. Only
// touches rows that still have no source file, so it's a no-op once applied
// (and never overwrites a real admin upload).
const SEEDS = [
  { templateKey: "plan_design", fileName: "乡土课程设计方案模版.docx" },
  { templateKey: "lesson_execution", fileName: "课时实施记录模板.docx" },
];

module.exports = {
  async up(queryInterface, Sequelize) {
    for (const { templateKey, fileName } of SEEDS) {
      const srcPath = path.join(__dirname, "..", "app", "seed-assets", "templates", fileName);
      if (!fs.existsSync(srcPath)) continue;

      const [[row]] = await queryInterface.sequelize.query(
        "SELECT id, source_file_path FROM template_versions WHERE template_key = ? AND version = 1",
        { replacements: [templateKey] }
      );
      if (!row || row.source_file_path) continue;

      const destDir = path.join(__dirname, "..", "upload", "Templates", templateKey);
      fs.mkdirSync(destDir, { recursive: true });
      const destPath = path.join(destDir, `${Date.now()}-${fileName}`);
      fs.copyFileSync(srcPath, destPath);

      await queryInterface.sequelize.query(
        "UPDATE template_versions SET source_file_path = ?, source_file_name = ? WHERE id = ?",
        { replacements: [path.resolve(destPath), fileName, row.id] }
      );
    }
  },

  async down(queryInterface, Sequelize) {
    for (const { templateKey, fileName } of SEEDS) {
      const [[row]] = await queryInterface.sequelize.query(
        "SELECT id, source_file_path FROM template_versions WHERE template_key = ? AND version = 1",
        { replacements: [templateKey] }
      );
      if (!row || !row.source_file_path || !row.source_file_path.endsWith(fileName)) continue;

      fs.unlink(row.source_file_path, () => {});
      await queryInterface.sequelize.query(
        "UPDATE template_versions SET source_file_path = NULL, source_file_name = NULL WHERE id = ?",
        { replacements: [row.id] }
      );
    }
  },
};
