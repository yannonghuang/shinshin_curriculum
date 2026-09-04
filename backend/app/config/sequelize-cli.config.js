// Config for the sequelize-cli *process* (db:migrate etc.), pointed at by
// ../../.sequelizerc. Separate from db.config.js, which app/models/index.js
// uses to build the app's own runtime Sequelize instance -- both read the
// same env vars, so they're always in sync, but the CLI needs its own file
// in sequelize-cli's own {development,test,production} shape.
//
// This repo has never differentiated DB connection details by NODE_ENV --
// only by which env vars Compose injects into the container -- so all three
// environments below point at the same values.
require("dotenv").config();

const config = {
  username: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "shinshin_curriculum",
  host: process.env.DB_HOST || "localhost",
  dialect: "mysql",
};

module.exports = {
  development: config,
  test: config,
  production: config,
};
