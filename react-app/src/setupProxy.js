// Loaded automatically by react-scripts' dev server (CRA convention).
// Replaces the old static "proxy" field in package.json so the target can be
// the "backend" service name inside Docker Compose, while still defaulting
// to localhost for running `npm start` directly on the host.
const { createProxyMiddleware } = require("http-proxy-middleware");

module.exports = function (app) {
  app.use(
    "/api",
    createProxyMiddleware({
      target: process.env.API_PROXY_TARGET || "http://localhost:8080",
      changeOrigin: true,
    })
  );
};
