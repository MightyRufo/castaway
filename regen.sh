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
# Stream-key auth (rtmp on_publish)
# ---------------------------------------------------------------------------
if [ -n "$KEY" ]; then
  cat > "$CONF_DIR/rtmp-auth.conf" <<EOF
on_publish http://127.0.0.1:8080/auth/publish;
EOF
  cat > "$CONF_DIR/keys.conf" <<EOF
default_type text/plain;
if (\$arg_name = "$KEY") { return 200 "ok"; }
return 403 "stream key not authorized\n";
EOF
else
  : > "$CONF_DIR/rtmp-auth.conf"
  echo 'return 200 "no auth\n";' > "$CONF_DIR/keys.conf"
fi

# ---------------------------------------------------------------------------
# Stream title (served via /api/config to the player)
# ---------------------------------------------------------------------------
TITLE_ESC=$(printf '%s' "$TITLE" | sed 's/"/\\"/g')
cat > "$CONF_DIR/http-config.conf" <<EOF
default_type application/json;
add_header Cache-Control no-cache;
return 200 '{"title":"$TITLE_ESC"}';
EOF

# ---------------------------------------------------------------------------
# Stream relay — single-bitrate passthrough. OBS publishes whatever
# resolution/bitrate it likes; we pass the bytes through to /show/stream
# so HLS is generated from the source unchanged.
# ---------------------------------------------------------------------------
cat > "$CONF_DIR/live-relay.conf" <<'EOF'
push rtmp://127.0.0.1:1935/show/stream;
EOF

cat > "$CONF_DIR/show-hls.conf" <<'EOF'
hls on;
hls_path /var/lib/nginx/hls;
hls_fragment 2s;
hls_playlist_length 8s;
hls_cleanup on;
hls_nested off;
EOF

# ---------------------------------------------------------------------------
# Viewer password — in-page login + cookie gate
# ---------------------------------------------------------------------------
if [ -n "$VIEWER_PW" ]; then
  AUTH_TOKEN=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)
  cat > "$CONF_DIR/http-auth-map.conf" <<EOF
map \$cookie_castaway_auth \$authed {
    default 0;
    "$AUTH_TOKEN" 1;
}
EOF
  cat > "$CONF_DIR/http-login-route.conf" <<EOF
location = /login.html { root /var/www/html; }
location = /icon.svg   { root /var/www/html; }

location = /auth/login {
    if (\$arg_password = "$VIEWER_PW") {
        add_header Set-Cookie "castaway_auth=$AUTH_TOKEN; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000" always;
        return 302 /;
    }
    return 302 /login.html?bad=1;
}

location = /auth/logout {
    add_header Set-Cookie "castaway_auth=deleted; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" always;
    return 302 /login.html;
}
EOF
  cat > "$CONF_DIR/http-auth-check.conf" <<'EOF'
if ($authed = 0) { return 302 /login.html; }
EOF
else
  cat > "$CONF_DIR/http-auth-map.conf" <<'EOF'
map $cookie_castaway_auth $authed { default 1; }
EOF
  : > "$CONF_DIR/http-login-route.conf"
  : > "$CONF_DIR/http-auth-check.conf"
fi

nginx -t
