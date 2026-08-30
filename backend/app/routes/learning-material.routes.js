const { authJwt } = require("../middleware");
const materials = require("../controllers/learning-material.controller.js");

module.exports = function (app) {
  app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Headers", "x-access-token, Origin, Content-Type, Accept");
    next();
  });

  app.post("/api/learning-materials", [authJwt.verifyToken, authJwt.isAdmin], materials.create);
  app.get("/api/learning-materials", materials.findAll);
  app.get("/api/learning-materials/:id", materials.findOne);
  app.get("/api/learning-materials/:id/download", materials.download);
  app.put("/api/learning-materials/:id", [authJwt.verifyToken, authJwt.isAdmin], materials.update);
  app.delete("/api/learning-materials/:id", [authJwt.verifyToken, authJwt.isAdmin], materials.delete);
};
