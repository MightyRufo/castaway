/* Castaway admin dashboard. */
(() => {
  const $ = (id) => document.getElementById(id);

  const fmtBps = (bps) => {
    if (!bps || bps < 1) return '—';
    if (bps > 1e6) return (bps / 1e6).toFixed(2) + ' Mbps';
    if (bps > 1e3) return (bps / 1e3).toFixed(0) + ' kbps';
    return bps.toFixed(0) + ' bps';
  };
  const fmtBytes = (b) => {
    if (b > 1e9) return (b / 1e9).toFixed(2) + ' GB';
    if (b > 1e6) return (b / 1e6).toFixed(1) + ' MB';
    if (b > 1e3) return (b / 1e3).toFixed(0) + ' KB';
    return b + ' B';
  };
  const fmtUptime = (s) => {
    if (!s) return '—';
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m`;
    return `${s}s`;
  };

  const toast = (msg, kind) => {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast visible' + (kind ? ' ' + kind : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.className = 'toast' + (kind ? ' ' + kind : ''); }, 2200);
  };

  const setText = (id, v, cls) => {
    const el = $(id); if (!el) return;
    el.textContent = v;
    el.classList.remove('good', 'warn', 'bad');
    if (cls) el.classList.add(cls);
  };

  const stateBox = { config: null };

  /* --- CSRF token (fetched once, refreshed if a request 403s) --- */
  let csrf = '';
  async function refreshCsrf() {
    try {
      const r = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
      if (r.ok) csrf = (await r.json()).csrf || '';
    } catch (_) {}
  }

  /* --- API --- */
  async function getState() {
    const r = await fetch('/api/state');
    if (r.status === 401) { location.href = '/login'; return null; }
    return await r.json();
  }
  async function postWithCsrf(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      credentials: 'same-origin',
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 403) {
      // Stale CSRF (e.g. session token rotated). Refresh and retry once.
      await refreshCsrf();
      return await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        credentials: 'same-origin',
        body: body ? JSON.stringify(body) : undefined,
      });
    }
    return r;
  }
  async function postConfig(patch) {
    const r = await postWithCsrf('/api/config', patch);
    return await r.json();
  }
  async function regenKey() {
    const r = await postWithCsrf('/api/key/regenerate');
    return await r.json();
  }
  async function logout() {
    const r = await postWithCsrf('/api/auth/logout');
    if (r.redirected) location.href = r.url;
    else location.href = '/login';
  }

  /* --- Render --- */
  function render(s) {
    if (!s) return;
    const cfg = s.config;
    const stats = s.stats;
    stateBox.config = cfg;

    // Status pill
    const pill = $('status-pill');
    if (stats.publishing) {
      pill.textContent = 'Live';
      pill.className = 'pill live';
    } else {
      pill.textContent = 'Offline';
      pill.className = 'pill off';
    }

    // Live card
    setText('kv-publish', stats.publishing ? 'Publishing' : 'Idle', stats.publishing ? 'good' : '');
    setText('kv-viewers', stats.viewers, stats.viewers > 0 ? 'good' : '');
    setText('kv-bw', fmtBps(stats.source_bw_in));
    setText('kv-bytes', fmtBytes(stats.source_bytes_in));
    setText('kv-uptime', fmtUptime(stats.server_uptime));

    // System
    const sys = stats.system;
    setText('kv-cpu', `${sys.cpu_percent.toFixed(1)}%`, sys.cpu_percent > 80 ? 'bad' : sys.cpu_percent > 50 ? 'warn' : 'good');
    setText('kv-mem', `${sys.mem_used_mb} / ${sys.mem_total_mb} MB (${sys.mem_percent.toFixed(0)}%)`,
      sys.mem_percent > 90 ? 'bad' : sys.mem_percent > 70 ? 'warn' : 'good');
    setText('kv-disk', `${(sys.disk_used_mb / 1024).toFixed(1)} / ${(sys.disk_total_mb / 1024).toFixed(1)} GB`);

    // Config inputs (only update if user not actively editing)
    if (document.activeElement.id !== 'cfg-title') $('cfg-title').value = cfg.stream_title || '';
    $('cfg-key').value = cfg.stream_key || '';
    $('viewer-pw-status').textContent = cfg.viewer_password_set
      ? 'Set — viewers must enter a password to watch.'
      : 'Empty — viewers can watch without a password.';

    // OBS / watch URLs derived from the admin host. Cloudflare Tunnel users
    // will see the tunnel hostname automatically since the page knows what
    // hostname it was loaded from.
    const host = location.hostname;
    $('rtmp-url').textContent = `rtmp://${host}:1935/live`;
    $('watch-url').textContent = `${location.protocol}//${host}:8080/`;

    // Connected viewers — uses the module-level fmtUptime defined at top.
    const list = s.clients || [];
    $('viewers-count').textContent = list.length ? `(${list.length})` : '';
    const box = $('viewers-list');
    if (!list.length) {
      box.innerHTML = '<div class="viewers-empty">No one watching right now.</div>';
    } else {
      box.innerHTML = list
        .sort((a, b) => b.duration - a.duration)
        .map(c => {
          const ua = (c.user_agent || '').replace(/.*\((.+?)\).*/, '$1') || c.user_agent || '—';
          return `<div class="viewer-row">
            <span class="v-id">${c.session}</span>
            <span class="v-ip">${c.ip || '—'}</span>
            <span class="v-ua" title="${(c.user_agent||'').replace(/"/g,'&quot;')}">${ua}</span>
            <span class="v-time">${fmtUptime(c.duration)}</span>
          </div>`;
        }).join('');
    }
  }

  /* --- Event wiring --- */
  document.querySelectorAll('button[data-save]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const field = btn.dataset.save;
      let value;
      if (field === 'stream_title') value = $('cfg-title').value;
      else if (field === 'viewer_password') value = $('cfg-viewer-pw').value;
      const r = await postConfig({ [field]: value });
      if (r.ok) {
        toast(`Saved · ${field.replace('_', ' ')}`, 'success');
        if (field === 'viewer_password') $('cfg-viewer-pw').value = '';
        loop();
      } else {
        toast(`Error: ${r.error || 'unknown'}`, 'error');
      }
    });
  });

  $('regen-key-btn').addEventListener('click', async () => {
    if (!confirm('Generate a new stream key? OBS will need to be updated and reconnected.')) return;
    const r = await regenKey();
    if (r.ok) {
      toast('New stream key generated', 'success');
      loop();
    } else {
      toast(`Error: ${r.error || 'unknown'}`, 'error');
    }
  });

  // Copy that works in non-secure contexts too (LAN IPs over plain HTTP
  // can't use navigator.clipboard).
  async function copyText(text, label) {
    if (!text) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        toast(label + ' copied', 'success');
        return;
      }
    } catch (_) { /* fall through to legacy */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
    toast(ok ? (label + ' copied') : 'Copy failed — select manually', ok ? 'success' : 'error');
  }

  $('copy-key-btn').addEventListener('click', () => copyText($('cfg-key').value, 'Stream key'));
  $('copy-watch-btn').addEventListener('click', () => copyText($('watch-url').textContent.trim(), 'Watch URL'));

  $('logout-btn').addEventListener('click', logout);

  /* --- Refresh loop --- */
  async function loop() {
    const s = await getState();
    render(s);
  }
  refreshCsrf().then(loop);
  setInterval(loop, 3000);
})();
