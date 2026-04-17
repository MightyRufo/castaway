# Castaway

Self-hosted single-stream RTMP relay for Unraid (or any Docker host). OBS pushes to a private key, viewers watch a fullscreen HTML5 player with a real-time **viewer-side** connection diagnostics drawer (bitrate, buffer, latency, dropped frames, stalls). One container = one stream.

## Why

When viewers say "the stream is laggy" you can immediately see whether it's their connection or yours. The stats panel reads `hls.js` and `HTMLVideoElement.getVideoPlaybackQuality()` directly — it reflects exactly what the viewer's browser sees, not the server.

## Features

- **Single-stream model** — one container, one stream. The OBS publish key is private and never appears in URLs or UI.
- **Fullscreen, edge-to-edge player** — minimal overlay, auto-hides on idle, click-to-pause, double-click for fullscreen.
- **In-page password gate** — `VIEWER_PASSWORD` env. Custom branded login form (no native browser popup), HttpOnly per-boot token cookie. The password is never written to the cookie.
- **Adaptive bitrate (ABR)** via Intel Quick Sync — pass through `/dev/dri` and the container fans the source out to 480p/720p/1080p variants on the GPU. `hls.js` picks the right one for each viewer; manual quality dropdown in the controls.
- **Viewer-side stats drawer** — resolution, video bitrate, bandwidth estimate, buffer, latency, dropped frames, stalls. Toggle with `I`.
- **Auto-reconnect** with backoff when the stream drops.
- **Mobile responsive**, **keyboard shortcuts**, **picture-in-picture**.
- **Proxy/tunnel safe** — relative redirects so it works behind Cloudflare Tunnel, NPM, Traefik, port remaps.

## Quick start

```bash
docker run -d --name castaway --restart unless-stopped \
  -p 1935:1935 -p 8080:8080 \
  -e STREAM_KEY=$(openssl rand -hex 12) \
  -e STREAM_TITLE="My Stream" \
  -e VIEWER_PASSWORD=hunter2 \
  --device=/dev/dri:/dev/dri \
  mightyrufo/castaway:latest
```

OBS:
- Service: **Custom**
- Server: `rtmp://<host>:1935/live`
- Stream Key: the value of `STREAM_KEY` from your container env

Viewers open `http://<host>:8080/`, enter the viewer password, and the stream plays fullscreen automatically.

## Environment variables

| Var | Default | Description |
|---|---|---|
| `STREAM_KEY` | *(empty)* | Private publish password (what you put in OBS as the Stream Key). Generate something random. Never visible to viewers. |
| `STREAM_TITLE` | `Live Stream` | Display name shown above the player. |
| `VIEWER_PASSWORD` | *(empty)* | If set, viewers see the in-page login form. Empty = open access. |
| `ABR_MODE` | `auto` | `auto` (QSV if `/dev/dri` exists, else off), `qsv`, `cpu`, `off`. |

## How it works

```
OBS  ──RTMP──>  /live/<STREAM_KEY>  ──[push or ffmpeg]──>  /show/stream*  ──HLS──>  /hls/stream*.m3u8  ──>  viewer
                  ↑                                          ↑
                  on_publish callback                        only fed by
                  validates STREAM_KEY                       127.0.0.1
                                                              (push relay)
```

- nginx-rtmp accepts publishes on `/live` only after the `on_publish` HTTP callback validates `?name=` matches `STREAM_KEY`.
- Without ABR, the source is `push`-relayed to a fixed internal channel `/show/stream` — zero CPU.
- With ABR, `ffmpeg` reads `/live/<key>` and produces three variants pushed to `/show/stream_480p`, `_720p`, `_1080p` (Intel QSV when `/dev/dri` is available).
- HLS files are written from the `/show` application using fixed names (`stream.m3u8`, `stream_480p.m3u8` …). Viewers always fetch the same path. The OBS key never appears anywhere viewer-facing.

## Adaptive bitrate (ABR) with Intel QSV

Requires an Intel iGPU or Arc GPU and `/dev/dri` mounted into the container. Variants:

| Variant | Resolution | Bitrate |
|---|---|---|
| 480p | 854×480 | 800 kbps |
| 720p | 1280×720 | 2.5 Mbps |
| 1080p | 1920×1080 | 5.5 Mbps |

A master playlist is served at `/hls/stream_master.m3u8`; the player falls back to `/hls/stream.m3u8` when ABR is off.

## Unraid

1. Drop [`unraid-template.xml`](./unraid-template.xml) into `/boot/config/plugins/dockerMan/templates-user/` renamed to `my-castaway.xml` (Unraid surfaces user templates only with the `my-` prefix).
2. Docker tab → Add Container → User templates → **castaway**.
3. Set `STREAM_KEY` (random), optionally `VIEWER_PASSWORD`, `STREAM_TITLE`. Keep `/dev/dri` device mount for QSV.

## Security note

`VIEWER_PASSWORD` uses an HttpOnly cookie set after a server-side password check. Over plain HTTP that's still cleartext on the wire. **For LAN this is fine.** If you expose Castaway to the internet, terminate TLS in front (NPM, Cloudflare Tunnel, Traefik, Caddy).

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
docker run --rm -p 8080:8080 -p 1935:1935 castaway:dev
```

## License

MIT — see [`LICENSE`](./LICENSE).
