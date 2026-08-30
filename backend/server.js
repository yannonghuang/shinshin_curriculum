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

db.sequelize
  .sync()
  .then(() => {
    console.log("Database synced.");
  })
  .catch((err) => {
    console.error("Failed to sync database:", err.message);
  });

// simple route
app.get("/", (req, res) => {
  res.json({ message: "乡土课程项目实施与案例分享系统（AI智能体）API" });
});

require("./app/routes/auth.routes")(app);
require("./app/routes/plan.routes")(app);
require("./app/routes/artifact.routes")(app);
require("./app/routes/review.routes")(app);
require("./app/routes/learning-material.routes")(app);

// Note: no static frontend serving / catch-all here — the frontend is being
// built separately and its build output path doesn't exist yet.

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}.`);
});

module.exports = app;
