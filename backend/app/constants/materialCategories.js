// Shared by teacherManual.controller.js (the only current writer under this
// category) and knowledgeIngest.js (which reads it to exclude that category
// from the knowledge base -- see knowledgeIngest.js's own comments on
// ingestSource/regenerateSkillCardInner). A single exported constant instead
// of the literal "手册" repeated in both files, so the two can't drift apart.
const MANUAL_CATEGORY = "手册";

module.exports = { MANUAL_CATEGORY };
