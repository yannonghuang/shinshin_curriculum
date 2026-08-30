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
db.user = require("./user.model.js")(sequelize, Sequelize);
db.plan = require("./plan.model.js")(sequelize, Sequelize);
db.artifact = require("./artifact.model.js")(sequelize, Sequelize);
db.review = require("./review.model.js")(sequelize, Sequelize);
db.learningMaterial = require("./learning-material.model.js")(sequelize, Sequelize);

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

// uploader (user, nullable) -> learning materials
db.user.hasMany(db.learningMaterial, {
  foreignKey: "uploadedBy",
  as: "LearningMaterials",
  onDelete: "SET NULL",
});
db.learningMaterial.belongsTo(db.user, {
  foreignKey: "uploadedBy",
  as: "Uploader",
});

// Roles are exactly admin/teacher/expert — this app has no
// volunteer/moderator/school/donor domain (see plan's "left behind" list).
db.ROLES2 = ["admin", "teacher", "expert"];

db.ROLES = [
  { name: "teacher", label: "教师" },
  { name: "expert", label: "专家" },
  { name: "admin", label: "管理员" },
];

// 乡土主题 taxonomy, migrated from shinshin's
// CASE_CATEGORIES_BY_COURSE['乡土课程'] (case-options.js).
db.PLAN_THEMES = [
  "家乡美食与饮食文化",
  "非遗与传统手工艺",
  "乡土游戏与童年记忆",
  "传统节日与民俗活动",
  "家乡名人与文化传承",
  "植物探索与劳动实践",
  "乡土艺术与创意表达",
  "家乡物产与经济生活",
  "家乡地理与生态保护",
  "家乡历史与地方记忆",
  "民谣方言/家乡服饰/家乡特色建筑",
];

db.GRADE_OPTIONS = ["一年级", "二年级", "三年级", "四年级", "五年级", "六年级"];

module.exports = db;
