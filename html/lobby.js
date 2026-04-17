/* Castaway lobby — polls /stat for live channels and renders cards. */
(() => {
  const content = document.getElementById('lobby-content');

  const titleFromSlug = (slug) =>
    slug.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  const fmtUptime = (s) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m`;
    return `${s}s`;
  };

  const fmtBitrate = (bps) => {
    if (bps > 1e6) return (bps / 1e6).toFixed(1) + ' Mbps';
    if (bps > 1e3) return (bps / 1e3).toFixed(0) + ' kbps';
    return bps + ' bps';
  };

  const renderEmpty = () => {
    content.innerHTML = `
      <div class="lobby-empty">
        <h2>No live streams</h2>
        <p>Point OBS at the server and start streaming. Refresh this page when you're live.</p>
        <code>rtmp://${location.hostname}:1935/live/&lt;your-stream-key&gt;</code>
      </div>`;
  };

  const renderCards = (streams) => {
    content.innerHTML = `<div class="lobby-grid">${streams.map(s => `
      <a class="lobby-card" href="/watch.html?c=${encodeURIComponent(s.name)}">
        <div class="ch-title">${titleFromSlug(s.name)}</div>
        <div class="ch-meta">
          <span>● Live · ${fmtUptime(s.time)}</span>
          <span>${s.clients} watching</span>
        </div>
        <div class="ch-meta" style="margin-top:6px">
          <span>${fmtBitrate(s.bw)}${s.video ? ` · ${s.video}` : ''}</span>
        </div>
        <div class="ch-key">${s.name}</div>
      </a>
    `).join('')}</div>`;
  };

  const refresh = async () => {
    try {
      const r = await fetch('/stat');
      const xml = new DOMParser().parseFromString(await r.text(), 'application/xml');
      const out = [];
      const seen = new Set();
      xml.querySelectorAll('application').forEach(app => {
        if (app.querySelector(':scope > name')?.textContent !== 'live') return;
        app.querySelectorAll('stream').forEach(s => {
          const name = s.querySelector(':scope > name')?.textContent;
          if (!name || seen.has(name)) return;
          // Skip transcoded variant streams (suffixed _480p / _720p / _1080p)
          if (/_(480p|720p|1080p)$/.test(name)) return;
          seen.add(name);
          // Only show streams with an active publisher
          const publishing = s.querySelector('publishing');
          if (!publishing) return;
          const time = parseInt(s.querySelector(':scope > time')?.textContent || '0', 10);
          const bw   = parseInt(s.querySelector(':scope > bw_in')?.textContent || '0', 10);
          const clients = parseInt(s.querySelector(':scope > nclients')?.textContent || '0', 10) - 1;
          const meta = s.querySelector('meta video');
          const video = meta ? `${meta.querySelector('width')?.textContent}×${meta.querySelector('height')?.textContent}` : '';
          out.push({ name, time: Math.floor(time / 1000), bw, clients: Math.max(0, clients), video });
        });
      });
      if (!out.length) renderEmpty();
      else renderCards(out);
    } catch (e) {
      content.innerHTML = `<div class="lobby-empty"><h2>Unreachable</h2><p>Can't read /stat — is the server up?</p></div>`;
    }
  };

  refresh();
  setInterval(refresh, 5000);
})();
