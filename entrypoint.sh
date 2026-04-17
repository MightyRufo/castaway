#!/bin/sh
# Castaway entrypoint. Generates conf.d snippets from environment + hardware
# detection before launching nginx.
set -eu

CONF_DIR=/etc/nginx/conf.d
mkdir -p "$CONF_DIR"

# ============================================================================
# Stream-key auth
# STREAM_KEYS=""        -> no auth, any key publishes
# STREAM_KEYS="a,b,c"   -> only those keys are accepted
# ============================================================================
KEYS=$(printf '%s' "${STREAM_KEYS:-}" | tr -d '[:space:]')
if [ -n "$KEYS" ]; then
  cat > "$CONF_DIR/rtmp-auth.conf" <<EOF
on_publish http://127.0.0.1:8080/auth/publish;
EOF
  {
    echo 'default_type text/plain;'
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

# ============================================================================
# ABR transcoding
# ABR_MODE=auto (default) -> use QSV if /dev/dri exists, else off
# ABR_MODE=qsv             -> force Intel Quick Sync (h264_qsv)
# ABR_MODE=cpu             -> force libx264 (CPU encode — heavy!)
# ABR_MODE=off             -> single-bitrate passthrough
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
  cpu)
    : # libx264 is built-in
    ;;
  off)
    : # nothing to do
    ;;
  *)
    echo "castaway: unknown ABR_MODE='$ABR_MODE', defaulting to OFF"
    ABR_MODE=off
    ;;
esac

# Decide which application generates HLS — only one can write to the dir.
HLS_BLOCK='hls on;
hls_path /var/lib/nginx/hls;
hls_fragment 2s;
hls_playlist_length 8s;
hls_cleanup on;
hls_nested off;'

if [ "$ABR_MODE" != "off" ]; then
  # Build the per-variant encoder args based on mode.
  if [ "$ABR_MODE" = "qsv" ]; then
    V480="-c:v h264_qsv -preset veryfast -b:v 800k -maxrate 1000k -bufsize 1500k -vf format=nv12,hwupload=extra_hw_frames=64,scale_qsv=854:480"
    V720="-c:v h264_qsv -preset veryfast -b:v 2500k -maxrate 3000k -bufsize 5000k -vf format=nv12,hwupload=extra_hw_frames=64,scale_qsv=1280:720"
    V1080="-c:v h264_qsv -preset veryfast -b:v 5500k -maxrate 6500k -bufsize 11000k -vf format=nv12,hwupload=extra_hw_frames=64,scale_qsv=1920:1080"
  else
    V480="-c:v libx264 -preset veryfast -tune zerolatency -b:v 800k -maxrate 1000k -bufsize 1500k -vf scale=854:480"
    V720="-c:v libx264 -preset veryfast -tune zerolatency -b:v 2500k -maxrate 3000k -bufsize 5000k -vf scale=1280:720"
    V1080="-c:v libx264 -preset veryfast -tune zerolatency -b:v 5500k -maxrate 6500k -bufsize 11000k -vf scale=1920:1080"
  fi

  # nginx-rtmp `exec` is one logical line, terminated by ';'. Keep it flat.
  printf 'exec ffmpeg -hide_banner -loglevel warning %s -i rtmp://127.0.0.1:1935/live/$name %s -c:a aac -b:a 96k  -ar 44100 -g 60 -keyint_min 60 -sc_threshold 0 -f flv rtmp://127.0.0.1:1935/stream/${name}_480p %s -c:a aac -b:a 128k -ar 44100 -g 60 -keyint_min 60 -sc_threshold 0 -f flv rtmp://127.0.0.1:1935/stream/${name}_720p %s -c:a aac -b:a 160k -ar 44100 -g 60 -keyint_min 60 -sc_threshold 0 -f flv rtmp://127.0.0.1:1935/stream/${name}_1080p;\n' \
    "$ENC" "$V480" "$V720" "$V1080" > "$CONF_DIR/rtmp-abr.conf"

  cat > "$CONF_DIR/http-abr.conf" <<'EOF'
location ~ ^/hls/(?<channel>[a-zA-Z0-9_-]+)_master\.m3u8$ {
    default_type application/vnd.apple.mpegurl;
    add_header Cache-Control no-cache;
    add_header Access-Control-Allow-Origin "*" always;
    return 200 "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=854x480,CODECS=\"avc1.4d401e,mp4a.40.2\"\n${channel}_480p.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2900000,RESOLUTION=1280x720,CODECS=\"avc1.4d401f,mp4a.40.2\"\n${channel}_720p.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=6300000,RESOLUTION=1920x1080,CODECS=\"avc1.4d4028,mp4a.40.2\"\n${channel}_1080p.m3u8\n";
}
EOF
  # ABR ON: stream app generates per-variant HLS, live app does not.
  : > "$CONF_DIR/live-hls.conf"
  printf '%s\n' "$HLS_BLOCK" > "$CONF_DIR/stream-hls.conf"
  echo "castaway: ABR ENABLED ($ABR_MODE) — 480p / 720p / 1080p variants"
else
  : > "$CONF_DIR/rtmp-abr.conf"
  : > "$CONF_DIR/http-abr.conf"
  # ABR OFF: live app generates direct single-bitrate HLS.
  printf '%s\n' "$HLS_BLOCK" > "$CONF_DIR/live-hls.conf"
  : > "$CONF_DIR/stream-hls.conf"
  echo "castaway: ABR DISABLED (single-bitrate passthrough)"
fi

# ============================================================================
# Viewer password (HTTP basic auth)
# VIEWER_PASSWORD=""        -> open access (default)
# VIEWER_PASSWORD="hunter2" -> browser prompts for username/password.
# VIEWER_USER="viewer"      -> username (default "viewer")
# ============================================================================
if [ -n "${VIEWER_PASSWORD:-}" ]; then
  USER="${VIEWER_USER:-viewer}"
  HTPASSWD=/etc/nginx/.htpasswd
  # bcrypt (-B) is the strongest format htpasswd supports.
  htpasswd -nbB "$USER" "$VIEWER_PASSWORD" > "$HTPASSWD"
  chown root:nginx "$HTPASSWD" 2>/dev/null || true
  chmod 640 "$HTPASSWD"
  cat > "$CONF_DIR/http-auth.conf" <<EOF
auth_basic "Castaway";
auth_basic_user_file $HTPASSWD;
EOF
  echo "castaway: viewer password ENABLED (user='$USER')"
else
  : > "$CONF_DIR/http-auth.conf"
  echo "castaway: viewer password DISABLED (set VIEWER_PASSWORD to enable)"
fi

# Validate config before exec.
nginx -t

exec "$@"
