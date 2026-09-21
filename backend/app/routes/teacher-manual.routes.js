const { authJwt } = require("../middleware");
const teacherManual = require("../controllers/teacherManual.controller.js");

module.exports = function (app) {
  app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Headers", "x-access-token, Origin, Content-Type, Accept");
    next();
  });

  // Both admin-only, mirroring template.routes.js's admin-management gating
  // -- generating/publishing the manual is a content-management action, not
  // something every teacher needs a direct endpoint for (teachers read it
  // via 学习资源库 once #publish has filed it there).
  app.get("/api/admin/teacher-manual/download", [authJwt.verifyToken, authJwt.isAdmin], teacherManual.download);
  app.put("/api/admin/teacher-manual/publish", [authJwt.verifyToken, authJwt.isAdmin], teacherManual.publish);
};
