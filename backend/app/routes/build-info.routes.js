const { authJwt } = require("../middleware");
const buildInfo = require("../controllers/buildInfo.controller.js");

module.exports = function (app) {
  app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Headers", "x-access-token, Origin, Content-Type, Accept");
    next();
  });

  // Super-only, like 用户管理 -- deploy internals aren't something plain
  // admins, experts or teachers need.
  app.get("/api/admin/build-info", [authJwt.verifyToken, authJwt.isSuper], buildInfo.get);
};
