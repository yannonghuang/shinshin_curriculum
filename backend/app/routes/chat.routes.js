const { authJwt } = require("../middleware");
const chat = require("../controllers/chat.controller.js");

module.exports = function (app) {
  app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Headers", "x-access-token, Origin, Content-Type, Accept");
    next();
  });

  // Any authenticated user (teacher/expert/admin) -- scoped to req.userId,
  // no role restriction, matching the co-pilot's "helps teachers" ask
  // without arbitrarily excluding other roles who might also use it.
  app.get("/api/chat/conversations/current", [authJwt.verifyToken], chat.getCurrent);
  app.post("/api/chat/conversations/new", [authJwt.verifyToken], chat.startNew);
  app.post("/api/chat/conversations/current/messages", [authJwt.verifyToken], chat.sendMessage);
};
