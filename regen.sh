#!/bin/sh
# Regenerate nginx conf.d snippets from /var/lib/castaway/config.json.
# Called by entrypoint at boot AND by the admin server after config edits.
set -eu

CONFIG_FILE="${CASTAWAY_CONFIG:-/var/lib/castaway/config.json}"
CONF_DIR=/etc/nginx/conf.d
mkdir -p "$CONF_DIR"

# Bail early if config doesn't exist yet (admin server will create it).
if [ ! -f "$CONFIG_FILE" ]; then
  echo "regen: config not found at $CONFIG_FILE, leaving conf.d untouched" >&2
  exit 0
fi

# Read scalar fields out of the JSON via python (always available — we
# install it for the admin server).
KEY=$(python3 -c "import json,sys; print(json.load(open('$CONFIG_FILE')).get('stream_key',''))")
TITLE=$(python3 -c "import json,sys; print(json.load(open('$CONFIG_FILE')).get('stream_title','Live Stream'))")
VIEWER_PW=$(python3 -c "import json,sys; print(json.load(open('$CONFIG_FILE')).get('viewer_password',''))")
ABR_MODE=$(python3 -c "import json,sys; print(json.load(open('$CONFIG_FILE')).get('abr_mode','auto'))")

# ---------------------------------------------------------------------------
# Stream key auth (rtmp on_publish)
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
# ABR transcoding (auto/qsv/cpu/off)
# ---------------------------------------------------------------------------
ENC=""
if [ "$ABR_MODE" = "auto" ]; then
  if [ -e /dev/dri/renderD128 ]; then ABR_MODE=qsv; else ABR_MODE=off; fi
fi
case "$ABR_MODE" in
  qsv)
    if ! ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_qsv \
       || [ ! -e /dev/dri/renderD128 ]; then
      ABR_MODE=off
    else
      ENC="-init_hw_device qsv=hw,child_device=/dev/dri/renderD128 -filter_hw_device hw"
    fi
    ;;
  cpu) ;;
  off) ;;
  *) ABR_MODE=off ;;
esac

# Always-on HLS in /show.
cat > "$CONF_DIR/show-hls.conf" <<'EOF'
hls on;
hls_path /var/lib/nginx/hls;
hls_fragment 2s;
hls_playlist_length 8s;
hls_cleanup on;
hls_nested off;
EOF

# Always push source to /show/stream — gives us stream.m3u8 regardless of
# whether ABR transcoding is on. If ffmpeg ABR fails, viewers can still
# watch the source-quality stream.
BASE_PUSH='push rtmp://127.0.0.1:1935/show/stream;'

if [ "$ABR_MODE" = "off" ]; then
  printf '%s\n' "$BASE_PUSH" > "$CONF_DIR/live-relay.conf"
  : > "$CONF_DIR/http-abr.conf"
else
  if [ "$ABR_MODE" = "qsv" ]; then
    V480="-c:v h264_qsv -preset veryfast -b:v 800k -maxrate 1000k -bufsize 1500k -vf format=nv12,hwupload=extra_hw_frames=64,scale_qsv=854:480"
    V720="-c:v h264_qsv -preset veryfast -b:v 2500k -maxrate 3000k -bufsize 5000k -vf format=nv12,hwupload=extra_hw_frames=64,scale_qsv=1280:720"
    V1080="-c:v h264_qsv -preset veryfast -b:v 5500k -maxrate 6500k -bufsize 11000k -vf format=nv12,hwupload=extra_hw_frames=64,scale_qsv=1920:1080"
  else
    V480="-c:v libx264 -preset veryfast -tune zerolatency -b:v 800k -maxrate 1000k -bufsize 1500k -vf scale=854:480"
    V720="-c:v libx264 -preset veryfast -tune zerolatency -b:v 2500k -maxrate 3000k -bufsize 5000k -vf scale=1280:720"
    V1080="-c:v libx264 -preset veryfast -tune zerolatency -b:v 5500k -maxrate 6500k -bufsize 11000k -vf scale=1920:1080"
  fi
  # Source push first, then ffmpeg variants. If ffmpeg dies, source still
  # works — viewers fall back to /hls/stream.m3u8.
  {
    printf '%s\n' "$BASE_PUSH"
    # ffmpeg log goes to /var/log/ffmpeg-abr.log so we can debug failures.
    printf 'exec ffmpeg -hide_banner -loglevel info %s -i rtmp://127.0.0.1:1935/live/$name %s -c:a aac -b:a 96k  -ar 44100 -g 60 -keyint_min 60 -sc_threshold 0 -f flv rtmp://127.0.0.1:1935/show/stream_480p %s -c:a aac -b:a 128k -ar 44100 -g 60 -keyint_min 60 -sc_threshold 0 -f flv rtmp://127.0.0.1:1935/show/stream_720p %s -c:a aac -b:a 160k -ar 44100 -g 60 -keyint_min 60 -sc_threshold 0 -f flv rtmp://127.0.0.1:1935/show/stream_1080p 2>>/var/log/ffmpeg-abr.log;\n' \
      "$ENC" "$V480" "$V720" "$V1080"
  } > "$CONF_DIR/live-relay.conf"
  cat > "$CONF_DIR/http-abr.conf" <<'EOF'
location = /hls/stream_master.m3u8 {
    default_type application/vnd.apple.mpegurl;
    add_header Cache-Control no-cache;
    add_header Access-Control-Allow-Origin "*" always;
    include /etc/nginx/conf.d/http-auth-check.conf;
    return 200 "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=854x480,CODECS=\"avc1.4d401e,mp4a.40.2\"\nstream_480p.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2900000,RESOLUTION=1280x720,CODECS=\"avc1.4d401f,mp4a.40.2\"\nstream_720p.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=6300000,RESOLUTION=1920x1080,CODECS=\"avc1.4d4028,mp4a.40.2\"\nstream_1080p.m3u8\n";
}
EOF
fi

# ---------------------------------------------------------------------------
# Viewer password — in-page login + cookie gate
# ---------------------------------------------------------------------------
if [ -n "$VIEWER_PW" ]; then
  # Per-boot random token. The cookie value is opaque, never the password.
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

# Validate before reload.
nginx -t
