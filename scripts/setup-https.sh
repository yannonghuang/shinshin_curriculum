#!/usr/bin/env bash
# One-time HTTPS bootstrap for a domain fronting this app's docker-compose.prod.yml
# stack via a host-level nginx + Certbot (see ALIYUN_DEPLOY.md §7).
#
# Run this ON the target VM itself, as root -- unlike scripts/deploy-aliyun.sh
# (which builds/pushes/deploys from your own machine over SSH), this only
# touches the VM's own host nginx/certbot install and the already-deployed
# compose stack living at DEPLOY_PATH. It does not build or push any images.
#
# Usage (on the VM, from the repo checkout or anywhere):
#   sudo DOMAIN=xtclass.nhfoundation.cn CERTBOT_EMAIL=you@example.org \
#     bash scripts/setup-https.sh
#
# Requires: DNS for DOMAIN already resolving to this VM's public IP, and
# security-group/firewall rules allowing inbound 80 and 443.
#
# Idempotent -- safe to re-run (e.g. to add a second domain with a different
# DOMAIN value, or to retry after a step failed partway). Each run only
# touches nginx's site for THIS DOMAIN and the frontend's port binding; it
# never removes an unrelated site you've configured for another domain.

set -euo pipefail

DOMAIN="${DOMAIN:?Set DOMAIN=your.subdomain.example.com}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:?Set CERTBOT_EMAIL=you@example.com (used for certificate renewal/expiry notices)}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/shinshin_curriculum}"
FRONTEND_LOCAL_PORT="${FRONTEND_LOCAL_PORT:-8082}"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo DOMAIN=... CERTBOT_EMAIL=... bash $0" >&2
  exit 1
fi

# Suppresses both apt's own interactive prompts and needrestart's "which
# services should be restarted?" whiptail dialog (confirmed to otherwise
# pop up here, same as any apt install that pulls in an upgraded library) --
# this script has no TTY to answer it from when run non-interactively.
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

echo "==> [1/6] Installing nginx + certbot (no-op if already installed)"
apt-get update -qq
apt-get install -y -qq nginx certbot python3-certbot-nginx

echo "==> [2/6] Ensuring $DEPLOY_PATH/.env pins the frontend off the public interface"
ENV_FILE="$DEPLOY_PATH/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE -- create it by hand first (see ALIYUN_DEPLOY.md §4)." >&2
  exit 1
fi
BINDING="127.0.0.1:${FRONTEND_LOCAL_PORT}:80"
if grep -q "^FRONTEND_PORT_BINDING=" "$ENV_FILE"; then
  sed -i "s|^FRONTEND_PORT_BINDING=.*|FRONTEND_PORT_BINDING=${BINDING}|" "$ENV_FILE"
else
  echo "FRONTEND_PORT_BINDING=${BINDING}" >> "$ENV_FILE"
fi

echo "==> [3/6] Redeploying the frontend container with the new binding"
( cd "$DEPLOY_PATH" && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d )

echo "==> [4/6] Waiting for the frontend container to answer on 127.0.0.1:${FRONTEND_LOCAL_PORT}"
frontend_up=0
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${FRONTEND_LOCAL_PORT}/"; then
    frontend_up=1
    break
  fi
  sleep 1
done
if [[ "$frontend_up" -ne 1 ]]; then
  echo "Frontend never answered on 127.0.0.1:${FRONTEND_LOCAL_PORT} after 30s -- check 'docker compose logs frontend' in $DEPLOY_PATH." >&2
  exit 1
fi
echo "    frontend is up."

echo "==> [5/6] Writing the nginx site for $DOMAIN"
SITE_FILE="/etc/nginx/sites-available/${DOMAIN}"
cat > "$SITE_FILE" <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${FRONTEND_LOCAL_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        client_max_body_size 1024m;
        proxy_connect_timeout 75s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
    }
}
EOF
ln -sf "$SITE_FILE" "/etc/nginx/sites-enabled/${DOMAIN}"

# Ubuntu's default site (sites-enabled/default, server_name _) can coexist
# with this one -- nginx picks whichever server_name actually matches the
# request's Host header -- so it's left alone here rather than silently
# removed; only relevant if it was set as the port-80 default_server AND
# something about that shadows this block (not the common case).
nginx -t
systemctl enable nginx
systemctl restart nginx

echo "==> [6/6] Requesting/renewing the Let's Encrypt certificate"
certbot --nginx --non-interactive --agree-tos -m "$CERTBOT_EMAIL" -d "$DOMAIN" --redirect

echo "==> Done. Verifying:"
curl -fsSI "https://${DOMAIN}/" || echo "Warning: https check failed -- inspect manually." >&2
