# 部署到阿里云 / Deploy to Alibaba Cloud

How to provision the target Alibaba Cloud resources and use
`scripts/deploy-aliyun.sh` to build, push, and deploy this app to a single
ECS VM running the existing `docker-compose.prod.yml` stack (see `deploy.md`
for what that stack is — this document is only about the *cloud* target and
the deploy script that reaches it; local Docker Compose usage is unchanged).

**By design, GitHub never talks to Alibaba Cloud.** GitHub only ever holds
source (`git push` as usual). Building the Docker images, pushing them to
Alibaba Cloud Container Registry (ACR), and deploying to the ECS VM all
happen by running `scripts/deploy-aliyun.sh` on your own machine — so the
only place that ever holds ACR/ECS credentials is your local
`scripts/deploy-aliyun.env` (gitignored, never committed, never sent to
GitHub in any form).

**I can't provision real Alibaba Cloud resources for you** — this is a guide
to run yourself (Console or `aliyun` CLI), ending with the exact values
`scripts/deploy-aliyun.env` needs.

## Architecture

```
your machine, running scripts/deploy-aliyun.sh:
  1. docker build backend + frontend (from your current local checkout)
  2. docker push both, tagged :<git-short-sha> and :latest, to ACR
  3. scp docker-compose.yml + docker-compose.prod.yml + backend/schema.sql to the ECS VM
  4. ssh into the VM: docker compose pull && up -d --remove-orphans
```

One VM, three containers (`db`, `backend`, `frontend`/nginx), same shape as
local `docker-compose.prod.yml` — just running pre-built images pulled from
ACR instead of building on the VM. The VM never needs the full source tree,
Node, or a Docker build toolchain — only Docker itself. GitHub is not in this
loop at all; it's source control, not a build/deploy orchestrator here.

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

## 2. Get ACR docker-login credentials

You can push as your main account, but a RAM user scoped to just ACR is
better practice even for a solo/local workflow (limits the blast radius if
your laptop's `deploy-aliyun.env` ever leaks). RAM 访问控制 → 用户 → create a
user (e.g. `local-deploy`) with **编程访问 (programmatic access)**, and
attach `AliyunContainerRegistryFullAccess` (or a custom policy scoped to just
the `shinshin` namespace's repos for tighter scope).

Note ACR docker-login uses a **separate registry login password**, not this
user's AccessKey: 容器镜像服务 ACR → 访问凭证 → set a fixed password for
`docker login`, and use your Alibaba Cloud account name (or the RAM user's
login name, format `<AccountID>@<ram-username>`) as the username.

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
  to `0.0.0.0/0`; open **22** (SSH) ideally restricted to your own IP, since
  you'll be deploying directly from your machine over SSH.
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
handled by `scripts/deploy-aliyun.sh`.

```bash
mkdir -p /opt/shinshin_curriculum/backend
cd /opt/shinshin_curriculum
```

Create `.env` here **by hand** (never committed, never touched by the deploy
script — matches the root `.env` shape from `.env.example` in the repo, plus
the ACR coordinates so a plain `docker compose up -d` run later without the
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

### SSH access

Use an existing SSH key you already deploy with, or generate one dedicated
to this:
```
ssh-keygen -t ed25519 -f ~/.ssh/shinshin_deploy -C "shinshin-curriculum-deploy" -N ""
```
Append the `.pub` half to `~/.ssh/authorized_keys` on the ECS VM for the user
you'll deploy as. The private half's path is what `ECS_SSH_KEY_PATH` in
`scripts/deploy-aliyun.env` points to (§5) — it stays on your machine only.

## 5. Local deploy config

```
cp scripts/deploy-aliyun.env.example scripts/deploy-aliyun.env
```
Fill in every value (all required, the script checks and refuses to run with
anything missing):

| Variable | Value |
|---|---|
| `ACR_REGISTRY` | e.g. `registry.cn-hangzhou.aliyuncs.com` |
| `ACR_NAMESPACE` | e.g. `shinshin` |
| `ACR_USERNAME` | your ACR docker-login username (§2) |
| `ACR_PASSWORD` | your ACR docker-login password (§2) |
| `ECS_HOST` | the VM's public IP or domain |
| `ECS_USER` | the SSH login user (e.g. `root` or a deploy user) |
| `ECS_SSH_KEY_PATH` | path to the private key from §4 (`~` is expanded) |
| `ECS_DEPLOY_PATH` | `/opt/shinshin_curriculum` |

This file is gitignored (`scripts/deploy-aliyun.env` specifically, not the
`.example` template) — it never gets committed, never gets pushed, GitHub
never sees it.

## 6. Deploying

```
scripts/deploy-aliyun.sh
```
Builds `backend/Dockerfile` and `react-app/Dockerfile` (the same production
Dockerfiles `docker-compose.prod.yml` uses locally) from your **current local
checkout**, tags both images `:<current-commit-short-sha>` and `:latest`,
pushes both tags to ACR, copies the three deploy files to the VM, then SSHes
in and runs:
```
docker login <ACR_REGISTRY> ...
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --remove-orphans
docker image prune -f
```
Optionally pin an explicit tag instead of the commit SHA, e.g. for a release:
```
scripts/deploy-aliyun.sh v1.2.0
```

Since the script builds from whatever's currently checked out locally
(committed or not), `git push` before or after deploying to keep GitHub's
`main` in sync with what's actually running — the script itself doesn't
require a clean working tree or a prior push, but you'll want one for the
image tag (the commit SHA) to mean anything later.

## 7. HTTPS (not automated by this script)

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

Every image is tagged with the commit SHA it was built from, so rolling back
doesn't require rebuilding anything — just re-run the script with an older
tag:
```
scripts/deploy-aliyun.sh <previous-good-sha-or-tag>
```
That still rebuilds+pushes from your *current* checkout under that tag name,
which isn't quite a true rollback unless you also `git checkout` that commit
first. For a real rollback without touching your working tree, SSH in
directly:
```bash
ssh -i <ECS_SSH_KEY_PATH> <ECS_USER>@<ECS_HOST>
cd /opt/shinshin_curriculum
IMAGE_TAG=<previous-good-sha> docker compose -f docker-compose.yml -f docker-compose.prod.yml pull
IMAGE_TAG=<previous-good-sha> docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```
(works as long as that older tag hasn't been deleted from ACR).

## 9. Troubleshooting

- **Script exits immediately with "Missing ... in scripts/deploy-aliyun.env"**:
  fill in every variable in that file — none are optional, the script checks
  all of them upfront before doing anything.
- **Fails at `docker login`**: double check `ACR_USERNAME`/`ACR_PASSWORD` are
  the ACR *docker-login* credentials from §2, not your Alibaba Cloud account
  password or an AccessKey pair — those are different credentials.
- **`scp`/`ssh` steps fail to connect**: confirm the security group allows
  inbound 22 from your current IP, and that `ECS_SSH_KEY_PATH` points at the
  private key whose public half is in the VM's `~/.ssh/authorized_keys`.
- **`db` container has no data after first deploy**: `backend/schema.sql`
  only auto-applies via `docker-entrypoint-initdb.d` on a truly empty
  `db_data` volume — if you'd previously started the stack once without it
  present, wipe the volume once (`docker compose down -v` on the VM, matches
  the same caveat documented in `deploy.md` for local dev) and redeploy.
- **Images pull but the app 500s on AI review**: `.env` on the VM needs a
  real `DASHSCOPE_API_KEY` — the deploy script never sets this, only the
  one-time manual `.env` in §4 does.
