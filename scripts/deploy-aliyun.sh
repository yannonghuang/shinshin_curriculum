#!/usr/bin/env bash
# Build + push to Alibaba Cloud Container Registry, then deploy to the target
# ECS VM. Run by hand from your own machine -- see ALIYUN_DEPLOY.md.
# GitHub only ever holds source; this script (and its local-only
# deploy-aliyun.env config) is what actually talks to Alibaba Cloud.
#
# Usage:
#   scripts/deploy-aliyun.sh              # tag = current commit's short SHA
#   scripts/deploy-aliyun.sh v1.2.0        # explicit tag, e.g. for a release

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE="scripts/deploy-aliyun.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE -- copy scripts/deploy-aliyun.env.example to $ENV_FILE and fill in real values." >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

for var in ACR_REGISTRY ACR_NAMESPACE ACR_USERNAME ACR_PASSWORD ECS_HOST ECS_USER ECS_SSH_KEY_PATH ECS_DEPLOY_PATH; do
  if [[ -z "${!var:-}" ]]; then
    echo "Missing $var in $ENV_FILE." >&2
    exit 1
  fi
done

IMAGE_TAG="${1:-$(git rev-parse --short HEAD)}"
SSH_KEY="${ECS_SSH_KEY_PATH/#\~/$HOME}"
BACKEND_IMAGE="$ACR_REGISTRY/$ACR_NAMESPACE/shinshin-curriculum-backend"
FRONTEND_IMAGE="$ACR_REGISTRY/$ACR_NAMESPACE/shinshin-curriculum-frontend"

echo "==> Deploying commit $(git rev-parse --short HEAD) as image tag '$IMAGE_TAG' to $ECS_HOST"

echo "==> Logging in to $ACR_REGISTRY"
echo "$ACR_PASSWORD" | docker login "$ACR_REGISTRY" -u "$ACR_USERNAME" --password-stdin

echo "==> Building backend image"
docker build -t "$BACKEND_IMAGE:$IMAGE_TAG" -t "$BACKEND_IMAGE:latest" -f backend/Dockerfile backend

echo "==> Building frontend image"
docker build -t "$FRONTEND_IMAGE:$IMAGE_TAG" -t "$FRONTEND_IMAGE:latest" -f react-app/Dockerfile react-app

echo "==> Pushing images to ACR"
docker push "$BACKEND_IMAGE:$IMAGE_TAG"
docker push "$BACKEND_IMAGE:latest"
docker push "$FRONTEND_IMAGE:$IMAGE_TAG"
docker push "$FRONTEND_IMAGE:latest"

echo "==> Copying compose files + schema.sql to $ECS_HOST:$ECS_DEPLOY_PATH"
ssh -i "$SSH_KEY" "$ECS_USER@$ECS_HOST" "mkdir -p '$ECS_DEPLOY_PATH/backend'"
scp -i "$SSH_KEY" docker-compose.yml docker-compose.prod.yml "$ECS_USER@$ECS_HOST:$ECS_DEPLOY_PATH/"
scp -i "$SSH_KEY" backend/schema.sql "$ECS_USER@$ECS_HOST:$ECS_DEPLOY_PATH/backend/schema.sql"

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
EOF

echo "==> Done. Deployed image tag '$IMAGE_TAG'."
