const { authJwt } = require("../middleware");
const topics = require("../controllers/material-topic.controller.js");
const links = require("../controllers/material-link.controller.js");

module.exports = function (app) {
  app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Headers", "x-access-token, Origin, Content-Type, Accept");
    next();
  });

  app.get("/api/material-topics", [authJwt.verifyToken], topics.findAll);
  app.post("/api/material-topics", [authJwt.verifyToken, authJwt.isAdmin], topics.create);
  app.get("/api/material-topics/:id", [authJwt.verifyToken], topics.findOne);
  app.put("/api/material-topics/:id", [authJwt.verifyToken, authJwt.isAdmin], topics.update);
  app.delete("/api/material-topics/:id", [authJwt.verifyToken, authJwt.isAdmin], topics.delete);

  app.get("/api/material-topics/:topicId/links", [authJwt.verifyToken], links.findByTopic);
  app.post("/api/material-topics/:topicId/links", [authJwt.verifyToken, authJwt.isAdmin], links.create);
  app.put("/api/material-links/:id", [authJwt.verifyToken, authJwt.isAdmin], links.update);
  app.delete("/api/material-links/:id", [authJwt.verifyToken, authJwt.isAdmin], links.delete);
};
