// Nudges the *minimum* extra state onto REAL, already-existing plans so
// captureManualScreenshots.js has something to show for the screenshots
// that need a specific feature state (a "needs migration" flag) that this
// server's real content doesn't happen to have sitting ready on its own,
// and checks the review plan still carries its real reviews. Deliberately NOT a from-scratch seed:
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
const EXPERT_ID = 13; // yannonghuang2 -- a real existing expert account (author of the review plan's 专家点评)
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

// 黄陂三鲜 (captureManualScreenshots.js's REVIEW_PLAN_TITLE): real 设计
// content plus real expert and AI reviews -- review-panel.png/upload-
// dropzone.png/lesson-file-manager.png/plan-completion.png use this one.
const REVIEW_TARGET_PLAN_ID = 145;

// 从一粒玉米说起 (DRAFT_PLAN_TITLE): a real, still nearly blank 草稿 -- the
// plan where flipping needsMigration for the 模板迁移 screenshot costs the
// least (no real course content to visually clutter). needsMigration only
// shows on the plans list, so its plan-page shots are unaffected.
const MIGRATION_TARGET_PLAN_ID = 171;

(async () => {
  const reviewPlan = await Plan.findByPk(REVIEW_TARGET_PLAN_ID);
  if (!reviewPlan) {
    throw new Error(
      `Plan ${REVIEW_TARGET_PLAN_ID} not found -- this script's REVIEW_TARGET_PLAN_ID is specific to this dev database's real content; update it to an existing plan id here.`
    );
  }
  // Real reviews only -- no review text is written here. review-panel.png
  // needs at least one expert and one AI 点评 on the plan.
  const reviewTypes = (await Review.findAll({ where: { planId: REVIEW_TARGET_PLAN_ID }, attributes: ["reviewerType"] })).map(
    (r) => r.reviewerType
  );
  if (!reviewTypes.includes("expert") || !reviewTypes.includes("ai")) {
    throw new Error(
      `Plan ${REVIEW_TARGET_PLAN_ID}（${reviewPlan.title}）needs a real expert and AI 点评 for review-panel.png -- pick a plan that has both and update REVIEW_TARGET_PLAN_ID (and captureManualScreenshots.js's REVIEW_PLAN_TITLE).`
    );
  }
  console.log(`==> Plan ${REVIEW_TARGET_PLAN_ID}（${reviewPlan.title}）has ${reviewTypes.length} real review(s), leaving as-is.`);

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
