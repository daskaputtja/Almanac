#!/usr/bin/env bash
# Update Almanac to the latest version, keeping all settings and data.
# The installer puts this at /usr/local/bin/almanac-update:
#
#   sudo almanac-update           update now
#   sudo almanac-update --quiet   only print something if it updated or failed (used by the nightly timer)

set -euo pipefail

INSTALL_DIR=${ALMANAC_DIR:-/opt/almanac}
SELF_URL=https://raw.githubusercontent.com/daskaputtja/Almanac/main/deploy/update.sh
QUIET=false
[ "${1:-}" = "--quiet" ] && QUIET=true

say() { $QUIET || printf '  %s\n' "$*"; }
ok() { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
fail() { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Run this as root: sudo almanac-update"
[ -f "$INSTALL_DIR/docker-compose.yml" ] || fail "Almanac isn't installed in $INSTALL_DIR. Run the installer first."
cd "$INSTALL_DIR"

running_image() { docker inspect --format '{{.Image}}' almanac 2>/dev/null || true; }
before=$(running_image)

if grep -q '^ALMANAC_IMAGE=almanac:local' .env 2>/dev/null; then
  # Built on this server (the published image wasn't downloadable when it was installed).
  say "Fetching the latest code…"
  [ -d src/.git ] || git clone -q --depth 1 https://github.com/daskaputtja/Almanac.git src
  git -C src fetch -q --depth 1 origin main
  if [ "$(git -C src rev-parse HEAD)" = "$(git -C src rev-parse FETCH_HEAD)" ] && [ -n "$before" ]; then
    say "Already up to date."
    exit 0
  fi
  git -C src reset -q --hard FETCH_HEAD
  say "Building (this takes a few minutes)…"
  docker build -q -t almanac:local src >/dev/null
else
  say "Downloading the latest version…"
  docker compose pull -q almanac
fi

docker compose up -d >/dev/null 2>&1
after=$(running_image)
if [ "$before" = "$after" ]; then
  say "Already up to date."
  exit 0
fi

for _ in $(seq 1 30); do
  docker logs --since 2m almanac 2>&1 | grep -q "Almanac is running" && break
  sleep 2
done
docker logs --since 2m almanac 2>&1 | grep -q "Almanac is running" || {
  docker logs --tail 20 almanac 2>&1
  fail "Almanac didn't start after updating. The log is above."
}
docker image prune -f >/dev/null 2>&1 || true
ok "Almanac updated $(date '+%Y-%m-%d %H:%M'). Refresh the page in your browser to see what's new."

# Keep this script itself current (best effort).
tmp=$(mktemp)
if curl -fsSL -m 20 "$SELF_URL" -o "$tmp" 2>/dev/null && head -1 "$tmp" | grep -q '^#!/usr/bin/env bash'; then
  install -m 755 "$tmp" /usr/local/bin/almanac-update
fi
rm -f "$tmp"
