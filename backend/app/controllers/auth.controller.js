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

exports.signup = (req, res) => {
  User.create({
    username: req.body.username,
    email: req.body.email,
    password: bcrypt.hashSync(req.body.password, 8),
    chineseName: req.body.chineseName,
    phone: req.body.phone,
    emailVerified: false,
  })
    .then((user) => {
      if (req.body.roles) {
        Role.findAll({
          where: {
            name: {
              [Op.or]: req.body.roles,
            },
          },
        }).then((roles) => {
          user.setRoles(roles).then(() => {
            res.send({ message: "User was registered successfully!" });
          });
        });
      } else {
        // default role = teacher
        Role.findOne({ where: { name: "teacher" } }).then((role) => {
          user.setRoles(role ? [role] : []).then(() => {
            res.send({ message: "User was registered successfully!" });
          });
        });
      }
    })
    .catch((err) => {
      res.status(500).send({ message: "创建用户异常，密码是必填项。。。" + err.message });
    });
};

// Admin-only user creation (POST /api/auth/admin/users, authJwt.isAdmin-gated).
// Unlike public signup, this can assign any role including "admin" and skips
// the email-verification requirement entirely -- the creating admin is
// vouching for the account, so it's marked emailVerified immediately.
exports.adminCreateUser = (req, res) => {
  User.create({
    username: req.body.username,
    email: req.body.email,
    password: bcrypt.hashSync(req.body.password, 8),
    chineseName: req.body.chineseName,
    phone: req.body.phone,
    emailVerified: true,
  })
    .then((user) => {
      const roleNames = req.body.roles && req.body.roles.length ? req.body.roles : ["teacher"];
      Role.findAll({
        where: {
          name: {
            [Op.or]: roleNames,
          },
        },
      }).then((roles) => {
        user.setRoles(roles).then(() => {
          res.send({ message: "User was created successfully!" });
        });
      });
    })
    .catch((err) => {
      res.status(500).send({ message: "创建用户异常，密码是必填项。。。" + err.message });
    });
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

      if (!user.emailVerified) {
        return res.status(401).send({
          notEmailVerified: true,
          accessToken: null,
          username: user.username,
          chineseName: user.chineseName,
          email: user.email,
          message: "email not verified!!!",
        });
      }

      var token = jwt.sign({ id: user.id }, config.secret, {
        expiresIn: config.validity, // 86400 24 hours
      });

      const lastLastLogin = user.lastLogin;
      user.update({
        lastLogin: db.sequelize.literal("CURRENT_TIMESTAMP"),
      });

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
      user.update({
        lastLogin: db.sequelize.literal("CURRENT_TIMESTAMP"),
      });
      res.send({ message: "Signed out successfully." });
    })
    .catch((err) => {
      res.status(500).send({ message: err.message });
    });
};

// Dual-purpose: sets a new password via an emailed reset link, and also
// marks the email verified (mirrors shinshin's auth.controller.js exactly).
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
          emailVerified: 1,
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
      [db.Sequelize.fn("date_format", db.Sequelize.col("users.created_at"), "%Y-%m-%d"), "createdAt"],
      [db.Sequelize.fn("date_format", db.Sequelize.col("last_login"), "%Y-%m-%d %H:%i:%s"), "lastLogin"],
    ],
    include: [
      {
        model: Role,
        attributes: ["name"],
        through: { attributes: [] },
        required: false,
      },
    ],
  })
    .then((data) => {
      if (data) {
        res.send(data);
      } else {
        res.status(404).send({ message: `Cannot find user with id=${id}.` });
      }
    })
    .catch((err) => {
      res.status(500).send({ message: "Error retrieving user with id=" + id });
    });
};

// Update a user profile (PUT /api/auth/users/:id, authJwt.isSelfOrAdmin-gated).
// isAdminActor (set by isSelfOrAdmin) gates which fields are writable: a
// self-update can only touch its own basic profile fields; only an admin may
// reassign roles or flip emailVerified -- without this split, any logged-in
// user could PUT their own id with {roles:["admin"]} and self-promote.
exports.update = async (req, res) => {
  const id = req.params.id;
  const isAdminActor = !!req.isAdminActor;

  try {
    const { password, roles, ...otherParameters } = req.body;
    const allowed = ["username", "email", "chineseName", "phone"];
    if (isAdminActor) allowed.push("emailVerified");

    const updateParams = {};
    for (const key of allowed) {
      if (otherParameters[key] !== undefined) updateParams[key] = otherParameters[key];
    }
    if (password && password.length >= 6) {
      updateParams.password = bcrypt.hashSync(password, 8);
    }

    if (Object.keys(updateParams).length > 0) {
      await User.update(updateParams, { where: { id } });
    }

    const user = await User.findByPk(id);
    if (!user) {
      return res.send({
        message: `Cannot update User with id=${id}. Maybe User was not found or req.body is empty!`,
      });
    }

    if (roles && isAdminActor) {
      const foundRoles = await Role.findAll({ where: { name: { [Op.or]: roles } } });
      await user.setRoles(foundRoles);
      return res.send({ message: "User and roles were updated successfully!" });
    }

    res.send({ message: "User was updated successfully." });
  } catch (err) {
    res.status(500).send({ message: "Error updating User with id=" + id });
  }
};

// Delete a user (DELETE /api/auth/users/:id, authJwt.isAdmin-gated).
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

// Suspend / unsuspend a user (PUT /api/auth/users/:id/suspend|unsuspend, authJwt.isAdmin-gated).
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

// List/search users (GET /api/auth/users, authJwt.isAdmin-gated).
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

exports.findAll = async (req, res) => {
  try {
    const { page, size, keyword, role, suspended } = req.query;
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
      ],
      distinct: true,
      attributes: ["id", "username", "email", "chineseName", "phone", "emailVerified", "suspended", "lastLogin", "createdAt"],
      limit,
      offset,
      order: [["id", "DESC"]],
    });

    res.send(getPagingData(data, page, limit));
  } catch (err) {
    res.status(500).send({ message: err.message || "查询用户列表时发生错误。" });
  }
};
