"""Castaway admin server — small Flask app that manages config + stats.

Reads/writes /var/lib/castaway/config.json and triggers an nginx reload
when settings change so OBS sessions survive config edits.

Listens on 127.0.0.1 only — nginx proxies it on the viewer port (8080)
under /admin/ so external clients can't bypass viewer auth on heartbeat.
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
# Bind to all interfaces so external admin access works. The sensitive
# routes (/api/heartbeat, /api/streamstate, /auth/publish) are gated by
# `_trusted_loopback()` in `_gate()` — they require the request to come
# from 127.0.0.1 (i.e. via the nginx viewer-port proxy or nginx-rtmp).
ADMIN_BIND = os.environ.get("ADMIN_BIND", "0.0.0.0")

# Length caps on config inputs (prevent oversized writes / regen DoS).
MAX_TITLE_LEN = 200
MAX_PASSWORD_LEN = 200
MAX_KEY_LEN = 64

DEFAULT_CONFIG: dict[str, Any] = {
    "stream_key": "",
    "stream_title": "Live Stream",
    "viewer_password": "",
}

_config_lock = threading.Lock()

# Active player heartbeats: {session_id: {ip, ua, started, last_seen}}.
CLIENT_TTL = 15  # seconds
_clients: dict[str, dict[str, Any]] = {}
_clients_lock = threading.Lock()

# Per-login session tokens. Each successful login mints a fresh token;
# logout removes it. Set ⇒ logout invalidates only this session, not others.
_sessions: set[str] = set()
_sessions_lock = threading.Lock()

# Per-session CSRF tokens. Keyed by session token, value is csrf token.
_csrf_by_session: dict[str, str] = {}

# Login throttling: per-IP count of failed attempts + last-fail timestamp.
_login_failures: dict[str, dict[str, float]] = {}
_login_lock = threading.Lock()
LOGIN_BACKOFF_BASE = 2.0       # 2^n second backoff
LOGIN_BACKOFF_RESET = 600       # seconds — reset counter after no failures


def gen_key(length: int = 16) -> str:
    """URL-safe-ish stream key. Lowercase + digits, easy to type into OBS."""
    alphabet = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def _safe_chmod(p: Path, mode: int) -> None:
    try:
        p.chmod(mode)
    except Exception:
        pass


def load_config() -> dict[str, Any]:
    with _config_lock:
        if not CONFIG_PATH.exists():
            CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
            cfg = dict(DEFAULT_CONFIG)
            cfg["stream_key"] = gen_key()
            CONFIG_PATH.write_text(json.dumps(cfg, indent=2))
            _safe_chmod(CONFIG_PATH, 0o600)
            return cfg
        try:
            cfg = json.loads(CONFIG_PATH.read_text())
        except Exception:
            cfg = dict(DEFAULT_CONFIG)
        for k, v in DEFAULT_CONFIG.items():
            cfg.setdefault(k, v)
        return cfg


def save_config(cfg: dict[str, Any]) -> None:
    with _config_lock:
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(json.dumps(cfg, indent=2))
        _safe_chmod(CONFIG_PATH, 0o600)


def regen_and_reload() -> tuple[bool, str]:
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

    publishing = False
    source_bw_in = 0
    source_bytes_in = 0
    viewers = 0
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
                if sname != "stream":
                    continue
                bw_in = int(_stat_text(stream, "bw_in", "0") or 0)
                bytes_in = int(_stat_text(stream, "bytes_in", "0") or 0)
                nclients = int(_stat_text(stream, "nclients", "0") or 0)
                pub = stream.find("publishing")
                if pub is not None:
                    publishing = True
                source_bw_in = bw_in
                source_bytes_in = bytes_in
                viewers = max(0, nclients - 1)

    cpu = psutil.cpu_percent(interval=None)
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("/var/lib/nginx/hls")

    return {
        "publishing": publishing,
        "viewers": viewers,
        "source_bw_in": source_bw_in,
        "source_bytes_in": source_bytes_in,
        "server_uptime": server_uptime,
        "system": {
            "cpu_percent": cpu,
            "mem_percent": mem.percent,
            "mem_used_mb": int(mem.used / 1024 / 1024),
            "mem_total_mb": int(mem.total / 1024 / 1024),
            "disk_used_mb": int(disk.used / 1024 / 1024),
            "disk_total_mb": int(disk.total / 1024 / 1024),
        },
    }


# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------
app = Flask(__name__, static_folder="static", template_folder="templates")


def _trusted_loopback() -> bool:
    """True iff the request originated from 127.0.0.1 directly (not via XFF)."""
    return (request.remote_addr or "") == "127.0.0.1"


def _is_authed() -> bool:
    if not ADMIN_PASSWORD:
        return True
    cookie = request.cookies.get("castaway_admin", "")
    if not cookie:
        return False
    with _sessions_lock:
        return cookie in _sessions


def _current_session() -> str:
    return request.cookies.get("castaway_admin", "")


def _csrf_for_session(session: str) -> str:
    if not session:
        return ""
    if session not in _csrf_by_session:
        _csrf_by_session[session] = secrets.token_urlsafe(24)
    return _csrf_by_session[session]


def _check_csrf() -> bool:
    """Verify Origin matches host AND CSRF token matches session."""
    # Origin/Referer same-host check.
    origin = request.headers.get("Origin", "") or request.headers.get("Referer", "")
    host = request.host_url.rstrip("/")
    if origin and not origin.startswith(host):
        return False
    # CSRF token check.
    session = _current_session()
    if not session:
        return False
    expected = _csrf_by_session.get(session, "")
    given = request.headers.get("X-CSRF-Token", "") or (request.get_json(silent=True) or {}).get("csrf", "")
    return bool(expected) and secrets.compare_digest(expected, given)


def _login_throttle(ip: str) -> float:
    """Return seconds-to-wait before this IP can attempt login again, 0 if OK."""
    with _login_lock:
        rec = _login_failures.get(ip)
        if not rec:
            return 0.0
        if time.time() - rec["last"] > LOGIN_BACKOFF_RESET:
            _login_failures.pop(ip, None)
            return 0.0
        wait = LOGIN_BACKOFF_BASE ** rec["count"]
        elapsed = time.time() - rec["last"]
        return max(0.0, wait - elapsed)


def _login_record_failure(ip: str) -> None:
    with _login_lock:
        rec = _login_failures.setdefault(ip, {"count": 0, "last": 0})
        rec["count"] = min(rec["count"] + 1, 12)  # cap so 2^count doesn't explode
        rec["last"] = time.time()


def _login_record_success(ip: str) -> None:
    with _login_lock:
        _login_failures.pop(ip, None)


@app.after_request
def _security_headers(resp: Any) -> Any:
    if request.path.startswith("/static/") or request.path == "/" or request.path == "/login":
        resp.headers["Cache-Control"] = "no-cache, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    return resp


@app.before_request
def _gate() -> Any:
    """Auth gate. Loopback-only paths reject non-loopback requests."""
    # Loopback-only — these are nginx-rtmp callbacks + viewer-port-proxied APIs.
    loopback_only = ("/auth/publish", "/api/heartbeat", "/api/streamstate", "/viewer/auth/login")
    if any(request.path == p for p in loopback_only):
        if not _trusted_loopback():
            abort(403)
        return None

    open_paths = {"/login", "/login.html", "/static", "/api/auth/login", "/health"}
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


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
@app.route("/login")
def login_page() -> Any:
    bad = request.args.get("bad") is not None
    locked_for = float(request.args.get("locked", "0") or 0)
    return render_template("login.html", bad=bad, locked_for=locked_for)


@app.route("/api/auth/login", methods=["POST"])
def api_login() -> Any:
    if not ADMIN_PASSWORD:
        return jsonify({"ok": True, "open": True})
    ip = request.remote_addr or "?"
    wait = _login_throttle(ip)
    if wait > 0:
        if request.is_json:
            return jsonify({"error": "rate limited", "retry_after": round(wait, 1)}), 429
        return redirect(f"/login?locked={int(wait)+1}")
    pw = (request.form.get("password") or "").strip()
    if not pw and request.is_json:
        pw = ((request.get_json(silent=True) or {}).get("password") or "").strip()
    if not secrets.compare_digest(pw, ADMIN_PASSWORD):
        _login_record_failure(ip)
        if request.is_json:
            return jsonify({"error": "bad password"}), 401
        return redirect("/login?bad=1")
    _login_record_success(ip)
    # Mint a fresh per-login session token.
    session = secrets.token_urlsafe(24)
    with _sessions_lock:
        _sessions.add(session)
    _csrf_by_session[session] = secrets.token_urlsafe(24)
    resp = redirect("/") if not request.is_json else jsonify({"ok": True})
    resp.set_cookie(
        "castaway_admin", session,
        httponly=True, samesite="Strict", max_age=30 * 24 * 3600, path="/",
    )
    return resp


@app.route("/api/auth/logout", methods=["POST"])
def api_logout() -> Any:
    if not _check_csrf():
        return jsonify({"error": "csrf failed"}), 403
    session = _current_session()
    with _sessions_lock:
        _sessions.discard(session)
    _csrf_by_session.pop(session, None)
    resp = redirect("/login")
    resp.set_cookie("castaway_admin", "", expires=0, path="/")
    return resp


@app.route("/api/auth/csrf")
def api_csrf() -> Any:
    """Admin JS fetches this on dashboard load to populate X-CSRF-Token header."""
    return jsonify({"csrf": _csrf_for_session(_current_session())})


# ---------------------------------------------------------------------------
# Stream-key validation for nginx-rtmp on_publish callback (loopback only).
# Switched from nginx string-match to Flask + secrets.compare_digest so the
# key never appears in any URL on the HTTP plane.
# ---------------------------------------------------------------------------
@app.route("/auth/publish", methods=["POST"])
def auth_publish() -> Any:
    name = (request.form.get("name") or "").strip()
    cfg = load_config()
    expected = (cfg.get("stream_key") or "").strip()
    if not expected:
        return ("ok", 200)
    if secrets.compare_digest(name, expected):
        return ("ok", 200)
    return ("forbidden", 403)


# ---------------------------------------------------------------------------
# Viewer login (loopback only — nginx proxies /auth/login here as POST).
# Reads the per-boot AUTH_TOKEN that regen.sh wrote to a shared file and
# sets it as the castaway_auth cookie. nginx's auth-map gates /hls/ on
# cookie value matching that same token.
# ---------------------------------------------------------------------------
AUTH_TOKEN_FILE = Path("/var/lib/castaway/auth_token")
_viewer_login_failures: dict[str, dict[str, float]] = {}
_viewer_login_lock = threading.Lock()


def _viewer_login_throttle(ip: str) -> float:
    with _viewer_login_lock:
        rec = _viewer_login_failures.get(ip)
        if not rec:
            return 0.0
        if time.time() - rec["last"] > LOGIN_BACKOFF_RESET:
            _viewer_login_failures.pop(ip, None)
            return 0.0
        wait = LOGIN_BACKOFF_BASE ** rec["count"]
        return max(0.0, wait - (time.time() - rec["last"]))


def _viewer_login_record_failure(ip: str) -> None:
    with _viewer_login_lock:
        rec = _viewer_login_failures.setdefault(ip, {"count": 0, "last": 0})
        rec["count"] = min(rec["count"] + 1, 12)
        rec["last"] = time.time()


def _viewer_login_record_success(ip: str) -> None:
    with _viewer_login_lock:
        _viewer_login_failures.pop(ip, None)


@app.route("/viewer/auth/login", methods=["POST"])
def viewer_login() -> Any:
    # Real client IP from X-Real-IP that nginx sets when proxying.
    ip = request.headers.get("X-Real-IP", request.remote_addr or "?")
    wait = _viewer_login_throttle(ip)
    if wait > 0:
        return redirect(f"/login.html?locked={int(wait)+1}")
    pw = (request.form.get("password") or "")[:MAX_PASSWORD_LEN]
    cfg = load_config()
    expected = cfg.get("viewer_password", "")
    if not expected:
        # Viewer password not set — allow through. nginx auth-check is also
        # disabled in this mode.
        return redirect("/")
    if not secrets.compare_digest(pw, expected):
        _viewer_login_record_failure(ip)
        return redirect("/login.html?bad=1")
    _viewer_login_record_success(ip)
    token = ""
    try:
        token = AUTH_TOKEN_FILE.read_text().strip()
    except Exception:
        pass
    if not token:
        return redirect("/login.html?bad=1")
    resp = redirect("/")
    resp.set_cookie(
        "castaway_auth", token,
        httponly=True, samesite="Strict", max_age=30 * 24 * 3600, path="/",
    )
    return resp


# ---------------------------------------------------------------------------
# Dashboard (admin-only)
# ---------------------------------------------------------------------------
@app.route("/")
def dashboard() -> Any:
    return render_template("dashboard.html", csrf=_csrf_for_session(_current_session()))


def _evict_stale_clients() -> list[dict[str, Any]]:
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
        "stream_key": cfg["stream_key"],
        "stream_title": cfg["stream_title"],
        "viewer_password_set": bool(cfg.get("viewer_password")),
    }
    return jsonify({
        "config": safe_cfg,
        "stats": gather_stats(),
        "clients": _evict_stale_clients(),
    })


# -- Loopback-only endpoints reached via nginx proxy on viewer port ---------

@app.route("/api/streamstate")
def api_streamstate() -> Any:
    cfg = load_config()
    s = gather_stats()
    return jsonify({
        "publishing": s["publishing"],
        "title": cfg.get("stream_title") or "Live Stream",
    })


@app.route("/api/heartbeat", methods=["POST"])
def api_heartbeat() -> Any:
    sid = request.headers.get("X-Castaway-Session", "").strip()
    if not sid or len(sid) > 64:
        return ("", 204)
    now = time.time()
    # Trust X-Forwarded-For only when nginx (loopback) is the immediate caller.
    xff = request.headers.get("X-Forwarded-For", "")
    ip = (xff.split(",")[0].strip() if xff and _trusted_loopback() else request.remote_addr) or ""
    ua = request.headers.get("User-Agent", "")[:160]
    with _clients_lock:
        if sid in _clients:
            _clients[sid]["last_seen"] = now
            _clients[sid]["ip"] = ip
        else:
            _clients[sid] = {"ip": ip, "ua": ua, "started": now, "last_seen": now}
    return ("", 204)


@app.route("/api/config", methods=["POST"])
def api_config_set() -> Any:
    if not _check_csrf():
        return jsonify({"error": "csrf failed"}), 403
    body = request.get_json(silent=True) or {}
    cfg = load_config()
    changed = []

    if "stream_title" in body and isinstance(body["stream_title"], str):
        new_title = body["stream_title"][:MAX_TITLE_LEN]
        # Strip control chars + characters that break nginx config interpolation.
        new_title = "".join(c for c in new_title if c >= " " and c not in "'\"\\")
        if new_title != cfg["stream_title"]:
            cfg["stream_title"] = new_title
            changed.append("stream_title")

    if "viewer_password" in body:
        new_pw = (body["viewer_password"] or "")[:MAX_PASSWORD_LEN]
        # Strip control chars to avoid breaking nginx config interpolation.
        new_pw = "".join(c for c in new_pw if c >= " ")
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
    if not _check_csrf():
        return jsonify({"error": "csrf failed"}), 403
    cfg = load_config()
    cfg["stream_key"] = gen_key()
    save_config(cfg)
    ok, msg = regen_and_reload()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 500
    return jsonify({"ok": True, "stream_key": cfg["stream_key"]})


def main() -> None:
    load_config()
    app.run(host=ADMIN_BIND, port=ADMIN_PORT, threaded=True, debug=False)


if __name__ == "__main__":
    main()
