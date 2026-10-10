// Drives a headless Chromium (via Playwright, a devDependency -- never
// installed in the production image, see backend/package.json) to capture
// the screenshots teacherManualGenerator.js embeds in the auto-generated
// teacher manual -- sourcing each one from whichever real server (local dev
// or production) actually has the more representative real content for it.
// Right now that's local dev for everything plan-related (richer 乡土课程设计
// content there) and production for 学习资源库 (its real 2026年秋季学期 topic
// has several real uploaded files; dev's only real topic is a single-file
// placeholder-ish "test1") -- see MATERIAL_* below.
//
// Uses REAL existing accounts and REAL existing content on whichever server
// each screenshot comes from -- not fabricated demo data. Logging in is done
// by minting a real JWT for an existing user id (scripts/mintDevToken.js,
// run *on that server* -- inside the local backend container via `docker
// compose exec`, or on the production ECS host via SSH -- wherever that
// server's own real JWT_SECRET actually lives) and injecting it into
// localStorage, never by touching/knowing anyone's actual password. See
// scripts/prepareManualScreenshotState.js for the couple of small,
// clearly-scoped nudges (a review pair, a needsMigration flag) dev's real
// content still needed on top of what was already there naturally.
//
// No real person's name is ever displayed in any captured screenshot --
// checked by hand for each one (dev's teacher/expert display names are
// genericized by prepareManualScreenshotState.js; production's 学习资源库
// topic has a real 主讲人 name on its 基本信息 tab, so this deliberately only
// ever captures its 材料内容 tab, never 基本信息).
//
// The account ids/plan titles/SSH target below are specific to *these*
// servers -- on a different one, inspect what's actually there and update
// them (see prepareManualScreenshotState.js's own header for the same
// caveat, and scripts/deploy-aliyun-hk.env for where the SSH target/prod
// domain come from).
//
// Prerequisites (dev screenshots -- local/dev-only, never run destructive
// steps against a real deployment):
//   1. `docker compose up --build` (frontend on :3000, backend on :8080).
//   2. `docker compose exec backend node scripts/prepareManualScreenshotState.js`
//   3. From the HOST (not inside the alpine backend container -- Playwright's
//      bundled Chromium needs glibc, which alpine doesn't have):
//        cd backend && npm install && npx playwright install --with-deps chromium
//        node scripts/captureManualScreenshots.js
// Production screenshots additionally need SSH access to the deploy target
// (same key deploy-aliyun-hk.env uses) -- this script only ever *reads*
// production (view a real 学习资源库 topic), never writes to it.
//
// Writes PNGs into backend/assets/manual-screenshots/ -- commit them once
// you've eyeballed that they look right; teacherManualGenerator.js embeds
// whatever is on disk there at generation time (skipping gracefully, not
// erroring, if a given file is missing -- see its own screenshot() helper).
// Re-run this any time the UI changes enough that a screenshot goes stale.
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const BASE_URL = process.env.MANUAL_SCREENSHOT_BASE_URL || "http://localhost:3000";
const OUT_DIR = path.join(__dirname, "..", "assets", "manual-screenshots");
const REPO_ROOT = path.join(__dirname, "..", "..");

const TEACHER_ID = 8; // yannonghuang / 黄教师 -- a real existing teacher account (dev)

// Real plans already on the dev server (see prepareManualScreenshotState.js's
// own comment on how these were picked).
const REVIEW_PLAN_TITLE = "小小菜农 —— 萝卜种植乡土实践课"; // real 设计 content + a real review pair
const MANUAL_MIGRATION_PLAN_TITLE = "童心探敦煌，巧手汇非遗"; // real leftover 手动迁移内容 from an actual past migration
const FOCUS_PLAN_TITLE = "黄陂三鲜"; // real online WHY/WHAT/HOW content, for the 小助手 hover menu

// 学习资源库 content is sourced from PRODUCTION instead of dev -- see this
// file's header comment on why, and on why only 材料内容 (never 基本信息, which
// carries a real 主讲人 name) is ever captured from it.
const PROD_BASE_URL = "https://xtclass.shinshinfoundation.org";
const PROD_SSH_HOST = "root@8.210.148.145";
const PROD_SSH_KEY = path.join(os.homedir(), ".ssh", "shinshin_deploy");
const PROD_DEPLOY_PATH = "/opt/shinshin_curriculum";
const PROD_TEACHER_ID = 2; // yannonghuang -- the same real teacher, on production
const MATERIAL_CATEGORY = "2026";
const MATERIAL_THEME = "2026年秋季学期";

fs.mkdirSync(OUT_DIR, { recursive: true });

// Mints the same {id, username, ..., accessToken, ...} shape auth.
// controller.js#signin returns, for an existing user id, by running
// mintDevToken.js *inside the backend container on the given server* (the
// only place that server's own real JWT_SECRET env var lives) -- never
// touches that user's actual password.
const mintToken = (userId) => {
  const output = execFileSync(
    "docker",
    ["compose", "exec", "-T", "backend", "node", "scripts/mintDevToken.js", String(userId)],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  return JSON.parse(output);
};

const mintTokenOnProd = (userId) => {
  const remoteCmd = `cd ${PROD_DEPLOY_PATH} && docker compose exec -T backend node scripts/mintDevToken.js ${userId}`;
  const output = execFileSync("ssh", ["-i", PROD_SSH_KEY, "-o", "ConnectTimeout=10", PROD_SSH_HOST, remoteCmd], {
    encoding: "utf8",
  });
  return JSON.parse(output);
};

// Injects the minted token into localStorage before the app's own first
// script runs (addInitScript fires on every new document in this context),
// so AuthService.getCurrentUser() already finds a valid session on first
// paint -- no /login form, no password, ever.
const loginAs = async (context, userId, mintFn = mintToken) => {
  const user = mintFn(userId);
  await context.addInitScript((userJson) => {
    window.localStorage.setItem("user", userJson);
  }, JSON.stringify(user));
  return user;
};

// Opens a plan by its (unique) real title from "我的乡土课程" rather than a
// hardcoded id -- ids depend on whatever's already in the target DB, titles
// are what prepareManualScreenshotState.js's own header documents. plan-
// card.component.js's title text itself isn't a link -- only its own "编辑"/
// "查看详情" footer link navigates -- so this scopes to the one card
// containing that title, then clicks that card's own link.
const openPlanByTitle = async (page, title) => {
  await page.goto(`${BASE_URL}/plans?mine=true`, { waitUntil: "load" });
  const card = page.locator(".pl-plan-card", { has: page.getByText(title, { exact: false }) }).first();
  await card.getByRole("link", { name: /编辑|查看详情/ }).click();
  await page.waitForURL(/\/plans\/\d+/, { timeout: 15000 });
  await page.waitForTimeout(500);
};

// plan-detail.component.js's top-level "计划"/"实施" sidebar groups start
// already expanded on a fresh page load (confirmed against a live instance
// -- unlike every *nested* subgroup, e.g. a 课时N's own 实施记录/支撑材料
// leaves, which do start collapsed). Clicking "计划"'s own header toggles
// it AND reselects the 课程设计文件 pane as a side effect (see plan-detail.
// component.js's own comment on that button), so blindly clicking it to
// "expand" it is exactly backwards the second time around -- this checks
// real current state (via a leaf that's only rendered while expanded)
// before deciding whether a click is even needed.
const ensurePlanGroupExpanded = async (page) => {
  const alreadyExpanded = await page
    .getByText("计划整体点评", { exact: true })
    .first()
    .isVisible()
    .catch(() => false);
  if (!alreadyExpanded) {
    await page.locator("button.pl-explorer-folder", { hasText: "计划" }).first().click();
    await page.waitForTimeout(300);
  }
};

const shoot = async (locatorOrPage, name, options) => {
  const target = path.join(OUT_DIR, `${name}.png`);
  await locatorOrPage.screenshot({ path: target, ...options });
  console.log(`    saved ${name}.png`);
};

// 欣欣小助手's per-field 小助手 hover menu (ask-ai-menu.component.js) on a
// real plan's WHY page, then the panel it opens: the 针对：… chip and a real
// reply to the 帮我完善 question (a live LLM round-trip -- read-only, the
// question only asks for suggestions, nothing is written). Runs with the
// panel closed and leaves it closed.
async function captureFocusShots(page) {
  console.log("==> 欣欣小助手 小助手 悬停菜单 (WHY 页的第一个字段)");
  await openPlanByTitle(page, FOCUS_PLAN_TITLE);
  await ensurePlanGroupExpanded(page);
  await page.locator(".pl-explorer-leaf", { hasText: /^WHY/ }).first().click();
  await page.waitForTimeout(300);
  // A fresh 新对话 first, so the reply isn't preceded by unrelated history.
  await page.locator(".copilot-toggle").click();
  await page.locator(".copilot-panel").getByRole("button", { name: "新对话" }).click();
  await page.waitForTimeout(300);
  await page.locator(".copilot-toggle").click();
  const field = page.locator(".pl-card .form-group.ai-ask-host").first();
  await field.hover();
  await field.locator(".ai-ask-trigger").hover();
  await page.locator(".ai-ask-menu").waitFor();
  await page.waitForTimeout(300);
  {
    const box = await field.boundingBox();
    const menuBox = await page.locator(".ai-ask-menu").boundingBox();
    const bottom = Math.max(box.y + box.height, menuBox.y + menuBox.height) + 12;
    await shoot(page, "copilot-ask-menu", { clip: { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: bottom - box.y + 12 } });
  }

  console.log("==> 欣欣小助手 针对某一栏的对话 (帮我完善)");
  await page.locator(".ai-ask-menu").getByRole("menuitem", { name: "帮我完善" }).click();
  await page.locator(".copilot-panel .copilot-focus-chip").waitFor();
  await page.waitForFunction(
    () => !document.querySelector(".copilot-bubble-thinking") && !document.querySelector(".copilot-task-card") &&
      !!document.querySelector(".copilot-bubble-user .copilot-bubble-focus") &&
      document.querySelectorAll(".copilot-bubble-assistant").length > 0,
    null,
    { timeout: 240000 }
  );
  await page.locator(".copilot-bubble-user .copilot-bubble-focus").last().scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await shoot(page.locator(".copilot-panel"), "copilot-focus");
  await page.locator(".copilot-toggle").click();

  // 基本信息's own menu (推荐标题/推荐乡土主题/...) -- just the menu, no
  // question sent.
  console.log("==> 欣欣小助手 基本信息 小助手 菜单 (乡土主题)");
  await page.locator(".pl-explorer-leaf", { hasText: "基本信息" }).first().click();
  await page.waitForTimeout(300);
  const card = page.locator(".pl-card").first();
  const themeField = card.locator(".form-group.ai-ask-host", { hasText: "乡土主题" }).first();
  await themeField.hover();
  await themeField.locator(".ai-ask-trigger").hover();
  await page.locator(".ai-ask-menu").waitFor();
  await page.waitForTimeout(300);
  {
    const box = await card.boundingBox();
    const menuBox = await page.locator(".ai-ask-menu").boundingBox();
    const bottom = Math.max(box.y + box.height, menuBox.y + menuBox.height) + 12;
    await shoot(page, "copilot-basic-info-menu", { clip: { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: bottom - box.y + 12 } });
  }
  await page.mouse.move(0, 0);
}

async function run() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  try {
    // ---------------------------------------------------------------
    // Teacher-role screenshots
    // ---------------------------------------------------------------
    console.log("==> Logging in as real teacher account (no password used)...");
    await loginAs(context, TEACHER_ID);
    const page = await context.newPage();
    await page.goto(BASE_URL, { waitUntil: "load" });

    console.log("==> nav-bar");
    // Full-width clip (locator.screenshot() would capture the navbar's whole
    // 1440px flex box, with brand+links clustered left and the user menu
    // pinned far right) makes for an unreadably squat image once scaled down
    // to the manual's page width -- clip to just the brand+links cluster
    // instead (see 常用导航入口's own table, which is what this illustrates).
    const navBox = await page.locator("nav.navbar").boundingBox();
    await shoot(page, "nav-bar", { clip: { x: 0, y: navBox.y, width: 620, height: navBox.height } });

    console.log("==> plans-list (真实课程列表，含「待迁移」「待手动整理」标签)");
    await page.goto(`${BASE_URL}/plans?mine=true`, { waitUntil: "load" });
    // plans-list.component.js's outer wrapper is plain `.container` (no
    // `.pl-page`) for a logged-in teacher's own ?mine=true view -- `.pl-page`
    // only applies to the public/"stylish" gallery view.
    await shoot(page.locator(".container").first(), "plans-list");

    console.log("==> plan-detail: 课程设计文件 上传区域");
    await openPlanByTitle(page, REVIEW_PLAN_TITLE);
    // Clicking "计划"'s header selects 课程设计文件 as a side effect regardless
    // of which way it also toggles expand/collapse -- exactly the pane we
    // want here, so no need to check expand state first.
    await page.locator("button.pl-explorer-folder", { hasText: "计划" }).first().click();
    await page.waitForTimeout(300);
    const uploadToggle = page.getByRole("button", { name: "上传", exact: true }).first();
    await uploadToggle.click();
    await page.waitForTimeout(300);
    await shoot(page.locator(".pl-card").first(), "upload-dropzone");
    await uploadToggle.click(); // close it back so it doesn't affect later steps

    console.log("==> plan-detail: 计划整体点评 (专家点评/AI点评/请AI点评/讨论)");
    await ensurePlanGroupExpanded(page);
    await page.getByText("计划整体点评", { exact: true }).first().click();
    await page.waitForTimeout(300);
    await shoot(page.locator(".pl-card").first(), "review-panel");
    // An AI 点评 row with its AI 设计分数 opened from the 评分 column
    // (collapsed), from the row's header line down through its body.
    {
      const scoreBtn = page.locator("tr.pl-review-ai-meta td button", { hasText: "/" }).first();
      if (await scoreBtn.count()) {
        await scoreBtn.click();
        await page.waitForTimeout(300);
        const top = await page.locator("tr.pl-review-ai-meta").first().boundingBox();
        const bottom = await page.locator("tr.pl-review-ai-body").first().boundingBox();
        await shoot(page, "ai-design-score-row", { clip: { x: top.x, y: top.y, width: top.width, height: bottom.y + bottom.height - top.y } });
        await scoreBtn.click(); // back to the review text
      }
    }

    console.log("==> plan-detail: 设计完成度 (标题栏)");
    await shoot(page.locator(".pl-hero").first(), "plan-completion");

    console.log("==> plan-detail: 支撑材料 (文件管理器)");
    // "实施" (unlike a 课时N subgroup) also starts expanded, same as "计划" --
    // 课时 1 is already a visible leaf, no group click needed first.
    await page.getByText("课时 1", { exact: true }).first().click();
    await page.waitForTimeout(200);
    await page.getByText("支撑材料", { exact: true }).first().click();
    await page.waitForTimeout(300);
    await shoot(page.locator(".pl-card").first(), "lesson-file-manager");

    console.log("==> plan-detail #2: 手动迁移内容 板块 (真实的历史迁移遗留内容)");
    await openPlanByTitle(page, MANUAL_MIGRATION_PLAN_TITLE);
    await ensurePlanGroupExpanded(page);
    await page.getByText("手动迁移内容", { exact: true }).first().click();
    await page.waitForTimeout(300);
    await shoot(page.locator(".pl-card").first(), "manual-migration-panel");

    console.log("==> plan-detail #2: 实施记录 (保存草稿/提交待点评 按钮)");
    // Shot on this plan, not REVIEW_PLAN_TITLE's: it's still 草稿 on dev, and
    // 提交待点评 only renders for a draft -- REVIEW_PLAN_TITLE's is 已提交, so
    // the screenshot would show 保存草稿 alone. 分课时设计 starts collapsed,
    // so the first "课时 1" leaf is 实施's.
    await page.getByText("课时 1", { exact: true }).first().click();
    await page.waitForTimeout(200);
    await page.getByText("实施记录", { exact: true }).first().click();
    await page.waitForTimeout(300);
    // The page's single 保存草稿/提交待点评 pair lives in the sticky header
    // (not per section) -- clip from that header down through the top of the
    // 实施记录 form open below it, so the screenshot shows one pair sitting
    // above the section it saves.
    {
      const headerBox = await page.locator(".pl-sticky-header").first().boundingBox();
      await shoot(page, "save-submit-buttons", {
        clip: { x: headerBox.x, y: headerBox.y, width: headerBox.width, height: headerBox.height + 260 },
      });
    }

    console.log("==> 欣欣小助手 面板 (打开状态)");
    await page.locator(".copilot-toggle").click();
    await page.waitForTimeout(500);
    await shoot(page.locator(".copilot-panel"), "copilot-panel");

    console.log("==> 欣欣小助手 代办操作：「待确认」卡片 (提交待点评 -> 取消，不改动任何数据)");
    // A real request on this still-草稿 plan: submit_plan is confirm-tier, so
    // the reply carries a pending 确认执行/取消 card instead of acting --
    // captured, then 取消'd, so the plan itself stays exactly as it was. A
    // fresh 新对话 first, so the card isn't preceded by unrelated history.
    // The reply is a live LLM round-trip, hence the long wait.
    await page.locator(".copilot-panel").getByRole("button", { name: "新对话" }).click();
    await page.waitForTimeout(500);
    await page.locator(".copilot-input-row textarea").fill("请把这份课程设计提交待点评。");
    await page.locator(".copilot-input-row button[type=submit]").click();
    const actionCard = page.locator(".copilot-action", { has: page.getByRole("button", { name: "确认执行" }) }).first();
    await actionCard.waitFor({ timeout: 180000 });
    await page.waitForTimeout(500);
    await shoot(page.locator(".copilot-panel"), "copilot-action-confirm");
    await actionCard.getByRole("button", { name: "取消" }).click();
    await page.waitForTimeout(1000);

    console.log("==> 欣欣小助手 附件：选择文件 + 粘贴截图");
    // Real material on both counts: the project's own spec .docx from the
    // repo root, picked through the 📎 file input, and a screenshot of the
    // real plan page currently open, pasted into the input the way a teacher
    // pastes one (a synthetic ClipboardEvent carrying the PNG -- what
    // copilot-panel.component.js#onPaste reads). Both go through the real
    // upload/extraction (the image through the live vision model).
    await page.locator(".copilot-panel").getByRole("button", { name: "新对话" }).click();
    await page.waitForTimeout(500);
    const pastedScreenshot = (await page.screenshot({ clip: { x: 0, y: 0, width: 1000, height: 640 } })).toString("base64");
    await page
      .locator(".copilot-panel input[type=file]")
      .setInputFiles(path.join(REPO_ROOT, "乡土课程项目实施与案例分享系统（AI智能体）Spec.docx"));
    await page.locator(".copilot-input-row textarea").evaluate((el, b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], "image.png", { type: "image/png" }));
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, pastedScreenshot);
    await page.waitForFunction(() => document.querySelectorAll(".copilot-chip-ready").length === 2, null, { timeout: 180000 });
    await page.locator(".copilot-input-row textarea").fill("请结合附件文档，说明截图中这份课程设计还缺哪些内容。");
    await page.waitForTimeout(300);
    await shoot(page.locator(".copilot-panel"), "copilot-attachments");

    console.log("==> 欣欣小助手 导出：选择部分消息");
    // Sends the turn above for real (a live LLM round-trip, hence the long
    // wait), then opens 导出 in 选择部分消息 mode with the reply unticked --
    // captured and 取消'd; nothing is downloaded.
    await page.locator(".copilot-input-row button[type=submit]").click();
    await page.waitForFunction(() => !document.querySelector(".copilot-bubble-thinking"), null, { timeout: 180000 });
    await page.waitForTimeout(1000);
    await page.locator(".copilot-panel").getByRole("button", { name: "导出" }).click();
    await page.locator(".copilot-panel").getByLabel("选择部分消息").check();
    await page.locator(".copilot-select-box").last().uncheck();
    await page.waitForTimeout(300);
    await shoot(page.locator(".copilot-panel"), "copilot-export");
    await page.locator(".copilot-export-bar").getByRole("button", { name: "取消" }).click();

    console.log("==> 欣欣小助手 耗时较长的请求：「正在处理」进度卡片 + 起草的课程设计草案");
    // A real drafting request (draft_plan) -- long enough to outlast the
    // inline wait, so its progress card appears; captured once the drafting
    // sub-steps show, then left to finish so the draft's 新建为课程设计
    // button can be captured too. The button is never clicked -- nothing is
    // written.
    await page.locator(".copilot-panel").getByRole("button", { name: "新对话" }).click();
    await page.waitForTimeout(500);
    await page.locator(".copilot-input-row textarea").fill("请帮我草拟一份为期5周的五年级乡土课程设计，主题与本课程相同。");
    await page.locator(".copilot-input-row button[type=submit]").click();
    const taskCard = page.locator(".copilot-task-card");
    await taskCard.waitFor({ timeout: 30000 });
    await page.waitForFunction(() => /并行撰写/.test(document.querySelector(".copilot-task-card")?.innerText || ""), null, { timeout: 90000 });
    await page.waitForTimeout(500);
    await shoot(page.locator(".copilot-panel"), "copilot-task");
    await taskCard.waitFor({ state: "detached", timeout: 240000 });
    await page.waitForTimeout(1000);
    await page.locator(".copilot-panel").getByRole("button", { name: "新建为课程设计" }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await shoot(page.locator(".copilot-panel"), "copilot-draft");

    console.log("==> 欣欣小助手 照片：回复下方显示的照片");
    // A real photo request (find_photos): library photos if any, otherwise
    // relevance-checked web photos with their sources -- captured once the
    // images have loaded.
    await page.locator(".copilot-panel").getByRole("button", { name: "新对话" }).click();
    await page.waitForTimeout(500);
    await page.locator(".copilot-input-row textarea").fill("能显示几张本课程主题的照片吗？");
    await page.locator(".copilot-input-row button[type=submit]").click();
    await page.waitForFunction(
      () => {
        const imgs = [...document.querySelectorAll(".copilot-photo-img")];
        return imgs.length > 0 && imgs.every((i) => i.tagName === "IMG" && i.complete && i.naturalWidth > 0);
      },
      null,
      { timeout: 240000 }
    );
    await page.locator(".copilot-photos").last().scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await shoot(page.locator(".copilot-panel"), "copilot-photos");
    await page.locator(".copilot-toggle").click();

    await captureFocusShots(page);

    // ---------------------------------------------------------------
    // 学习资源库 screenshot -- sourced from PRODUCTION (see this file's header
    // for why), read-only: browses a real topic as the same real teacher
    // account, never writes anything. A fresh browser context -- different
    // server entirely, so it needs its own localStorage-backed session.
    // ---------------------------------------------------------------
    console.log("==> Logging in on PRODUCTION as the real teacher account (no password used)...");
    const prodContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await loginAs(prodContext, PROD_TEACHER_ID, mintTokenOnProd);
    const prodPage = await prodContext.newPage();
    await prodPage.goto(`${PROD_BASE_URL}/materials`, { waitUntil: "load" });

    // A populated 材料内容 file listing from a real, already-existing 学习
    // 资源库 topic on production -- deliberately never opens 基本信息 (see
    // this file's header on why); reads only, writes nothing.
    console.log("==> 学习资源库：材料内容 文件列表 (生产环境真实主题的真实文件)");
    await prodPage.locator("button.pl-explorer-folder", { hasText: MATERIAL_CATEGORY }).first().click();
    await prodPage.waitForTimeout(300);
    await prodPage.getByText(MATERIAL_THEME, { exact: true }).first().click();
    await prodPage.waitForTimeout(300);
    await prodPage.getByText("材料内容", { exact: true }).first().click();
    await prodPage.waitForTimeout(300);
    await shoot(prodPage.locator(".pl-explorer").first(), "materials-library-content");
    await prodContext.close();

    console.log("\n==> All screenshots captured into", OUT_DIR);
  } catch (err) {
    console.error("Screenshot capture failed partway through:", err);
    console.error("Whatever was saved before the failure is still usable -- re-run to retry the rest.");
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

// `node scripts/captureManualScreenshots.js` runs everything; requiring it
// lets a one-off capture reuse a single step (e.g. captureFocusShots).
if (require.main === module) run();

module.exports = { BASE_URL, loginAs, captureFocusShots };
