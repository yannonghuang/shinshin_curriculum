const db = require("../models");
const { createFileSpaceController } = require("../services/fileSpace");

// 项目管理 -- a cloud file repository for admins' documents: one app-wide
// file space (services/fileSpace.js single-space mode), organized however
// admins like with folders. Every route is admin/super-only
// (project.routes.js), so there's no per-row ownership check.
//
// Handlers: findFolders, createFolder, updateFolder, deleteFolder,
// findArtifacts, findArtifact, createArtifact, updateArtifact,
// deleteArtifact, download, downloadSelection.
module.exports = createFileSpaceController({
  Folder: db.projectFolder,
  Artifact: db.projectArtifact,
  uploadSubdir: "Project",
  zipPrefix: "project",
});
