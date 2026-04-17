# Castaway

Self-hosted RTMP streaming for Unraid (or any Docker host). OBS pushes a stream in, viewers watch it on a polished, **fullscreen** web player with a real-time **viewer-side** connection diagnostics panel — bitrate, buffer, latency, dropped frames, stalls — so when a viewer says "the stream is laggy" you can immediately see whether it's their connection or yours.

## Features

- **Fullscreen, edge-to-edge player** — minimal overlay, auto-hides on idle, click-to-pause, double-click for fullscreen
- **Lobby page** — `/` lists every channel currently being published, with title / uptime / viewer count
- **Channel slug = title** — OBS stream key `apex-legends` displays as "Apex Legends"
- **Viewer-side diagnostics drawer** — resolution, video bitrate, bandwidth estimate, buffer health, latency, dropped frames, stalls — toggleable, slides in from the right
- **Adaptive bitrate (ABR)** via Intel Quick Sync — pass through `/dev/dri` and the container fans the source out to 480p / 720p / 1080p variants on the GPU. Quality picker in the player.
- **Optional viewer password** — `VIEWER_PASSWORD=hunter2` and the player + HLS endpoints require HTTP Basic Auth (bcrypt-hashed)
- **Optional stream-key auth** — `STREAM_KEYS=alice,bob` and only those keys can publish
- **Auto-reconnect** with backoff when the stream drops
- **Mobile responsive**, **keyboard shortcuts**, **picture-in-picture**

## Quick start

```bash
docker run -d --name castaway --restart unless-stopped \
  -p 1935:1935 -p 8080:8080 \
  mightyrufo/castaway:latest
```

OBS settings:
- Service: **Custom**
- Server: `rtmp://<host>:1935/live`
- Stream Key: anything memorable, e.g. `apex-legends`

Open `http://<host>:8080/` — the lobby will list your live channels. Click one to watch fullscreen.
Direct watch URL: `http://<host>:8080/watch.html?c=apex-legends`

## With everything enabled

```bash
docker run -d --name castaway --restart unless-stopped \
  -p 1935:1935 -p 8080:8080 \
  -e VIEWER_PASSWORD=hunter2 \
  -e VIEWER_USER=viewer \
  -e STREAM_KEYS=alice,bob \
  -e ABR_MODE=auto \
  --device=/dev/dri:/dev/dri \
  mightyrufo/castaway:latest
```

## Environment variables

| Var | Default | Description |
|---|---|---|
| `VIEWER_PASSWORD` | *(empty)* | Browser prompts for credentials. Stored bcrypt-hashed inside the container. Empty = open access. |
| `VIEWER_USER` | `viewer` | Username paired with `VIEWER_PASSWORD`. |
| `STREAM_KEYS` | *(empty)* | Comma-separated allowed OBS stream keys. Empty = any key publishes. |
| `ABR_MODE` | `auto` | `auto` (QSV if `/dev/dri` exists, else off), `qsv`, `cpu`, `off`. |

## Adaptive bitrate (ABR) with Intel QSV

Requires an Intel iGPU or Arc GPU and `/dev/dri` mounted into the container. When enabled, every incoming stream is transcoded into three variants on the GPU (~negligible CPU cost):

| Variant | Resolution | Bitrate |
|---|---|---|
| 480p | 854×480 | 800 kbps |
| 720p | 1280×720 | 2.5 Mbps |
| 1080p | 1920×1080 | 5.5 Mbps |

The player fetches a master playlist that lists all three; `hls.js` picks the right one based on the viewer's bandwidth. A manual quality dropdown appears in the controls bar.

`ABR_MODE=cpu` falls back to libx264 — heavy on Unraid CPU, only use if you don't have a GPU and you really need ABR.

## Unraid

1. Drop [`unraid-template.xml`](./unraid-template.xml) into `/boot/config/plugins/dockerMan/templates-user/`, renamed to `my-castaway.xml` (Unraid only surfaces user templates with the `my-` prefix).
2. Docker tab → Add Container → User templates → **castaway**.
3. Set whatever you want (viewer password, stream keys), apply.
4. For QSV ABR: keep the `/dev/dri` device mount, leave `ABR_MODE=auto`.

## Security note

`VIEWER_PASSWORD` uses HTTP Basic Auth. The username/password is sent on every request — over plain HTTP that's cleartext on the wire. **For LAN use this is fine.** If you expose Castaway to the internet, terminate TLS in front (NPM, Cloudflare Tunnel, Traefik, Caddy) so the credentials are encrypted.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `M` | Mute |
| `F` | Fullscreen |
| `L` | Jump to live edge |
| `I` | Toggle stats drawer |
| `Esc` | Close stats drawer |

## URL params

- `/?c=<key>` — legacy, redirects to `/watch.html?c=<key>`
- `/watch.html?c=<key>` — fullscreen player for that channel

## Build from source

```bash
git clone https://github.com/MightyRufo/castaway
cd castaway
docker build -t castaway:dev .
docker run --rm -p 8080:8080 -p 1935:1935 castaway:dev
```

## Why client-side stats?

The user reporting "laggy stream" is on the receiving end. Server-side stats tell you the server is fine — they don't tell you anything about the user's hop. Castaway reads the stats out of `hls.js` and `HTMLVideoElement.getVideoPlaybackQuality()` so the panel reflects exactly what the viewer's browser sees.

## License

MIT — see [`LICENSE`](./LICENSE).
