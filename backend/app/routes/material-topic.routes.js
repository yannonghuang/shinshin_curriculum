const { authJwt } = require("../middleware");
const topics = require("../controllers/material-topic.controller.js");
const links = require("../controllers/material-link.controller.js");

module.exports = function (app) {
  app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Headers", "x-access-token, Origin, Content-Type, Accept");
    next();
  });

  // Every read below (here and in material-folder/material-artifact.routes.js)
  // is public -- 学习资源库 is browsable without login, like 课程案例库;
  // writes stay admin-only.
  app.get("/api/material-topics", topics.findAll);
  app.post("/api/material-topics", [authJwt.verifyToken, authJwt.isAdmin], topics.create);
  // Registered before the :id routes below -- Express matches path segments
  // literally before params, but "search"/"" ​would otherwise be swallowed by
  // :id if this came after (it wouldn't crash, just 404 as an invalid id --
  // still wrong, so kept first for clarity as much as correctness).
  app.get("/api/material-topics/search", topics.search);
  // Also registered before the :id routes below, same reason -- "category"
  // would otherwise be parsed as an :id. Backs the tree's first-level
  // folder rename/delete (see materials-library.component.js).
  app.put("/api/material-topics/category", [authJwt.verifyToken, authJwt.isAdmin], topics.renameCategory);
  app.delete("/api/material-topics/category", [authJwt.verifyToken, authJwt.isAdmin], topics.deleteCategory);
  app.get("/api/material-topics/:id", topics.findOne);
  app.put("/api/material-topics/:id", [authJwt.verifyToken, authJwt.isAdmin], topics.update);
  app.delete("/api/material-topics/:id", [authJwt.verifyToken, authJwt.isAdmin], topics.delete);
  app.get("/api/material-topics/:id/skill", topics.getSkill);
  app.put("/api/material-topics/:id/skill", [authJwt.verifyToken, authJwt.isAdmin], topics.updateSkill);
  app.get("/api/material-topics/:id/skill/generating", topics.getSkillGenerating);
  app.post("/api/material-topics/:id/skill/regenerate", [authJwt.verifyToken, authJwt.isAdmin], topics.forceRegenerateSkill);
  // 资料索引 is the exception to the public reads above: an admin diagnostic
  // view (unredacted file names included), so admin-only like its rebuild.
  app.get("/api/material-topics/:id/knowledge-tree", [authJwt.verifyToken, authJwt.isAdmin], topics.getKnowledgeTree);
  app.get("/api/material-topics/:id/knowledge-tree/chunks", [authJwt.verifyToken, authJwt.isAdmin], topics.getKnowledgeChunks);
  app.post("/api/material-topics/:id/knowledge-tree/rebuild", [authJwt.verifyToken, authJwt.isAdmin], topics.rebuildKnowledgeTree);

  app.get("/api/material-topics/:topicId/links", links.findByTopic);
  app.post("/api/material-topics/:topicId/links", [authJwt.verifyToken, authJwt.isAdmin], links.create);
  app.put("/api/material-links/:id", [authJwt.verifyToken, authJwt.isAdmin], links.update);
  app.delete("/api/material-links/:id", [authJwt.verifyToken, authJwt.isAdmin], links.delete);
};
