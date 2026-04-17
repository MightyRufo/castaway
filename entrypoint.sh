#!/bin/sh
# Castaway entrypoint. Generates conf.d snippets from environment variables
# before launching nginx, so STREAM_KEYS can be set without rebuilding.
set -eu

CONF_DIR=/etc/nginx/conf.d
mkdir -p "$CONF_DIR"

# --- Stream key validation -------------------------------------------------
# STREAM_KEYS="" or unset  -> no auth, anyone can publish
# STREAM_KEYS="a,b,c"      -> only those keys (used as the OBS stream key)
#                             will be accepted on rtmp://host:1935/live/<key>.
KEYS=$(printf '%s' "${STREAM_KEYS:-}" | tr -d '[:space:]')

if [ -n "$KEYS" ]; then
  cat > "$CONF_DIR/rtmp-auth.conf" <<EOF
on_publish http://127.0.0.1:8080/auth/publish;
EOF

  # Build /auth/publish location body. Default = 403, allow if name matches.
  {
    echo 'default_type text/plain;'
    # nginx-rtmp posts the stream name as the `name` arg.
    OLDIFS=$IFS; IFS=','
    for k in $KEYS; do
      [ -n "$k" ] || continue
      printf 'if ($arg_name = "%s") { return 200 "ok"; }\n' "$k"
    done
    IFS=$OLDIFS
    echo 'return 403 "stream key not authorized\n";'
  } > "$CONF_DIR/keys.conf"

  echo "castaway: stream-key auth ENABLED ($(echo "$KEYS" | tr ',' '\n' | wc -l) key(s))"
else
  : > "$CONF_DIR/rtmp-auth.conf"
  echo 'return 200 "no auth\n";' > "$CONF_DIR/keys.conf"
  echo "castaway: stream-key auth DISABLED (set STREAM_KEYS to enable)"
fi

# Validate config before exec.
nginx -t

exec "$@"
