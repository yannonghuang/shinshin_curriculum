const jwt = require("jsonwebtoken");
const config = require("../config/auth.config.js");
const db = require("../models");
const User = db.user;

// Throttles the lastActivityAt DB write (see below) to at most once per user
// per this many seconds -- reissuing a fresh token on literally every single
// request is cheap (pure jwt.sign, no DB), but writing to the users table
// that often isn't worth it: this app is a single Node process (no
// clustering, see docker-compose.prod.yml), so a plain in-memory Map is safe
// here and needs no external store. Losing this cache on a restart just
// means the next request per user writes again -- not a correctness issue,
// only ever adds writes, never skips one that matters (1800s/60s = comfortably
// within the 30-minute inactivity window either way).
const ACTIVITY_PERSIST_THROTTLE_MS = 60 * 1000;
const lastPersistedActivity = new Map();

// Sliding inactivity expiry: reissues a token with a fresh expiry for
// whoever's making an authenticated (or optionally-authenticated, via
// attachUserIfPresent below) request, rather than leaving the original
// token's own fixed exp in place -- so a session only actually times out
// after config.validity seconds with *no* request at all, active browsing
// of a soft-auth route like GET /api/plans included. See auth.config.js's
// own comment. Exposed via a response header (needs cors's exposedHeaders,
// see server.js) since a response body here is whatever the route handler
// sends, not something this middleware controls. lastActivityAt writes are
// throttled per-user (see ACTIVITY_PERSIST_THROTTLE_MS above) since this is
// a single Node process (no clustering, see docker-compose.prod.yml) -- a
// plain in-memory Map is safe and needs no external store; losing it on a
// restart just means the next request per user writes again.
const renewAndTrackActivity = (userId, res) => {
  const renewedToken = jwt.sign({ id: userId }, config.secret, { expiresIn: config.validity });
  res.set("x-access-token", renewedToken);

  const now = Date.now();
  const lastPersisted = lastPersistedActivity.get(userId) || 0;
  if (now - lastPersisted >= ACTIVITY_PERSIST_THROTTLE_MS) {
    lastPersistedActivity.set(userId, now);
    // Fire-and-forget: a missed write here just means totalLoginTime
    // reconciliation (see auth.controller.js's signin/signout) is off by up
    // to one throttle window for this session -- not worth blocking the
    // request on.
    User.update({ lastActivityAt: new Date(now) }, { where: { id: userId } }).catch((e) => {
      console.error("Failed to persist lastActivityAt for user", userId, e.message);
    });
  }
};

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
    renewAndTrackActivity(decoded.id, res);
    next();
  });
};

// Soft auth for endpoints that must stay publicly readable (e.g. GET /api/plans,
// used unauthenticated by the public 优秀案例展示 gallery) but still need to know
// who's asking when a token IS present (e.g. to resolve ?mine=true to the caller's
// own id server-side, rather than trusting a client-supplied teacherId). Unlike
// verifyToken, a missing or invalid token is not an error -- req.userId is just left
// unset and the route decides what that means, so the request still succeeds (as an
// anonymous view) rather than 401ing.
attachUserIfPresent = (req, res, next) => {
  const token = req.headers["x-access-token"];
  if (!token) return next();

  jwt.verify(token, config.secret, (err, decoded) => {
    if (!err) {
      req.userId = decoded.id;
      renewAndTrackActivity(decoded.id, res);
    } else {
      // The request itself still succeeds (see above), but the caller's
      // cached "logged in" session is stale/expired -- unlike verifyToken's
      // outright 401 (which the frontend's response-error interceptor
      // already catches, see token-renewal-interceptor.js), a soft-auth
      // route never fails, so there's no error for that interceptor to see.
      // This header is the equivalent signal on the success path: read by
      // that same interceptor to clear the stale session and redirect to
      // /login, even though this particular request "worked".
      res.set("x-session-expired", "1");
    }
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
// for "super" and no longer granted to plain "admin" accounts; so is the
// combined AI 打分加点评 batch (ai-review.routes.js).
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
