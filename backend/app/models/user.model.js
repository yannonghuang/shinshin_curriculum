module.exports = (sequelize, Sequelize) => {
  const User = sequelize.define(
    "user",
    {
      id: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        autoIncrement: true,
      },
      username: {
        type: Sequelize.STRING(64),
        allowNull: false,
        unique: true,
      },
      email: {
        type: Sequelize.STRING(255),
        allowNull: false,
        unique: true,
      },
      password: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      chineseName: {
        type: Sequelize.STRING(64),
      },
      phone: {
        type: Sequelize.STRING(32),
      },
      emailVerified: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      // Not in the original plan SQL block — added to support the full auth flow
      // (signin/signout must read+update lastLogin per the late-added auth
      // requirement, mirroring shinshin's auth.controller.js exactly). See
      // schema.sql for the matching `last_login` column.
      lastLogin: {
        type: Sequelize.DATE,
      },
      // Admin user-management: a suspended account can't sign in but isn't
      // deleted. See auth.controller.js's suspend/unsuspend + signin check.
      suspended: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      // Only meaningful for 教师 -- enforced in auth.controller.js
      // (validateSchoolFields), not here; a role is a many-to-many relation,
      // not something a Sequelize column validator can see. FK to
      // schools(code) added at the DB level in
      // 20260907120000-teacher-school-enforcement.js; school name is derived
      // via the School association (see models/index.js), not stored here.
      schoolCode: {
        type: Sequelize.INTEGER,
      },
    },
    {
      tableName: "users",
      freezeTableName: true,
    }
  );

  return User;
};
