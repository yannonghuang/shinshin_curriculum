const { authJwt } = require("../middleware");
const files = require("../controllers/project.controller.js");

// 项目管理 -- one app-wide cloud file repository for admins' documents.
// Every route, reads and downloads included, is admin/super-only: unlike
// 学习资源库 or 教师分享, the download route is NOT public, so the frontend
// fetches files (thumbnails too) through the authenticated API.
module.exports = function (app) {
  app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Headers", "x-access-token, Origin, Content-Type, Accept");
    next();
  });

  const adminOnly = [authJwt.verifyToken, authJwt.isAdmin];

  // 项目管理的文件夹列表（管理员）。
  app.get("/api/project-folders", adminOnly, files.findFolders);
  // 在项目管理中新建文件夹（管理员）。body: name, parentFolderId。
  app.post("/api/project-folders", adminOnly, files.createFolder);
  // 重命名或移动项目管理中的文件夹（管理员）。body: name, parentFolderId。
  app.put("/api/project-folders/:id", adminOnly, files.updateFolder);
  // 删除项目管理中的文件夹及其内容（管理员）。需 confirmDelete=true。
  app.delete("/api/project-folders/:id", adminOnly, files.deleteFolder);

  // 项目管理的文件列表（管理员）。
  app.get("/api/project-artifacts", adminOnly, files.findArtifacts);
  app.post("/api/project-artifacts", adminOnly, files.createArtifact);
  app.post("/api/project-artifacts/download-selection", adminOnly, files.downloadSelection);
  // 查看项目管理中一个文件的信息（管理员）。
  app.get("/api/project-artifacts/:id", adminOnly, files.findArtifact);
  app.get("/api/project-artifacts/:id/download", adminOnly, files.download);
  // 修改项目管理中文件的说明、分类或所在文件夹（管理员）。body: description, category, folderId。
  app.put("/api/project-artifacts/:id", adminOnly, files.updateArtifact);
  // 删除项目管理中的一个文件（管理员）。需 confirmDelete=true。
  app.delete("/api/project-artifacts/:id", adminOnly, files.deleteArtifact);
};
