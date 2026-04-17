#!/bin/sh
# Castaway entrypoint. Generates conf.d snippets from environment + hardware
# detection before launching nginx.
#
# Single-stream model: OBS publishes to /live/<STREAM_KEY>. The key is
# validated, then the stream is internally republished to a fixed channel
# `stream` (or, with ABR, ffmpeg fans it out to stream_480p/720p/1080p).
# Viewers always watch /hls/stream.m3u8 — they never see the OBS key.
set -eu

CONF_DIR=/etc/nginx/conf.d
mkdir -p "$CONF_DIR"

# ============================================================================
# Stream key (publish secret)
# STREAM_KEY=""        -> any key publishes (NOT recommended)
# STREAM_KEY="abc123"  -> only that key is accepted as the OBS Stream Key
# ============================================================================
KEY=$(printf '%s' "${STREAM_KEY:-}" | tr -d '[:space:]')
if [ -n "$KEY" ]; then
  cat > "$CONF_DIR/rtmp-auth.conf" <<EOF
on_publish http://127.0.0.1:8080/auth/publish;
EOF
  cat > "$CONF_DIR/keys.conf" <<EOF
default_type text/plain;
if (\$arg_name = "$KEY") { return 200 "ok"; }
return 403 "stream key not authorized\n";
EOF
  echo "castaway: stream key auth ENABLED"
else
  : > "$CONF_DIR/rtmp-auth.conf"
  echo 'return 200 "no auth\n";' > "$CONF_DIR/keys.conf"
  echo "castaway: stream key auth DISABLED (set STREAM_KEY to enable)"
fi

# ============================================================================
# Stream title (display name shown to viewers)
# ============================================================================
TITLE="${STREAM_TITLE:-Live Stream}"

# /api/config — JSON consumed by the player to render the title.
TITLE_ESC=$(printf '%s' "$TITLE" | sed 's/"/\\"/g')
cat > "$CONF_DIR/http-config.conf" <<EOF
default_type application/json;
add_header Cache-Control no-cache;
return 200 '{"title":"$TITLE_ESC"}';
EOF

# ============================================================================
# ABR transcoding
# ABR_MODE=auto (default) -> use QSV if /dev/dri exists, else off
# ABR_MODE=qsv             -> force Intel Quick Sync (h264_qsv)
# ABR_MODE=cpu             -> force libx264 (CPU encode — heavy!)
# ABR_MODE=off             -> single-bitrate passthrough (push, no transcode)
# ============================================================================
ABR_MODE="${ABR_MODE:-auto}"
ENC=""

if [ "$ABR_MODE" = "auto" ]; then
  if [ -e /dev/dri/renderD128 ]; then
    ABR_MODE=qsv
  else
    ABR_MODE=off
  fi
fi

case "$ABR_MODE" in
  qsv)
    if ! ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_qsv; then
      echo "castaway: ABR=qsv requested but ffmpeg has no h264_qsv encoder, falling back to OFF"
      ABR_MODE=off
    elif [ ! -e /dev/dri/renderD128 ]; then
      echo "castaway: ABR=qsv requested but /dev/dri/renderD128 not present, falling back to OFF"
      ABR_MODE=off
    else
      ENC="-init_hw_device qsv=hw,child_device=/dev/dri/renderD128 -filter_hw_device hw"
    fi
    ;;
  cpu) ;;
  off) ;;
  *)
    echo "castaway: unknown ABR_MODE='$ABR_MODE', defaulting to OFF"
    ABR_MODE=off
    ;;
esac

# Always-on HLS in the `show` application — that's where viewers read from.
HLS_BLOCK='hls on;
hls_path /var/lib/nginx/hls;
hls_fragment 2s;
hls_playlist_length 8s;
hls_cleanup on;
hls_nested off;'
printf '%s\n' "$HLS_BLOCK" > "$CONF_DIR/show-hls.conf"

if [ "$ABR_MODE" = "off" ]; then
  # No transcode — push the source bytes verbatim into /show/stream.
  cat > "$CONF_DIR/live-relay.conf" <<'EOF'
push rtmp://127.0.0.1:1935/show/stream;
EOF
  : > "$CONF_DIR/http-abr.conf"
  echo "castaway: ABR DISABLED (single-bitrate, push relay)"

else
  # Transcode — ffmpeg generates 3 variants pushed to /show/stream_<q>.
  if [ "$ABR_MODE" = "qsv" ]; then
    V480="-c:v h264_qsv -preset veryfast -b:v 800k -maxrate 1000k -bufsize 1500k -vf format=nv12,hwupload=extra_hw_frames=64,scale_qsv=854:480"
    V720="-c:v h264_qsv -preset veryfast -b:v 2500k -maxrate 3000k -bufsize 5000k -vf format=nv12,hwupload=extra_hw_frames=64,scale_qsv=1280:720"
    V1080="-c:v h264_qsv -preset veryfast -b:v 5500k -maxrate 6500k -bufsize 11000k -vf format=nv12,hwupload=extra_hw_frames=64,scale_qsv=1920:1080"
  else
    V480="-c:v libx264 -preset veryfast -tune zerolatency -b:v 800k -maxrate 1000k -bufsize 1500k -vf scale=854:480"
    V720="-c:v libx264 -preset veryfast -tune zerolatency -b:v 2500k -maxrate 3000k -bufsize 5000k -vf scale=1280:720"
    V1080="-c:v libx264 -preset veryfast -tune zerolatency -b:v 5500k -maxrate 6500k -bufsize 11000k -vf scale=1920:1080"
  fi

  printf 'exec ffmpeg -hide_banner -loglevel warning %s -i rtmp://127.0.0.1:1935/live/$name %s -c:a aac -b:a 96k  -ar 44100 -g 60 -keyint_min 60 -sc_threshold 0 -f flv rtmp://127.0.0.1:1935/show/stream_480p %s -c:a aac -b:a 128k -ar 44100 -g 60 -keyint_min 60 -sc_threshold 0 -f flv rtmp://127.0.0.1:1935/show/stream_720p %s -c:a aac -b:a 160k -ar 44100 -g 60 -keyint_min 60 -sc_threshold 0 -f flv rtmp://127.0.0.1:1935/show/stream_1080p;\n' \
    "$ENC" "$V480" "$V720" "$V1080" > "$CONF_DIR/live-relay.conf"

  cat > "$CONF_DIR/http-abr.conf" <<'EOF'
location = /hls/stream_master.m3u8 {
    include /etc/nginx/conf.d/http-auth-check.conf;
    default_type application/vnd.apple.mpegurl;
    add_header Cache-Control no-cache;
    add_header Access-Control-Allow-Origin "*" always;
    return 200 "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=854x480,CODECS=\"avc1.4d401e,mp4a.40.2\"\nstream_480p.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2900000,RESOLUTION=1280x720,CODECS=\"avc1.4d401f,mp4a.40.2\"\nstream_720p.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=6300000,RESOLUTION=1920x1080,CODECS=\"avc1.4d4028,mp4a.40.2\"\nstream_1080p.m3u8\n";
}
EOF
  echo "castaway: ABR ENABLED ($ABR_MODE) — 480p / 720p / 1080p variants"
fi

# ============================================================================
# Viewer password — custom in-page login (no browser auth popup)
# VIEWER_PASSWORD=""        -> open access (default)
# VIEWER_PASSWORD="hunter2" -> /login.html prompts; HttpOnly cookie on success.
# ============================================================================
if [ -n "${VIEWER_PASSWORD:-}" ]; then
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
    if (\$arg_password = "$VIEWER_PASSWORD") {
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
  echo "castaway: viewer password ENABLED (in-page login)"
else
  cat > "$CONF_DIR/http-auth-map.conf" <<'EOF'
map $cookie_castaway_auth $authed { default 1; }
EOF
  : > "$CONF_DIR/http-login-route.conf"
  : > "$CONF_DIR/http-auth-check.conf"
  echo "castaway: viewer password DISABLED (set VIEWER_PASSWORD to enable)"
fi

nginx -t

exec "$@"
