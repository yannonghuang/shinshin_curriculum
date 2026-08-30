const db = require("../models");
const ROLES2 = db.ROLES2;
const User = db.user;

checkDuplicateUsernameOrEmail = (req, res, next) => {
  // Username
  User.findOne({
    where: {
      username: req.body.username,
    },
  }).then((user) => {
    if (user) {
      res.status(400).send({
        message: "错误! 用户名已经被使用!",
      });
      return;
    }

    // Email
    User.findOne({
      where: {
        email: req.body.email,
      },
    }).then((user) => {
      if (user) {
        res.status(400).send({
          message: "错误! 邮件地址已经被使用!",
        });
        return;
      }

      next();
    });
  });
};

checkRolesExisted = (req, res, next) => {
  if (req.body.roles) {
    for (let i = 0; i < req.body.roles.length; i++) {
      if (!ROLES2.includes(req.body.roles[i])) {
        res.status(400).send({
          message: "Failed! Role does not exist = " + req.body.roles[i],
        });
        return;
      }
    }
  }

  next();
};

// Public signup (POST /api/auth/signup) must never be able to mint an admin
// account — only an existing admin can create another admin, via the
// separate authJwt.isAdmin-gated POST /api/auth/admin/users endpoint.
checkNotAdminRole = (req, res, next) => {
  if (req.body.roles && req.body.roles.includes("admin")) {
    return res.status(403).send({
      message: "不能通过注册创建管理员账号，请联系现有管理员。",
    });
  }
  next();
};

const verifySignUp = {
  checkDuplicateUsernameOrEmail: checkDuplicateUsernameOrEmail,
  checkRolesExisted: checkRolesExisted,
  checkNotAdminRole: checkNotAdminRole,
};

module.exports = verifySignUp;
