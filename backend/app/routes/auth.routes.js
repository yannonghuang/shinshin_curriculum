const { verifySignUp, authJwt } = require("../middleware");
const controller = require("../controllers/auth.controller");

module.exports = function (app) {
  app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Headers", "x-access-token, Origin, Content-Type, Accept");
    next();
  });

  app.post(
    "/api/auth/signup",
    [verifySignUp.checkDuplicateUsernameOrEmail, verifySignUp.checkRolesExisted, verifySignUp.checkOnlyTeacherRole],
    controller.signup
  );

  // Admin-only: create a user with any role, including "admin"/"expert".
  // Public signup is teacher-only (see checkOnlyTeacherRole above).
  app.post(
    "/api/auth/admin/users",
    [
      authJwt.verifyToken,
      authJwt.isAdmin,
      verifySignUp.checkDuplicateUsernameOrEmail,
      verifySignUp.checkRolesExisted,
    ],
    controller.adminCreateUser
  );

  app.post("/api/auth/signin", controller.signin);

  app.post("/api/auth/signout", controller.signout);

  app.post("/api/auth/reset", controller.reset);

  app.post("/api/auth/findByEmail", controller.findByEmail);

  app.get("/api/auth/roles", controller.getRoles);

  // Admin-only: list/search all users (must come before the /:id route below).
  app.get("/api/auth/users", [authJwt.verifyToken, authJwt.isAdmin], controller.findAll);

  app.get("/api/auth/users/:id", [authJwt.verifyToken], controller.findOne);

  // isSelfOrAdmin: a user may edit their own profile; only an admin may edit
  // someone else's (or reassign roles / flip emailVerified -- see update()).
  app.put("/api/auth/users/:id", [authJwt.verifyToken, authJwt.isSelfOrAdmin], controller.update);

  // Admin-only: delete another user, or suspend/unsuspend one without deleting.
  app.delete("/api/auth/users/:id", [authJwt.verifyToken, authJwt.isAdmin], controller.delete);
  app.put("/api/auth/users/:id/suspend", [authJwt.verifyToken, authJwt.isAdmin], controller.suspend);
  app.put("/api/auth/users/:id/unsuspend", [authJwt.verifyToken, authJwt.isAdmin], controller.unsuspend);
};
