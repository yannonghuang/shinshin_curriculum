const { authJwt } = require("../middleware");
const plans = require("../controllers/plan.controller.js");

module.exports = function (app) {
  app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Headers", "x-access-token, Origin, Content-Type, Accept");
    next();
  });

  app.post("/api/plans", [authJwt.verifyToken, authJwt.isTeacherOrAdmin], plans.create);
  // attachUserIfPresent: stays publicly readable (the gallery browses this
  // unauthenticated), but resolves req.userId when a token is present so
  // ?mine=true can be scoped server-side to the actual caller (see findAll).
  app.get("/api/plans", [authJwt.attachUserIfPresent], plans.findAll);
  app.get("/api/plans/options", plans.getOptions);
  app.get("/api/plans/:id", plans.findOne);
  app.put("/api/plans/:id", [authJwt.verifyToken, authJwt.isTeacherOrAdmin], plans.update);
  app.delete("/api/plans/:id", [authJwt.verifyToken, authJwt.isTeacherOrAdmin], plans.delete);

  // Online-fill -> downloadable .docx, registered as a 课程设计文件 artifact.
  app.post("/api/plans/:id/generate-doc", [authJwt.verifyToken, authJwt.isTeacherOrAdmin], plans.generateDoc);
};
