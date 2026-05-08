/* Castaway admin dashboard. */
(() => {
  const $ = (id) => document.getElementById(id);

  /* ---- Formatters ---- */
  const fmtBps = (bps) => {
    if (!bps || bps < 1) return '—';
    if (bps > 1e6) return (bps / 1e6).toFixed(2) + ' Mbps';
    if (bps > 1e3) return (bps / 1e3).toFixed(0) + ' kbps';
    return bps.toFixed(0) + ' bps';
  };
  const fmtBytes = (b) => {
    if (!b) return '—';
    if (b > 1e9) return (b / 1e9).toFixed(2) + ' GB';
    if (b > 1e6) return (b / 1e6).toFixed(1) + ' MB';
    if (b > 1e3) return (b / 1e3).toFixed(0) + ' KB';
    return b + ' B';
  };
  const fmtUptime = (s) => {
    if (!s && s !== 0) return '—';
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m`;
    return `${s}s`;
  };
  const fmtAge = (ts) => {
    if (!ts) return '';
    const s = Math.floor(Date.now() / 1000 - ts);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), h = Math.floor(s / 3600);
    if (h) return `${h}h ${m % 60}m`;
    return `${m}m`;
  };
  const fmtDate = (ts) => {
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const parseUA = (ua) => {
    if (!ua) return '—';
    let browser = 'Unknown';
    if (/Edg\//.test(ua))            browser = 'Edge';
    else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
    else if (/Chrome\//.test(ua))    browser = 'Chrome';
    else if (/Firefox\//.test(ua))   browser = 'Firefox';
    else if (/Safari\//.test(ua))    browser = 'Safari';
    let os = '';
    if (/Windows NT/.test(ua))       os = 'Windows';
    else if (/iPhone/.test(ua))      os = 'iPhone';
    else if (/iPad/.test(ua))        os = 'iPad';
    else if (/Android/.test(ua))     os = 'Android';
    else if (/Mac OS X/.test(ua))    os = 'macOS';
    else if (/Linux/.test(ua))       os = 'Linux';
    return os ? `${browser} · ${os}` : browser;
  };

  /* ---- Toast ---- */
  const toast = (msg, kind) => {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast visible' + (kind ? ' ' + kind : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.className = 'toast' + (kind ? ' ' + kind : ''); }, 2200);
  };
  const setVal = (id, v, cls) => {
    const el = $(id); if (!el) return;
    el.textContent = v;
    el.classList.remove('good', 'warn', 'bad');
    if (cls) el.classList.add(cls);
  };

  /* ---- Sidebar nav ---- */
  let activeSection = 'overview';
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const sec = item.dataset.section;
      if (!sec) return;
      activeSection = sec;
      document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      document.querySelectorAll('.section').forEach(s => s.classList.add('hidden'));
      const el = document.getElementById('section-' + sec);
      if (el) el.classList.remove('hidden');
      if (sec === 'logs') loadSessions();
      closeSidebar();
    });
  });

  /* ---- Mobile sidebar toggle ---- */
  const sidebar = $('sidebar');
  const overlay = $('sidebar-overlay');
  const hamburger = $('hamburger');
  function openSidebar() {
    sidebar.classList.add('open');
    overlay.classList.add('visible');
  }
  function closeSidebar() {
    sidebar.classList.remove('open');
    overlay.classList.remove('visible');
  }
  if (hamburger) hamburger.addEventListener('click', openSidebar);
  if (overlay) overlay.addEventListener('click', closeSidebar);

  /* ---- Bitrate sparkline ---- */
  const bwHistory = [];
  const SPARK_MAX = 60;

  function updateSparkline(bwBps) {
    bwHistory.push(bwBps || 0);
    if (bwHistory.length > SPARK_MAX) bwHistory.shift();
    const svg = $('sparkline');
    if (!svg || bwHistory.length < 2) return;
    const W = 120, H = 28;
    const max = Math.max(...bwHistory) || 1;
    const pts = bwHistory.map((v, i) => {
      const x = (i / (SPARK_MAX - 1)) * W;
      const y = H - (v / max) * (H - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    // Area path (closed)
    const first = bwHistory.map((v, i) => {
      const x = (i / (SPARK_MAX - 1)) * W;
      const y = H - (v / max) * (H - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const areaD = `M ${first[0]} L ${first.slice(1).join(' L ')} L ${W},${H} L 0,${H} Z`;
    svg.innerHTML = `
      <defs>
        <linearGradient id="spark-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#f4d03f" stop-opacity="0.5"/>
          <stop offset="100%" stop-color="#f4d03f" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path class="sparkline-area" d="${areaD}"/>
      <polyline class="sparkline-line" points="${pts}"/>
    `;
  }

  /* ---- CSRF ---- */
  let csrf = '';
  async function refreshCsrf() {
    try {
      const r = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
      if (r.ok) csrf = (await r.json()).csrf || '';
    } catch (_) {}
  }

  /* ---- API ---- */
  async function getState() {
    const r = await fetch('/api/state');
    if (r.status === 401) { location.href = '/login'; return null; }
    return await r.json();
  }
  async function postWithCsrf(url, body) {
    const opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      credentials: 'same-origin',
      body: body ? JSON.stringify(body) : undefined,
    };
    let r = await fetch(url, opts);
    if (r.status === 403) {
      await refreshCsrf();
      opts.headers['X-CSRF-Token'] = csrf;
      r = await fetch(url, opts);
    }
    return r;
  }

  /* ---- Session log ---- */
  let sessionsLoaded = false;
  async function loadSessions() {
    const box = $('sessions-list');
    if (!box) return;
    try {
      const r = await fetch('/api/sessions');
      const data = await r.json();
      const list = data.sessions || [];
      if (!list.length) {
        box.innerHTML = '<div class="viewers-empty">No sessions logged yet.</div>';
        return;
      }
      box.innerHTML = list.map(s => `
        <div class="session-row">
          <span class="s-time">${fmtDate(s.t)}</span>
          <span class="s-ip">${s.ip || '—'}</span>
          <span class="s-client">${parseUA(s.ua || '')}</span>
          <span class="s-dur">${fmtUptime(s.duration)}</span>
        </div>`).join('');
      sessionsLoaded = true;
    } catch {
      box.innerHTML = '<div class="viewers-empty">Failed to load sessions.</div>';
    }
  }

  /* ---- Render ---- */
  function render(s) {
    if (!s) return;
    const cfg = s.config;
    const stats = s.stats;
    const list = s.clients || [];

    // Pills (sidebar + mobile)
    const live = stats.publishing;
    ['status-pill', 'mobile-pill'].forEach(id => {
      const el = $(id); if (!el) return;
      el.textContent = live ? 'Live' : 'Idle';
      el.className = 'pill ' + (live ? 'live' : 'off');
    });

    // Stats
    setVal('kv-publish', live ? 'Publishing' : 'Idle', live ? 'good' : '');
    const ageEl = $('kv-stream-age');
    if (ageEl) ageEl.textContent = live && stats.stream_started_at ? `Live for ${fmtAge(stats.stream_started_at)}` : '';

    setVal('kv-viewers', list.length, list.length > 0 ? 'good' : '');
    setVal('kv-bw', fmtBps(stats.source_bw_in));
    setVal('kv-peak', live ? (stats.peak_viewers || 0) : '—');
    updateSparkline(stats.source_bw_in);

    // System
    const sys = stats.system;
    setVal('kv-cpu', `${sys.cpu_percent.toFixed(1)}%`,
      sys.cpu_percent > 80 ? 'bad' : sys.cpu_percent > 50 ? 'warn' : 'good');
    setVal('kv-mem', `${sys.mem_used_mb} / ${sys.mem_total_mb} MB`,
      sys.mem_percent > 90 ? 'bad' : sys.mem_percent > 70 ? 'warn' : 'good');
    setVal('kv-disk', `${sys.disk_used_mb} / ${sys.disk_total_mb} MB`);
    setVal('kv-bytes', fmtBytes(stats.source_bytes_in));
    setVal('kv-bw-out', fmtBps(sys.net_bw_out_bps));
    setVal('kv-uptime', fmtUptime(stats.server_uptime));

    // Viewer badge on nav
    const badge = $('nav-viewer-badge');
    if (badge) {
      if (list.length > 0) {
        badge.textContent = list.length;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }

    // Config inputs
    if (document.activeElement.id !== 'cfg-title') $('cfg-title').value = cfg.stream_title || '';
    $('cfg-key').value = cfg.stream_key || '';
    $('viewer-pw-status').textContent = cfg.viewer_password_set
      ? 'Password required — viewers must log in to watch.'
      : 'Open access — anyone with the link can watch.';

    const host = location.hostname;
    $('rtmp-url').textContent = `rtmp://${host}:1935/live`;
    const watchUrl = `${location.protocol}//${host}:8080/`;
    $('watch-url').textContent = watchUrl;
    const watchLink = $('watch-link');
    if (watchLink) watchLink.href = watchUrl;

    // Viewer list
    const countEl = $('viewers-count');
    if (countEl) countEl.textContent = list.length ? `(${list.length})` : '';
    const box = $('viewers-list');
    if (!list.length) {
      box.innerHTML = '<div class="viewers-empty">No one watching right now.</div>';
    } else {
      box.innerHTML = list.sort((a, b) => b.duration - a.duration).map(c => {
        const client = parseUA(c.user_agent || '');
        const ping = c.ping_ms;
        const pingTxt = ping != null ? ping + ' ms' : '—';
        const pingCls = ping == null ? 'dim' : ping < 30 ? 'good' : ping < 100 ? 'warn' : 'bad';
        return `<div class="viewer-row">
          <span class="v-ip">${c.ip || '—'}</span>
          <span class="v-client" title="${(c.user_agent||'').replace(/"/g,'&quot;')}">${client}</span>
          <span class="v-time">${fmtUptime(c.duration)}</span>
          <span class="v-ping ${pingCls}">${pingTxt}</span>
        </div>`;
      }).join('');
    }
  }

  /* ---- Controls ---- */
  document.querySelectorAll('button[data-save]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const field = btn.dataset.save;
      const value = field === 'stream_title' ? $('cfg-title').value : $('cfg-viewer-pw').value;
      const r = await postWithCsrf('/api/config', { [field]: value });
      const data = await r.json();
      if (data.ok) {
        toast('Saved', 'success');
        if (field === 'viewer_password') $('cfg-viewer-pw').value = '';
        loop();
      } else {
        toast(`Error: ${data.error || 'unknown'}`, 'error');
      }
    });
  });

  $('regen-key-btn').addEventListener('click', async () => {
    if (!confirm('Generate a new stream key? OBS will need updating.')) return;
    const r = await postWithCsrf('/api/key/regenerate');
    const data = await r.json();
    if (data.ok) { toast('New stream key generated', 'success'); loop(); }
    else toast(`Error: ${data.error || 'unknown'}`, 'error');
  });

  async function copyText(text, label) {
    if (!text) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text); toast(label + ' copied', 'success'); return;
      }
    } catch (_) {}
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
    toast(ok ? label + ' copied' : 'Copy failed', ok ? 'success' : 'error');
  }

  $('copy-key-btn').addEventListener('click', () => copyText($('cfg-key').value, 'Stream key'));
  $('copy-watch-btn').addEventListener('click', () => copyText($('watch-url').textContent.trim(), 'Watch URL'));
  $('logout-btn').addEventListener('click', async () => {
    const r = await postWithCsrf('/api/auth/logout');
    location.href = r.redirected ? r.url : '/login';
  });

  /* ---- Poll loop ---- */
  async function loop() { render(await getState()); }
  refreshCsrf().then(loop);
  setInterval(loop, 3000);
})();
