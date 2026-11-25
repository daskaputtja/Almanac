#!/usr/bin/env bash
# Almanac installer for a Linux server with Docker (tested on Ubuntu).
#
#   curl -fsSL https://raw.githubusercontent.com/daskaputtja/Almanac/main/deploy/install.sh -o install-almanac.sh
#   sudo bash install-almanac.sh
#
# It asks a few questions, then:
#   - installs Docker if it's missing
#   - checks your Silo API key and your DNS record
#   - sets Almanac up in /opt/almanac, with automatic HTTPS (Caddy) if ports
#     80 and 443 are free, or behind your existing web server if they aren't
#   - starts it and shows the setup code for your first sign-in
#
# Running it again is safe: it keeps your data and updates Almanac.
# Afterwards, `sudo almanac-update` updates Almanac without any questions.

set -euo pipefail

INSTALL_DIR=/opt/almanac
IMAGE=ghcr.io/daskaputtja/almanac:latest
REPO=https://github.com/daskaputtja/Almanac.git

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
fail() { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok() { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || fail "Run this as root: sudo bash $0"

echo
bold "Almanac installer"
echo

# --- Questions -----------------------------------------------------------------

existing_env="$INSTALL_DIR/.env"
current() { [ -f "$existing_env" ] && grep -E "^$1=" "$existing_env" | head -1 | cut -d= -f2- || true; }

# Ask for a value, offering what's already saved (if anything) as the default.
ask() { # ask VAR "Question" "example"
  local saved answer
  saved=$(current "$1")
  if [ -n "$saved" ]; then
    read -r -p "$2 [$saved]: " answer
    answer=${answer:-$saved}
  else
    read -r -p "$2 (for example $3): " answer
  fi
  [ -n "$answer" ] || fail "That's needed."
  printf -v "$1" '%s' "$answer"
}

ask ALMANAC_DOMAIN "Address for Almanac" "almanac.example.com"
DOMAIN=$ALMANAC_DOMAIN
ask SILO_URL "Your Silo server's address" "https://silo.example.com"
SILO_URL=${SILO_URL%/}

existing_key=$(current SILO_API_KEY)
if [ -n "$existing_key" ]; then
  read -r -s -p "Silo API key (press Enter to keep the current one): " SILO_API_KEY; echo
  SILO_API_KEY=${SILO_API_KEY:-$existing_key}
else
  read -r -s -p "Silo API key (admin:monitor:read + libraries:read, starts with sa_): " SILO_API_KEY; echo
fi
[ -n "$SILO_API_KEY" ] || fail "An API key is needed."

if [ -f /etc/systemd/system/almanac-update.timer ]; then auto_default=Y; else auto_default=N; fi
read -r -p "Update Almanac automatically every night? [y/n, default $auto_default]: " AUTO_UPDATE
AUTO_UPDATE=${AUTO_UPDATE:-$auto_default}

echo

# --- Docker --------------------------------------------------------------------

bold "Checking Docker"
if ! command -v docker >/dev/null 2>&1; then
  info "Installing Docker…"
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
docker compose version >/dev/null 2>&1 || fail "Docker Compose isn't available. Install the docker-compose-plugin package and run this again."
ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo installed)"

# --- Silo API key --------------------------------------------------------------

bold "Checking the Silo API key"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 20 -H "Authorization: Bearer $SILO_API_KEY" "$SILO_URL/api/v2/admin/sessions?limit=1" || echo 000)
case "$code" in
  200) ok "Silo accepted the key." ;;
  401) fail "Silo says the key is wrong. Check you copied all of it." ;;
  403) fail "Silo refused the key. It needs the admin:monitor:read scope and must belong to an admin account." ;;
  000) fail "Couldn't reach $SILO_URL from this server." ;;
  *) warn "Silo answered $code. Carrying on, but check Almanac's log if nothing shows up." ;;
esac
code=$(curl -s -o /dev/null -w '%{http_code}' -m 20 -H "Authorization: Bearer $SILO_API_KEY" "$SILO_URL/api/v2/user/libraries" || echo 000)
[ "$code" = 200 ] && ok "Library names are readable." || warn "The key lacks libraries:read, so libraries will show as numbers. Everything else works."

# --- DNS -----------------------------------------------------------------------

bold "Checking DNS for $DOMAIN"
server_ips=$(hostname -I 2>/dev/null || true)
dns_ip=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1 {print $1}' || true)
if [ -z "$dns_ip" ]; then
  warn "$DOMAIN doesn't point anywhere yet. Add an A record for it pointing to this server."
  warn "Almanac will start anyway; HTTPS starts working once the record is live."
elif printf ' %s ' $server_ips | grep -q " $dns_ip "; then
  ok "$DOMAIN points to this server ($dns_ip)."
else
  warn "$DOMAIN points to $dns_ip, which isn't one of this server's addresses ($server_ips)."
  warn "If it's behind Cloudflare's proxy (orange cloud), that's expected; otherwise fix the A record."
fi

# --- Web server: our own Caddy, or an existing one -----------------------------

bold "Checking ports 80 and 443"
port_owner() { ss -ltnpH "sport = :$1" 2>/dev/null | sed -E 's/.*users:\(\("([^"]+)".*/\1/' | head -1; }
own_caddy=$(docker ps --format '{{.Names}}' | grep -x almanac-caddy || true)
p80=$(port_owner 80); p443=$(port_owner 443)
if [ -n "$own_caddy" ] || { [ -z "$p80" ] && [ -z "$p443" ]; }; then
  MODE=caddy
  ok "Ports 80 and 443 are free: Almanac gets automatic HTTPS with Caddy."
else
  MODE=proxy
  warn "Something already uses ports 80/443 (${p80:-?}/${p443:-?}), so Almanac will sit behind it."
  info "Almanac will listen on 127.0.0.1:8191 (this server only). Instructions follow at the end."
fi

# --- Files ---------------------------------------------------------------------

bold "Writing $INSTALL_DIR"
mkdir -p "$INSTALL_DIR/data"
chown 1000:1000 "$INSTALL_DIR/data"   # the container runs as the "node" user
umask 077
cat > "$INSTALL_DIR/.env" <<EOF
ALMANAC_DOMAIN=$DOMAIN
SILO_URL=$SILO_URL
SILO_API_KEY=$SILO_API_KEY
EOF
umask 022

if [ "$MODE" = caddy ]; then
  cat > "$INSTALL_DIR/docker-compose.yml" <<'EOF'
services:
  almanac:
    image: ${ALMANAC_IMAGE:-ghcr.io/daskaputtja/almanac:latest}
    container_name: almanac
    restart: unless-stopped
    environment:
      SILO_URL: ${SILO_URL}
      SILO_API_KEY: ${SILO_API_KEY}
      TRUST_PROXY: "true"
    volumes:
      - ./data:/data

  caddy:
    image: caddy:2
    container_name: almanac-caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    command: caddy reverse-proxy --from ${ALMANAC_DOMAIN} --to almanac:8191
    volumes:
      - ./caddy:/data
EOF
else
  cat > "$INSTALL_DIR/docker-compose.yml" <<'EOF'
services:
  almanac:
    image: ${ALMANAC_IMAGE:-ghcr.io/daskaputtja/almanac:latest}
    container_name: almanac
    restart: unless-stopped
    ports:
      - "127.0.0.1:8191:8191"
    environment:
      SILO_URL: ${SILO_URL}
      SILO_API_KEY: ${SILO_API_KEY}
      TRUST_PROXY: "true"
    volumes:
      - ./data:/data
EOF
fi
ok "Settings saved (the API key is in $INSTALL_DIR/.env, readable by root only)."

# --- Image ---------------------------------------------------------------------

bold "Getting Almanac"
cd "$INSTALL_DIR"
if docker pull "$IMAGE" >/dev/null 2>&1; then
  ok "Downloaded the latest image."
else
  info "The published image isn't downloadable (it may be private), so building it here instead. This takes a few minutes…"
  rm -rf "$INSTALL_DIR/src"
  git clone --depth 1 "$REPO" "$INSTALL_DIR/src" >/dev/null 2>&1 || {
    apt-get update -qq && apt-get install -y -qq git >/dev/null
    git clone --depth 1 "$REPO" "$INSTALL_DIR/src" >/dev/null
  }
  docker build -t almanac:local "$INSTALL_DIR/src" >/dev/null
  echo "ALMANAC_IMAGE=almanac:local" >> "$INSTALL_DIR/.env"
  ok "Built the image."
fi

# --- Update command ------------------------------------------------------------

bold "Setting up updates"
if [ -f "$INSTALL_DIR/src/deploy/update.sh" ]; then
  install -m 755 "$INSTALL_DIR/src/deploy/update.sh" /usr/local/bin/almanac-update
else
  curl -fsSL https://raw.githubusercontent.com/daskaputtja/Almanac/main/deploy/update.sh -o /usr/local/bin/almanac-update
  chmod 755 /usr/local/bin/almanac-update
fi
ok "Update any time with: sudo almanac-update"

if [[ "$AUTO_UPDATE" =~ ^[Yy] ]] && command -v systemctl >/dev/null 2>&1; then
  cat > /etc/systemd/system/almanac-update.service <<'UNIT'
[Unit]
Description=Update Almanac
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/almanac-update --quiet
UNIT
  cat > /etc/systemd/system/almanac-update.timer <<'UNIT'
[Unit]
Description=Update Almanac every night

[Timer]
OnCalendar=*-*-* 04:00
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now almanac-update.timer >/dev/null 2>&1
  ok "Almanac will update itself every night around 4am (server time)."
elif [ -f /etc/systemd/system/almanac-update.timer ]; then
  systemctl disable --now almanac-update.timer >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/almanac-update.timer /etc/systemd/system/almanac-update.service
  systemctl daemon-reload
  ok "Nightly updates turned off."
fi

# --- Start ---------------------------------------------------------------------

bold "Starting Almanac"
docker compose up -d >/dev/null
for _ in $(seq 1 30); do
  docker logs almanac 2>&1 | grep -q "Almanac is running" && break
  sleep 2
done
docker logs almanac 2>&1 | grep -q "Almanac is running" || { docker logs almanac 2>&1 | tail -20; fail "Almanac didn't start. The log is above."; }
ok "Almanac is running."

echo
setup_code=$(docker logs almanac 2>&1 | grep -o 'setup code: .*' | tail -1 | cut -d' ' -f3 || true)
if [ "$MODE" = caddy ]; then
  bold "Open https://$DOMAIN"
else
  bold "Almanac is running on 127.0.0.1:8191. Add it to your web server:"
  info "Nginx:   location / { proxy_pass http://127.0.0.1:8191; proxy_buffering off;"
  info "                      proxy_set_header Host \$host; proxy_set_header X-Forwarded-For \$remote_addr;"
  info "                      proxy_set_header X-Forwarded-Proto \$scheme; }"
  info "Caddy:   $DOMAIN { reverse_proxy 127.0.0.1:8191 }"
  info "Nginx Proxy Manager: forward $DOMAIN to 127.0.0.1 port 8191, with SSL on."
fi
if [ -n "$setup_code" ]; then
  echo
  bold "Your setup code: $setup_code"
  info "Enter it on the first page, then create your account and set up two-factor authentication."
else
  info "An account already exists, so just sign in."
fi

echo
info "First start: the catalog copies in a few minutes, and play history imports over about half an hour."
info "Useful commands (from $INSTALL_DIR):"
info "  docker logs -f almanac                    see what it's doing"
info "  sudo almanac-update                        update to the latest version"
info "  journalctl -u almanac-update              what the nightly updates did"
info "  docker exec -it almanac almanac-cli users     account recovery"

if command -v ufw >/dev/null 2>&1 && ! ufw status 2>/dev/null | grep -q "Status: active"; then
  echo
  warn "No firewall is active on this server. To allow only SSH and web traffic:"
  info "  ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443 && ufw enable"
  warn "Check first that nothing else you run needs other ports open."
fi
echo
