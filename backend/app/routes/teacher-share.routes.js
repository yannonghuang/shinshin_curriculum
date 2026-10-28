const { authJwt } = require("../middleware");
const topics = require("../controllers/share-topic.controller.js");
const shares = require("../controllers/share.controller.js");
const files = require("../controllers/share-file.controller.js");

// 教师分享 -- teachers share their views (with files) on admin-defined 话题.
// Every logged-in user reads; changes to a share are author-or-admin,
// checked in the handlers.
module.exports = function (app) {
  app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Headers", "x-access-token, Origin, Content-Type, Accept");
    next();
  });

  // 教师分享话题列表（含每个话题下的分享数 shareCount）。
  app.get("/api/share-topics", [authJwt.verifyToken], topics.findAll);
  // 新建教师分享话题（管理员）。body: title, description。
  app.post("/api/share-topics", [authJwt.verifyToken, authJwt.isAdmin], topics.create);
  // 修改教师分享话题（管理员；话题下已有分享时不可修改）。body: title, description。
  app.put("/api/share-topics/:id", [authJwt.verifyToken, authJwt.isAdmin], topics.update);
  // 删除教师分享话题（管理员；话题下已有分享时不可删除）。
  app.delete("/api/share-topics/:id", [authJwt.verifyToken, authJwt.isAdmin], topics.delete);

  // 教师分享列表，可按话题 topicId 或作者 authorId 过滤。
  app.get("/api/shares", [authJwt.verifyToken], shares.findAll);
  // 新建教师分享（教师或管理员）。教师发布时作者为本人；管理员上传时须用 authorId 指定作者教师。
  // body: shareTopicId, title, summary, relatedPlanId（可选）, authorId（仅管理员）。
  app.post("/api/shares", [authJwt.verifyToken, authJwt.isTeacherOrAdmin], shares.create);
  // 可选作分享作者的教师列表（管理员），可按 keyword 搜索姓名或用户名。
  // Before /api/shares/:id, which would otherwise take "teachers" as an id.
  app.get("/api/shares/teachers", [authJwt.verifyToken, authJwt.isAdmin], shares.findTeachers);
  // 查看一条教师分享。
  app.get("/api/shares/:id", [authJwt.verifyToken], shares.findOne);
  // 修改教师分享（仅作者或管理员）。body: title, summary, relatedPlanId, shareTopicId, authorId（仅管理员）。
  app.put("/api/shares/:id", [authJwt.verifyToken], shares.update);
  // 删除教师分享及其全部文件（仅作者或管理员）。需 confirmDelete=true。
  app.delete("/api/shares/:id", [authJwt.verifyToken], shares.delete);

  // 某条分享的文件夹列表。
  app.get("/api/shares/:shareId/folders", [authJwt.verifyToken], files.findFolders);
  // 在分享中新建文件夹（仅作者或管理员）。body: name, parentFolderId。
  app.post("/api/shares/:shareId/folders", [authJwt.verifyToken], files.createFolder);
  // 重命名或移动分享中的文件夹（仅作者或管理员）。body: name, parentFolderId。
  app.put("/api/share-folders/:id", [authJwt.verifyToken], files.updateFolder);
  // 删除分享中的文件夹及其内容（仅作者或管理员）。需 confirmDelete=true。
  app.delete("/api/share-folders/:id", [authJwt.verifyToken], files.deleteFolder);

  // 某条分享的文件列表。
  app.get("/api/shares/:shareId/artifacts", [authJwt.verifyToken], files.findArtifacts);
  app.post("/api/shares/:shareId/artifacts", [authJwt.verifyToken], files.createArtifact);
  app.post("/api/shares/:shareId/artifacts/download-selection", [authJwt.verifyToken], files.downloadSelection);
  // 查看分享中的一个文件的信息。
  app.get("/api/share-artifacts/:id", [authJwt.verifyToken], files.findArtifact);
  app.get("/api/share-artifacts/:id/download", files.download);
  // 修改分享中文件的说明、分类或所在文件夹（仅作者或管理员）。body: description, category, folderId。
  app.put("/api/share-artifacts/:id", [authJwt.verifyToken], files.updateArtifact);
  // 删除分享中的一个文件（仅作者或管理员）。需 confirmDelete=true。
  app.delete("/api/share-artifacts/:id", [authJwt.verifyToken], files.deleteArtifact);
};
