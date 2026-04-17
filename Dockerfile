# syntax=docker/dockerfile:1.7
FROM alpine:3.20

LABEL org.opencontainers.image.title="Castaway"
LABEL org.opencontainers.image.description="Self-hosted single-stream RTMP relay with admin dashboard, viewer-side diagnostics, and Intel QSV adaptive bitrate transcoding."
LABEL org.opencontainers.image.source="https://github.com/MightyRufo/castaway"
LABEL org.opencontainers.image.licenses="MIT"

RUN apk add --no-cache \
        nginx nginx-mod-rtmp \
        ffmpeg \
        intel-media-driver libva-intel-driver mesa-va-gallium \
        python3 py3-flask py3-psutil \
        ca-certificates tzdata \
    && mkdir -p /var/lib/nginx/hls /var/lib/castaway /var/log/nginx /run/nginx /etc/nginx/conf.d /opt/castaway \
    && rm -rf /etc/nginx/http.d/default.conf

COPY nginx/nginx.conf       /etc/nginx/nginx.conf
COPY entrypoint.sh          /usr/local/bin/entrypoint.sh
COPY regen.sh               /usr/local/bin/regen.sh
COPY html/                  /var/www/html/
COPY admin/                 /opt/castaway/

RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/regen.sh

EXPOSE 1935 8080 7401

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -q --spider http://127.0.0.1:8080/health || exit 1

# ADMIN_PASSWORD — required for the admin dashboard. If unset the dashboard
# is open to anyone who reaches the port. Always set this in production.
ENV ADMIN_PASSWORD=""

# ADMIN_PORT — port the admin server listens on.
ENV ADMIN_PORT="7401"

# Initial config can be seeded from these env vars on first boot. Once the
# config file exists at /var/lib/castaway/config.json, env vars are ignored
# and the admin dashboard is the source of truth.
ENV STREAM_KEY=""
ENV STREAM_TITLE="Live Stream"
ENV VIEWER_PASSWORD=""
ENV ABR_MODE="auto"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
