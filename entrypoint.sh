#!/bin/sh
# Castaway entrypoint.
# - Seeds /var/lib/castaway/config.json on first boot if missing.
# - Generates nginx conf.d snippets via /usr/local/bin/regen.sh.
# - Starts the admin server (Python/Flask) in the background on $ADMIN_PORT.
# - Execs nginx in the foreground (PID 1).
set -eu

CONFIG_FILE="${CASTAWAY_CONFIG:-/var/lib/castaway/config.json}"
ADMIN_PORT="${ADMIN_PORT:-7401}"

if [ ! -f "$CONFIG_FILE" ]; then
  mkdir -p "$(dirname "$CONFIG_FILE")"
  python3 - <<EOF
import json, secrets, string, os
cfg = {
    "stream_key":      os.environ.get("STREAM_KEY")      or "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(16)),
    "stream_title":    os.environ.get("STREAM_TITLE")    or "Live Stream",
    "viewer_password": os.environ.get("VIEWER_PASSWORD") or "",
}
open("$CONFIG_FILE", "w").write(json.dumps(cfg, indent=2))
os.chmod("$CONFIG_FILE", 0o600)
EOF
  echo "castaway: seeded $CONFIG_FILE"
fi
# Tighten perms even if the file already existed from a prior version.
chmod 600 "$CONFIG_FILE" 2>/dev/null || true
chmod 700 "$(dirname "$CONFIG_FILE")" 2>/dev/null || true

/usr/local/bin/regen.sh

if [ -n "${ADMIN_PASSWORD:-}" ]; then
  echo "castaway: admin server starting on :$ADMIN_PORT (password protected)"
else
  echo "castaway: admin server starting on :$ADMIN_PORT (NO ADMIN_PASSWORD set — open access!)"
fi

python3 -u /opt/castaway/server.py 2>&1 &

nginx -t

exec "$@"
