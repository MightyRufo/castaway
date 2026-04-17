#!/bin/sh
# Castaway entrypoint.
# - Seeds /var/lib/castaway/config.json on first boot if missing.
# - Generates nginx conf.d snippets via /usr/local/bin/regen.sh.
# - Starts the admin server (Python/Flask) in the background on $ADMIN_PORT.
# - Execs nginx in the foreground (PID 1).
set -eu

CONFIG_FILE="${CASTAWAY_CONFIG:-/var/lib/castaway/config.json}"
ADMIN_PORT="${ADMIN_PORT:-7401}"

# Pre-seed config from env on first boot only. The admin server can also do
# this, but doing it here means nginx is correctly configured before the
# admin server is even reachable.
if [ ! -f "$CONFIG_FILE" ]; then
  mkdir -p "$(dirname "$CONFIG_FILE")"
  python3 - <<EOF
import json, secrets, string, os
cfg = {
    "stream_key":     os.environ.get("STREAM_KEY")     or "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(16)),
    "stream_title":   os.environ.get("STREAM_TITLE")   or "Live Stream",
    "viewer_password":os.environ.get("VIEWER_PASSWORD") or "",
    "abr_mode":       os.environ.get("ABR_MODE")       or "auto",
}
open("$CONFIG_FILE", "w").write(json.dumps(cfg, indent=2))
EOF
  echo "castaway: seeded $CONFIG_FILE"
fi

# Generate nginx conf.d snippets from config.json.
/usr/local/bin/regen.sh

if [ -n "${ADMIN_PASSWORD:-}" ]; then
  echo "castaway: admin server starting on :$ADMIN_PORT (password protected)"
else
  echo "castaway: admin server starting on :$ADMIN_PORT (NO ADMIN_PASSWORD set — open access!)"
fi

# Background the admin server. Output goes to stdout so docker logs picks it up.
python3 -u /opt/castaway/server.py 2>&1 &

# Tail the ffmpeg ABR log into docker stderr so we can see transcode
# output / errors from `docker logs castaway`. Without this we'd have to
# `docker exec` to read the file — nginx remaps its own fd 2 to its
# error.log file once it takes over PID 1, so a direct redirect to
# /proc/1/fd/2 doesn't reach docker.
mkdir -p /var/log
: >> /var/log/ffmpeg-abr.log
( tail -F /var/log/ffmpeg-abr.log 2>/dev/null | sed -u 's/^/[ffmpeg-abr] /' >&2 ) &

# Validate config one more time before exec.
nginx -t

exec "$@"
