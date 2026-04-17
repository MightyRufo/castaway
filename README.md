# Castaway

Self-hosted RTMP streaming for Unraid (or any Docker host). OBS pushes a stream in, viewers watch it on a polished web player with a real-time **viewer-side** connection diagnostics panel — bitrate, buffer, latency, dropped frames, stalls — so when a viewer says "the stream is laggy" you can immediately see whether it's their connection or yours.

## Features

- **Tiny** — alpine + nginx + nginx-mod-rtmp, image is ~12 MB.
- **Polished player** — custom controls, fullscreen, picture-in-picture, mobile-responsive, keyboard shortcuts.
- **Viewer-side diagnostics** — resolution, video bitrate, bandwidth estimate, buffer health, latency to live edge, dropped frames, stall count. Computed entirely client-side.
- **Live-edge sync indicator** — one-click "Live" button when you've drifted behind.
- **Auto-reconnect** — offline placeholder with backoff while waiting for the stream.
- **Multi-channel** — multiple stream keys map to multiple watch URLs.
- **Optional stream-key auth** — set `STREAM_KEYS=foo,bar` to allow only those keys to publish.
- **Single container, single image** — no sidecar processes, no database.

## Quick start

```bash
docker run -d --name castaway --restart unless-stopped \
  -p 1935:1935 -p 8080:8080 \
  mightyrufo/castaway:latest
```

OBS settings:
- Service: **Custom**
- Server: `rtmp://<host>:1935/live`
- Stream Key: anything (default channel = `live`)

Watch at `http://<host>:8080/?c=<stream-key>`

## Stream-key auth

By default any key publishes. To restrict:

```bash
docker run -d --name castaway \
  -e STREAM_KEYS=alice,bob,charlie \
  -p 1935:1935 -p 8080:8080 \
  mightyrufo/castaway:latest
```

Only `alice`, `bob`, or `charlie` will be accepted as the OBS stream key.

## Unraid

1. Drop [`unraid-template.xml`](./unraid-template.xml) into `/boot/config/plugins/dockerMan/templates-user/`, renamed to `my-castaway.xml` (Unraid only surfaces user templates with the `my-` prefix).
2. Docker tab → Add Container → User templates → **castaway**.
3. Defaults are sane (1935 + 8080); apply.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `M` | Mute |
| `F` | Fullscreen |
| `L` | Jump to live edge |
| `I` | Toggle stats overlay |

## URL params

- `?c=<key>` — stream channel (default `live`). `?key=<key>` works as an alias.

## Build from source

```bash
git clone https://github.com/MightyRufo/castaway
cd castaway
docker build -t castaway:dev .
docker run --rm -p 8080:8080 -p 1935:1935 castaway:dev
```

## Why client-side stats?

The whole point: the user reporting "laggy stream" is on the receiving end. Server-side stats tell you the server is fine — they don't tell you anything about the user's hop. Castaway reads the stats out of `hls.js` + `HTMLVideoElement.getVideoPlaybackQuality()` so the panel reflects exactly what the viewer's browser sees.

## License

MIT — see [`LICENSE`](./LICENSE).
