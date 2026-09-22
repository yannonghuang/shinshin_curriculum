// Drives a headless Chromium (via Playwright, a devDependency -- never
// installed in the production image, see backend/package.json) against a
// running local dev instance of the app to capture the screenshots
// teacherManualGenerator.js embeds in the auto-generated teacher manual.
//
// Uses REAL existing accounts and REAL existing 乡土课程设计/学习资源库 content
// already on this dev server -- not fabricated demo data. Logging in is done
// by minting a real JWT for an existing user id (scripts/mintDevToken.js,
// run inside the backend container, where the real JWT_SECRET lives) and
// injecting it into localStorage, never by touching/knowing anyone's actual
// password. See scripts/prepareManualScreenshotState.js for the couple of
// small, clearly-scoped nudges (a review pair, a needsMigration flag) this
// still needs on top of what's already there naturally.
//
// The account ids and plan ids below are specific to THIS dev database --
// on a different server, inspect what's actually there and update them
// (see prepareManualScreenshotState.js's own header for the same caveat).
//
// Prerequisites (all local/dev-only, never run against a real deployment):
//   1. `docker compose up --build` (frontend on :3000, backend on :8080).
//   2. `docker compose exec backend node scripts/prepareManualScreenshotState.js`
//   3. From the HOST (not inside the alpine backend container -- Playwright's
//      bundled Chromium needs glibc, which alpine doesn't have):
//        cd backend && npm install && npx playwright install --with-deps chromium
//        node scripts/captureManualScreenshots.js
//
// Writes PNGs into backend/assets/manual-screenshots/ -- commit them once
// you've eyeballed that they look right; teacherManualGenerator.js embeds
// whatever is on disk there at generation time (skipping gracefully, not
// erroring, if a given file is missing -- see its own screenshot() helper).
// Re-run this any time the UI changes enough that a screenshot goes stale.
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const BASE_URL = process.env.MANUAL_SCREENSHOT_BASE_URL || "http://localhost:3000";
const OUT_DIR = path.join(__dirname, "..", "assets", "manual-screenshots");
const REPO_ROOT = path.join(__dirname, "..", "..");

const TEACHER_ID = 8; // yannonghuang / 黄砚农教师 -- a real existing teacher account
const ADMIN_ID = 4; // manager / 管理员 -- a real existing admin account

// Real plans already on this server (see prepareManualScreenshotState.js's
// own comment on how these were picked).
const REVIEW_PLAN_TITLE = "小小菜农 —— 萝卜种植乡土实践课"; // real 设计 content + a real review pair
const MANUAL_MIGRATION_PLAN_TITLE = "童心探敦煌，巧手汇非遗"; // real leftover 手动迁移内容 from an actual past migration

// Real 学习资源库 topic already on this server, with one real uploaded file.
const MATERIAL_CATEGORY = "2026";
const MATERIAL_THEME = "test1";

fs.mkdirSync(OUT_DIR, { recursive: true });

// Mints the same {id, username, ..., accessToken, ...} shape auth.
// controller.js#signin returns, for an existing user id, by running
// mintDevToken.js *inside* the backend container (only place the real
// JWT_SECRET env var lives) -- never touches that user's actual password.
const mintToken = (userId) => {
  const output = execFileSync(
    "docker",
    ["compose", "exec", "-T", "backend", "node", "scripts/mintDevToken.js", String(userId)],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  return JSON.parse(output);
};

// Injects the minted token into localStorage before the app's own first
// script runs (addInitScript fires on every new document in this context),
// so AuthService.getCurrentUser() already finds a valid session on first
// paint -- no /login form, no password, ever.
const loginAs = async (context, userId) => {
  const user = mintToken(userId);
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

    console.log("==> plan-detail: 实施记录 (保存草稿/提交待点评 按钮)");
    // "实施" (unlike a 课时N subgroup) also starts expanded, same as "计划" --
    // 课时 1 is already a visible leaf, no group click needed first.
    await page.getByText("课时 1", { exact: true }).first().click();
    await page.waitForTimeout(200);
    await page.getByText("实施记录", { exact: true }).first().click();
    await page.waitForTimeout(300);
    // The full 实施记录 form is long (every field down to 观察和反思, plus its
    // own 点评 block) -- clip to just the card's own title through the first
    // (position="top") 保存草稿/提交待点评 row instead of the whole
    // .pl-card, which is what this screenshot is actually illustrating.
    {
      const cardBox = await page.locator(".pl-card").first().boundingBox();
      const buttonBox = await page
        .locator(".d-flex", { has: page.getByText("保存草稿", { exact: true }) })
        .first()
        .boundingBox();
      await shoot(page, "save-submit-buttons", {
        clip: { x: cardBox.x, y: cardBox.y, width: cardBox.width, height: buttonBox.y + buttonBox.height - cardBox.y + 16 },
      });
    }

    console.log("==> plan-detail: 支撑材料 (文件管理器)");
    await page.getByText("支撑材料", { exact: true }).first().click();
    await page.waitForTimeout(300);
    await shoot(page.locator(".pl-card").first(), "lesson-file-manager");

    console.log("==> plan-detail #2: 手动迁移内容 板块 (真实的历史迁移遗留内容)");
    await openPlanByTitle(page, MANUAL_MIGRATION_PLAN_TITLE);
    await ensurePlanGroupExpanded(page);
    await page.getByText("手动迁移内容", { exact: true }).first().click();
    await page.waitForTimeout(300);
    await shoot(page.locator(".pl-card").first(), "manual-migration-panel");

    console.log("==> 欣欣助手 面板 (打开状态)");
    await page.locator(".copilot-toggle").click();
    await page.waitForTimeout(500);
    await shoot(page.locator(".copilot-panel"), "copilot-panel");
    await page.locator(".copilot-toggle").click();

    // ---------------------------------------------------------------
    // Admin-role screenshots (学习资源库) -- a fresh browser context, not the
    // teacher's `page` above: two different logged-in sessions can't share
    // one localStorage-backed context.
    // ---------------------------------------------------------------
    console.log("==> Logging in as real admin account (no password used)...");
    const adminContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await loginAs(adminContext, ADMIN_ID);
    const adminPage = await adminContext.newPage();
    await adminPage.goto(`${BASE_URL}/materials`, { waitUntil: "load" });

    // A real admin action (publishes/updates the actual 使用指南/教师在线手册
    // topic) -- not captured for its own screenshot here, just exercised so
    // a stale publish doesn't linger if this script is the only thing run.
    console.log("==> Publishing 教师在线手册 into 使用指南...");
    const publishButton = adminPage.getByRole("button", { name: /生成并发布到/ });
    if (await publishButton.count()) {
      await publishButton.click();
      await adminPage.waitForTimeout(3000);
    }

    // A populated 材料内容 file listing from a real, already-existing 学习
    // 资源库 topic (see this file's header) -- not staged for the screenshot.
    console.log("==> 学习资源库：材料内容 文件列表 (真实主题的真实文件)");
    await adminPage.locator("button.pl-explorer-folder", { hasText: MATERIAL_CATEGORY }).first().click();
    await adminPage.waitForTimeout(300);
    await adminPage.getByText(MATERIAL_THEME, { exact: true }).first().click();
    await adminPage.waitForTimeout(300);
    await adminPage.getByText("材料内容", { exact: true }).first().click();
    await adminPage.waitForTimeout(300);
    await shoot(adminPage.locator(".pl-explorer").first(), "materials-library-content");
    await adminContext.close();

    console.log("\n==> All screenshots captured into", OUT_DIR);
  } catch (err) {
    console.error("Screenshot capture failed partway through:", err);
    console.error("Whatever was saved before the failure is still usable -- re-run to retry the rest.");
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

run();
