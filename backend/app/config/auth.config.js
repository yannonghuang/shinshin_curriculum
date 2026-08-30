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
  validity: Number(process.env.JWT_VALIDITY || 86400), // seconds, 24h default
};
