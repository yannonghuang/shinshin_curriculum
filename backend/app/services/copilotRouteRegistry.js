const fs = require("fs");
const path = require("path");
const { authJwt } = require("../middleware");

// The co-pilot's view of this app's REST API, discovered at runtime from the
// live Express router rather than hand-listed -- so adding, removing or
// re-guarding a route changes what 欣欣助手 can do with no edit here:
//   - which endpoints exist        <- app._router.stack (registration order,
//                                     same first-match semantics as Express)
//   - who may call each one        <- the authJwt guards in its own chain
//   - what it does / takes         <- the comment block above its app.METHOD(
//                                     call in routes/*.js, plus the req.body/
//                                     req.query/req.params names its handler
//                                     reads
// Calls run the route's own middleware chain + handler in-process (see
// invoke below), so every permission/ownership rule the REST API enforces
// applies to the co-pilot unchanged.

// Every guard this registry understands, mapped to the roles it admits
// (null = any authenticated user; the handler may still check ownership).
// A route whose chain contains any middleware NOT listed here is left out
// entirely -- fail closed, so a future guard the co-pilot doesn't know how
// to evaluate never gets silently skipped.
const GUARD_ROLES = new Map([
  [authJwt.verifyToken, null],
  [authJwt.attachUserIfPresent, null],
  [authJwt.isAdmin, ["admin", "super"]],
  [authJwt.isSuper, ["super"]],
  [authJwt.isTeacher, ["teacher"]],
  [authJwt.isExpert, ["expert"]],
  [authJwt.isTeacherOrAdmin, ["teacher", "admin", "super"]],
  [authJwt.isExpertOrAdmin, ["expert", "admin", "super"]],
  [authJwt.isSelfOrSuper, null],
]);
// Authentication-only layers: the chat request was already authenticated,
// so these are skipped on invocation (req.userId is set directly) -- they'd
// otherwise 403 for want of an x-access-token header.
const AUTHN_ONLY = new Set([authJwt.verifyToken, authJwt.attachUserIfPresent]);

// Never exposed: session/credential flows, and the chat API itself (the
// co-pilot calling its own endpoint would recurse).
const PATH_DENYLIST = [/^\/api\/auth\/(signup|signin|signout|reset|findByEmail)\b/, /^\/api\/chat\//];
// File transfer can't travel through a chat turn (multipart uploads in,
// .docx/.zip/.xlsx streams out) -- detected from the path and from the
// handler's own source.
const FILE_PATH_RE = /\/(download|export|design-doc|execution-doc|blank-doc)(\/|$)|download-selection/;
const FILE_SOURCE_RE = /res\.(download|sendFile|attachment|write)\(|\.pipe\(res|Single\(req|\.single\(|Content-Disposition/i;
// A POST whose handler runs an upload helper (multer) is a file upload --
// there's no file to send from chat. A PUT that does the same only
// *optionally* replaces a file (multer passes a non-multipart request
// straight through), so its metadata edit stays usable.
const UPLOAD_HELPER_RE = /upload\w*\(req,\s*res\)/i;

const ROUTES_DIR = path.join(__dirname, "..", "routes");
const MAX_DOC_CHARS = 400;

let attachedApp = null;
// Rebuilt whenever the router's own stack changes size, so a route
// registered (or removed) after the first lookup is still picked up.
let cachedRoutes = null;
let cachedStackSize = -1;

// Called once from server.js after every routes/*.js has registered.
const attachApp = (app) => {
  attachedApp = app;
  cachedRoutes = null;
};

// "METHOD /path" -> the comment block directly above that app.METHOD( call.
const readRouteDocs = () => {
  const docs = new Map();
  let files = [];
  try {
    files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".js"));
  } catch (e) {
    return docs;
  }
  const callRe = /app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROUTES_DIR, file), "utf8");
    let match;
    while ((match = callRe.exec(source))) {
      const before = source.slice(0, match.index).split("\n");
      before.pop(); // the partial line the call itself starts on
      const comment = [];
      for (let i = before.length - 1; i >= 0; i -= 1) {
        const line = before[i].trim();
        if (!line.startsWith("//")) break;
        comment.unshift(line.replace(/^\/\/\s?/, ""));
      }
      const text = comment.join(" ").replace(/\s+/g, " ").trim();
      if (text) docs.set(`${match[1].toUpperCase()} ${match[2]}`, text.length > MAX_DOC_CHARS ? `${text.slice(0, MAX_DOC_CHARS)}…` : text);
    }
  }
  return docs;
};

// The request fields a handler reads, straight from its own source.
const readHandlerParams = (handler) => {
  const source = handler.toString();
  const collect = (where) => {
    const names = new Set();
    for (const m of source.matchAll(new RegExp(`req\\.${where}\\.(\\w+)`, "g"))) names.add(m[1]);
    for (const m of source.matchAll(new RegExp(`\\{([^{}]+)\\}\\s*=\\s*req\\.${where}\\b`, "g"))) {
      m[1].split(",").forEach((part) => {
        const name = part.split(/[:=]/)[0].trim();
        if (/^\w+$/.test(name)) names.add(name);
      });
    }
    return [...names];
  };
  return { body: collect("body"), query: collect("query") };
};

const intersectRoles = (a, b) => (a === null ? b : b === null ? a : a.filter((r) => b.includes(r)));

const discoverRoutes = () => {
  if (!attachedApp || !attachedApp._router) return [];
  if (cachedRoutes && cachedStackSize === attachedApp._router.stack.length) return cachedRoutes;
  const docs = readRouteDocs();
  const routes = [];
  for (const layer of attachedApp._router.stack) {
    const route = layer.route;
    if (!route || typeof route.path !== "string") continue;
    const chain = route.stack.map((l) => l.handle);
    const handler = chain[chain.length - 1];
    const middleware = chain.slice(0, -1);
    if (middleware.some((fn) => !GUARD_ROLES.has(fn))) continue; // unknown middleware -- fail closed
    if (PATH_DENYLIST.some((re) => re.test(route.path))) continue;
    if (FILE_PATH_RE.test(route.path) || FILE_SOURCE_RE.test(handler.toString())) continue;

    let roles = null;
    for (const fn of middleware) roles = intersectRoles(roles, GUARD_ROLES.get(fn));
    for (const method of Object.keys(route.methods).filter((m) => route.methods[m])) {
      const upper = method.toUpperCase();
      if (upper === "POST" && UPLOAD_HELPER_RE.test(handler.toString())) continue;
      routes.push({
        layer,
        method: upper,
        path: route.path,
        key: `${upper} ${route.path}`,
        roles, // null = any logged-in user
        requiresLogin: middleware.some((fn) => fn === authJwt.verifyToken),
        doc: docs.get(`${upper} ${route.path}`) || "",
        params: { path: (route.path.match(/:(\w+)/g) || []).map((p) => p.slice(1)), ...readHandlerParams(handler) },
        chain: chain.filter((fn) => !AUTHN_ONLY.has(fn)),
      });
    }
  }
  cachedRoutes = routes;
  cachedStackSize = attachedApp._router.stack.length;
  return routes;
};

const isAllowed = (route, roles) => route.roles === null || route.roles.some((r) => roles.includes(r));

// Endpoints this user's roles admit, in registration order.
const listRoutes = (roles) => discoverRoutes().filter((r) => isAllowed(r, roles));

const hasRoute = (key) => discoverRoutes().some((r) => r.key === key);

// Concrete method+path -> { route, params }, first match in registration
// order (so /api/plans/migrate-my-plans still wins over /api/plans/:id,
// exactly as in Express itself).
const resolve = (method, concretePath) => {
  const upper = String(method || "").toUpperCase();
  const cleanPath = String(concretePath || "").split("?")[0];
  for (const route of discoverRoutes()) {
    if (route.method !== upper) continue;
    if (!route.layer.match(cleanPath)) continue;
    return { route, params: { ...route.layer.params } };
  }
  return null;
};

const toPlain = (payload) => {
  if (payload && typeof payload.toJSON === "function") return payload.toJSON();
  if (Array.isArray(payload)) return payload.map(toPlain);
  return payload;
};

// Runs one resolved route's chain against a synthetic req/res. Resolves to
// the response body; rejects with the handler's own (Chinese, user-facing)
// message on any non-2xx, which agentLoop.js relays as an { error } result.
const invoke = async (userId, roles, method, concretePath, { query = {}, body = {} } = {}) => {
  const resolved = resolve(method, concretePath);
  if (!resolved || !isAllowed(resolved.route, roles)) {
    const err = new Error(`接口不存在或当前账号无权调用：${String(method).toUpperCase()} ${concretePath}`);
    err.status = 404;
    throw err;
  }
  const req = { userId, params: resolved.params, query: stringifyQuery(query), body: body || {}, headers: {}, method: resolved.route.method };
  let statusCode = 200;
  let payload;
  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    send(data) {
      payload = data;
      return res;
    },
    json(data) {
      payload = data;
      return res;
    },
    set() {
      return res;
    },
    header() {
      return res;
    },
    setHeader() {
      return res;
    },
  };
  for (const fn of resolved.route.chain) {
    let calledNext = false;
    await fn(req, res, () => {
      calledNext = true;
    });
    if (!calledNext) break;
  }
  if (statusCode >= 400) {
    const err = new Error((payload && payload.message) || `操作失败（${statusCode}）`);
    err.status = statusCode;
    throw err;
  }
  if (Buffer.isBuffer(payload)) throw new Error("该接口返回的是文件内容，无法在对话中使用。");
  return toPlain(payload);
};

// Query values arrive from the model as JSON (numbers/booleans); the REST
// handlers expect what Express would give them -- strings.
const stringifyQuery = (query) => {
  const out = {};
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
};

module.exports = { attachApp, listRoutes, hasRoute, resolve, invoke, isAllowed };
