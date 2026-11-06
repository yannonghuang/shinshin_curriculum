const db = require("../models");
const { loadEditableShare } = require("../services/teacherShare");
const { createFileSpaceController } = require("../services/fileSpace");

// A share's folders and files -- the endpoints lesson-file-manager.component.js
// drives, built by services/fileSpace.js, scoped by shareId. Reads are open
// to every logged-in user; every change requires the share's author or an
// admin (loadEditableShare). Unlike 学习资源库, nothing here feeds the
// knowledge base.
const files = createFileSpaceController({
  Folder: db.shareFolder,
  Artifact: db.shareArtifact,
  Owner: db.share,
  ownerKey: "shareId",
  ownerParam: "shareId",
  label: "分享",
  uploadSubdir: "Share",
  zipPrefix: "share",
  loadEditableOwner: async (req, shareId) => {
    const { share, status, message } = await loadEditableShare(req, shareId);
    return share ? { owner: share } : { status, message };
  },
});

module.exports = files;
