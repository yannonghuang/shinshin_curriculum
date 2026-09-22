// Nudges the *minimum* extra state onto REAL, already-existing plans so
// captureManualScreenshots.js has something to show for the couple of
// screenshots that need a specific feature state (a review pair, a
// "needs migration" flag) that this server's real content doesn't happen
// to have sitting ready on its own. Deliberately NOT a from-scratch seed:
// no new users, no new plans, no fabricated course content -- every id
// below is a real plan already on this dev server, picked by hand after
// inspecting what's actually there (see backend/assets/manual-screenshots/
// README.md for how this and captureManualScreenshots.js fit together).
//
// Idempotent: checks current state before writing anything, safe to re-run.
// The ids/content below are specific to *this* dev database -- on a
// different server, inspect its own real plans (`Plan.findAll` by
// teacherId) and update the constants below to match, rather than assuming
// these same ids exist.
//
// Run inside the backend container against your local dev stack:
//   docker compose exec backend node scripts/prepareManualScreenshotState.js
const db = require("../app/models");
const Plan = db.plan;
const Review = db.review;
const User = db.user;
const MaterialArtifact = db.materialArtifact;

const TEACHER_ID = 8; // yannonghuang -- a real existing teacher account
const EXPERT_ID = 13; // yannonghuang2 -- a real existing expert account
// These accounts' real display names get genericized (see below) so the
// manual's screenshots -- distributed to every user -- don't carry anyone's
// actual full name, while still showing a real account's real content.
const TEACHER_DISPLAY_NAME = "黄教师";
const EXPERT_DISPLAY_NAME = "黄专家";

// A real 学习资源库 material topic already on this server with one real
// uploaded file (see captureManualScreenshots.js's MATERIAL_CATEGORY/
// MATERIAL_THEME) -- its filename carried a real person's name.
const MATERIAL_TOPIC_ID = 15;
const MATERIAL_NAME_FROM = "王海英";
const MATERIAL_NAME_TO = "王专家";

// 小小菜农 —— 萝卜种植乡土实践课: real 设计 content already filled in (see
// planFormData.s0/s1), no reviews yet -- review-panel.png/save-submit-
// buttons.png/upload-dropzone.png/lesson-file-manager.png all use this one.
const REVIEW_TARGET_PLAN_ID = 126;

// 未命名课程设计: a real but still-blank placeholder plan -- the one real
// plan on this server where flipping needsMigration for the 模板迁移
// screenshot costs the least (no real course content to visually clutter).
const MIGRATION_TARGET_PLAN_ID = 129;

(async () => {
  const reviewPlan = await Plan.findByPk(REVIEW_TARGET_PLAN_ID);
  if (!reviewPlan) {
    throw new Error(
      `Plan ${REVIEW_TARGET_PLAN_ID} not found -- this script's REVIEW_TARGET_PLAN_ID is specific to this dev database's real content; update it to an existing plan id here.`
    );
  }
  const existingReviews = await Review.count({ where: { planId: REVIEW_TARGET_PLAN_ID } });
  if (existingReviews === 0) {
    console.log(`==> Adding one real review pair to plan ${REVIEW_TARGET_PLAN_ID}（${reviewPlan.title}）...`);
    await Review.bulkCreate([
      {
        planId: REVIEW_TARGET_PLAN_ID,
        reviewerType: "expert",
        reviewerId: EXPERT_ID,
        score: 90,
        content:
          "选题贴近学生生活，从播种到收获的完整农耕体验设计得很扎实，“萝卜生命观察手帐”这个记录形式很有想象力。" +
          "建议在教学活动流程里补充一次结合二十四节气的农谚学习环节，让节气智慧与实际农事观察更紧密地结合起来。",
        planVersionAt: reviewPlan.contentVersionAt,
      },
      {
        planId: REVIEW_TARGET_PLAN_ID,
        reviewerType: "ai",
        reviewerId: null,
        aiModel: "qwen3.8-max",
        content:
          "【主题与本地特色相关建议】课程围绕本地秋季常见的水萝卜种植展开，紧密结合劳动实践教育传统，" +
          "从播种到收获形成完整闭环，主题选取贴近学生真实生活经验。\n\n" +
          "【通用教学方法提示】五个分课时目前仅有标题占位，建议尽快补充每课时具体的教学活动流程与所需材料，" +
          "便于后续实际教学与点评。",
        planVersionAt: reviewPlan.contentVersionAt,
      },
    ]);
  } else {
    console.log(`==> Plan ${REVIEW_TARGET_PLAN_ID} already has ${existingReviews} real review(s), leaving as-is.`);
  }

  const migPlan = await Plan.findByPk(MIGRATION_TARGET_PLAN_ID);
  if (!migPlan) {
    throw new Error(
      `Plan ${MIGRATION_TARGET_PLAN_ID} not found -- this script's MIGRATION_TARGET_PLAN_ID is specific to this dev database's real content; update it to an existing plan id here.`
    );
  }
  if (!migPlan.needsMigration) {
    console.log(`==> Flagging plan ${MIGRATION_TARGET_PLAN_ID}（${migPlan.title}）needsMigration for 十四、模板迁移...`);
    await migPlan.update({ needsMigration: true });
  } else {
    console.log(`==> Plan ${MIGRATION_TARGET_PLAN_ID} already flagged needsMigration, leaving as-is.`);
  }

  const teacher = await User.findByPk(TEACHER_ID);
  const expert = await User.findByPk(EXPERT_ID);
  if (teacher && teacher.chineseName !== TEACHER_DISPLAY_NAME) {
    console.log(`==> Genericizing teacher display name: ${teacher.chineseName} -> ${TEACHER_DISPLAY_NAME}`);
    await teacher.update({ chineseName: TEACHER_DISPLAY_NAME });
  }
  if (expert && expert.chineseName !== EXPERT_DISPLAY_NAME) {
    console.log(`==> Genericizing expert display name: ${expert.chineseName} -> ${EXPERT_DISPLAY_NAME}`);
    await expert.update({ chineseName: EXPERT_DISPLAY_NAME });
  }

  const materialArtifact = await MaterialArtifact.findOne({ where: { materialTopicId: MATERIAL_TOPIC_ID } });
  if (materialArtifact && materialArtifact.attachmentName.includes(MATERIAL_NAME_FROM)) {
    const newName = materialArtifact.attachmentName.replace(MATERIAL_NAME_FROM, MATERIAL_NAME_TO);
    console.log(`==> Genericizing material filename: ${materialArtifact.attachmentName} -> ${newName}`);
    await materialArtifact.update({ attachmentName: newName });
  }

  console.log("==> Done.");
  await db.sequelize.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
