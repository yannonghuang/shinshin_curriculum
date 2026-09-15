// JWT secret is sourced from the environment (see .env / .env.example) —
// unlike shinshin's config, no secret is hardcoded here.
if (!process.env.JWT_SECRET) {
  console.warn(
    "[auth.config] JWT_SECRET is not set in the environment. " +
      "Set it in backend/.env before issuing real tokens."
  );
}

module.exports = {
  secret: process.env.JWT_SECRET || "dev-insecure-secret-change-me",
  // A token's own `exp` is this many seconds past whenever it was last
  // (re)issued -- but authJwt.js#verifyToken reissues a fresh token on every
  // authenticated request, so in practice this is a *sliding* inactivity
  // window, not a fixed session length: staying active keeps renewing it,
  // and it only actually expires after this many seconds with no request at
  // all. 900s = 15 minutes of inactivity.
  validity: Number(process.env.JWT_VALIDITY || 900),
};
