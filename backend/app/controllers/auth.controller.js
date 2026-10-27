const db = require("../models");
const config = require("../config/auth.config");
const User = db.user;
const Role = db.role;
const ROLES = db.ROLES;
const Op = db.Sequelize.Op;

var jwt = require("jsonwebtoken");
var bcrypt = require("bcryptjs");
const ExcelJS = require("exceljs");

// Session state behind the admin user list's 在线 / 退出时间 columns, from a
// user's plain fields. A session starts at lastLogin and is over once
// either (a) signout recorded a lastLogoutAt at/after it, or (b) the
// sliding inactivity window (config.validity, see authJwt.js) has lapsed
// since its last activity -- lastActivityAt, or lastLogin itself if no
// renewal was persisted yet. (b) is never written when it happens (no
// request marks a timeout), so until the next signin records it (see
// signin) its time is derived here as last activity + validity.
// findAll's online filter must express this same rule in SQL.
const sessionStatusOf = (u, now = Date.now()) => {
  const login = u.lastLogin ? new Date(u.lastLogin).getTime() : null;
  const logout = u.lastLogoutAt ? new Date(u.lastLogoutAt).getTime() : null;
  if (login == null) {
    return { online: false, logoutAt: u.lastLogoutAt || null, logoutType: logout ? u.lastLogoutType : null };
  }
  if (logout != null && logout >= login) {
    return { online: false, logoutAt: u.lastLogoutAt, logoutType: u.lastLogoutType };
  }
  const activity = u.lastActivityAt ? new Date(u.lastActivityAt).getTime() : 0;
  const expiresAt = Math.max(login, activity) + config.validity * 1000;
  if (expiresAt > now) return { online: true, logoutAt: null, logoutType: null };
  return { online: false, logoutAt: new Date(expiresAt), logoutType: "timeout" };
};

// return role list: [{name:'teacher',label:'教师'}, {name:'expert',label:'专家'}, {name:'admin',label:'管理员'}]
exports.getRoles = (req, res) => {
  res.send(ROLES);
};

// 教师 must have a non-null schoolCode (FK to the `schools` table -- see
// react-app/src/constants/school-options.js, migrated in
// 20260907120000-teacher-school-enforcement.js); non-teachers must not have
// one. roleNames is whatever the user's role set will actually be *after*
// the request: the roles being assigned (signup/admin-create/admin-update-
// with-roles), or the user's existing roles (self-update, or an admin update
// that doesn't touch roles). This is app-layer defense-in-depth -- the same
// rule is also enforced at the DB level by that migration's triggers.
const validateSchoolFields = (schoolCode, schoolName, roleNames) => {
  const isTeacher = (roleNames || []).includes("teacher");
  const hasValue =
    (schoolCode !== undefined && schoolCode !== null && schoolCode !== "") ||
    (schoolName !== undefined && schoolName !== null && schoolName !== "");
  if (hasValue && !isTeacher) {
    return "只有教师角色可以设置学校代码/学校名称。";
  }
  if (isTeacher && (schoolCode === undefined || schoolCode === null || schoolCode === "")) {
    return "教师账号必须选择所在学校。";
  }
  return null;
};

exports.signup = async (req, res) => {
  try {
    // roles not provided => defaults to a single "teacher" role (matches the
    // setRoles() fallback below), so that's also the default validated against.
    const roleNames = req.body.roles && req.body.roles.length ? req.body.roles : ["teacher"];
    const schoolError = validateSchoolFields(req.body.schoolCode, req.body.schoolName, roleNames);
    if (schoolError) {
      return res.status(422).send({ message: schoolError });
    }

    const user = await User.create({
      username: req.body.username,
      email: req.body.email,
      password: bcrypt.hashSync(req.body.password, 8),
      chineseName: req.body.chineseName,
      phone: req.body.phone,
      schoolCode: req.body.schoolCode || null,
      // Self-signup no longer requires clicking an emailed verification link
      // -- accounts are usable immediately (see exports.signin below, which
      // no longer gates on this flag either).
      emailVerified: true,
    });

    if (req.body.roles) {
      const roles = await Role.findAll({ where: { name: { [Op.or]: req.body.roles } } });
      await user.setRoles(roles);
    } else {
      const role = await Role.findOne({ where: { name: "teacher" } });
      await user.setRoles(role ? [role] : []);
    }
    res.send({ message: "User was registered successfully!" });
  } catch (err) {
    res.status(500).send({ message: "创建用户异常，密码是必填项。。。" + err.message });
  }
};

// Super-only user creation (POST /api/auth/admin/users, authJwt.isSuper-gated).
// Unlike public signup, this can assign any role including "admin"/"super" and skips
// the email-verification requirement entirely -- the creating admin is
// vouching for the account, so it's marked emailVerified immediately.
exports.adminCreateUser = async (req, res) => {
  try {
    const roleNames = req.body.roles && req.body.roles.length ? req.body.roles : ["teacher"];
    const schoolError = validateSchoolFields(req.body.schoolCode, req.body.schoolName, roleNames);
    if (schoolError) {
      return res.status(422).send({ message: schoolError });
    }

    const user = await User.create({
      username: req.body.username,
      email: req.body.email,
      password: bcrypt.hashSync(req.body.password, 8),
      chineseName: req.body.chineseName,
      phone: req.body.phone,
      schoolCode: req.body.schoolCode || null,
      emailVerified: true,
    });

    const roles = await Role.findAll({ where: { name: { [Op.or]: roleNames } } });
    await user.setRoles(roles);
    res.send({ message: "User was created successfully!" });
  } catch (err) {
    res.status(500).send({ message: "创建用户异常，密码是必填项。。。" + err.message });
  }
};

exports.signin = (req, res) => {
  User.findOne({
    where: {
      username: req.body.username,
    },
  })
    .then((user) => {
      if (!user) {
        return res.status(404).send({ message: "User Not found." });
      }

      var passwordIsValid = bcrypt.compareSync(req.body.password, user.password);

      if (!passwordIsValid) {
        return res.status(401).send({
          accessToken: null,
          message: "Invalid Password!",
        });
      }

      if (user.suspended) {
        return res.status(403).send({
          accessToken: null,
          suspended: true,
          message: "账号已被管理员停用，请联系管理员。",
        });
      }

      var token = jwt.sign({ id: user.id }, config.secret, {
        expiresIn: config.validity, // sliding inactivity window -- see auth.config.js
      });

      const lastLastLogin = user.lastLogin;
      const signinUpdates = { lastLogin: db.sequelize.literal("CURRENT_TIMESTAMP") };
      // Reconciles a *previous* session that never got an explicit
      // sign-out -- signout() below already credited its own session and
      // stamped lastLogoutAt, so one with a lastLogoutAt at/after its
      // lastLogin is skipped (a late request on a still-valid token after
      // signout can leave lastActivityAt past lastLogin; crediting it here
      // would count that session twice).
      const signedOut = user.lastLogoutAt && lastLastLogin && user.lastLogoutAt >= lastLastLogin;
      if (!signedOut && user.lastActivityAt && lastLastLogin && user.lastActivityAt > lastLastLogin) {
        const elapsedSeconds = Math.max(0, Math.round((user.lastActivityAt.getTime() - lastLastLogin.getTime()) / 1000));
        signinUpdates.totalLoginTime = user.totalLoginTime + elapsedSeconds;
        signinUpdates.lastActivityAt = null;
      }
      // ...and records how it ended, if it timed out (one still within its
      // window -- e.g. signing in again on another device -- was just
      // superseded, not logged out, so nothing is recorded for it).
      const previous = sessionStatusOf(user);
      if (!signedOut && previous.logoutType === "timeout") {
        signinUpdates.lastLogoutAt = previous.logoutAt;
        signinUpdates.lastLogoutType = "timeout";
      }
      user.update(signinUpdates);

      var authorities = [];
      user.getRoles().then((roles) => {
        for (let i = 0; i < roles.length; i++) {
          authorities.push("ROLE_" + roles[i].name.toUpperCase());
        }
        res.status(200).send({
          id: user.id,
          username: user.username,
          chineseName: user.chineseName,
          email: user.email,
          lastLogin: lastLastLogin
            ? lastLastLogin.toLocaleDateString("zh-cn", {
                hour12: true,
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })
            : "",
          roles: authorities,
          accessToken: token,
          thisLogin: Math.floor(Date.now() / 1000),
          validity: config.validity,
        });
      });
    })
    .catch((err) => {
      res.status(500).send({ message: err.message });
    });
};

exports.signout = (req, res) => {
  User.findOne({
    where: {
      username: req.body.username,
    },
  })
    .then((user) => {
      if (!user) {
        console.log("logout: " + req.body.username);
        return res.status(404).send({ message: "User Not found." });
      }
      // Credits this session's elapsed time (since it started at
      // user.lastLogin) to totalLoginTime -- the precise, no-reconciliation-
      // needed case, since the user is explicitly ending the session right
      // now (contrast signin's reconciliation of a session that ended by
      // inactivity timeout instead). lastLogoutAt marks it ended (so signin
      // doesn't also reconcile it, and the admin list shows it offline);
      // lastLogin is left as the session's start, so 上次登录时间 stays a
      // login time rather than turning into the sign-out time.
      const signoutUpdates = {
        lastActivityAt: null,
        lastLogoutAt: db.sequelize.literal("CURRENT_TIMESTAMP"),
        lastLogoutType: "manual",
      };
      // A session that's already over -- signed out in another tab, or timed
      // out before this request -- is left alone: re-crediting it from
      // lastLogin would count it twice (or count the idle hours), and a
      // timed-out one is still recorded as such at the next signin.
      if (sessionStatusOf(user).online) {
        const elapsedSeconds = Math.max(0, Math.round((Date.now() - user.lastLogin.getTime()) / 1000));
        signoutUpdates.totalLoginTime = user.totalLoginTime + elapsedSeconds;
        user.update(signoutUpdates);
      }
      res.send({ message: "Signed out successfully." });
    })
    .catch((err) => {
      res.status(500).send({ message: err.message });
    });
};

// Sets a new password for the account whose email matches req.body.email --
// this *is* the identity check for password reset: the caller must supply
// the email already on file for the account (no separate emailed
// link/token is involved).
exports.reset = (req, res) => {
  User.findOne({
    where: {
      email: req.body.email,
    },
  })
    .then((user) => {
      if (!user) {
        return res.status(404).send({ message: "User Not found." });
      }

      user
        .update({
          password: bcrypt.hashSync(req.body.password, 8),
        })
        .then((r) => {
          res.status(200).send(user);
        })
        .catch((e) => {
          res.status(500).send({ message: e.message });
        });
    })
    .catch((err) => {
      res.status(500).send({ message: err.message });
    });
};

// Used by the frontend's email-verification-link landing flow.
exports.findByEmail = (req, res) => {
  User.findOne({
    where: {
      email: req.body.email,
    },
  })
    .then((user) => {
      if (!user) {
        res.status(404).send({ message: "User Not found." });
      } else {
        if (req.body.emailVerified) {
          user.update({ emailVerified: 1 });
        }
        res.status(200).send(user);
      }
    })
    .catch((err) => {
      res.status(500).send({ message: err.message });
    });
};

// Find a single user profile (GET /api/auth/users/:id)
exports.findOne = (req, res) => {
  const id = req.params.id;

  User.findByPk(id, {
    attributes: [
      "id",
      "username",
      "email",
      "chineseName",
      "phone",
      "emailVerified",
      "schoolCode",
      // Sequelize.col("users.created_at") (a "table.column" qualifier) fails
      // with "Unknown column 'users.created_at' in 'field list'" -- doesn't
      // match the alias Sequelize actually generates for this query. Bare
      // "created_at" (matching how last_login is referenced right below,
      // unqualified) resolves correctly.
      [db.Sequelize.fn("date_format", db.Sequelize.col("created_at"), "%Y-%m-%d"), "createdAt"],
      [db.Sequelize.fn("date_format", db.Sequelize.col("last_login"), "%Y-%m-%d %H:%i:%s"), "lastLogin"],
    ],
    include: [
      {
        model: Role,
        attributes: ["name"],
        through: { attributes: [] },
        required: false,
      },
      { model: db.school, as: "School", attributes: ["code", "name"], required: false },
    ],
  })
    .then((data) => {
      if (data) {
        // schoolName is no longer a real column (dropped in
        // 20260907120000-teacher-school-enforcement.js) -- derive it from the
        // School include so the response shape stays unchanged for callers.
        const plain = data.get({ plain: true });
        plain.schoolName = plain.School ? plain.School.name : null;
        delete plain.School;
        res.send(plain);
      } else {
        res.status(404).send({ message: `Cannot find user with id=${id}.` });
      }
    })
    .catch((err) => {
      res.status(500).send({ message: "Error retrieving user with id=" + id });
    });
};

// Update a user profile (PUT /api/auth/users/:id, authJwt.isSelfOrSuper-gated).
// isSuperActor (set by isSelfOrSuper) gates which fields are writable: a
// self-update can only touch its own basic profile fields; only a "super"
// user may reassign roles or flip emailVerified -- without this split, any
// logged-in user could PUT their own id with {roles:["super"]} and self-promote.
exports.update = async (req, res) => {
  const id = req.params.id;
  const isSuperActor = !!req.isSuperActor;

  try {
    const { password, roles, ...otherParameters } = req.body;
    // schoolCode is self-editable like the other basic profile fields
    // (unlike roles/emailVerified, which stay admin-only) -- id is never in
    // this list, so it can never be altered via this endpoint. schoolName is
    // no longer a writable column (dropped in
    // 20260907120000-teacher-school-enforcement.js, derived via the School
    // association instead) -- silently ignored if a caller still sends it.
    const allowed = ["username", "email", "chineseName", "phone", "schoolCode"];
    if (isSuperActor) allowed.push("emailVerified");

    const updateParams = {};
    for (const key of allowed) {
      if (otherParameters[key] !== undefined) updateParams[key] = otherParameters[key];
    }
    if (password && password.length >= 6) {
      updateParams.password = bcrypt.hashSync(password, 8);
    }

    const user = await User.findByPk(id);
    if (!user) {
      return res.send({
        message: `Cannot update User with id=${id}. Maybe User was not found or req.body is empty!`,
      });
    }

    // Effective new role set: roles being assigned in this same request
    // (admin only), else the user's current roles unchanged.
    const nextRoleNames = roles && isSuperActor ? roles : null;
    let effectiveRoleNames = nextRoleNames;
    if (updateParams.schoolCode !== undefined) {
      if (!effectiveRoleNames) {
        const currentRoles = await user.getRoles();
        effectiveRoleNames = currentRoles.map((r) => r.name);
      }
      const schoolCodeValue = updateParams.schoolCode;
      const schoolError = validateSchoolFields(schoolCodeValue, undefined, effectiveRoleNames);
      if (schoolError) {
        return res.status(422).send({ message: schoolError });
      }
    }

    // Write order matters once the DB-level teacher/school triggers are in
    // play (see 20260907120000-teacher-school-enforcement.js): promoting to
    // (or staying) teacher while also setting schoolCode in the same request
    // must write schoolCode *before* the user_roles insert (the insert
    // trigger checks users.school_code); demoting away from teacher while
    // also clearing schoolCode must remove the user_roles row *before*
    // nulling schoolCode (the update trigger checks current role
    // membership). Requests touching only one of {roles, schoolCode} are
    // unaffected by the ordering either way.
    const applyScalarUpdate = async () => {
      if (Object.keys(updateParams).length > 0) {
        await User.update(updateParams, { where: { id } });
      }
    };
    const applyRoles = async () => {
      if (roles && isSuperActor) {
        const foundRoles = await Role.findAll({ where: { name: { [Op.or]: roles } } });
        await user.setRoles(foundRoles);
      }
    };

    const demotingAwayFromTeacher = nextRoleNames !== null && !nextRoleNames.includes("teacher");
    if (demotingAwayFromTeacher) {
      await applyRoles();
      await applyScalarUpdate();
    } else {
      await applyScalarUpdate();
      await applyRoles();
    }

    if (roles && isSuperActor) {
      return res.send({ message: "User and roles were updated successfully!" });
    }

    res.send({ message: "User was updated successfully." });
  } catch (err) {
    res.status(500).send({ message: "Error updating User with id=" + id });
  }
};

// Delete a user (DELETE /api/auth/users/:id, authJwt.isSuper-gated).
exports.delete = (req, res) => {
  const id = req.params.id;

  if (String(id) === String(req.userId)) {
    return res.status(400).send({ message: "不能删除自己的账号。" });
  }

  User.destroy({
    where: { id: id },
  })
    .then((num) => {
      if (num == 1) {
        res.send({ message: "User was deleted successfully!" });
      } else {
        res.send({ message: `Cannot delete User with id=${id}. Maybe User was not found!` });
      }
    })
    .catch((err) => {
      res.status(500).send({ message: "Could not delete User with id=" + id });
    });
};

// Suspend / unsuspend a user (PUT /api/auth/users/:id/suspend|unsuspend, authJwt.isSuper-gated).
// A suspended account can't sign in (see exports.signin) but isn't deleted.
exports.suspend = async (req, res) => {
  const id = req.params.id;
  if (String(id) === String(req.userId)) {
    return res.status(400).send({ message: "不能停用自己的账号。" });
  }
  try {
    const [num] = await User.update({ suspended: true }, { where: { id } });
    if (num === 1) res.send({ message: "用户已停用。" });
    else res.status(404).send({ message: `未找到用户 id=${id}。` });
  } catch (err) {
    res.status(500).send({ message: err.message });
  }
};

exports.unsuspend = async (req, res) => {
  const id = req.params.id;
  try {
    const [num] = await User.update({ suspended: false }, { where: { id } });
    if (num === 1) res.send({ message: "用户已恢复启用。" });
    else res.status(404).send({ message: `未找到用户 id=${id}。` });
  } catch (err) {
    res.status(500).send({ message: err.message });
  }
};

// List/search users (GET /api/auth/users, authJwt.isSuper-gated).
// Same paginated-envelope convention as plan/review/learning-material
// controllers: {totalItems, rows, totalPages, currentPage}.
const getPagination = (page, size) => {
  const limit = size ? +size : 20;
  const offset = page ? page * limit : 0;
  return { limit, offset };
};

const getPagingData = (data, page, limit) => {
  const { count: totalItems, rows } = data;
  const currentPage = page ? +page : 0;
  const totalPages = Math.ceil(totalItems / limit);
  return { totalItems, rows, totalPages, currentPage };
};

// sortBy=name orders by chineseName (the visible "姓名" column); sortBy=school
// orders by the joined School's name (not the raw numeric code, which
// wouldn't group same-named schools or read as alphabetical to an admin).
// sortBy=lastLogin/totalLoginTime/aiTokensUsed order by those columns directly;
// sortBy=createdAt (注册时间) breaks same-timestamp ties by id. Anything
// else (including unset) keeps the original newest-first order. MySQL sorts
// NULLs first in ASC / last in DESC, which is an acceptable default here (no
// explicit NULLS LAST handling) since admin/expert rows have no
// chineseName-is-always-set guarantee, non-teacher rows have no school at
// all, and a never-logged-in user has no lastLogin.
const buildUsersOrder = (sortBy, sortOrder) => {
  const direction = sortOrder === "desc" ? "DESC" : "ASC";
  if (sortBy === "name") return [["chineseName", direction]];
  if (sortBy === "school") return [[{ model: db.school, as: "School" }, "name", direction]];
  if (sortBy === "lastLogin") return [["lastLogin", direction]];
  if (sortBy === "totalLoginTime") return [["totalLoginTime", direction]];
  if (sortBy === "aiTokensUsed") return [["aiTokensUsed", direction], ["id", direction]];
  if (sortBy === "createdAt") return [["createdAt", direction], ["id", direction]];
  return [["id", "DESC"]];
};

// The list's where/include/attributes/order for the given query-string
// filters -- shared by findAll (one page) and exportUsers (every matching
// row), so a download always holds exactly what the filtered list shows.
// AI 用量 bounds arrive in 万 tokens (what the filter inputs show); blank or
// non-numeric = no bound.
const TOKENS_PER_WAN = 10000;
const tokenBound = (text) =>
  text === undefined || text === "" || Number.isNaN(Number(text)) ? null : Math.round(Number(text) * TOKENS_PER_WAN);

const usersQuery = ({ keyword, role, suspended, schoolCode, online, logoutType, aiTokensMin, aiTokensMax, sortBy, sortOrder }) => {
  // Same rule as sessionStatusOf, in SQL: a session started, not signed
  // out since, with its last activity (or login) inside the window. The
  // offline side is spelled out rather than NOT(online) -- NOT over a
  // comparison with a NULL column is NULL, which would drop e.g. a
  // never-renewed (last_activity_at NULL) session from both filters.
  const activeSince = new Date(Date.now() - config.validity * 1000);
  const col = db.sequelize.col;
  const onlineCondition = {
    [Op.and]: [
      { lastLogin: { [Op.ne]: null } },
      { [Op.or]: [{ lastLogoutAt: null }, db.sequelize.where(col("last_logout_at"), Op.lt, col("last_login"))] },
      { [Op.or]: [{ lastLogin: { [Op.gt]: activeSince } }, { lastActivityAt: { [Op.gt]: activeSince } }] },
    ],
  };
  const windowLapsed = {
    [Op.and]: [
      { lastLogin: { [Op.lte]: activeSince } },
      { [Op.or]: [{ lastActivityAt: null }, { lastActivityAt: { [Op.lte]: activeSince } }] },
    ],
  };
  const offlineCondition = {
    [Op.or]: [{ lastLogin: null }, db.sequelize.where(col("last_logout_at"), Op.gte, col("last_login")), windowLapsed],
  };
  // 退出方式 filter, matching sessionStatusOf's logoutType: a recorded
  // logout of that type (one at/after the latest login, or with no login
  // at all), plus -- for "timeout" -- a not-yet-recorded one: a session
  // never signed out whose window has lapsed.
  const recordedLogout = (type) => ({
    [Op.and]: [
      { lastLogoutType: type },
      { [Op.or]: [{ lastLogin: null }, db.sequelize.where(col("last_logout_at"), Op.gte, col("last_login"))] },
    ],
  });
  const logoutTypeConditions = {
    manual: recordedLogout("manual"),
    timeout: {
      [Op.or]: [
        recordedLogout("timeout"),
        {
          [Op.and]: [
            { lastLogin: { [Op.ne]: null } },
            { [Op.or]: [{ lastLogoutAt: null }, db.sequelize.where(col("last_logout_at"), Op.lt, col("last_login"))] },
            windowLapsed,
          ],
        },
      ],
    },
  };

  const tokensMin = tokenBound(aiTokensMin);
  const tokensMax = tokenBound(aiTokensMax);

  const condition = {
    [Op.and]: [
      keyword
        ? {
            [Op.or]: [
              { username: { [Op.like]: `%${keyword}%` } },
              { email: { [Op.like]: `%${keyword}%` } },
              { chineseName: { [Op.like]: `%${keyword}%` } },
            ],
          }
        : null,
      suspended !== undefined ? { suspended: suspended === "true" || suspended === "1" } : null,
      schoolCode !== undefined && schoolCode !== "" ? { schoolCode: Number(schoolCode) } : null,
      online === "true" ? onlineCondition : online === "false" ? offlineCondition : null,
      logoutType === "manual" || logoutType === "timeout" ? logoutTypeConditions[logoutType] : null,
      tokensMin !== null ? { aiTokensUsed: { [Op.gte]: tokensMin } } : null,
      tokensMax !== null ? { aiTokensUsed: { [Op.lte]: tokensMax } } : null,
    ],
  };

  return {
    where: condition,
    include: [
      {
        model: Role,
        attributes: ["name"],
        through: { attributes: [] },
        required: !!role,
        where: role ? { name: role } : undefined,
      },
      { model: db.school, as: "School", attributes: ["code", "name"], required: false },
    ],
    attributes: [
      "id",
      "username",
      "email",
      "chineseName",
      "phone",
      "emailVerified",
      "suspended",
      "schoolCode",
      "lastLogin",
      "lastActivityAt",
      "lastLogoutAt",
      "lastLogoutType",
      "totalLoginTime",
      "aiTokensUsed",
      "createdAt",
    ],
    order: buildUsersOrder(sortBy, sortOrder),
  };
};

// schoolName is no longer a real column (dropped in
// 20260907120000-teacher-school-enforcement.js) -- derive it from the
// School include so the response shape stays unchanged for callers.
const toUserListRow = (row) => {
  const plain = row.get({ plain: true });
  plain.schoolName = plain.School ? plain.School.name : null;
  delete plain.School;
  Object.assign(plain, sessionStatusOf(plain));
  delete plain.lastActivityAt;
  delete plain.lastLogoutAt;
  delete plain.lastLogoutType;
  return plain;
};

exports.findAll = async (req, res) => {
  try {
    const { page, size } = req.query;
    const { limit, offset } = getPagination(page, size);
    const data = await User.findAndCountAll({ ...usersQuery(req.query), distinct: true, limit, offset });
    data.rows = data.rows.map(toUserListRow);
    // exportFields: what the page's 导出字段 picker offers (see exportUsers).
    res.send({ ...getPagingData(data, page, limit), exportFields: userExportFieldOptions() });
  } catch (err) {
    res.status(500).send({ message: err.message || "查询用户列表时发生错误。" });
  }
};

const USER_ROLE_LABELS = { teacher: "教师", expert: "专家", admin: "管理员", super: "超级管理员" };
const LOGOUT_TYPE_LABELS = { manual: "主动退出", timeout: "超时退出" };
// Pinned to China time -- the server runs in UTC, but readers don't.
const dateText = (d) => (d ? new Date(d).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }) : "");
// Same wording as admin-users-list.component.js#formatDuration.
const durationText = (totalSeconds) => {
  if (!totalSeconds) return "0分钟";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return minutes > 0 ? `${hours}小时${minutes}分钟` : `${hours}小时`;
  return `${minutes}分钟`;
};

// Everything the user-list Excel export can include, in column order --
// same shape as services/dashboard.js's EXPORT_FIELDS. `defaultOn` marks the
// set pre-selected in the 导出字段 picker (the table's own columns).
const USER_EXPORT_FIELDS = [
  { key: "username", label: "用户名", width: 18, defaultOn: true, value: (u) => u.username },
  { key: "chineseName", label: "姓名", width: 12, defaultOn: true, value: (u) => u.chineseName || "" },
  { key: "email", label: "邮箱", width: 28, defaultOn: true, value: (u) => u.email || "" },
  { key: "phone", label: "电话", width: 15, value: (u) => u.phone || "" },
  {
    key: "roles",
    label: "角色",
    width: 16,
    defaultOn: true,
    value: (u) => (u.roles || []).map((r) => USER_ROLE_LABELS[r.name] || r.name).join("、"),
  },
  { key: "schoolCode", label: "学校编号", width: 10, defaultOn: true, value: (u) => (u.schoolCode != null ? u.schoolCode : "") },
  { key: "schoolName", label: "学校名称", width: 28, value: (u) => u.schoolName || "" },
  { key: "emailVerified", label: "邮箱已验证", width: 10, defaultOn: true, value: (u) => (u.emailVerified ? "是" : "否") },
  { key: "status", label: "状态", width: 8, defaultOn: true, value: (u) => (u.suspended ? "已停用" : "正常") },
  { key: "online", label: "在线", width: 8, defaultOn: true, value: (u) => (u.online ? "在线" : "离线") },
  { key: "createdAt", label: "注册时间", width: 20, defaultOn: true, value: (u) => dateText(u.createdAt) },
  {
    key: "lastLogin",
    label: "上次登录时间",
    width: 20,
    defaultOn: true,
    value: (u) => (u.lastLogin ? dateText(u.lastLogin) : "从未登录"),
  },
  { key: "logoutAt", label: "退出时间", width: 20, defaultOn: true, value: (u) => dateText(u.logoutAt) },
  { key: "logoutType", label: "退出方式", width: 10, value: (u) => LOGOUT_TYPE_LABELS[u.logoutType] || "" },
  { key: "totalLoginTime", label: "累计登录时长", width: 14, defaultOn: true, value: (u) => durationText(u.totalLoginTime) },
  // A plain number (not "12.3万") so the sheet can sum/sort it.
  { key: "aiTokensUsed", label: "AI 用量（tokens）", width: 16, defaultOn: true, value: (u) => Number(u.aiTokensUsed) || 0 },
];

const userExportFieldOptions = () =>
  USER_EXPORT_FIELDS.map(({ key, label, defaultOn }) => ({ key, label, defaultOn: !!defaultOn }));

// GET /api/auth/users/export?fields=a,b,... (super-only) -- .xlsx of every
// user matching the list's current filters, in its current sort order (no
// pagination), with the columns picked in 导出字段 (unknown keys ignored).
exports.exportUsers = async (req, res) => {
  try {
    const wanted = new Set(String(req.query.fields || "").split(","));
    const fields = USER_EXPORT_FIELDS.filter((f) => wanted.has(f.key));
    if (fields.length === 0) return res.status(422).send({ message: "请至少选择一个导出字段。" });

    const rows = (await User.findAll(usersQuery(req.query))).map(toUserListRow);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("用户");
    sheet.columns = fields.map((f) => ({ header: f.label, key: f.key, width: f.width }));
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    rows.forEach((u) => sheet.addRow(Object.fromEntries(fields.map((f) => [f.key, f.value(u)]))));
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="users.xlsx"`);
    return res.send(Buffer.from(buffer));
  } catch (err) {
    return res.status(500).send({ message: err.message || "导出用户列表时发生错误。" });
  }
};
