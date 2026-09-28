const { authJwt } = require("../middleware");
const reviews = require("../controllers/review.controller.js");

module.exports = function (app) {
  app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Headers", "x-access-token, Origin, Content-Type, Accept");
    next();
  });

  app.post("/api/plans/:planId/reviews", [authJwt.verifyToken, authJwt.isExpertOrAdmin], reviews.create);
  // Owner teacher, or an admin/expert on a submitted plan -- the rule lives
  // in review.controller.js#createAiReview, since it depends on the plan.
  app.post("/api/plans/:planId/reviews/ai", [authJwt.verifyToken], reviews.createAiReview);
  app.post("/api/plans/:planId/reviews/seen", [authJwt.verifyToken], reviews.markSeen);
  app.get("/api/plans/:planId/reviews", reviews.findByPlan);
  app.delete("/api/reviews/:id", [authJwt.verifyToken], reviews.delete);
};
