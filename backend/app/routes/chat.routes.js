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
  //
  // Literal /current and /new routes registered before the generic /:id
  // ones below -- Express matches path segments in registration order, and
  // /:id would otherwise happily swallow the literal string "current" too.
  app.get("/api/chat/conversations/current", [authJwt.verifyToken], chat.getCurrent);
  app.post("/api/chat/conversations/new", [authJwt.verifyToken], chat.startNew);
  app.post("/api/chat/conversations/current/messages", [authJwt.verifyToken], chat.sendMessage);

  // "Revisit all threads" -- list every retained conversation, open one by
  // id, continue it.
  app.get("/api/chat/conversations", [authJwt.verifyToken], chat.listConversations);
  app.get("/api/chat/conversations/:id", [authJwt.verifyToken], chat.getConversationById);
  app.post("/api/chat/conversations/:id/messages", [authJwt.verifyToken], chat.sendMessageToConversation);
  app.delete("/api/chat/conversations/:id", [authJwt.verifyToken], chat.deleteConversation);

  // Admin-only: draft a shared-knowledge-base card from one of the admin's
  // own conversations (see chat.controller.js#shareDraft) -- the actual save
  // into knowledge_skills still goes through the existing
  // PUT /api/material-topics/:id/skill (material-topic.routes.js), this only
  // produces the draft for the admin to review/edit first.
  app.post("/api/chat/conversations/:id/share-draft", [authJwt.verifyToken, authJwt.isAdmin], chat.shareDraft);
};
