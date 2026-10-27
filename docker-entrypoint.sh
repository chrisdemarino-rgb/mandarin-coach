#!/bin/sh
# Starts the app. Railway (and some other hosts) mount the persistent disk at /data owned by root,
# so we start as root, hand /data to the unprivileged "node" user, then drop privileges.
# If already unprivileged (e.g. plain `docker run --user node`), just run the command.
set -e
DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR" 2>/dev/null || true
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR" 2>/dev/null || echo "warning: could not chown $DATA_DIR (database may be read-only)" >&2
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
