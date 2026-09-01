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

isAdmin = async (req, res, next) => {
  try {
    if (await hasRole(req, "admin")) {
      return next();
    }
    return res.status(403).send({ message: "Require Admin Role!" });
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
    if (await hasAnyRole(req, ["teacher", "admin"])) {
      return next();
    }
    return res.status(403).send({ message: "Require Teacher or Admin Role!" });
  } catch (e) {
    return res.status(500).send({ message: e.message });
  }
};

isExpertOrAdmin = async (req, res, next) => {
  try {
    if (await hasAnyRole(req, ["expert", "admin"])) {
      return next();
    }
    return res.status(403).send({ message: "Require Expert or Admin Role!" });
  } catch (e) {
    return res.status(500).send({ message: e.message });
  }
};

// Allows a request to proceed if the caller is either an admin or acting on
// their own account (req.params.id). Sets req.isAdminActor so the controller
// can decide which fields are safe to change (e.g. only an admin may
// reassign roles or flip emailVerified via PUT /api/auth/users/:id --
// otherwise any logged-in user could PUT their own id with {roles:["admin"]}
// and self-promote).
isSelfOrAdmin = async (req, res, next) => {
  try {
    const isAdmin = await hasRole(req, "admin");
    req.isAdminActor = isAdmin;
    if (isAdmin || String(req.userId) === String(req.params.id)) {
      return next();
    }
    return res.status(403).send({ message: "Require Self or Admin!" });
  } catch (e) {
    return res.status(500).send({ message: e.message });
  }
};

hasAdminRole = async (req) => {
  if (!req.userId) return false;
  try {
    return await hasRole(req, "admin");
  } catch (e) {
    console.log(e);
    return false;
  }
};

const authJwt = {
  verifyToken: verifyToken,
  attachUserIfPresent: attachUserIfPresent,
  isAdmin: isAdmin,
  isTeacher: isTeacher,
  isExpert: isExpert,
  isTeacherOrAdmin: isTeacherOrAdmin,
  isExpertOrAdmin: isExpertOrAdmin,
  isSelfOrAdmin: isSelfOrAdmin,
  hasAdminRole: hasAdminRole,
};
module.exports = authJwt;
