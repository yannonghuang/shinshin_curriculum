require("dotenv").config();

const express = require("express");
const cors = require("cors");
const app = express();

app.use(cors());

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

// Note: no static frontend serving / catch-all here — the frontend is being
// built separately and its build output path doesn't exist yet.

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}.`);
});

module.exports = app;
