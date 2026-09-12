// One-off: refresh cached schemaJson for existing upload-derived
// template_versions rows against the current templateParser.js -- needed
// whenever the parser gains a new capability that a pre-existing row's
// frozen-at-upload-time schemaJson can never pick up on its own (e.g. the
// non-heading 课时-marker runStyle/markerStyle fields). Run once inside the
// backend container: `docker compose exec backend node scripts/reparse-template-versions.js`.
const db = require("../app/models");
const { parseTemplateDocx } = require("../app/services/templateParser.js");

(async () => {
  const versions = await db.templateVersion.findAll({ where: { sourceFilePath: { [db.Sequelize.Op.ne]: null } } });
  console.log(`Found ${versions.length} upload-derived template_versions rows.`);
  for (const v of versions) {
    try {
      const schema = parseTemplateDocx(v.sourceFilePath);
      await v.update({ schemaJson: schema });
      console.log(`OK  id=${v.id} templateKey=${v.templateKey} version=${v.version}`);
    } catch (e) {
      console.error(`SKIP id=${v.id} templateKey=${v.templateKey} version=${v.version}: ${e.message}`);
    }
  }
  await db.sequelize.close();
})();
