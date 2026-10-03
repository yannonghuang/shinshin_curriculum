require("dotenv").config();

const express = require("express");
const cors = require("cors");
const app = express();

// exposedHeaders: without this, a browser's JS can't read a custom response
// header cross-origin even though the response itself carries it -- needed
// so the frontend can pick up the renewed token authJwt.js#verifyToken
// reissues on every authenticated request, and the "your session actually
// expired" signal authJwt.js#attachUserIfPresent sets on an otherwise-
// successful soft-auth request (see either's own comment).
app.use(cors({ exposedHeaders: ["x-access-token", "x-session-expired"] }));

// parse requests of content-type - application/json
app.use(express.json({ limit: "25mb" }));

// parse requests of content-type - application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

const db = require("./app/models");

// Schema is owned by sequelize-cli migrations now (run by
// docker-entrypoint.sh before this process starts) -- sync() would fight
// them by auto-creating tables outside migration tracking. Just verify the
// connection actually works, failing fast the same way sync() incidentally
// did.
db.sequelize
  .authenticate()
  .then(() => {
    console.log("Database connection established.");
  })
  .catch((err) => {
    console.error("Failed to connect to database:", err.message);
  });

// simple route
app.get("/", (req, res) => {
  res.json({ message: "乡土课程项目实施与案例分享系统（AI智能体）API" });
});

require("./app/routes/auth.routes")(app);
require("./app/routes/plan.routes")(app);
require("./app/routes/artifact.routes")(app);
require("./app/routes/folder.routes")(app);
require("./app/routes/review.routes")(app);
require("./app/routes/template.routes")(app);
require("./app/routes/material-topic.routes")(app);
require("./app/routes/material-folder.routes")(app);
require("./app/routes/material-artifact.routes")(app);
require("./app/routes/chat.routes")(app);
require("./app/routes/teacher-manual.routes")(app);
require("./app/routes/ai-review.routes")(app);
require("./app/routes/dashboard.routes")(app);
require("./app/routes/build-info.routes")(app);

// 欣欣助手's action layer discovers the API from the live router (lazily, on
// first use) -- must come after every route above is registered.
require("./app/services/copilotRouteRegistry").attachApp(app);

// Note: no static frontend serving / catch-all here — the frontend is being
// built separately and its build output path doesn't exist yet.

// Daily sweep of chat conversations past their retention window (see
// chatRetention.js) -- a plain in-process interval, not a cron job or
// external scheduler, since nothing else in this app runs on a schedule and
// one sweep a day doesn't justify a new deployment piece. Runs once shortly
// after startup too (nodemon/container restarts are frequent in dev, and a
// freshly-started prod container shouldn't have to wait a full day for its
// first sweep), delayed a few seconds so it isn't racing the DB connection
// check above.
const chatRetention = require("./app/services/chatRetention");
const CHAT_RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const runChatRetentionSweep = () => {
  chatRetention
    .purgeStaleConversations()
    .then((deletedCount) => {
      if (deletedCount > 0) console.log(`Chat retention sweep: purged ${deletedCount} conversation(s).`);
    })
    .catch((err) => console.error("Chat retention sweep failed:", err.message));
  chatRetention
    .purgeOrphanAttachments()
    .then((deletedCount) => {
      if (deletedCount > 0) console.log(`Chat retention sweep: purged ${deletedCount} unsent attachment(s).`);
    })
    .catch((err) => console.error("Chat attachment sweep failed:", err.message));
};
setTimeout(runChatRetentionSweep, 10 * 1000);
setInterval(runChatRetentionSweep, CHAT_RETENTION_SWEEP_INTERVAL_MS);

// Keeps the published 教师使用手册 (the copy 欣欣助手 actually reads, via the
// knowledge base) in step with the manual text shipped in this build --
// otherwise it only updated when an admin remembered to republish after a
// deploy. A no-op when nothing changed; see teacherManualPublish.js. Delayed
// past the retention sweep so startup isn't doing both at once.
setTimeout(() => {
  require("./app/services/teacherManualPublish")
    .syncPublishedTeacherManual()
    .then((r) => {
      if (r.updated) console.log("Teacher manual changed since last publish -- republished to 学习资源库 and the knowledge base.");
    })
    .catch((err) => console.error("Teacher manual sync failed:", err.message));
}, 30 * 1000);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}.`);
});

module.exports = app;
