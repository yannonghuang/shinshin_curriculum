# 教师手册截图

PNGs captured by `scripts/captureManualScreenshots.js` and embedded by
`app/services/teacherManualGenerator.js` into the auto-generated teacher
manual. Every file here is a real screenshot of the running app, taken
against **real existing accounts and real existing 乡土课程设计/学习资源库
content** — not a fabricated demo account with placeholder text. Most come
from the local dev server (richer real 乡土课程设计 content there);
`materials-library-content.png` comes from **production** instead (its real
2026年秋季学期 topic has several real uploaded files; dev's only real topic
is a single-file placeholder-ish one) — read-only, never writes anything
there. `scripts/prepareManualScreenshotState.js` adds only the couple of
small, clearly-scoped nudges dev's real content needed on top of what was
already there naturally (a review pair, a `needsMigration` flag), plus
genericizes the real accounts'/file's display names (黄教师/黄专家/王专家) so
the manual — distributed to every user — doesn't carry anyone's actual full
name. Every screenshot is checked by hand to make sure no real person's name
ends up in it (see captureManualScreenshots.js's own header for specifics,
e.g. why the production topic's 基本信息 tab, which does carry one, is never
captured).

`scripts/mintDevToken.js` is how the capture script "logs in" on either
server — it mints a real JWT for an existing user id (run inside that
server's own backend container, local via `docker compose exec` or
production via SSH) and injects it into localStorage, so no account's
actual password is ever touched or known.

**All of these hardcode ids/hosts specific to these particular servers**
(see each script's own header comments) — on a different server, inspect
what's actually there (`Plan.findAll` by teacherId, etc.) and update the
constants to match, rather than assuming these same ids exist.

## Regenerating

```
docker compose up --build
docker compose exec backend node scripts/prepareManualScreenshotState.js

# From the HOST, not inside the alpine backend container (Playwright's
# bundled Chromium needs glibc). Also needs SSH access to production (same
# key scripts/deploy-aliyun-hk.env uses) for the one screenshot sourced
# from there:
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
| `copilot-action-confirm.png` | 十二、AI 聊天助手「欣欣助手」 -- 代办操作 (live LLM call; the pending 提交待点评 is 取消'd right after) |
| `lesson-file-manager.png` | 十三、执行阶段支撑材料管理 |
| `manual-migration-panel.png` | 十四、模板迁移 |
| `materials-library-content.png` | 十五、学习资源库 (sourced from production) |

To add another screenshot: capture it in `captureManualScreenshots.js`,
reference it via `screenshot("name", "caption")` at the right point in
`teacherManualGenerator.js`, then run the regeneration steps above and
commit the new PNG.
