const dbConfig = require("../config/db.config.js");

const Sequelize = require("sequelize");
const { QueryTypes } = require("sequelize");

// Consistent field-naming convention for the whole app: every model is
// defined with camelCase JS attribute names, and `underscored: true` (set
// once, globally, here) makes Sequelize map them to the snake_case columns
// used in schema.sql (teacherId -> teacher_id, createdAt -> created_at, ...)
// without needing per-attribute `field:` overrides in each model file.
const sequelize = new Sequelize(dbConfig.DB, dbConfig.USER, dbConfig.PASSWORD, {
  host: dbConfig.HOST,
  dialect: dbConfig.dialect,
  logging: false,

  pool: {
    max: dbConfig.pool.max,
    min: dbConfig.pool.min,
    acquire: dbConfig.pool.acquire,
    idle: dbConfig.pool.idle,
  },

  define: {
    underscored: true,
    charset: "utf8mb4",
    collate: "utf8mb4_0900_ai_ci",
  },
});

const db = {};

db.Sequelize = Sequelize;
db.sequelize = sequelize;
db.QueryTypes = QueryTypes;

db.role = require("./role.model.js")(sequelize, Sequelize);
db.school = require("./school.model.js")(sequelize, Sequelize);
db.user = require("./user.model.js")(sequelize, Sequelize);
db.plan = require("./plan.model.js")(sequelize, Sequelize);
db.artifact = require("./artifact.model.js")(sequelize, Sequelize);
db.folder = require("./folder.model.js")(sequelize, Sequelize);
db.review = require("./review.model.js")(sequelize, Sequelize);
db.templateVersion = require("./templateVersion.model.js")(sequelize, Sequelize);
db.materialTopic = require("./material-topic.model.js")(sequelize, Sequelize);
db.materialLink = require("./material-link.model.js")(sequelize, Sequelize);
db.materialFolder = require("./material-folder.model.js")(sequelize, Sequelize);
db.materialArtifact = require("./material-artifact.model.js")(sequelize, Sequelize);
db.knowledgeSkill = require("./knowledge-skill.model.js")(sequelize, Sequelize);
db.knowledgeChunk = require("./knowledge-chunk.model.js")(sequelize, Sequelize);
db.knowledgeSourceSummary = require("./knowledge-source-summary.model.js")(sequelize, Sequelize);
db.chatConversation = require("./chat-conversation.model.js")(sequelize, Sequelize);
db.chatMessage = require("./chat-message.model.js")(sequelize, Sequelize);
db.chatAttachment = require("./chat-attachment.model.js")(sequelize, Sequelize);
db.aiReviewStandard = require("./ai-review-standard.model.js")(sequelize, Sequelize);
db.aiPlanScore = require("./ai-plan-score.model.js")(sequelize, Sequelize);

// users <-> roles (many-to-many via user_roles)
// Explicitly pre-defined (rather than through: "user_roles" as a bare string)
// with timestamps: false — schema.sql's user_roles is a plain (user_id,
// role_id) join table with no created_at/updated_at columns. Passing
// `timestamps: false` inside `through: { model: "user_roles", ... } is NOT
// honored by Sequelize for an auto-generated-by-string through model; only a
// real pre-defined Model object reliably disables timestamps on it. Without
// this, every setRoles()/addRoles() call fails with "Unknown column 'created_at'".
const UserRole = sequelize.define("user_roles", {}, { tableName: "user_roles", timestamps: false });

db.role.belongsToMany(db.user, {
  through: UserRole,
  foreignKey: { name: "roleId", field: "role_id" },
  otherKey: { name: "userId", field: "user_id" },
});
db.user.belongsToMany(db.role, {
  through: UserRole,
  foreignKey: { name: "userId", field: "user_id" },
  otherKey: { name: "roleId", field: "role_id" },
});

// teacher (user) -> school (schools.code). Every teacher must have one --
// enforced in auth.controller.js's validateSchoolFields plus the DB-level
// triggers added in 20260907120000-teacher-school-enforcement.js; admin/
// expert users stay NULL.
db.user.belongsTo(db.school, {
  foreignKey: "schoolCode",
  targetKey: "code",
  as: "School",
});

// teacher (user) -> plans
db.user.hasMany(db.plan, {
  foreignKey: "teacherId",
  as: "Plans",
  onDelete: "CASCADE",
});
db.plan.belongsTo(db.user, {
  foreignKey: "teacherId",
  as: "Teacher",
});

// plan -> artifacts
db.plan.hasMany(db.artifact, {
  foreignKey: "planId",
  as: "Artifacts",
  onDelete: "CASCADE",
  hooks: true,
});
db.artifact.belongsTo(db.plan, {
  foreignKey: "planId",
  onDelete: "CASCADE",
});

// plan -> folders
db.plan.hasMany(db.folder, {
  foreignKey: "planId",
  as: "Folders",
  onDelete: "CASCADE",
  hooks: true,
});
db.folder.belongsTo(db.plan, {
  foreignKey: "planId",
  onDelete: "CASCADE",
});

// folder -> folder (self-referencing parent/children -- see folder.controller.js's
// recursive delete, which walks this in JS to clean up physical files first;
// this CASCADE only cleans up the folder *rows* once that's done)
db.folder.hasMany(db.folder, {
  foreignKey: "parentFolderId",
  as: "Children",
  onDelete: "CASCADE",
});
db.folder.belongsTo(db.folder, {
  foreignKey: "parentFolderId",
  as: "Parent",
});

// folder -> artifacts (SET NULL, not CASCADE -- folder.controller.js#delete
// explicitly removes each contained artifact, row and physical file, before
// deleting the folder itself; this is just a safety net, not the primary path)
db.folder.hasMany(db.artifact, {
  foreignKey: "folderId",
  as: "Artifacts",
  onDelete: "SET NULL",
});
db.artifact.belongsTo(db.folder, {
  foreignKey: "folderId",
  onDelete: "SET NULL",
});

// plan -> reviews
db.plan.hasMany(db.review, {
  foreignKey: "planId",
  as: "Reviews",
  onDelete: "CASCADE",
  hooks: true,
});
db.review.belongsTo(db.plan, {
  foreignKey: "planId",
  onDelete: "CASCADE",
});

// reviewer (user, nullable for AI reviews) -> reviews
db.user.hasMany(db.review, {
  foreignKey: "reviewerId",
  as: "AuthoredReviews",
  onDelete: "SET NULL",
});
db.review.belongsTo(db.user, {
  foreignKey: "reviewerId",
  as: "Reviewer",
});

// plan -> the two template versions it was created under (pinned at
// creation time, see plan.controller.js#create) -- separate FKs, not a
// single generic one, since a plan always needs exactly one of each kind.
db.plan.belongsTo(db.templateVersion, {
  foreignKey: "planTemplateVersionId",
  as: "PlanTemplateVersion",
});
db.plan.belongsTo(db.templateVersion, {
  foreignKey: "executionTemplateVersionId",
  as: "ExecutionTemplateVersion",
});

// admin (user, nullable -- NULL for the hand-authored seed versions) ->
// uploaded template versions
db.user.hasMany(db.templateVersion, {
  foreignKey: "createdBy",
  as: "UploadedTemplateVersions",
  onDelete: "SET NULL",
});
db.templateVersion.belongsTo(db.user, {
  foreignKey: "createdBy",
  as: "Uploader",
});

// materialTopic -> links/folders/artifacts (共享学习材料库 -- see
// materials-library.component.js). No owner FK on materialTopic itself:
// it's purely admin-curated, unlike plan's teacher ownership.
db.materialTopic.hasMany(db.materialLink, {
  foreignKey: "materialTopicId",
  as: "Links",
  onDelete: "CASCADE",
  hooks: true,
});
db.materialLink.belongsTo(db.materialTopic, {
  foreignKey: "materialTopicId",
  onDelete: "CASCADE",
});

db.materialTopic.hasMany(db.materialFolder, {
  foreignKey: "materialTopicId",
  as: "Folders",
  onDelete: "CASCADE",
  hooks: true,
});
db.materialFolder.belongsTo(db.materialTopic, {
  foreignKey: "materialTopicId",
  onDelete: "CASCADE",
});

// materialFolder -> materialFolder (self-referencing parent/children, same
// shape as folder -> folder above)
db.materialFolder.hasMany(db.materialFolder, {
  foreignKey: "parentFolderId",
  as: "Children",
  onDelete: "CASCADE",
});
db.materialFolder.belongsTo(db.materialFolder, {
  foreignKey: "parentFolderId",
  as: "Parent",
});

db.materialTopic.hasMany(db.materialArtifact, {
  foreignKey: "materialTopicId",
  as: "Artifacts",
  onDelete: "CASCADE",
  hooks: true,
});
db.materialArtifact.belongsTo(db.materialTopic, {
  foreignKey: "materialTopicId",
  onDelete: "CASCADE",
});

db.materialFolder.hasMany(db.materialArtifact, {
  foreignKey: "folderId",
  as: "Artifacts",
  onDelete: "SET NULL",
});
db.materialArtifact.belongsTo(db.materialFolder, {
  foreignKey: "folderId",
  onDelete: "SET NULL",
});

// materialTopic -> knowledgeSkill (one curated card per topic, see
// knowledgeIngest.js#regenerateSkillCard) and -> knowledgeChunk (many raw
// extracted-text chunks, see knowledgeIngest.js#ingestSource). knowledgeChunk
// has no association to material_artifact/material_link -- its sourceId is
// polymorphic (points at whichever table sourceType names), which Sequelize
// associations can't model; callers look it up manually when needed.
db.materialTopic.hasOne(db.knowledgeSkill, {
  foreignKey: "materialTopicId",
  as: "Skill",
  onDelete: "CASCADE",
});
db.knowledgeSkill.belongsTo(db.materialTopic, {
  foreignKey: "materialTopicId",
  onDelete: "CASCADE",
});

db.materialTopic.hasMany(db.knowledgeChunk, {
  foreignKey: "materialTopicId",
  as: "KnowledgeChunks",
  onDelete: "CASCADE",
  hooks: true,
});
db.knowledgeChunk.belongsTo(db.materialTopic, {
  foreignKey: "materialTopicId",
  onDelete: "CASCADE",
});

// materialTopic -> knowledgeSourceSummary (one per source under the topic,
// see knowledgeTree.js) -- the middle layer of the knowledge tree.
db.materialTopic.hasMany(db.knowledgeSourceSummary, {
  foreignKey: "materialTopicId",
  as: "SourceSummaries",
  onDelete: "CASCADE",
  hooks: true,
});
db.knowledgeSourceSummary.belongsTo(db.materialTopic, {
  foreignKey: "materialTopicId",
  onDelete: "CASCADE",
});

// user -> chatConversations -> chatMessages (the co-pilot's own
// conversation/turn history -- see chat.controller.js and agentLoop.js)
db.user.hasMany(db.chatConversation, {
  foreignKey: "userId",
  as: "ChatConversations",
  onDelete: "CASCADE",
});
db.chatConversation.belongsTo(db.user, {
  foreignKey: "userId",
});

db.chatConversation.hasMany(db.chatMessage, {
  foreignKey: "conversationId",
  as: "Messages",
  onDelete: "CASCADE",
  hooks: true,
});
db.chatMessage.belongsTo(db.chatConversation, {
  foreignKey: "conversationId",
  onDelete: "CASCADE",
});

// chatMessage -> chatAttachments (files picked/pasted into 欣欣助手 -- see
// copilotAttachments.js). messageId is null while an upload is still waiting
// to be sent.
db.chatMessage.hasMany(db.chatAttachment, {
  foreignKey: "messageId",
  as: "Attachments",
  onDelete: "CASCADE",
});
db.chatAttachment.belongsTo(db.chatMessage, {
  foreignKey: "messageId",
  onDelete: "CASCADE",
});

db.aiReviewStandard.belongsTo(db.user, {
  foreignKey: "createdBy",
  as: "Creator",
  onDelete: "SET NULL",
});

db.plan.hasMany(db.aiPlanScore, {
  foreignKey: "planId",
  as: "AiScores",
  onDelete: "CASCADE",
  hooks: true,
});
db.aiPlanScore.belongsTo(db.plan, {
  foreignKey: "planId",
  onDelete: "CASCADE",
});
db.aiPlanScore.belongsTo(db.aiReviewStandard, {
  foreignKey: "standardId",
  as: "Standard",
});

// Roles are exactly admin/teacher/expert/super — this app has no
// volunteer/moderator/donor domain (see plan's "left behind" list). A real
// `School` model does exist (db.school, above), but narrowly for teacher
// school-affiliation -- not a general school-management domain.
// "super" carries every privilege "admin" does (see authJwt.isAdmin), plus
// exclusive ownership of user management (authJwt.isSuper) -- see
// authJwt.js's isAdmin/isSuper split.
db.ROLES2 = ["admin", "teacher", "expert", "super"];

db.ROLES = [
  { name: "teacher", label: "教师" },
  { name: "expert", label: "专家" },
  { name: "admin", label: "管理员" },
  { name: "super", label: "超级管理员" },
];

// 乡土主题 taxonomy -- kept in sync with react-app/src/constants/plan-options.js's
// PLAN_THEMES (client-side dropdown).
db.PLAN_THEMES = [
  "自然地理风貌",
  "生计方式实践",
  "家乡物产探索",
  "家乡美食文化",
  "村落民居文化",
  "家族历史故事",
  "传统节日民俗",
  "家乡人物故事",
  "童谣民歌俗语",
  "民族服饰文化",
  "家乡游戏娱乐",
  "传统手艺制作",
];

db.GRADE_OPTIONS = ["一年级", "二年级", "三年级", "四年级", "五年级", "六年级"];

// 学期 -- alongside plans.year, drives the manager/expert plan list's
// year-学期 -> teacher navigation (plans-hierarchy.component.js). Optional at
// the DB level (existing rows predate this field, left NULL rather than
// guessed retroactively) -- new plans always get one, defaulted client-side
// to the current 学期 the same way year already defaults to the current
// calendar year (see plan-options.js's currentSeason()).
db.PLAN_SEASONS = ["秋季", "春季"];

module.exports = db;
