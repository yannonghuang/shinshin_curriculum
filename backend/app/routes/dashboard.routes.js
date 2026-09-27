const { authJwt } = require("../middleware");
const dashboard = require("../controllers/dashboard.controller.js");

module.exports = function (app) {
  app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Headers", "x-access-token, Origin, Content-Type, Accept");
    next();
  });

  // Admin only (super included, see authJwt.isAdmin).
  const guard = [authJwt.verifyToken, authJwt.isAdmin];
  app.get("/api/dashboard", guard, dashboard.list);
  app.post("/api/dashboard/export", guard, dashboard.exportExcel);
};
