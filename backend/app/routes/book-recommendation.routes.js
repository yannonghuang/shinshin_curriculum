const { authJwt } = require("../middleware");
const controller = require("../controllers/book-recommendation.controller.js");

module.exports = function (app) {
  app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Headers", "x-access-token, Origin, Content-Type, Accept");
    next();
  });

  // 课外读物推荐 is reserved to super-admins.
  const guard = [authJwt.verifyToken, authJwt.isSuper];

  // 课外读物推荐 form options: provinces, 学段, and every school with its
  // inferred province and 学段 defaults.
  app.get("/api/book-recommendations/options", guard, controller.options);

  // 课外读物推荐 runs (newest first): school, province, status, and
  // recommended/excluded/review counts.
  app.get("/api/book-recommendations/runs", guard, controller.list);

  // Start a 课外读物推荐 run from an uploaded book list (.xlsx/.csv
  // multipart upload) for a school.
  app.post("/api/book-recommendations/runs", guard, controller.start);

  // One 课外读物推荐 run's result: recommended books grouped by 学段, the
  // excluded ones with the rule they break, the ones needing review, and the
  // province's rules used.
  app.get("/api/book-recommendations/runs/:id", guard, controller.get);

  // Delete a 课外读物推荐 run.
  app.delete("/api/book-recommendations/runs/:id", guard, controller.delete);

  // Run a 课外读物推荐 again with the same school and book list (picks up
  // renewed book profiles and provincial rules).
  app.post("/api/book-recommendations/runs/:id/rerun", guard, controller.rerun);

  // Export a finished 课外读物推荐 run as Excel (format=xlsx) or Word
  // (format=docx).
  app.get("/api/book-recommendations/runs/:id/export", guard, controller.export);

  // Cached provincial 课外读物进校园 rules (依据文件, 红线, 学段要求).
  app.get("/api/book-recommendations/guidances", guard, controller.guidances);

  // Re-fetch one province's 课外读物进校园 rules from the web.
  app.post("/api/book-recommendations/guidances/refresh", guard, controller.refreshGuidance);

  // The 图书检索 / 指导检索 skills' self-improvement notes.
  app.get("/api/book-recommendations/skills", guard, controller.skills);
};
