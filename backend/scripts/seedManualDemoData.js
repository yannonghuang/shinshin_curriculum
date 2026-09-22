// One-off: seeds a small, realistic-looking demo dataset (three demo
// accounts + two demo 乡土课程设计) that scripts/captureManualScreenshots.js
// drives a headless browser against to take screenshots for the
// auto-generated teacher manual (see teacherManualGenerator.js). Only ever
// meant to run against a local/dev database -- never a real one.
//
// Fully idempotent: every row it creates is either keyed by a
// "manual_demo_"-prefixed username or a clearly-marked "（教师手册截图用）"
// plan title, deleted and recreated fresh on every run, so it's always safe
// to re-run (e.g. after a schema/UI change) without leaving stale
// duplicates behind.
//
// Run inside the backend container against your local dev stack:
//   docker compose exec backend node scripts/seedManualDemoData.js
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const db = require("../app/models");
const User = db.user;
const Role = db.role;
const Plan = db.plan;
const Review = db.review;
const TemplateVersion = db.templateVersion;
const MaterialTopic = db.materialTopic;
const MaterialArtifact = db.materialArtifact;
const { getArtifactStorageDirectory } = require("../app/controllers/material-artifact.controller");
const { Op } = db.Sequelize;

const DEMO_PASSWORD = "ManualDemo!2026";
// Matches react-app/src/constants/school-options.js's first seeded school
// (code 1) -- any valid FK into the schools table works equally well here.
const DEMO_SCHOOL_CODE = 1;

const DEMO_USERS = [
  { username: "manual_demo_teacher", chineseName: "示例教师", roles: ["teacher"], schoolCode: DEMO_SCHOOL_CODE },
  { username: "manual_demo_expert", chineseName: "示例专家", roles: ["expert"] },
  { username: "manual_demo_admin", chineseName: "示例管理员", roles: ["admin"] },
];

const flattenedFields = (section) => (section && Array.isArray(section.fields) ? section.fields : []);

const sampleTextFor = (field, i) =>
  `示例内容：${field.label || field.key}的示范文字，用于生成教师手册截图，实际内容请以真实填写为准。（${i + 1}）`;

async function upsertDemoUser({ username, chineseName, roles, schoolCode }) {
  await User.destroy({ where: { username } });
  const user = await User.create({
    username,
    email: `${username}@example.invalid`,
    password: bcrypt.hashSync(DEMO_PASSWORD, 8),
    chineseName,
    emailVerified: true,
    schoolCode: schoolCode || null,
  });
  const roleRows = await Role.findAll({ where: { name: { [Op.or]: roles } } });
  await user.setRoles(roleRows);
  return user;
}

// Walks a template_versions row's schemaJson.sections and fills the first
// few fields of each section with placeholder text -- generic on purpose
// (reads whatever schema is actually active rather than hardcoding field
// keys from one specific template) so this stays correct even after the
// real plan_design/lesson_execution templates change.
function buildPlanFormData(templateVersion) {
  const sections = (templateVersion && templateVersion.schemaJson && templateVersion.schemaJson.sections) || [];
  const formData = {};
  sections.forEach((section) => {
    const fields = flattenedFields(section).slice(0, 3);
    if (fields.length === 0) return;
    formData[section.key] = {};
    fields.forEach((field, i) => {
      formData[section.key][field.key] = sampleTextFor(field, i);
    });
  });
  return formData;
}

function buildExecutionFormData(templateVersion) {
  const sections = (templateVersion && templateVersion.schemaJson && templateVersion.schemaJson.sections) || [];
  const fields = flattenedFields(sections[0]).slice(0, 4);
  const entry = { index: 1 };
  fields.forEach((field, i) => {
    entry[field.key] = sampleTextFor(field, i);
  });
  return [entry];
}

(async () => {
  console.log("==> Seeding demo accounts...");
  const [teacher, expert] = await Promise.all([upsertDemoUser(DEMO_USERS[0]), upsertDemoUser(DEMO_USERS[1])]);
  const admin = await upsertDemoUser(DEMO_USERS[2]);
  console.log(`    teacher id=${teacher.id}, expert id=${expert.id}, admin id=${admin.id}`);

  const planTemplate = await TemplateVersion.findOne({ where: { templateKey: "plan_design", isActive: true } });
  const executionTemplate = await TemplateVersion.findOne({ where: { templateKey: "lesson_execution", isActive: true } });
  if (!planTemplate || !executionTemplate) {
    throw new Error("未找到启用中的 plan_design / lesson_execution 模板版本，请先确认数据库已正常初始化。");
  }

  console.log("==> Seeding demo 乡土课程设计 #1（草稿/已点评 -- 保留草稿状态，让「保存草稿」「提交待点评」按钮都能同时截图）...");
  const plan1Title = "示例：家乡的四季农事（教师手册截图用）";
  await Plan.destroy({ where: { title: plan1Title } });
  const planFormData = buildPlanFormData(planTemplate);
  const plan1 = await Plan.create({
    teacherId: teacher.id,
    title: plan1Title,
    theme: "生计方式实践",
    grade: "三年级",
    studentCount: 28,
    instructorName: "示例教师",
    year: new Date().getFullYear(),
    season: "秋季",
    plannedLessonCount: 4,
    planMode: "online",
    planFormData,
    executionFormData: buildExecutionFormData(executionTemplate),
    planTemplateVersionId: planTemplate.id,
    executionTemplateVersionId: executionTemplate.id,
    // Deliberately "draft", not "submitted" -- reviews aren't gated on plan
    // status (see review.model.js), so this still gets a real 专家点评/AI
    // 点评 pair for review-panel.png, while also keeping 提交待点评 visible
    // (only shown while status === "draft") for save-submit-buttons.png.
    status: "draft",
  });

  await Review.destroy({ where: { planId: plan1.id } });
  // Both sectionKey: null -- 设计's own "计划整体点评" aggregate (see
  // review.model.js's sectionKey comment) -- so a single screenshot of that
  // panel shows 专家点评/AI点评/请AI点评/讨论 all together.
  await Review.bulkCreate([
    {
      planId: plan1.id,
      reviewerType: "expert",
      reviewerId: expert.id,
      score: 88.5,
      content:
        "整体设计思路清晰，能够结合本地农事活动引导学生观察与记录，建议在实施部分进一步说明如何组织学生实地走访，增强课程的可操作性。",
      planVersionAt: plan1.contentVersionAt,
    },
    {
      planId: plan1.id,
      reviewerType: "ai",
      reviewerId: null,
      aiModel: "qwen3.8-max",
      content:
        "【主题与本地特色相关建议】该课程结合三年级学生的认知特点，围绕家乡四季农事展开，主题贴近生活、素材具体，建议进一步补充本地物候观察记录表作为配套材料。\n\n【通用教学方法提示】建议适当增加小组合作环节，鼓励学生互相分享观察记录。",
      planVersionAt: plan1.contentVersionAt,
    },
  ]);

  console.log("==> Seeding demo 乡土课程设计 #2（待迁移/手动迁移内容）...");
  const plan2Title = "示例：老手艺新传承（教师手册截图用）";
  await Plan.destroy({ where: { title: plan2Title } });
  await Plan.create({
    teacherId: teacher.id,
    title: plan2Title,
    theme: "传统手艺制作",
    grade: "五年级",
    year: new Date().getFullYear(),
    season: "秋季",
    planMode: "online",
    planFormData: {
      ...planFormData,
      _manualMigration: [{ label: "公开展示方式", value: "示例内容：计划在校本课程展示日向全校师生公开展示学生作品。" }],
    },
    planTemplateVersionId: planTemplate.id,
    executionTemplateVersionId: executionTemplate.id,
    status: "draft",
    needsMigration: true,
    needsManualMigrationReview: true,
  });

  // A populated 学习资源库 topic -- materials-library-content.png (see
  // captureManualScreenshots.js) needs an actual 材料内容 file listing to
  // show, not an empty "请选择左侧主题" state. Category name is short (kept
  // off the demo plans' longer "（教师手册截图用）" suffix so it doesn't wrap
  // across 3 lines in the narrow sidebar) but still unambiguously demo data,
  // so this destroy-then-recreate stays safe to re-run.
  console.log("==> Seeding demo 学习资源库 主题（含示例材料文件）...");
  const demoCategory = "教师手册截图示例";
  const demoTheme = "乡土课程设计与实施培训";
  await MaterialTopic.destroy({ where: { category: demoCategory } });
  const materialTopic = await MaterialTopic.create({
    category: demoCategory,
    theme: demoTheme,
    lecturer: "示例专家",
    comment: "示例材料主题，仅用于生成教师手册截图。",
  });

  const demoFiles = [
    {
      name: "乡土课程设计与实施培训-要点纪要.docx",
      category: "Word文档",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    {
      name: "乡土课程项目启动会.pptx",
      category: "课件PPT",
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    },
  ];
  for (const f of demoFiles) {
    const dir = getArtifactStorageDirectory(materialTopic.id, f.category);
    const filePath = path.join(dir, f.name);
    fs.writeFileSync(filePath, "示例占位内容，仅用于教师手册截图展示文件列表外观。");
    await MaterialArtifact.create({
      materialTopicId: materialTopic.id,
      folderId: null,
      category: f.category,
      description: "示例材料，仅用于生成教师手册截图。",
      attachmentPath: path.resolve(filePath),
      attachmentName: f.name,
      attachmentMime: f.mime,
      attachmentSize: fs.statSync(filePath).size,
      type: path.extname(f.name).slice(1).toLowerCase(),
    });
  }

  console.log(`==> Done. Demo accounts (password for all: ${DEMO_PASSWORD}):`);
  DEMO_USERS.forEach((u) => console.log(`    ${u.username} (${u.roles.join("/")})`));

  await db.sequelize.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
