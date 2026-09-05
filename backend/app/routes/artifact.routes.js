const { authJwt } = require("../middleware");
const artifacts = require("../controllers/artifact.controller.js");

module.exports = function (app) {
  app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Headers", "x-access-token, Origin, Content-Type, Accept");
    next();
  });

  app.post("/api/plans/:planId/artifacts", [authJwt.verifyToken, authJwt.isTeacherOrAdmin], artifacts.create);
  app.post(
    "/api/plans/:planId/artifacts/bulk",
    [authJwt.verifyToken, authJwt.isTeacherOrAdmin],
    artifacts.bulkCreateFromZip
  );
  app.get("/api/plans/:planId/artifacts", artifacts.findByPlan);
  app.get("/api/plans/:planId/artifacts/download", artifacts.downloadByPlan);
  app.post("/api/plans/:planId/artifacts/download-selection", artifacts.downloadSelection);
  app.get("/api/artifacts/:id", artifacts.findOne);
  app.get("/api/artifacts/:id/download", artifacts.download);
  app.put("/api/artifacts/:id", [authJwt.verifyToken, authJwt.isTeacherOrAdmin], artifacts.update);
  app.delete("/api/artifacts/:id", [authJwt.verifyToken, authJwt.isTeacherOrAdmin], artifacts.delete);
};
