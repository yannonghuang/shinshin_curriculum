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

// Public signup (POST /api/auth/signup) is teacher-only — anyone wanting an
// 专家/管理员/超级管理员 account needs one created for them via the
// authJwt.isSuper-gated POST /api/auth/admin/users endpoint instead. Enforced server-side (not just
// by the frontend hiding the choice) since the frontend alone can always be
// bypassed by posting to the API directly.
checkOnlyTeacherRole = (req, res, next) => {
  const roles = req.body.roles;
  if (roles && roles.some((r) => r !== "teacher")) {
    return res.status(403).send({
      message: "自助注册仅限教师角色，专家/管理员账号请联系现有管理员创建。",
    });
  }
  next();
};

const verifySignUp = {
  checkDuplicateUsernameOrEmail: checkDuplicateUsernameOrEmail,
  checkRolesExisted: checkRolesExisted,
  checkOnlyTeacherRole: checkOnlyTeacherRole,
};

module.exports = verifySignUp;
