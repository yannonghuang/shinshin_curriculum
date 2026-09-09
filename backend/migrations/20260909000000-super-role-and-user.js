"use strict";

// Adds the "super" role and a pre-seeded super/super account, for existing
// deployments that already ran schema.sql before "super" was added there
// (see schema.sql's own INSERT INTO roles / users for the fresh-install
// equivalent of this). "super" carries every privilege "admin" does, plus
// exclusive ownership of user management -- see authJwt.js's isAdmin/isSuper
// split. Password hash below is bcrypt.hashSync('super', 8) from this app's
// own bcryptjs -- change this password immediately after first login in any
// real deployment.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(
      `INSERT INTO roles (name) SELECT 'super' WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'super')`
    );

    await queryInterface.sequelize.query(
      `INSERT INTO users (username, email, password, chinese_name, email_verified)
       SELECT 'super', 'super@example.com', '$2a$08$mE3NRd9QeCfauhXRUSWA0ur5ilUNu9PdGD/e7Uqpn/Ho4pUQahxjy', '超级管理员', 1
       WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = 'super')`
    );

    await queryInterface.sequelize.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT u.id, r.id FROM users u, roles r
       WHERE u.username = 'super' AND r.name = 'super'
         AND NOT EXISTS (
           SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_id = r.id
         )`
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DELETE FROM users WHERE username = 'super'`);
    await queryInterface.sequelize.query(`DELETE FROM roles WHERE name = 'super'`);
  },
};
