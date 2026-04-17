/* Castaway player — single-stream, fullscreen, minimal overlay,
   slide-out stats drawer, ABR quality selector. */
(() => {
  const $ = (id) => document.getElementById(id);

  // Single-stream model — channel name is fixed internally. Viewers never
  // see or set it. The OBS publish key is private and lives only on the server.
  const HLS_SINGLE = '/hls/stream.m3u8';
  const HLS_MASTER = '/hls/stream_master.m3u8';

  const stage   = $('stage');
  const video   = $('video');
  const playBtn = $('play-btn');
  const muteBtn = $('mute-btn');
  const fsBtn   = $('fs-btn');
  const pipBtn  = $('pip-btn');
  const liveBtn = $('live-btn');
  const volSlider = $('vol-slider');
  const offline = $('offline');
  const offlineMsg = $('offline-msg');
  const livePill = $('live-pill');
  const titleText = $('title-text');
  const drawer = $('drawer');
  const drawerCloseBtn = $('drawer-close');
  const statsBtn = $('stats-btn');
  const qualitySelect = $('quality-select');

  // Pull title from the server config endpoint, fall back to "Live Stream".
  fetch('/api/config').then(r => r.json()).then(cfg => {
    if (cfg && cfg.title) {
      titleText.textContent = cfg.title;
      document.title = `${cfg.title} · Castaway`;
    }
  }).catch(() => {});

  /* ---- Helpers ---- */
  const setPill = (live) => {
    livePill.textContent = live ? 'Live' : 'Offline';
    livePill.className = 'live-pill ' + (live ? 'live' : 'off');
  };
  const setOffline = (visible, msg) => {
    if (visible) { offline.classList.add('visible'); if (msg) offlineMsg.innerHTML = msg; }
    else offline.classList.remove('visible');
  };
  const setVal = (id, v, cls) => {
    const el = $(id);
    if (!el) return;
    el.textContent = v;
    el.classList.remove('good','warn','bad');
    if (cls) el.classList.add(cls);
  };
  const fmtBps = (bps) => {
    if (!bps || bps < 1) return '—';
    if (bps > 1e6) return (bps / 1e6).toFixed(2) + ' Mbps';
    if (bps > 1e3) return (bps / 1e3).toFixed(0) + ' kbps';
    return bps.toFixed(0) + ' bps';
  };

  /* ---- Icons ---- */
  const ICONS = {
    play:  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
    mute:  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM3 9v6h4l5 5V4L7 9H3z"/></svg>',
    muted: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.63 3.63a.996.996 0 000 1.41L7.29 8.7 7 9H3v6h4l5 5v-6.59l4.18 4.18c-.49.37-1.03.68-1.62.91v2.06a8.94 8.94 0 003.21-1.55l2.04 2.04a.996.996 0 101.41-1.41L5.05 3.63a.996.996 0 00-1.42 0zM12 4L9.91 6.09 12 8.18V4z"/></svg>',
    fs:    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>',
    pip:   '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 7h-8v6h8V7zm2-4H3a2 2 0 00-2 2v14a2 2 0 002 2h18a2 2 0 002-2V5a2 2 0 00-2-2zm0 16.01H3V4.98h18v14.03z"/></svg>',
  };
  playBtn.innerHTML = ICONS.play;
  muteBtn.innerHTML = ICONS.mute;
  fsBtn.innerHTML   = ICONS.fs;
  pipBtn.innerHTML  = ICONS.pip;

  /* ---- Controls ---- */
  const updatePlay = () => { playBtn.innerHTML = video.paused ? ICONS.play : ICONS.pause; };
  const updateMute = () => { muteBtn.innerHTML = (video.muted || video.volume === 0) ? ICONS.muted : ICONS.mute; };

  playBtn.onclick = () => video.paused ? video.play() : video.pause();
  muteBtn.onclick = () => { video.muted = !video.muted; updateMute(); };
  volSlider.oninput = () => {
    video.volume = +volSlider.value;
    video.muted = video.volume === 0;
    updateMute();
  };

  fsBtn.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else stage.requestFullscreen?.();
  };
  pipBtn.onclick = async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch (_) {}
  };
  liveBtn.onclick = () => {
    if (hls && hls.liveSyncPosition !== undefined) {
      video.currentTime = hls.liveSyncPosition;
      video.play().catch(() => {});
    }
  };
  statsBtn.onclick = () => drawer.classList.toggle('open');
  drawerCloseBtn.onclick = () => drawer.classList.remove('open');
  qualitySelect.onchange = () => {
    if (!hls) return;
    hls.currentLevel = parseInt(qualitySelect.value, 10);
  };

  video.addEventListener('play', updatePlay);
  video.addEventListener('pause', updatePlay);
  video.addEventListener('volumechange', updateMute);

  /* ---- Auto-hide UI after 2.5s of cursor inactivity ---- */
  let hideTimer;
  const showUI = () => {
    stage.classList.remove('hide-ui');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => stage.classList.add('hide-ui'), 2500);
  };
  stage.addEventListener('mousemove', showUI);
  stage.addEventListener('touchstart', showUI);
  showUI();

  /* ---- Click-to-play, double-click for fullscreen ---- */
  let clickTimer = null;
  video.addEventListener('click', () => {
    if (clickTimer) {
      clearTimeout(clickTimer); clickTimer = null;
      fsBtn.click();
    } else {
      clickTimer = setTimeout(() => { clickTimer = null; playBtn.click(); }, 220);
    }
  });

  /* ---- Stats ---- */
  let stallCount = 0;
  video.addEventListener('waiting', () => { stallCount++; });

  const tickStats = () => {
    if (!hls) return;
    const lvl = hls.levels?.[hls.currentLevel];
    if (lvl) {
      setVal('s-res', `${lvl.width}×${lvl.height}`);
      setVal('s-vbr', fmtBps(lvl.bitrate));
      setVal('s-quality', hls.autoLevelEnabled ? `Auto (${lvl.height}p)` : `${lvl.height}p`);
    }
    setVal('s-bw', fmtBps(hls.bandwidthEstimate));
    const buf = video.buffered;
    const bufLen = buf.length ? Math.max(0, buf.end(buf.length - 1) - video.currentTime) : 0;
    setVal('s-buf', bufLen.toFixed(1) + ' s', bufLen > 4 ? 'good' : bufLen > 1 ? 'warn' : 'bad');

    if (hls.liveSyncPosition !== undefined && hls.liveSyncPosition !== null) {
      const lat = Math.max(0, hls.liveSyncPosition - video.currentTime + bufLen);
      setVal('s-lat', lat.toFixed(1) + ' s', lat < 6 ? 'good' : lat < 12 ? 'warn' : 'bad');
    }

    const q = video.getVideoPlaybackQuality?.();
    if (q) {
      setVal('s-drop', q.droppedVideoFrames,
        q.droppedVideoFrames === 0 ? 'good' : q.droppedVideoFrames < 30 ? 'warn' : 'bad');
    }
    setVal('s-stall', stallCount, stallCount === 0 ? 'good' : stallCount < 3 ? 'warn' : 'bad');

    if (hls.liveSyncPosition !== undefined) {
      const drift = hls.liveSyncPosition - video.currentTime;
      liveBtn.classList.toggle('synced', drift < 3);
    }
  };

  /* ---- HLS lifecycle ---- */
  let hls;
  let reconnectTimer;
  let consecutiveErrors = 0;

  const tryLoad = async () => {
    setOffline(true, '<span class="reconnect-dot"></span>Connecting…');

    // ABR master playlist if the server has it, otherwise single bitrate.
    let src = HLS_SINGLE;
    try {
      const r = await fetch(HLS_MASTER, { method: 'HEAD' });
      if (r.ok) src = HLS_MASTER;
    } catch (_) {}

    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({
        lowLatencyMode: true,
        liveSyncDuration: 4,
        liveMaxLatencyDuration: 10,
        manifestLoadingMaxRetry: 0,
        levelLoadingMaxRetry: 0,
        fragLoadingMaxRetry: 1,
        xhrSetup: (xhr) => { xhr.withCredentials = true; },  // send cookie on HLS XHRs
      });
      hls.loadSource(src);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
        consecutiveErrors = 0;
        setOffline(false);
        setPill(true);
        if (data.levels && data.levels.length > 1) {
          qualitySelect.innerHTML = '<option value="-1">Auto</option>' +
            data.levels.map((lvl, i) =>
              `<option value="${i}">${lvl.height}p</option>`).join('');
          qualitySelect.style.display = '';
        } else {
          qualitySelect.style.display = 'none';
        }
        video.play().catch(() => {});
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        consecutiveErrors++;
        setPill(false);
        const wait = Math.min(15000, 1500 * consecutiveErrors);
        setOffline(true, `<span class="reconnect-dot"></span>Stream offline. Reconnecting in ${(wait/1000).toFixed(0)}s…`);
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => { try { hls.destroy(); } catch {} ; tryLoad(); }, wait);
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      video.addEventListener('loadedmetadata', () => { setOffline(false); setPill(true); video.play().catch(() => {}); });
      video.addEventListener('error', () => {
        setPill(false);
        setOffline(true, '<span class="reconnect-dot"></span>Stream offline. Reconnecting…');
        setTimeout(tryLoad, 4000);
      });
    } else {
      setOffline(true, 'Your browser does not support HLS playback.');
    }
  };

  tryLoad();
  setInterval(tickStats, 1000);

  /* ---- Keyboard shortcuts ---- */
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if      (e.code === 'Space')                { e.preventDefault(); playBtn.click(); }
    else if (e.key === 'm' || e.key === 'M')    muteBtn.click();
    else if (e.key === 'f' || e.key === 'F')    fsBtn.click();
    else if (e.key === 'l' || e.key === 'L')    liveBtn.click();
    else if (e.key === 'i' || e.key === 'I')    statsBtn.click();
    else if (e.key === 'Escape')                drawer.classList.remove('open');
  });
})();
