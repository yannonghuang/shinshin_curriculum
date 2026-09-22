# 教师手册截图

PNGs captured by `scripts/captureManualScreenshots.js` and embedded by
`app/services/teacherManualGenerator.js` into the auto-generated teacher
manual. Every file here is a real screenshot of the running app, taken
against **real existing accounts and real existing 乡土课程设计/学习资源库
content** already on the dev server it was run against — not a fabricated
demo account with placeholder text. `scripts/prepareManualScreenshotState.js`
adds only the couple of small, clearly-scoped nudges (a review pair, a
`needsMigration` flag) that a specific screenshot needs but this server's
organic content doesn't already have sitting ready.

`scripts/mintDevToken.js` is how the capture script "logs in" — it mints a
real JWT for an existing user id and injects it into localStorage, so no
account's actual password is ever touched or known.

**Both scripts hardcode ids specific to the dev database they were last run
against** (see their own header comments) — on a different server, inspect
what's actually there (`Plan.findAll` by teacherId, etc.) and update the
constants to match, rather than assuming these same ids exist.

## Regenerating

```
docker compose up --build
docker compose exec backend node scripts/prepareManualScreenshotState.js

# From the HOST, not inside the alpine backend container (Playwright's
# bundled Chromium needs glibc):
cd backend
npm install
npx playwright install --with-deps chromium
node scripts/captureManualScreenshots.js
```

Eyeball the results, then commit whichever files changed. A missing file
here doesn't break manual generation — `teacherManualGenerator.js`'s own
`screenshot()` helper skips it with a `console.warn` instead of failing the
whole document, so it's fine to add these incrementally.

## Current set

| File | Chapter |
|---|---|
| `nav-bar.png` | 前言 -- 常用导航入口 |
| `plans-list.png` | 一、创建课程设计 / 十四、模板迁移 |
| `save-submit-buttons.png` | 三、保存 |
| `upload-dropzone.png` | 五、上传 |
| `review-panel.png` | 八、专家评审 |
| `copilot-panel.png` | 十二、AI 聊天助手「欣欣助手」 |
| `lesson-file-manager.png` | 十三、执行阶段支撑材料管理 |
| `manual-migration-panel.png` | 十四、模板迁移 |
| `materials-library-content.png` | 十五、学习资源库 |

To add another screenshot: capture it in `captureManualScreenshots.js`,
reference it via `screenshot("name", "caption")` at the right point in
`teacherManualGenerator.js`, then run the regeneration steps above and
commit the new PNG.
