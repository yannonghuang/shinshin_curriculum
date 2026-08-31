# 部署到阿里云 / CI/CD to Alibaba Cloud

How to provision the target Alibaba Cloud resources and wire up
`.github/workflows/deploy-aliyun.yml` so pushing to `main` automatically
builds, pushes, and deploys this app to a single ECS VM running the existing
`docker-compose.prod.yml` stack (see `deploy.md` for what that stack is —
this document is only about the *cloud* target and the CI/CD pipeline that
reaches it; local Docker Compose usage is unchanged).

**I can't provision real Alibaba Cloud resources for you** — this is a guide
to run yourself (Console or `aliyun` CLI), with the exact values the pipeline
needs at the end.

## Architecture

```
GitHub push to main
  -> build-and-push job: docker build backend + frontend, push to ACR
  -> deploy job: scp compose files + schema.sql to the ECS VM,
                 ssh in, `docker compose pull && up -d`
```

One VM, three containers (`db`, `backend`, `frontend`/nginx), same shape as
local `docker-compose.prod.yml` — just running pre-built images pulled from
ACR instead of building on the VM. The VM never needs the full source tree,
Node, or a Docker build toolchain — only Docker itself.

## 1. Create an ACR (Container Registry) instance + namespace

**Console**: 容器镜像服务 ACR → 实例列表 → create an instance (the free
"个人版"/Personal Edition instance is enough to start). Inside it, create a
**命名空间 (namespace)** — e.g. `shinshin` — and note the region you picked
(e.g. `cn-hangzhou`); your registry endpoint will be
`registry.<region>.aliyuncs.com`. Repos (`shinshin-curriculum-backend`,
`shinshin-curriculum-frontend`) don't need to be created ahead of time — the
first `docker push` creates them automatically inside the namespace.

**CLI equivalent** (`aliyun` CLI, after `aliyun configure`):
```
aliyun cr20181201 CreateNamespace --NamespaceName shinshin --region cn-hangzhou
```

## 2. Create a RAM user scoped to ACR only

Don't use your root/primary account credentials in CI. RAM 访问控制 → 用户 →
create a user (e.g. `github-actions-deploy`) with **编程访问 (programmatic
access)**, and attach a policy scoped to ACR push/pull only —
`AliyunContainerRegistryFullAccess` is the simplest built-in policy if you
want to keep this to one step; for tighter scope, write a custom policy
limited to the `shinshin` namespace's repos. Generate an **AccessKey** for
this user — but note ACR docker-login typically uses a **separate registry
login password**, not the AccessKey directly: 容器镜像服务 ACR → 访问凭证 →
set a fixed password for `docker login`, and use your Alibaba Cloud account
name (or the RAM user's login name, format `<AccountID>@<ram-username>`) as
the username.

You'll end up with three values: `ACR_REGISTRY` (e.g.
`registry.cn-hangzhou.aliyuncs.com`), `ACR_USERNAME`, `ACR_PASSWORD`.

## 3. Create the ECS instance

**Console**: 云服务器 ECS → 创建实例.
- **Spec**: 2 vCPU / 4 GB is comfortable for this stack (MySQL + Node backend
  + nginx); the smallest burstable instance family (e.g. `ecs.t6.large`) is
  fine to start and can be resized later.
- **Image**: Ubuntu 22.04 (or Alibaba Cloud Linux 3 — commands below cover
  both).
- **Security group**: open **80** (HTTP, and 443 once you add TLS — see §7)
  to `0.0.0.0/0`; open **22** (SSH) ideally restricted to your own IP /
  office IP range, not the whole internet, since this VM will also hold a
  deploy SSH key.
- **Login**: create it with an SSH key pair (recommended) or set a password
  and switch to key-only auth afterward.

SSH in and install Docker + the Compose plugin:
```bash
# Ubuntu 22.04
curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker
sudo usermod -aG docker $USER   # log out/in again for this to take effect

# Alibaba Cloud Linux 3 (RHEL-compatible)
sudo yum install -y docker
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
# Compose plugin isn't in the default yum repo on Alibaba Cloud Linux --
# install the CLI plugin binary directly:
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
```
Verify: `docker compose version`.

## 4. Prepare the deploy directory on the VM

This is the one manual, one-time setup step — everything after this is
automated by the pipeline.

```bash
mkdir -p /opt/shinshin_curriculum/backend
cd /opt/shinshin_curriculum
```

Create `.env` here **by hand** (never committed, never touched by CI —
matches the root `.env` shape from `.env.example` in the repo, plus the ACR
coordinates so a plain `docker compose up -d` run later without the CI
script's exported vars still resolves the right image):

```
DB_ROOT_PASSWORD=<a real generated password>
DB_NAME=shinshin_curriculum
DB_USER=shinshin
DB_PASSWORD=<a real generated password>
JWT_SECRET=<openssl rand -hex 32>
LLM_PROVIDER=dashscope
DASHSCOPE_API_KEY=<your real key>
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
AI_REVIEW_MODEL=qwen3.8-max
ACR_REGISTRY=registry.cn-hangzhou.aliyuncs.com
ACR_NAMESPACE=shinshin
```
`chmod 600 .env` — it holds production secrets.

The first deploy run (see §6) copies `docker-compose.yml`,
`docker-compose.prod.yml`, and `backend/schema.sql` into this directory
automatically; you don't need to create those by hand. `backend/schema.sql`
being present is what makes the `db` container auto-apply the schema (+ seed
roles + the `manager`/`manager` admin account — **change that password
immediately after the first deploy**) on its first boot, exactly like local
dev.

### SSH access for the pipeline

Generate a **dedicated** key pair for GitHub Actions (don't reuse your
personal key):
```
ssh-keygen -t ed25519 -f deploy_key -C "github-actions-deploy" -N ""
```
Append `deploy_key.pub` to `~/.ssh/authorized_keys` on the ECS VM for the
user you'll deploy as. Keep `deploy_key` (the private half) for the GitHub
secret in §5 — never commit it.

## 5. GitHub repository secrets

Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `ACR_REGISTRY` | e.g. `registry.cn-hangzhou.aliyuncs.com` |
| `ACR_NAMESPACE` | e.g. `shinshin` |
| `ACR_USERNAME` | your ACR docker-login username (§2) |
| `ACR_PASSWORD` | your ACR docker-login password (§2) |
| `ECS_HOST` | the VM's public IP or domain |
| `ECS_USER` | the SSH login user (e.g. `root` or a deploy user) |
| `ECS_SSH_KEY` | contents of the **private** key from §4 (`deploy_key`) |
| `ECS_DEPLOY_PATH` | `/opt/shinshin_curriculum` |

## 6. How the pipeline runs

`.github/workflows/deploy-aliyun.yml` triggers on every push to `main`
(or manually via the Actions tab → "Deploy to Aliyun ECS" → Run workflow):

1. **build-and-push**: builds `backend/Dockerfile` and `react-app/Dockerfile`
   (the same production Dockerfiles `docker-compose.prod.yml` uses locally),
   tags each image both `:${{ github.sha }}` and `:latest`, pushes both tags
   to ACR.
2. **deploy**: copies `docker-compose.yml` + `docker-compose.prod.yml` +
   `backend/schema.sql` to the VM (`appleboy/scp-action`), then SSHes in
   (`appleboy/ssh-action`) and runs, with `IMAGE_TAG` pinned to the commit SHA
   just built:
   ```
   docker login <ACR_REGISTRY> ...
   docker compose -f docker-compose.yml -f docker-compose.prod.yml pull
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --remove-orphans
   docker image prune -f
   ```

Because every deploy is pinned to the exact commit SHA (not just `:latest`),
you always know precisely what's running, and rollback is simple (§8).

## 7. HTTPS (not automated by this pipeline)

The stack as deployed serves plain HTTP on port 80. For production HTTPS,
put one of these in front of the `frontend` container rather than modifying
`nginx.conf` inside the app image:
- Easiest: point a domain at the ECS IP and run Certbot (`certbot --nginx`)
  against a *separate*, host-level nginx reverse-proxying to `localhost:80`,
  or
- Use an Alibaba Cloud SLB (负载均衡) in front of the ECS instance with a
  managed certificate (免费证书 in 数字证书管理服务/SSL证书), terminating
  TLS at the SLB and forwarding plain HTTP to the VM.

## 8. Rollback

Every image is tagged with its commit SHA, so rolling back doesn't require
rebuilding anything:
```bash
ssh <ECS_USER>@<ECS_HOST>
cd /opt/shinshin_curriculum
IMAGE_TAG=<previous-good-sha> docker compose -f docker-compose.yml -f docker-compose.prod.yml pull
IMAGE_TAG=<previous-good-sha> docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```
Or just re-run the GitHub Actions workflow from an older commit (Actions tab
→ that run → Re-run jobs) to go through the full pipeline again.

## 9. Troubleshooting

- **`deploy` job fails at `docker login`**: double check `ACR_USERNAME`/`ACR_PASSWORD`
  are the ACR *docker-login* credentials from §2, not your Alibaba Cloud
  account password or an AccessKey pair — those are different credentials.
- **`scp`/`ssh` steps fail to connect**: confirm the security group actually
  allows inbound 22 from GitHub Actions' runner IPs (GitHub's hosted runners
  don't have static IPs — if you've locked down 22 to specific IPs, you'll
  need a self-hosted runner or a bastion instead of GitHub-hosted runners).
- **`db` container has no data after first deploy**: `backend/schema.sql`
  only auto-applies via `docker-entrypoint-initdb.d` on a truly empty
  `db_data` volume — if you'd previously started the stack once without it
  present, wipe the volume once (`docker compose down -v`, matches the same
  caveat documented in `deploy.md` for local dev) and redeploy.
- **Images pull but the app 500s on AI review**: `.env` on the VM needs a
  real `DASHSCOPE_API_KEY` — this is never set by CI, only by the one-time
  manual `.env` in §4.
