const { authJwt } = require("../middleware");
const aiReview = require("../controllers/ai-review.controller.js");

module.exports = function (app) {
  app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Headers", "x-access-token, Origin, Content-Type, Accept");
    next();
  });

  // AI 点评 is reserved to experts and admins (super included, see
  // authJwt.isExpertOrAdmin).
  const guard = [authJwt.verifyToken, authJwt.isExpertOrAdmin];
  app.get("/api/ai-review/standard", guard, aiReview.getStandard);
  app.get("/api/ai-review/standard/versions", guard, aiReview.listVersions);
  app.get("/api/ai-review/standard/versions/:id", guard, aiReview.getVersion);
  app.get("/api/ai-review/standard/versions/:id/export", guard, aiReview.exportVersion);
  app.post("/api/ai-review/standard/check", guard, aiReview.checkRevision);
  app.post("/api/ai-review/standard/revisions", guard, aiReview.saveRevision);
  app.post("/api/ai-review/standard/generate", guard, aiReview.generateStandard);

  // AI 打分加点评: experts read it, admins (super included, see
  // authJwt.isAdmin) can also run the batch.
  app.get("/api/ai-review/score-review", guard, aiReview.getScoreReview);
  const adminGuard = [authJwt.verifyToken, authJwt.isAdmin];
  app.post("/api/ai-review/score-review/run", adminGuard, aiReview.runScoreReview);
};
