const { authJwt } = require("../middleware");
const folders = require("../controllers/folder.controller.js");

module.exports = function (app) {
  app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Headers", "x-access-token, Origin, Content-Type, Accept");
    next();
  });

  app.post("/api/plans/:planId/folders", [authJwt.verifyToken, authJwt.isTeacherOrAdmin], folders.create);
  app.get("/api/plans/:planId/folders", folders.findByPlan);
  app.put("/api/folders/:id", [authJwt.verifyToken, authJwt.isTeacherOrAdmin], folders.update);
  app.delete("/api/folders/:id", [authJwt.verifyToken, authJwt.isTeacherOrAdmin], folders.delete);
};
