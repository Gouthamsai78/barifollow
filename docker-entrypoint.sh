#!/bin/sh
set -eu

# Mounted volumes (Railway, Docker, bind mounts) arrive owned by root. The app
# runs as `node`, so fix ownership before dropping privileges.
DATA_DIR="$(dirname "${DATABASE_PATH:-/app/data/barifollow.db}")"
mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR" 2>/dev/null || true

  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid=node --regid=node --init-groups "$@"
  elif command -v gosu >/dev/null 2>&1; then
    exec gosu node "$@"
  elif command -v su >/dev/null 2>&1; then
    exec su -s /bin/sh node -c "$(printf '%s ' "$@")"
  fi
fi

exec "$@"
