# 部署指南 / Deploy Guide

How to run 乡土课程项目实施与案例分享系统（AI智能体） locally (dev, hot-reload) or as a
production deployment (Docker Compose, built images). Two ways to run it either way:
**Docker Compose** (recommended — this is what's documented in depth below) or
**manual/bare-metal** (running `npm` directly on the host, covered briefly at the end).

## Prerequisites

- Docker + Docker Compose v2 (`docker compose version` — this setup uses the
  `!override` merge-control tag in `docker-compose.prod.yml`, which needs a
  reasonably recent Compose; verified working on v5.4.0).
- An EmailJS account (https://www.emailjs.com/) — required for the
  email-verification and forgot-password links to actually send. The app will
  run without one, but signup/reset emails will silently fail to send.
- A DashScope (Alibaba Cloud Model Studio) API key — required for the "请AI点评"
  (AI review) feature. Everything else works without it.

## One-time setup

1. **Root `.env`** (Docker Compose variables — DB credentials, JWT secret, DashScope key):
   ```
   cp .env.example .env
   ```
   Edit `.env` and fill in real values, at minimum:
   - `DB_ROOT_PASSWORD`, `DB_PASSWORD` — pick real passwords (the `.env.example`
     defaults are placeholders, not safe to use as-is, especially in prod).
   - `JWT_SECRET` — any long random string (e.g. `openssl rand -hex 32`).
   - `DASHSCOPE_API_KEY` — your DashScope key. Leave blank to run without AI
     review; the rest of the app is unaffected, and the AI-review endpoint
     will just return a clear "DASHSCOPE_API_KEY is not configured" error.

2. **EmailJS config** (frontend, not a Docker/compose concern — same file for
   dev and prod since it's baked into the frontend build):
   Edit `react-app/src/config/emailjs.config.js` and fill in:
   - `userId` — your EmailJS "Public Key".
   - `serviceId` — the email service you connected in the EmailJS dashboard.
   - `templateIdEmailVerification` / `templateIdPasswordReset` — two EmailJS
     templates, one for "please verify your email" links, one for "reset your
     password" links. Each template needs a `{{link}}` variable — the app
     fills it with a URL like `https://your-domain/login?token=...` (verify)
     or `https://your-domain/reset?token=...` (reset).

   If you skip this, signup/login/forgot-password still work functionally
   (accounts are created, passwords are checked) but no verification/reset
   email is ever sent, so `emailVerified` stays `0` and those users can never
   sign in (`signin` rejects unverified accounts by design — see
   `backend/app/controllers/auth.controller.js`). For a first smoke test
   without EmailJS, verify a user directly via SQL: see "Manually verifying a
   user" below.

That's it for one-time setup — `backend/.env` is a separate file only needed
if you run the backend *outside* Docker (see "Manual / non-Docker" below);
Docker Compose gets everything it needs from the root `.env` and passes it
into the `backend` container as environment variables directly.

## Dev (hot reload)

```
docker compose up --build
```

This starts three services on your machine, plus MySQL:

| Service | URL | Notes |
|---|---|---|
| `frontend` | http://localhost:3000 | CRA dev server, hot-reloads on edits to `react-app/src/**` |
| `backend` | http://localhost:8080 | `nodemon`, restarts on edits to `backend/**` |
| `db` | localhost:3306 | MySQL 8, schema auto-applied on first start (see below) |

Source is bind-mounted from your working tree into both containers, so
editing files locally takes effect without rebuilding — rebuild only when you
change `package.json` (new dependency) or a `Dockerfile*`.

Want a DB browser UI too (Adminer, at http://localhost:8081)?
```
docker compose --profile dev up --build
```
(Adminer is opt-in via the `dev` Compose profile — it never starts under the
production command below.)

Stop everything:
```
docker compose down
```
Stop and wipe all data (MySQL data, uploaded files, node_modules caches) —
useful for a truly clean slate or to force `schema.sql` to re-apply:
```
docker compose down -v
```

### First-run schema note

`db_data` starts empty on first `docker compose up`, so the official MySQL
image auto-runs `backend/schema.sql` (mounted into
`/docker-entrypoint-initdb.d/`) against the `shinshin_curriculum` database —
this creates every table **and** seeds the three roles (`admin`/`teacher`/`expert`).
This only happens once, on an empty volume. If you edit `schema.sql` later,
either:
- `docker compose down -v` (destroys all data, cleanest for dev), or
- apply the change manually: `docker compose exec db mysql -u root -p"$DB_ROOT_PASSWORD" "$DB_NAME" < backend/schema.sql` won't work for `ALTER`-style changes to existing tables — write the specific `ALTER TABLE`/`CREATE TABLE IF NOT EXISTS` statements you need and run them the same way.

The backend's own startup (`db.sequelize.sync()` in `server.js`) also runs on
every boot — it only creates tables that don't exist yet, so it's a safe
no-op once `schema.sql` has already created everything.

## Production

This section covers running the prod compose stack yourself, on any host.
For deploying to a specific cloud target (build, push to a registry, deploy
to a VM, all from your own machine), see `ALIYUN_DEPLOY.md` — it targets
Alibaba Cloud (ACR + ECS) via `scripts/deploy-aliyun.sh`, building on the
same `docker-compose.prod.yml` described here. GitHub only ever holds
source in that setup — the deploy script talks to Alibaba Cloud directly,
not GitHub Actions.

```
cp .env.example .env   # if you haven't already — use real production values this time
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
```

Differences from dev, all handled by `docker-compose.prod.yml`:
- **Backend** runs the production `Dockerfile` (`npm ci --omit=dev`, no
  `nodemon`, plain `node server.js`), no source bind-mount — the image is
  self-contained; the `backend_upload` named volume is kept so uploaded files
  survive a redeploy.
- **Frontend** is built into a static bundle and served by **nginx**
  (`react-app/Dockerfile` → `nginx.conf`), not the CRA dev server. nginx
  reverse-proxies `/api/*` to the `backend` container internally, so the
  frontend still only ever talks to a relative `/api` URL — same as dev.
  Exposed on **port 80** (map it behind a real TLS-terminating reverse proxy
  or load balancer for HTTPS in an actual production deployment — this compose
  file does not set up TLS itself).
- **MySQL** is not exposed to the host at all in prod (no `3306` port
  mapping) — only reachable from `backend` over the internal Compose network.
- Adminer never starts (it's dev-profile-only).

Useful commands:
```
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f backend
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
docker compose -f docker-compose.yml -f docker-compose.prod.yml down        # stop, keep volumes
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d   # redeploy after a code change
```

## Smoke-testing a deployment

```
# Backend reachable and DB connected:
curl -s http://localhost:8080/api/auth/roles
# -> [{"name":"admin",...},{"name":"teacher",...},{"name":"expert",...}]

# Frontend reachable:
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/    # dev
curl -s -o /dev/null -w '%{http_code}\n' http://localhost/         # prod
```

Then in a browser: register a teacher account, verify it (via the EmailJS
link, or manually — see below), sign in, create a 乡土课程计划, fill it in
online, upload a lesson artifact, and (with `DASHSCOPE_API_KEY` set) click
"请AI点评" to confirm the DashScope/Qwen3.8-Max round trip works end to end.

### Manually verifying a user (no EmailJS configured yet)

```
docker compose exec db mysql -u root -p"$DB_ROOT_PASSWORD" "$DB_NAME" \
  -e "UPDATE users SET email_verified = 1 WHERE username = 'YOUR_USERNAME';"
```

## Manual / non-Docker (running directly on the host)

Useful for quick backend-only iteration without rebuilding containers.

```
# MySQL: point it at any MySQL 8 instance you already have running, then:
mysql -u root -p -e "CREATE DATABASE shinshin_curriculum CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
mysql -u root -p shinshin_curriculum < backend/schema.sql

# Backend
cd backend
cp .env.example .env   # fill in DB_HOST=localhost, JWT_SECRET, DASHSCOPE_API_KEY, etc.
npm install
npm run dev             # nodemon, hot-restarts on save

# Frontend (separate terminal)
cd react-app
npm install
API_PROXY_TARGET=http://localhost:8080 npm start
```

`backend/.env` (via `dotenv`) is only read in this mode — Docker Compose
never uses it, since compose passes the same variables in directly as
container environment variables (see `docker-compose.yml`'s `backend.environment` block).

## Troubleshooting

- **AI review returns "DASHSCOPE_API_KEY is not configured"** — expected if
  you left it blank; set it in `.env` and `docker compose up --build -d`
  (recreates the `backend` container with the new env var).
- **Signup succeeds but the user can never sign in** — no verification email
  was sent (EmailJS not configured) or the user hasn't clicked the link yet.
  See "Manually verifying a user" above for a quick unblock.
- **Frontend can't reach `/api/*` in dev** — confirm `backend` is healthy
  (`docker compose ps`) and that `API_PROXY_TARGET=http://backend:8080` is
  set on the `frontend` container (it is, by default, in `docker-compose.yml`);
  `src/setupProxy.js` is what makes this work instead of CRA's static
  `package.json` `proxy` field, which doesn't support container-network
  hostnames.
- **Frontend dev container fails to compile with `Module not found: Can't resolve '.../style-loader/index.js'` (or similar)** —
  on some Docker Desktop setups the `frontend_node_modules` named volume doesn't
  get auto-populated from the image's baked-in `node_modules` on first
  container start (the usual "copy image content into a fresh named volume"
  behavior didn't trigger reliably when this was built). Fix: `docker compose exec frontend npm install`,
  then `docker compose restart frontend`. Same applies to `backend_node_modules`
  if you ever see `Cannot find module` errors from the backend container.
- **`node --openssl` errors during frontend build/start** — react-scripts
  3.4.0 (webpack 4) needs Node's legacy OpenSSL provider on Node ≥17; both
  `Dockerfile.dev` and `Dockerfile` already set this (`NODE_OPTIONS=--openssl-legacy-provider`),
  so this should only come up if running `npm start`/`npm run build` directly
  on the host with a newer Node and without that flag.
