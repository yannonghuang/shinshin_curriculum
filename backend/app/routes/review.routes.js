const { authJwt } = require("../middleware");
const reviews = require("../controllers/review.controller.js");

module.exports = function (app) {
  app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Headers", "x-access-token, Origin, Content-Type, Accept");
    next();
  });

  // Expert/admin review. body: content (required), score (optional number),
  // sectionKey + lessonIndex pick what it's about -- omit both for 计划整体点评;
  // sectionKey "IMPLEMENTATION_OVERALL" for 实施整体点评; "EXECUTION_RECORD" +
  // lessonIndex for one 课时's 实施记录; "LESSON_DESIGN" + lessonIndex for
  // one 课时's 分课时设计; otherwise a design segment's own anchor key.
  app.post("/api/plans/:planId/reviews", [authJwt.verifyToken, authJwt.isExpertOrAdmin], reviews.create);
  // Owner teacher, or an admin/expert on a submitted plan -- the rule lives
  // in review.controller.js#createAiReview, since it depends on the plan.
  app.post("/api/plans/:planId/reviews/ai", [authJwt.verifyToken], reviews.createAiReview);
  app.post("/api/plans/:planId/reviews/seen", [authJwt.verifyToken], reviews.markSeen);
  // Soft auth: anyone may list reviews; an expert/admin caller additionally
  // gets AI 打分 on the AI review rows (see review.controller.js#attachAiScores).
  app.get("/api/plans/:planId/reviews", [authJwt.attachUserIfPresent], reviews.findByPlan);
  app.delete("/api/reviews/:id", [authJwt.verifyToken], reviews.delete);
};
