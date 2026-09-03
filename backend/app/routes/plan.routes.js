const { authJwt } = require("../middleware");
const plans = require("../controllers/plan.controller.js");

module.exports = function (app) {
  app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Headers", "x-access-token, Origin, Content-Type, Accept");
    next();
  });

  // Only teachers author a new plan -- managers/experts manage existing
  // cases (suspend/delete/promote/review) but don't create their own.
  app.post("/api/plans", [authJwt.verifyToken, authJwt.isTeacher], plans.create);
  // attachUserIfPresent: stays publicly readable (the gallery browses this
  // unauthenticated), but resolves req.userId when a token is present so
  // ?mine=true can be scoped server-side to the actual caller (see findAll).
  app.get("/api/plans", [authJwt.attachUserIfPresent], plans.findAll);
  app.get("/api/plans/options", plans.getOptions);
  // attachUserIfPresent: stays reachable without login (excellent-case plans
  // are public), but resolves req.userId so findOne can allow the owner/
  // admin/expert through for a non-excellent plan -- see findOne's visibility
  // check.
  app.get("/api/plans/:id", [authJwt.attachUserIfPresent], plans.findOne);
  app.put("/api/plans/:id", [authJwt.verifyToken, authJwt.isTeacherOrAdmin], plans.update);
  app.put("/api/plans/:id/suspend", [authJwt.verifyToken, authJwt.isAdmin], plans.suspend);
  app.put("/api/plans/:id/unsuspend", [authJwt.verifyToken, authJwt.isAdmin], plans.unsuspend);
  app.delete("/api/plans/:id", [authJwt.verifyToken, authJwt.isTeacherOrAdmin], plans.delete);

  // Online-fill -> .docx, rendered on the fly and streamed back (never
  // persisted) -- backs the 课程设计文件 panel's 下载/预览 commands.
  // attachUserIfPresent, like GET /api/plans/:id: viewing is open to the
  // owner/admin/expert or, for a public 优秀案例, anyone -- see
  // plan.controller.js#renderDoc's visibility check.
  app.get("/api/plans/:id/design-doc", [authJwt.attachUserIfPresent], plans.renderDoc);
};
