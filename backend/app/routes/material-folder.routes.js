const { authJwt } = require("../middleware");
const folders = require("../controllers/material-folder.controller.js");

module.exports = function (app) {
  app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Headers", "x-access-token, Origin, Content-Type, Accept");
    next();
  });

  app.post("/api/material-topics/:topicId/folders", [authJwt.verifyToken, authJwt.isAdmin], folders.create);
  app.get("/api/material-topics/:topicId/folders", [authJwt.verifyToken], folders.findByTopic);
  app.put("/api/material-folders/:id", [authJwt.verifyToken, authJwt.isAdmin], folders.update);
  app.delete("/api/material-folders/:id", [authJwt.verifyToken, authJwt.isAdmin], folders.delete);
};
