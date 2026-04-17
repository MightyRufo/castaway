"""Castaway admin server — small Flask app that manages config + stats.

Reads/writes /var/lib/castaway/config.json and triggers an nginx reload
when settings change so OBS sessions survive config edits.
"""
from __future__ import annotations

import json
import os
import secrets
import string
import subprocess
import threading
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

import psutil
from flask import (
    Flask, abort, jsonify, redirect, render_template, request, send_from_directory
)
import urllib.request

CONFIG_PATH = Path(os.environ.get("CASTAWAY_CONFIG", "/var/lib/castaway/config.json"))
REGEN_SCRIPT = os.environ.get("CASTAWAY_REGEN", "/usr/local/bin/regen.sh")
NGINX_STAT_URL = os.environ.get("CASTAWAY_STAT_URL", "http://127.0.0.1:8080/stat")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
ADMIN_PORT = int(os.environ.get("ADMIN_PORT", "7401"))

# Per-boot random session token. Stored as the admin cookie value so the
# password itself never lives in cookie storage.
SESSION_TOKEN = secrets.token_urlsafe(24)

DEFAULT_CONFIG: dict[str, Any] = {
    "stream_key": "",
    "stream_title": "Live Stream",
    "viewer_password": "",
    "abr_mode": "auto",
}

_config_lock = threading.Lock()

# Active player heartbeats: {session_id: {ip, ua, started, last_seen}}.
# Sessions older than CLIENT_TTL with no heartbeat are evicted.
CLIENT_TTL = 15  # seconds
_clients: dict[str, dict[str, Any]] = {}
_clients_lock = threading.Lock()


def gen_key(length: int = 16) -> str:
    """URL-safe-ish stream key. Lowercase + digits, easy to type into OBS."""
    alphabet = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def load_config() -> dict[str, Any]:
    with _config_lock:
        if not CONFIG_PATH.exists():
            CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
            cfg = dict(DEFAULT_CONFIG)
            cfg["stream_key"] = gen_key()
            CONFIG_PATH.write_text(json.dumps(cfg, indent=2))
            return cfg
        try:
            cfg = json.loads(CONFIG_PATH.read_text())
        except Exception:
            cfg = dict(DEFAULT_CONFIG)
        # Backfill any missing keys (forward-compat for new fields).
        for k, v in DEFAULT_CONFIG.items():
            cfg.setdefault(k, v)
        return cfg


def save_config(cfg: dict[str, Any]) -> None:
    with _config_lock:
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(json.dumps(cfg, indent=2))


def regen_and_reload() -> tuple[bool, str]:
    """Regenerate nginx conf.d snippets and tell nginx to reload."""
    try:
        r = subprocess.run([REGEN_SCRIPT], capture_output=True, text=True, timeout=10)
        if r.returncode != 0:
            return False, f"regen failed: {r.stderr or r.stdout}"
        r = subprocess.run(["nginx", "-s", "reload"], capture_output=True, text=True, timeout=5)
        if r.returncode != 0:
            return False, f"reload failed: {r.stderr or r.stdout}"
        return True, "reloaded"
    except Exception as e:
        return False, str(e)


def _fetch_stat_xml() -> ET.Element | None:
    try:
        with urllib.request.urlopen(NGINX_STAT_URL, timeout=2) as r:
            return ET.fromstring(r.read())
    except Exception:
        return None


def _stat_text(node: ET.Element | None, path: str, default: str = "") -> str:
    if node is None:
        return default
    el = node.find(path)
    return el.text if el is not None and el.text is not None else default


def gather_stats() -> dict[str, Any]:
    root = _fetch_stat_xml()

    server_uptime = int(_stat_text(root, "uptime", "0") or "0") // 1000

    # The relay (push or ffmpeg-exec) makes the source stream show up under
    # the `show` application, not `live`. So /show/stream is the source of
    # truth for whether something is being published. Variants (stream_480p
    # etc.) live alongside it.
    publishing = False
    source_bw_in = 0
    source_bytes_in = 0
    viewers = 0
    variants: list[dict[str, Any]] = []
    if root is not None:
        for app in root.iter("application"):
            name = _stat_text(app, "name")
            if name != "show":
                continue
            live_el = app.find("live")
            if live_el is None:
                continue
            for stream in live_el.findall("stream"):
                sname = _stat_text(stream, "name")
                bw_in = int(_stat_text(stream, "bw_in", "0") or 0)
                bytes_in = int(_stat_text(stream, "bytes_in", "0") or 0)
                nclients = int(_stat_text(stream, "nclients", "0") or 0)
                pub = stream.find("publishing")

                if sname == "stream":
                    if pub is not None:
                        publishing = True
                    source_bw_in = bw_in
                    source_bytes_in = bytes_in
                    # Subtract 1 for the publisher itself.
                    viewers = max(0, nclients - 1)
                elif sname.startswith("stream_"):
                    variants.append({
                        "name": sname,
                        "bw_in": bw_in,
                        "viewers": max(0, nclients - 1),
                    })

    cpu = psutil.cpu_percent(interval=None)
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("/var/lib/nginx/hls")

    return {
        "publishing": publishing,
        "viewers": viewers,
        "source_bw_in": source_bw_in,
        "source_bytes_in": source_bytes_in,
        "variants": variants,
        "server_uptime": server_uptime,
        "system": {
            "cpu_percent": cpu,
            "mem_percent": mem.percent,
            "mem_used_mb": int(mem.used / 1024 / 1024),
            "mem_total_mb": int(mem.total / 1024 / 1024),
            "disk_used_mb": int(disk.used / 1024 / 1024),
            "disk_total_mb": int(disk.total / 1024 / 1024),
        },
        "gpu_present": Path("/dev/dri/renderD128").exists(),
    }


# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------
app = Flask(__name__, static_folder="static", template_folder="templates")


def _is_authed() -> bool:
    if not ADMIN_PASSWORD:
        # Open mode (Mark warned: only for trial). Treat as authed.
        return True
    return request.cookies.get("castaway_admin") == SESSION_TOKEN


@app.before_request
def _gate() -> Any:
    """Redirect to login for HTML, return 401 for API.

    /api/heartbeat and /api/streamstate are reached via the nginx-proxied
    viewer port, where the viewer-auth check has already been applied.
    The admin auth check would block them, so they're explicitly open here.
    """
    open_paths = {
        "/login", "/login.html", "/static",
        "/api/auth/login", "/health",
        "/api/heartbeat", "/api/streamstate",
    }
    if any(request.path == p or request.path.startswith(p + "/") for p in open_paths):
        return None
    if _is_authed():
        return None
    if request.path.startswith("/api/"):
        return jsonify({"error": "unauthorized"}), 401
    return redirect("/login")


@app.route("/health")
def health() -> Any:
    return "ok", 200


@app.route("/login")
def login_page() -> Any:
    bad = request.args.get("bad") is not None
    return render_template("login.html", bad=bad)


@app.route("/api/auth/login", methods=["POST"])
def api_login() -> Any:
    if not ADMIN_PASSWORD:
        return jsonify({"ok": True, "open": True})
    pw = (request.form.get("password") or request.json.get("password") if request.is_json
          else request.form.get("password")) or ""
    if not secrets.compare_digest(pw, ADMIN_PASSWORD):
        return redirect("/login?bad=1") if not request.is_json else (jsonify({"error": "bad password"}), 401)
    resp = redirect("/") if not request.is_json else jsonify({"ok": True})
    resp.set_cookie(
        "castaway_admin", SESSION_TOKEN,
        httponly=True, samesite="Lax", max_age=30 * 24 * 3600, path="/",
    )
    return resp


@app.route("/api/auth/logout", methods=["POST", "GET"])
def api_logout() -> Any:
    resp = redirect("/login")
    resp.set_cookie("castaway_admin", "", expires=0, path="/")
    return resp


@app.route("/")
def dashboard() -> Any:
    return render_template("dashboard.html")


def _evict_stale_clients() -> list[dict[str, Any]]:
    """Drop clients that haven't sent a heartbeat in CLIENT_TTL seconds.

    Returns the still-active list as plain dicts safe for JSON.
    """
    now = time.time()
    out: list[dict[str, Any]] = []
    with _clients_lock:
        for sid in list(_clients):
            c = _clients[sid]
            if now - c["last_seen"] > CLIENT_TTL:
                _clients.pop(sid, None)
                continue
            out.append({
                "session": sid[:8],
                "ip": c["ip"],
                "user_agent": c["ua"],
                "duration": int(now - c["started"]),
                "idle": int(now - c["last_seen"]),
            })
    return out


@app.route("/api/state")
def api_state() -> Any:
    cfg = load_config()
    safe_cfg = {
        "stream_key": cfg["stream_key"],  # admin can see it
        "stream_title": cfg["stream_title"],
        "viewer_password_set": bool(cfg.get("viewer_password")),
        "abr_mode": cfg["abr_mode"],
    }
    return jsonify({
        "config": safe_cfg,
        "stats": gather_stats(),
        "clients": _evict_stale_clients(),
    })


# -- Open endpoints reached via the nginx proxy on the viewer port ----------

@app.route("/api/streamstate")
def api_streamstate() -> Any:
    """Public-ish: just `{publishing: bool, title: str}`. Used by the
    player to drive its state machine without spamming HLS requests when
    nothing is live."""
    cfg = load_config()
    s = gather_stats()
    return jsonify({
        "publishing": s["publishing"],
        "title": cfg.get("stream_title") or "Live Stream",
        "abr": cfg.get("abr_mode") != "off",
    })


@app.route("/api/heartbeat", methods=["POST"])
def api_heartbeat() -> Any:
    """Player POSTs every 5s with X-Castaway-Session header. Used to count
    active viewers in the admin dashboard."""
    sid = request.headers.get("X-Castaway-Session", "").strip()
    if not sid or len(sid) > 64:
        return ("", 204)
    now = time.time()
    # Trust X-Forwarded-For if set (nginx adds it); else remote_addr.
    ip = request.headers.get("X-Forwarded-For", request.remote_addr or "").split(",")[0].strip()
    ua = request.headers.get("User-Agent", "")[:160]
    with _clients_lock:
        if sid in _clients:
            _clients[sid]["last_seen"] = now
            _clients[sid]["ip"] = ip
        else:
            _clients[sid] = {
                "ip": ip,
                "ua": ua,
                "started": now,
                "last_seen": now,
            }
    return ("", 204)


@app.route("/api/config", methods=["POST"])
def api_config_set() -> Any:
    body = request.get_json(silent=True) or {}
    cfg = load_config()
    changed = []
    for field in ("stream_title", "abr_mode"):
        if field in body and isinstance(body[field], str):
            if body[field] != cfg[field]:
                cfg[field] = body[field]
                changed.append(field)
    if "viewer_password" in body:
        # "" clears the password.
        new_pw = body["viewer_password"] or ""
        if new_pw != cfg.get("viewer_password", ""):
            cfg["viewer_password"] = new_pw
            changed.append("viewer_password")
    save_config(cfg)
    if changed:
        ok, msg = regen_and_reload()
        if not ok:
            return jsonify({"ok": False, "error": msg, "changed": changed}), 500
    return jsonify({"ok": True, "changed": changed})


@app.route("/api/key/regenerate", methods=["POST"])
def api_regenerate_key() -> Any:
    cfg = load_config()
    cfg["stream_key"] = gen_key()
    save_config(cfg)
    ok, msg = regen_and_reload()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 500
    return jsonify({"ok": True, "stream_key": cfg["stream_key"]})


def main() -> None:
    # Ensure config exists (also seeds initial random key).
    load_config()
    # Use the simple Flask dev server — fine for a single-user admin UI.
    app.run(host="0.0.0.0", port=ADMIN_PORT, threaded=True, debug=False)


if __name__ == "__main__":
    main()
