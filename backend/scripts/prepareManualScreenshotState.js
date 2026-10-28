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

// 教师分享 (teacher-share.png): the feature is new, so no real share exists
// yet -- the one exception to "no new content" above, kept minimal: one
// admin 话题 and one share by the real teacher, linked to the real review
// plan, carrying that plan's own exported 课程设计 .docx (real content). Goes
// through the running API (design-doc export -> share upload) so the state
// is exactly what the real UI would have produced.
const SHARE_TOPIC_TITLE = "一堂乡土课程带来的影响";
const SHARE_TITLE = "《黄陂三鲜》让孩子们重新认识了家乡";
const SHARE_SUMMARY = "从学生的课堂表现、作品和家长反馈三个方面，分享这门课程带来的变化。";
const API_BASE = "http://localhost:8080/api";
const ADMIN_ID = 4;

const ensureTeacherShare = async (plan) => {
  const [topic] = await db.shareTopic.findOrCreate({
    where: { title: SHARE_TOPIC_TITLE },
    defaults: { description: "结合您实施过的乡土课程，谈谈它给学生、家长或您自己带来了哪些影响。", createdBy: ADMIN_ID },
  });
  if (await db.share.findOne({ where: { shareTopicId: topic.id, authorId: TEACHER_ID } })) {
    console.log(`==> 教师分享 already has a share under「${SHARE_TOPIC_TITLE}」, leaving as-is.`);
    return;
  }
  console.log(`==> Creating 教师分享 under「${SHARE_TOPIC_TITLE}」with ${plan.title}'s 课程设计 .docx...`);
  const share = await db.share.create({
    shareTopicId: topic.id,
    authorId: TEACHER_ID,
    relatedPlanId: plan.id,
    title: SHARE_TITLE,
    summary: SHARE_SUMMARY,
  });
  const jwt = require("jsonwebtoken");
  const token = jwt.sign({ id: TEACHER_ID }, require("../app/config/auth.config.js").secret, { expiresIn: 600 });
  const docResp = await fetch(`${API_BASE}/plans/${plan.id}/design-doc`, { headers: { "x-access-token": token } });
  if (!docResp.ok) throw new Error(`design-doc export failed: ${docResp.status}`);
  const form = new FormData();
  form.append("category", "Word文档");
  form.append("description", "");
  form.append("file", new Blob([await docResp.arrayBuffer()]), `${plan.title}课程设计方案.docx`);
  const upResp = await fetch(`${API_BASE}/shares/${share.id}/artifacts`, {
    method: "POST",
    headers: { "x-access-token": token },
    body: form,
  });
  if (!upResp.ok) throw new Error(`share upload failed: ${upResp.status} ${await upResp.text()}`);
};

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

  await ensureTeacherShare(reviewPlan);

  console.log("==> Done.");
  await db.sequelize.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
