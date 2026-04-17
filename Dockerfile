# syntax=docker/dockerfile:1.7
FROM alpine:3.20

LABEL org.opencontainers.image.title="Castaway"
LABEL org.opencontainers.image.description="Self-hosted RTMP streaming with viewer-side connection diagnostics."
LABEL org.opencontainers.image.source="https://github.com/MightyRufo/castaway"
LABEL org.opencontainers.image.licenses="MIT"

RUN apk add --no-cache nginx nginx-mod-rtmp ca-certificates tzdata \
    && mkdir -p /var/lib/nginx/hls /var/log/nginx /run/nginx /etc/nginx/conf.d \
    && rm -rf /etc/nginx/http.d/default.conf

COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh    /usr/local/bin/entrypoint.sh
COPY html/            /var/www/html/

RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 1935 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -q --spider http://127.0.0.1:8080/health || exit 1

# STREAM_KEYS — comma-separated allowed stream keys. Empty = no auth.
ENV STREAM_KEYS=""

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
