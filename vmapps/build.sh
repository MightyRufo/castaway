#!/usr/bin/env bash
# Build Castaway and publish it to VM Apps (Unraid installs/updates it from the VM's registry).
#   vmapps/build.sh            build + publish
#   vmapps/build.sh --local    build the image only
# The icon travels inside the image (label net.vmapps.icon); VM Apps puts it in place on Unraid,
# so nothing is downloaded from the internet for it.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/.." && pwd)"
commit=$(git -C "$ROOT" rev-parse --short HEAD)
# VM Apps updates by digest on ONE fixed tag (his saved settings name it); commit = build only
TAG="castaway:latest"
sudo docker build -q -t "$TAG" --label "net.vmapps.icon=$(base64 -w0 "$HERE/icon.png")" "$ROOT" >/dev/null
echo "built $TAG"
[ "${1:-}" = --local ] && exit 0
REG=192.168.1.219:5000
W=$(mktemp -d /var/tmp/castaway-tpl.XXXX); trap 'rm -rf "$W"' EXIT
sed "s#__IMAGE__#$REG/castaway:latest#" "$HERE/template.xml" > "$W/template.xml"
/srv/vmapps/vmapps-publish castaway "$TAG" "$W/template.xml" "Castaway: single-stream RTMP relay with admin dashboard and viewer page"
