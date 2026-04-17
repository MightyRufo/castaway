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

  /* --- API --- */
  async function getState() {
    const r = await fetch('/api/state');
    if (r.status === 401) { location.href = '/login'; return null; }
    return await r.json();
  }
  async function postConfig(patch) {
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return await r.json();
  }
  async function regenKey() {
    const r = await fetch('/api/key/regenerate', { method: 'POST' });
    return await r.json();
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
    setText('kv-gpu', stats.gpu_present ? 'Detected' : 'None', stats.gpu_present ? 'good' : '');

    // Variants
    const vbox = $('variants');
    if (stats.variants && stats.variants.length) {
      vbox.innerHTML = stats.variants
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(v => `
          <div class="variant-chip">
            <div class="v-name">${v.name.replace('stream_', '')}</div>
            <div class="v-bw">${fmtBps(v.bw_in)} · ${v.viewers} viewers</div>
          </div>`).join('');
    } else {
      vbox.innerHTML = '';
    }

    // System
    const sys = stats.system;
    setText('kv-cpu', `${sys.cpu_percent.toFixed(1)}%`, sys.cpu_percent > 80 ? 'bad' : sys.cpu_percent > 50 ? 'warn' : 'good');
    setText('kv-mem', `${sys.mem_used_mb} / ${sys.mem_total_mb} MB (${sys.mem_percent.toFixed(0)}%)`,
      sys.mem_percent > 90 ? 'bad' : sys.mem_percent > 70 ? 'warn' : 'good');
    setText('kv-disk', `${(sys.disk_used_mb / 1024).toFixed(1)} / ${(sys.disk_total_mb / 1024).toFixed(1)} GB`);

    // Config inputs (only update if user not actively editing)
    if (document.activeElement.id !== 'cfg-title') $('cfg-title').value = cfg.stream_title || '';
    $('cfg-key').value = cfg.stream_key || '';
    if (document.activeElement.id !== 'cfg-abr') $('cfg-abr').value = cfg.abr_mode || 'auto';
    $('viewer-pw-status').textContent = cfg.viewer_password_set
      ? 'Set — viewers must enter a password to watch.'
      : 'Empty — viewers can watch without a password.';

    // OBS / watch URLs (use the host the admin is currently on)
    const host = location.hostname;
    $('rtmp-url').textContent = `rtmp://${host}:1935/live`;
    $('watch-url').value = `${location.protocol}//${host}:8080/`;
  }

  /* --- Event wiring --- */
  document.querySelectorAll('button[data-save]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const field = btn.dataset.save;
      let value;
      if (field === 'stream_title') value = $('cfg-title').value;
      else if (field === 'abr_mode') value = $('cfg-abr').value;
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

  $('copy-key-btn').addEventListener('click', () => {
    const v = $('cfg-key').value;
    if (!v) return;
    navigator.clipboard?.writeText(v).then(() => toast('Stream key copied', 'success'));
  });

  $('copy-watch-btn').addEventListener('click', () => {
    const v = $('watch-url').value;
    if (!v) return;
    navigator.clipboard?.writeText(v).then(() => toast('Watch URL copied', 'success'));
  });

  $('logout-btn').addEventListener('click', () => {
    location.href = '/api/auth/logout';
  });

  /* --- Refresh loop --- */
  async function loop() {
    const s = await getState();
    render(s);
  }
  loop();
  setInterval(loop, 3000);
})();
