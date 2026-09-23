// Used by teacherManual.controller.js -- the auto-generated 教师手册 is
// filed under this category, alongside any other "how to use the system"
// topics an admin defines by hand (see materials-library.component.js's own
// mirrored constant). Deliberately NOT excluded from knowledgeIngest.js's
// retrieval pipeline -- per the "学习资源库 is the single source of truth,
// on both thematic topics and system usage, feeding 欣欣助手/AI 点评 alike"
// design, everything filed here is meant to be searchable by the chatbot
// just like any other 学习资源库 topic.
const MANUAL_CATEGORY = "使用指南";

// The category 教师手册 used to be filed under, before it moved here --
// kept only so teacherManual.controller.js#publish can migrate that one
// pre-existing topic in place on its next publish instead of leaving it
// orphaned under a now-unused category.
const LEGACY_MANUAL_CATEGORY = "手册";

module.exports = { MANUAL_CATEGORY, LEGACY_MANUAL_CATEGORY };
