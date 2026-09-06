const { authJwt } = require("../middleware");
const templates = require("../controllers/template.controller.js");

module.exports = function (app) {
  app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Headers", "x-access-token, Origin, Content-Type, Accept");
    next();
  });

  // Read access (resolving the active/a pinned version to drive a form or
  // doc) is open to any authenticated caller -- creating a plan, or
  // rendering one, needs this before the caller is necessarily known to be
  // that plan's owner yet.
  app.get("/api/templates/:templateKey/active", [authJwt.verifyToken], templates.getActive);
  app.get("/api/templates/versions/:id", [authJwt.verifyToken], templates.getVersion);
  app.get("/api/templates/:templateKey/blank-doc", [authJwt.verifyToken], templates.downloadBlank);

  // Managing templates (uploading a new version, browsing version history,
  // promoting/deleting a version, leaving a note on one) is admin-only --
  // mirrors auth.routes.js's /api/auth/admin/users gating.
  app.post("/api/admin/templates/:templateKey", [authJwt.verifyToken, authJwt.isAdmin], templates.upload);
  app.get("/api/admin/templates/:templateKey", [authJwt.verifyToken, authJwt.isAdmin], templates.list);
  app.put("/api/admin/templates/:templateKey/versions/:id/activate", [authJwt.verifyToken, authJwt.isAdmin], templates.activate);
  app.put("/api/admin/templates/:templateKey/versions/:id/note", [authJwt.verifyToken, authJwt.isAdmin], templates.updateNote);
  app.get("/api/admin/templates/:templateKey/versions/:id/download", [authJwt.verifyToken, authJwt.isAdmin], templates.download);
  app.delete("/api/admin/templates/:templateKey/versions/:id", [authJwt.verifyToken, authJwt.isAdmin], templates.remove);
};
