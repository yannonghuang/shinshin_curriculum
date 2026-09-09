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

  // Super-only: create a user with any role, including "admin"/"expert"/"super".
  // Public signup is teacher-only (see checkOnlyTeacherRole above). User
  // management is reserved for "super" -- plain "admin" no longer has it.
  app.post(
    "/api/auth/admin/users",
    [
      authJwt.verifyToken,
      authJwt.isSuper,
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

  // Super-only: list/search all users (must come before the /:id route below).
  app.get("/api/auth/users", [authJwt.verifyToken, authJwt.isSuper], controller.findAll);

  app.get("/api/auth/users/:id", [authJwt.verifyToken], controller.findOne);

  // isSelfOrSuper: a user may edit their own profile; only "super" may edit
  // someone else's (or reassign roles / flip emailVerified -- see update()).
  app.put("/api/auth/users/:id", [authJwt.verifyToken, authJwt.isSelfOrSuper], controller.update);

  // Super-only: delete another user, or suspend/unsuspend one without deleting.
  app.delete("/api/auth/users/:id", [authJwt.verifyToken, authJwt.isSuper], controller.delete);
  app.put("/api/auth/users/:id/suspend", [authJwt.verifyToken, authJwt.isSuper], controller.suspend);
  app.put("/api/auth/users/:id/unsuspend", [authJwt.verifyToken, authJwt.isSuper], controller.unsuspend);
};
