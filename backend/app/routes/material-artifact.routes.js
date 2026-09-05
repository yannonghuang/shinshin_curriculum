const { authJwt } = require("../middleware");
const artifacts = require("../controllers/material-artifact.controller.js");

module.exports = function (app) {
  app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Headers", "x-access-token, Origin, Content-Type, Accept");
    next();
  });

  app.post("/api/material-topics/:topicId/artifacts", [authJwt.verifyToken, authJwt.isAdmin], artifacts.create);
  app.post(
    "/api/material-topics/:topicId/artifacts/bulk",
    [authJwt.verifyToken, authJwt.isAdmin],
    artifacts.bulkCreateFromZip
  );
  app.get("/api/material-topics/:topicId/artifacts", [authJwt.verifyToken], artifacts.findByTopic);
  app.get("/api/material-topics/:topicId/artifacts/download", [authJwt.verifyToken], artifacts.downloadByTopic);
  app.post(
    "/api/material-topics/:topicId/artifacts/download-selection",
    [authJwt.verifyToken],
    artifacts.downloadSelection
  );
  app.get("/api/material-artifacts/:id", [authJwt.verifyToken], artifacts.findOne);
  app.get("/api/material-artifacts/:id/download", artifacts.download);
  app.put("/api/material-artifacts/:id", [authJwt.verifyToken, authJwt.isAdmin], artifacts.update);
  app.delete("/api/material-artifacts/:id", [authJwt.verifyToken, authJwt.isAdmin], artifacts.delete);
};
