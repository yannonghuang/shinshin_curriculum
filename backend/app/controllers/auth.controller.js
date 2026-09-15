const db = require("../models");
const config = require("../config/auth.config");
const User = db.user;
const Role = db.role;
const ROLES = db.ROLES;
const Op = db.Sequelize.Op;

var jwt = require("jsonwebtoken");
var bcrypt = require("bcryptjs");

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
      // Reconciles a *previous* session that ended via inactivity timeout
      // rather than an explicit sign-out -- signout() below always advances
      // lastLogin past whatever lastActivityAt it leaves behind, so this
      // only ever fires for the inactivity-timeout case (lastActivityAt from
      // authJwt.js's renewals still sitting after the old lastLogin).
      if (user.lastActivityAt && lastLastLogin && user.lastActivityAt > lastLastLogin) {
        const elapsedSeconds = Math.max(0, Math.round((user.lastActivityAt.getTime() - lastLastLogin.getTime()) / 1000));
        signinUpdates.totalLoginTime = user.totalLoginTime + elapsedSeconds;
        signinUpdates.lastActivityAt = null;
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
      // inactivity timeout instead). lastActivityAt is cleared so signin
      // doesn't also try to reconcile this same, already-credited session.
      const signoutUpdates = { lastLogin: db.sequelize.literal("CURRENT_TIMESTAMP"), lastActivityAt: null };
      if (user.lastLogin) {
        const elapsedSeconds = Math.max(0, Math.round((Date.now() - user.lastLogin.getTime()) / 1000));
        signoutUpdates.totalLoginTime = user.totalLoginTime + elapsedSeconds;
      }
      user.update(signoutUpdates);
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
// sortBy=lastLogin/totalLoginTime order by those columns directly. Anything
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
  return [["id", "DESC"]];
};

exports.findAll = async (req, res) => {
  try {
    const { page, size, keyword, role, suspended, schoolCode, sortBy, sortOrder } = req.query;
    const { limit, offset } = getPagination(page, size);

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
      ],
    };

    const data = await User.findAndCountAll({
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
      distinct: true,
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
        "totalLoginTime",
        "createdAt",
      ],
      limit,
      offset,
      order: buildUsersOrder(sortBy, sortOrder),
    });

    // schoolName is no longer a real column (dropped in
    // 20260907120000-teacher-school-enforcement.js) -- derive it from the
    // School include so the response shape stays unchanged for callers.
    data.rows = data.rows.map((row) => {
      const plain = row.get({ plain: true });
      plain.schoolName = plain.School ? plain.School.name : null;
      delete plain.School;
      return plain;
    });

    res.send(getPagingData(data, page, limit));
  } catch (err) {
    res.status(500).send({ message: err.message || "查询用户列表时发生错误。" });
  }
};
