// One-off: prints the exact JSON shape auth.controller.js#signin returns
// (id/username/chineseName/email/roles/accessToken/...) for an EXISTING
// user id, without touching that user's password at all -- used by
// captureManualScreenshots.js to log Playwright in as a real account for
// teacher-manual screenshots (see that script's own header) by injecting
// this straight into localStorage, the same shape AuthService.getCurrentUser()
// already expects, rather than driving the real login form (which would
// need a password we deliberately never ask for or store).
//
// Local/dev-only: run inside the backend container, where the real
// JWT_SECRET env var this signs against actually lives.
//   docker compose exec backend node scripts/mintDevToken.js <userId>
const jwt = require("jsonwebtoken");
const config = require("../app/config/auth.config.js");
const db = require("../app/models");

const userId = Number(process.argv[2]);
if (!Number.isInteger(userId) || userId <= 0) {
  console.error("Usage: node scripts/mintDevToken.js <userId>");
  process.exit(1);
}

(async () => {
  const user = await db.user.findByPk(userId);
  if (!user) {
    console.error(`No user with id=${userId}`);
    process.exit(1);
  }
  const roles = await user.getRoles();
  const accessToken = jwt.sign({ id: user.id }, config.secret, { expiresIn: config.validity });

  process.stdout.write(
    JSON.stringify({
      id: user.id,
      username: user.username,
      chineseName: user.chineseName,
      email: user.email,
      lastLogin: "",
      roles: roles.map((r) => "ROLE_" + r.name.toUpperCase()),
      accessToken,
      thisLogin: Math.floor(Date.now() / 1000),
      validity: config.validity,
    })
  );
  await db.sequelize.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
