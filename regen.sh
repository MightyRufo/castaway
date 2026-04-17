#!/bin/sh
# Regenerate nginx conf.d snippets from /var/lib/castaway/config.json.
# Called by entrypoint at boot AND by the admin server after config edits.
set -eu

CONFIG_FILE="${CASTAWAY_CONFIG:-/var/lib/castaway/config.json}"
CONF_DIR=/etc/nginx/conf.d
mkdir -p "$CONF_DIR"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "regen: config not found at $CONFIG_FILE, leaving conf.d untouched" >&2
  exit 0
fi

KEY=$(python3 -c "import json,sys; print(json.load(open('$CONFIG_FILE')).get('stream_key',''))")
TITLE=$(python3 -c "import json,sys; print(json.load(open('$CONFIG_FILE')).get('stream_title','Live Stream'))")
VIEWER_PW=$(python3 -c "import json,sys; print(json.load(open('$CONFIG_FILE')).get('viewer_password',''))")

# ---------------------------------------------------------------------------
# Stream-key auth — handled by the Flask admin via on_publish callback.
# nginx-rtmp POSTs the stream name to /auth/publish on Flask (loopback),
# which compares with secrets.compare_digest. The key never appears in any
# URL on the HTTP plane (notify_method post in nginx.conf puts it in the
# request body).
# ---------------------------------------------------------------------------
if [ -n "$KEY" ]; then
  cat > "$CONF_DIR/rtmp-auth.conf" <<'EOF'
on_publish http://127.0.0.1:7401/auth/publish;
EOF
else
  : > "$CONF_DIR/rtmp-auth.conf"
fi

# ---------------------------------------------------------------------------
# Stream title (served via /api/config to the player). Flask /api/config
# already strips control chars + quotes + backslashes from the saved title,
# but defence in depth: do it again here in case the file was hand-edited.
# ---------------------------------------------------------------------------
TITLE_SAFE=$(printf '%s' "$TITLE" | tr -d '\000-\037\047\042\134')
cat > "$CONF_DIR/http-config.conf" <<EOF
default_type application/json;
add_header Cache-Control no-cache;
return 200 '{"title":"$TITLE_SAFE"}';
EOF

# ---------------------------------------------------------------------------
# Stream relay — single-bitrate passthrough.
# ---------------------------------------------------------------------------
cat > "$CONF_DIR/live-relay.conf" <<'EOF'
push rtmp://127.0.0.1:1935/show/stream;
EOF

cat > "$CONF_DIR/show-hls.conf" <<'EOF'
hls on;
hls_path /var/lib/nginx/hls;
hls_fragment 4s;
hls_playlist_length 60s;
hls_cleanup on;
hls_nested off;
EOF

# ---------------------------------------------------------------------------
# Viewer password — in-page login + cookie gate.
# Login is POST and routed to Flask (no password in URL/access log). The
# per-boot AUTH_TOKEN is shared with Flask via /var/lib/castaway/auth_token.
# ---------------------------------------------------------------------------
if [ -n "$VIEWER_PW" ]; then
  AUTH_TOKEN=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)
  printf '%s' "$AUTH_TOKEN" > /var/lib/castaway/auth_token
  chmod 600 /var/lib/castaway/auth_token 2>/dev/null || true

  cat > "$CONF_DIR/http-auth-map.conf" <<EOF
map \$cookie_castaway_auth \$authed {
    default 0;
    "$AUTH_TOKEN" 1;
}
EOF
  cat > "$CONF_DIR/http-login-route.conf" <<'EOF'
location = /login.html { root /var/www/html; }
location = /icon.svg   { root /var/www/html; }

# POST to Flask: viewer password validated server-side, password never in URL.
location = /auth/login {
    proxy_pass http://127.0.0.1:7401/viewer/auth/login;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    access_log off;
}

location = /auth/logout {
    add_header Set-Cookie "castaway_auth=deleted; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" always;
    return 302 /login.html;
}
EOF
  cat > "$CONF_DIR/http-auth-check.conf" <<'EOF'
if ($authed = 0) { return 302 /login.html; }
EOF
else
  : > /var/lib/castaway/auth_token 2>/dev/null || true
  cat > "$CONF_DIR/http-auth-map.conf" <<'EOF'
map $cookie_castaway_auth $authed { default 1; }
EOF
  : > "$CONF_DIR/http-login-route.conf"
  : > "$CONF_DIR/http-auth-check.conf"
fi

nginx -t
