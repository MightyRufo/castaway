# Castaway

Self-hosted single-stream RTMP relay for Unraid (or any Docker host). OBS pushes to a private key, viewers watch a fullscreen HTML5 player with a real-time **viewer-side** connection diagnostics drawer (bitrate, buffer, latency, dropped frames, stalls). One container = one stream.

## Why

When viewers say "the stream is laggy" you can immediately see whether it's their connection or yours. The stats panel reads `hls.js` and `HTMLVideoElement.getVideoPlaybackQuality()` directly — it reflects exactly what the viewer's browser sees, not the server.

## Features

- **Single-stream model** — one container, one stream. The OBS publish key is private and never appears in URLs or UI.
- **Admin dashboard** on port 7401 — change the stream key, title, and viewer password at runtime. Live stats (publishing state, viewer count, bitrate, uptime, CPU/RAM/disk).
- **Passthrough only** — zero transcoding. nginx-rtmp byte-for-byte relays whatever OBS publishes. Stream at whatever resolution and bitrate you like.
- **HLS in tmpfs** — segments live in RAM (64 MB cap via `--tmpfs`). No SSD wear.
- **Fullscreen, edge-to-edge player** — minimal overlay, auto-hides on idle, click-to-pause, double-click for fullscreen.
- **In-page password gate** — `VIEWER_PASSWORD`. Custom branded login form (no native browser popup), HttpOnly per-boot token cookie. The password is never written to the cookie.
- **Viewer-side stats drawer** — resolution, video bitrate, bandwidth estimate, buffer, latency, dropped frames, stalls. Toggle with `I`.
- **Auto-reconnect** with backoff when the stream drops.
- **Mobile responsive**, **keyboard shortcuts**, **picture-in-picture**.
- **Proxy/tunnel safe** — relative redirects so it works behind Cloudflare Tunnel, NPM, Traefik, port remaps.

## Quick start

```bash
docker run -d --name castaway --restart unless-stopped \
  -p 1935:1935 -p 8080:8080 -p 7401:7401 \
  --tmpfs /var/lib/nginx/hls:rw,size=64m \
  -v /mnt/user/appdata/castaway:/var/lib/castaway \
  -e ADMIN_PASSWORD=hunter2 \
  mightyrufo/castaway:latest
```

Open `http://<host>:7401/`, log in with `ADMIN_PASSWORD`, then set the stream key, title, and (optionally) viewer password from the dashboard.

OBS:
- Service: **Custom**
- Server: `rtmp://<host>:1935/live`
- Stream Key: the value you set in the admin dashboard

Viewers open `http://<host>:8080/`, enter the viewer password, and the stream plays fullscreen automatically.

## Environment variables

Only `ADMIN_PASSWORD` is required. The other env vars seed `/var/lib/castaway/config.json` on first boot; after that the admin dashboard owns the state.

| Var | Default | Description |
|---|---|---|
| `ADMIN_PASSWORD` | *(empty)* | Login for the admin dashboard on port 7401. **Required** if you want the dashboard protected. |
| `STREAM_KEY` | *(random)* | Private publish password. If unset on first boot, a random 16-char key is generated. |
| `STREAM_TITLE` | `Live Stream` | Display name shown above the player. |
| `VIEWER_PASSWORD` | *(empty)* | If set, viewers see the in-page login form. Empty = open access. |

## How it works

```
OBS  ──RTMP──>  /live/<STREAM_KEY>  ──push──>  /show/stream  ──HLS──>  /hls/stream.m3u8  ──>  viewer
                  ↑                               ↑
                  on_publish callback             only fed by
                  validates STREAM_KEY            127.0.0.1
```

- nginx-rtmp accepts publishes on `/live` only after the `on_publish` HTTP callback validates `?name=` matches the configured `stream_key`.
- The source is `push`-relayed to a fixed internal channel `/show/stream` — zero CPU, zero transcoding.
- HLS segments are written from the `/show` application using fixed names (`stream.m3u8`, `stream-N.ts`). Viewers always fetch the same path. The OBS key never appears anywhere viewer-facing.
- HLS files live in tmpfs (`/var/lib/nginx/hls`) so they never touch the host SSD.

## Unraid

1. Drop [`unraid-template.xml`](./unraid-template.xml) into `/boot/config/plugins/dockerMan/templates-user/` renamed to `my-castaway.xml` (Unraid surfaces user templates only with the `my-` prefix).
2. Docker tab → Add Container → User templates → **castaway**.
3. Set `ADMIN_PASSWORD`, then open the admin dashboard on port 7401 to configure the stream.

## Security note

`VIEWER_PASSWORD` and `ADMIN_PASSWORD` use HttpOnly cookies set after server-side password checks. Over plain HTTP that's still cleartext on the wire. **For LAN this is fine.** If you expose Castaway to the internet, terminate TLS in front (NPM, Cloudflare Tunnel, Traefik, Caddy).

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `M` | Mute |
| `F` | Fullscreen |
| `L` | Jump to live edge |
| `I` | Toggle stats drawer |
| `Esc` | Close stats drawer |

## Build from source

```bash
git clone https://github.com/MightyRufo/castaway
cd castaway
docker build -t castaway:dev .
docker run --rm -p 8080:8080 -p 1935:1935 -p 7401:7401 \
  --tmpfs /var/lib/nginx/hls:rw,size=64m \
  -e ADMIN_PASSWORD=dev castaway:dev
```

## License

MIT — see [`LICENSE`](./LICENSE).
