#!/usr/bin/env bash
# Installs OS AI on a fresh Ubuntu 22.04/24.04 server (for example a Hostinger KVM VPS) and serves it
# over HTTPS on your domain. Run as root:
#
#   curl -fsSL https://raw.githubusercontent.com/oageeb7-spec/https-github.com-oageeb7-spec-forex-trading-bot/claude/agentic-trading-system/scripts/hostinger-setup.sh | bash -s -- ostradingai.com
#
# Safe to run again: it updates the code and restarts the service, keeping your .env.
set -euo pipefail

DOMAIN="${1:-ostradingai.com}"
REPO="${REPO:-https://github.com/oageeb7-spec/https-github.com-oageeb7-spec-forex-trading-bot.git}"
BRANCH="${BRANCH:-claude/agentic-trading-system}"
APP_DIR=/opt/os-ai

if [ "$(id -u)" -ne 0 ]; then echo "Run this as root (sudo -i first)." >&2; exit 1; fi

echo "==> Installing system packages"
apt-get update -y
apt-get install -y curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

if ! node -v 2>/dev/null | grep -Eq '^v(2[2-9]|[3-9][0-9])\.'; then
  echo "==> Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null; then
  echo "==> Installing Caddy (web server with automatic HTTPS)"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

id os-ai >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin os-ai

echo "==> Getting the OS AI code ($BRANCH)"
# The checkout is owned by the os-ai user; let root update it.
git config --global --add safe.directory "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  git -C "$APP_DIR" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
else
  git clone --quiet --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund

FIRST_RUN=0
if [ ! -f .env ]; then
  cp .env.example .env
  FIRST_RUN=1
fi
chown -R os-ai:os-ai "$APP_DIR"
chmod 600 .env

echo "==> Creating the os-ai service"
cat > /etc/systemd/system/os-ai.service <<EOF
[Unit]
Description=OS AI trading system
After=network-online.target
Wants=network-online.target

[Service]
User=os-ai
WorkingDirectory=$APP_DIR
Environment=HOST=127.0.0.1
Environment=PORT=3000
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

echo "==> Configuring HTTPS for $DOMAIN"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN, www.$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
EOF

systemctl daemon-reload
systemctl enable os-ai >/dev/null
systemctl restart caddy

if [ "$FIRST_RUN" -eq 1 ]; then
  cat <<EOF

OS AI is installed but not started yet: it needs your keys.

  1. nano $APP_DIR/.env
     Fill in DASHBOARD_PASSWORD, BRIDGE_TOKEN and (optionally) ANTHROPIC_API_KEY. Save with Ctrl+O, Enter, Ctrl+X.
  2. systemctl restart os-ai
  3. Open https://$DOMAIN (the first visit can take a minute while the HTTPS certificate is issued).

Check it is running:  systemctl status os-ai     Live log:  journalctl -u os-ai -f
EOF
else
  systemctl restart os-ai
  echo "OS AI updated and restarted. Open https://$DOMAIN    Live log: journalctl -u os-ai -f"
fi
