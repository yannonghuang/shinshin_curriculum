#!/usr/bin/env bash
# Build + push to Alibaba Cloud Container Registry, then deploy to the target
# ECS VM. Either run by hand from your own machine (see ALIYUN_DEPLOY.md §5-6,
# reading config from the local-only scripts/deploy-aliyun.env) or invoked by
# the "Deploy to ECS" GitHub Actions workflow (ALIYUN_DEPLOY.md §10, config
# arriving as already-exported env vars sourced from repo secrets instead) --
# this script accepts either: it sources deploy-aliyun.env if present, then
# falls through to whatever's already in the environment either way, and only
# fails if a required var is still unset after that.
#
# Usage:
#   scripts/deploy-aliyun.sh              # tag = current commit's short SHA
#   scripts/deploy-aliyun.sh v1.2.0        # explicit tag, e.g. for a release
#
# Deploying to a second target (e.g. a temporary non-mainland ECS instance
# while ICP备案 for the usual one is pending -- see ALIYUN_DEPLOY.md §7):
# keep a second env file (e.g. scripts/deploy-aliyun-hk.env, gitignored same
# as the default) with that instance's own ECS_HOST/ACR_NAMESPACE/etc., and
# point at it explicitly instead of editing the default file back and forth:
#   DEPLOY_ENV_FILE=scripts/deploy-aliyun-hk.env scripts/deploy-aliyun.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE="${DEPLOY_ENV_FILE:-scripts/deploy-aliyun.env}"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

for var in ACR_REGISTRY ACR_NAMESPACE ACR_USERNAME ACR_PASSWORD ECS_HOST ECS_USER ECS_SSH_KEY_PATH ECS_DEPLOY_PATH; do
  if [[ -z "${!var:-}" ]]; then
    echo "Missing $var -- set it in $ENV_FILE for a local deploy (copy $ENV_FILE.example to start), or as a workflow secret for the GitHub Actions deploy." >&2
    exit 1
  fi
done

IMAGE_TAG="${1:-$(git rev-parse --short HEAD)}"
SSH_KEY="${ECS_SSH_KEY_PATH/#\~/$HOME}"
BACKEND_IMAGE="$ACR_REGISTRY/$ACR_NAMESPACE/shinshin-curriculum-backend"
FRONTEND_IMAGE="$ACR_REGISTRY/$ACR_NAMESPACE/shinshin-curriculum-frontend"
MYSQL_IMAGE="$ACR_REGISTRY/$ACR_NAMESPACE/mysql:8.0"
# Almost every ECS instance type is x86_64 -- override in deploy-aliyun.env
# (TARGET_PLATFORM=linux/arm64) only if the VM is one of Aliyun's arm64
# instance families (e.g. ecs.g8y/c8y). Confirmed necessary: building on an
# Apple Silicon Mac without this produces linux/arm64 images that the (amd64)
# ECS VM refuses to run at all ("container ... exited (255)"), not just slowly.
TARGET_PLATFORM="${TARGET_PLATFORM:-linux/amd64}"

echo "==> Deploying commit $(git rev-parse --short HEAD) as image tag '$IMAGE_TAG' to $ECS_HOST (platform: $TARGET_PLATFORM)"

echo "==> Logging in to $ACR_REGISTRY"
echo "$ACR_PASSWORD" | docker login "$ACR_REGISTRY" -u "$ACR_USERNAME" --password-stdin

# Mirror mysql:8.0 into ACR so the ECS VM never needs to reach Docker Hub
# directly -- confirmed on the real deploy target that Docker Hub connectivity
# times out entirely (common for mainland-China-region ECS), while ACR pulls
# work fine. Idempotent/cheap after the first run: ACR already has the layers.
echo "==> Mirroring mysql:8.0 into ACR"
docker pull --platform "$TARGET_PLATFORM" mysql:8.0
docker tag mysql:8.0 "$MYSQL_IMAGE"
docker push "$MYSQL_IMAGE"

# --provenance=false --sbom=false: recent Docker/BuildKit attaches an OCI
# attestation manifest by default, which this ACR instance rejects on push
# with "unknown manifest class for application/vnd.oci.empty.v1+json"
# (confirmed by testing both with and without these flags against the real
# registry). Harmless to disable -- these are supply-chain metadata, not
# something the deploy or the running app needs.
# Build identity baked into both images, shown to super users in the app's
# build-info footer (see backend buildInfo.controller.js /
# react-app build-info.component.js) -- the only way to tell from the UI
# which commit is actually live, and whether frontend and backend match.
BUILD_ARGS=(
  --build-arg "BUILD_TAG=$IMAGE_TAG"
  --build-arg "BUILD_COMMIT=$(git rev-parse HEAD)"
  --build-arg "BUILD_COMMIT_TIME=$(git log -1 --format=%cI)"
  --build-arg "BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
)

# BUILDX_GHA_CACHE=true (set by the "Deploy to ECS" workflow only): build
# and push in one buildx step backed by the GitHub Actions layer cache. A
# fresh CI runner has no local layer cache, so a plain docker build
# re-creates every layer -- including npm ci's node_modules, unchanged
# between most commits -- with a new digest, and docker push then re-uploads
# all of it across the border to ACR, whose throughput from GitHub's runners
# swings from seconds to 15+ minutes per large layer (the cause of the
# 12-22 min deploys). Layers restored from the cache keep their original
# compressed blobs, so ACR reports them "already exists" and only the
# layers that actually changed get uploaded. oci-mediatypes=false keeps the
# Docker v2 manifest format a plain docker push produces, which is what
# this ACR instance has always been fed. Local deploys keep the plain path:
# the machine's own Docker cache already gives stable digests there.
build_and_push() {
  local name="$1" image="$2" dockerfile="$3" context="$4"
  if [[ "${BUILDX_GHA_CACHE:-}" == "true" ]]; then
    echo "==> Building + pushing $name image (buildx, GitHub Actions cache)"
    docker buildx build --platform "$TARGET_PLATFORM" --provenance=false --sbom=false "${BUILD_ARGS[@]}" \
      --cache-from "type=gha,scope=$name" --cache-to "type=gha,scope=$name,mode=max" \
      --output "type=image,\"name=$image:$IMAGE_TAG,$image:latest\",push=true,oci-mediatypes=false" \
      -f "$dockerfile" "$context"
  else
    echo "==> Building $name image"
    docker build --platform "$TARGET_PLATFORM" --provenance=false --sbom=false "${BUILD_ARGS[@]}" -t "$image:$IMAGE_TAG" -t "$image:latest" -f "$dockerfile" "$context"
    echo "==> Pushing $name image to ACR"
    docker push "$image:$IMAGE_TAG"
    docker push "$image:latest"
  fi
}

build_and_push backend "$BACKEND_IMAGE" backend/Dockerfile backend
build_and_push frontend "$FRONTEND_IMAGE" react-app/Dockerfile react-app

echo "==> Copying compose files + schema.sql to $ECS_HOST:$ECS_DEPLOY_PATH"
ssh -i "$SSH_KEY" "$ECS_USER@$ECS_HOST" "mkdir -p '$ECS_DEPLOY_PATH/backend'"
scp -i "$SSH_KEY" docker-compose.yml docker-compose.prod.yml "$ECS_USER@$ECS_HOST:$ECS_DEPLOY_PATH/"
scp -i "$SSH_KEY" backend/schema.sql "$ECS_USER@$ECS_HOST:$ECS_DEPLOY_PATH/backend/schema.sql"

# Every deploy tags a new image with the commit SHA and re-points :latest at
# it, but never removes the *previous* SHA-tagged image -- 17 old
# frontend/backend pairs (~380MB each) were already sitting on the ECS disk
# before this was added, none of it dangling (so plain `docker image prune`
# never touched it -- that only drops untagged images). KEEP_IMAGE_VERSIONS
# below controls how many of the most recent builds survive per repo (>=1;
# default 3 leaves room for a couple of rollbacks); override in
# deploy-aliyun.env if you want more/less history.
KEEP_IMAGE_VERSIONS="${KEEP_IMAGE_VERSIONS:-3}"

echo "==> Pulling + restarting on $ECS_HOST"
# shellcheck disable=SC2087
ssh -i "$SSH_KEY" "$ECS_USER@$ECS_HOST" bash -s <<EOF
set -euo pipefail
cd "$ECS_DEPLOY_PATH"
echo "$ACR_PASSWORD" | docker login "$ACR_REGISTRY" -u "$ACR_USERNAME" --password-stdin
export IMAGE_TAG="$IMAGE_TAG"
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --remove-orphans
docker image prune -f

# docker images lists newest-created first by default; dedupe by image ID
# (a single build's :latest and :<sha> tags share one ID, so counting by ID
# rather than by tag is what actually keeps N *builds*, not N tags) and drop
# everything past the newest $KEEP_IMAGE_VERSIONS. Removing by repo:tag
# rather than bare ID (confirmed necessary against the real registry: two
# commits that didn't touch backend/frontend source produce byte-identical
# layers, so their SHA tags share one image ID -- plain "docker rmi <id>"
# then refuses with "referenced in multiple repositories", meaning
# multiple tags, until every one of that ID's tags is removed individually.
# Not -f: an image still referenced by a container (shouldn't happen right
# after up -d, but just in case) fails soft here rather than aborting the
# whole deploy.
#
# Note: this whole heredoc is unquoted (<<EOF, not <<'EOF') because it
# needs local expansion of $BACKEND_IMAGE etc. -- so no line in it may
# contain a backtick. One snuck into an earlier draft of this comment and
# silently broke local parsing of the block (harmlessly here, since the
# resulting syntax error just made the substitution a no-op, but don't
# rely on that).
for repo in "$BACKEND_IMAGE" "$FRONTEND_IMAGE"; do
  old_ids=\$(docker images "\$repo" --format '{{.ID}}' | awk '!seen[\$0]++' | tail -n +"\$(($KEEP_IMAGE_VERSIONS + 1))")
  for id in \$old_ids; do
    docker images "\$repo" --format '{{.ID}} {{.Repository}}:{{.Tag}}' | awk -v id="\$id" '\$1==id {print \$2}' | xargs -r docker rmi || true
  done
done
EOF

echo "==> Done. Deployed image tag '$IMAGE_TAG'."
