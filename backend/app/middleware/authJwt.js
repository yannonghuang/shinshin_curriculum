const jwt = require("jsonwebtoken");
const config = require("../config/auth.config.js");
const db = require("../models");
const User = db.user;

verifyToken = (req, res, next) => {
  let token = req.headers["x-access-token"];

  if (!token) {
    return res.status(403).send({
      message: "No token provided!",
    });
  }

  jwt.verify(token, config.secret, (err, decoded) => {
    if (err) {
      return res.status(401).send({
        message: "Unauthorized!",
      });
    }
    req.userId = decoded.id;

    next();
  });
};

// Soft auth for endpoints that must stay publicly readable (e.g. GET /api/plans,
// used unauthenticated by the public 优秀案例展示 gallery) but still need to know
// who's asking when a token IS present (e.g. to resolve ?mine=true to the caller's
// own id server-side, rather than trusting a client-supplied teacherId). Unlike
// verifyToken, a missing or invalid token is not an error -- req.userId is just left
// unset and the route decides what that means.
attachUserIfPresent = (req, res, next) => {
  const token = req.headers["x-access-token"];
  if (!token) return next();

  jwt.verify(token, config.secret, (err, decoded) => {
    if (!err) req.userId = decoded.id;
    next();
  });
};

const hasRole = async (req, roleName) => {
  const user = await User.findByPk(req.userId);
  if (!user) return false;
  const roles = await user.getRoles();
  return roles.some((r) => r.name === roleName);
};

const hasAnyRole = async (req, roleNames) => {
  const user = await User.findByPk(req.userId);
  if (!user) return false;
  const roles = await user.getRoles();
  return roles.some((r) => roleNames.includes(r.name));
};

// "super" carries every privilege "admin" does (see isSuper below for the one
// exception -- user management, which moved to super-exclusive) -- so any
// route gated on isAdmin (materials, templates, plan suspend, etc.) accepts
// either role here rather than needing every call site updated individually.
isAdmin = async (req, res, next) => {
  try {
    if (await hasAnyRole(req, ["admin", "super"])) {
      return next();
    }
    return res.status(403).send({ message: "Require Admin Role!" });
  } catch (e) {
    return res.status(500).send({ message: e.message });
  }
};

// Super-only: user management (create/list/edit/delete/suspend) is reserved
// for "super" and no longer granted to plain "admin" accounts.
isSuper = async (req, res, next) => {
  try {
    if (await hasRole(req, "super")) {
      return next();
    }
    return res.status(403).send({ message: "Require Super Role!" });
  } catch (e) {
    return res.status(500).send({ message: e.message });
  }
};

isTeacher = async (req, res, next) => {
  try {
    if (await hasRole(req, "teacher")) {
      return next();
    }
    return res.status(403).send({ message: "Require Teacher Role!" });
  } catch (e) {
    return res.status(500).send({ message: e.message });
  }
};

isExpert = async (req, res, next) => {
  try {
    if (await hasRole(req, "expert")) {
      return next();
    }
    return res.status(403).send({ message: "Require Expert Role!" });
  } catch (e) {
    return res.status(500).send({ message: e.message });
  }
};

isTeacherOrAdmin = async (req, res, next) => {
  try {
    if (await hasAnyRole(req, ["teacher", "admin", "super"])) {
      return next();
    }
    return res.status(403).send({ message: "Require Teacher or Admin Role!" });
  } catch (e) {
    return res.status(500).send({ message: e.message });
  }
};

isExpertOrAdmin = async (req, res, next) => {
  try {
    if (await hasAnyRole(req, ["expert", "admin", "super"])) {
      return next();
    }
    return res.status(403).send({ message: "Require Expert or Admin Role!" });
  } catch (e) {
    return res.status(500).send({ message: e.message });
  }
};

// Allows a request to proceed if the caller is either "super" or acting on
// their own account (req.params.id). Sets req.isSuperActor so the controller
// can decide which fields are safe to change (e.g. only a super user may
// reassign roles or flip emailVerified via PUT /api/auth/users/:id --
// otherwise any logged-in user could PUT their own id with {roles:["super"]}
// and self-promote). Deliberately excludes plain "admin" -- user management
// is super-exclusive.
isSelfOrSuper = async (req, res, next) => {
  try {
    const isSuperActor = await hasRole(req, "super");
    req.isSuperActor = isSuperActor;
    if (isSuperActor || String(req.userId) === String(req.params.id)) {
      return next();
    }
    return res.status(403).send({ message: "Require Self or Super!" });
  } catch (e) {
    return res.status(500).send({ message: e.message });
  }
};

hasAdminRole = async (req) => {
  if (!req.userId) return false;
  try {
    return await hasAnyRole(req, ["admin", "super"]);
  } catch (e) {
    console.log(e);
    return false;
  }
};

const authJwt = {
  verifyToken: verifyToken,
  attachUserIfPresent: attachUserIfPresent,
  isAdmin: isAdmin,
  isSuper: isSuper,
  isTeacher: isTeacher,
  isExpert: isExpert,
  isTeacherOrAdmin: isTeacherOrAdmin,
  isExpertOrAdmin: isExpertOrAdmin,
  isSelfOrSuper: isSelfOrSuper,
  hasAdminRole: hasAdminRole,
};
module.exports = authJwt;
