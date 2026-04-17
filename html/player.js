/* Castaway custom player. Wraps hls.js with custom controls,
   offline-state handling, and a viewer-side stats panel. */
(() => {
  const $  = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const channel = params.get('c') || params.get('key') || 'live';

  const video = $('video');
  const wrap = $('player-wrap');
  const playBtn = $('play-btn');
  const muteBtn = $('mute-btn');
  const fsBtn = $('fs-btn');
  const pipBtn = $('pip-btn');
  const liveBtn = $('live-btn');
  const volSlider = $('vol-slider');
  const scrubFill = $('scrub-fill');
  const offline = $('offline');
  const offlineMsg = $('offline-msg');
  const livePill = $('live-pill');
  const channelInput = $('channel-input');
  const ingestUrl = $('ingest-url');
  const watchUrl = $('watch-url');
  const statsToggle = $('stats-toggle');
  const statsCard = $('stats-card');

  channelInput.value = channel;
  ingestUrl.textContent = `rtmp://${location.hostname}:1935/live/${channel}`;
  watchUrl.textContent = `${location.origin}${location.pathname}?c=${channel}`;

  const setPill = (live) => {
    livePill.textContent = live ? 'Live' : 'Offline';
    livePill.className = 'live-pill ' + (live ? 'live' : 'off');
  };

  const setOffline = (visible, msg) => {
    if (visible) {
      offline.classList.add('visible');
      if (msg) offlineMsg.innerHTML = msg;
    } else {
      offline.classList.remove('visible');
    }
  };

  /* ---- Stats ---- */
  const stats = {
    stalls: 0,
    set(id, v, cls) {
      const el = $(id);
      if (!el) return;
      el.textContent = v;
      el.classList.remove('good','warn','bad');
      if (cls) el.classList.add(cls);
    },
    fmt(bps) {
      if (!bps || bps < 1) return '—';
      if (bps > 1e6) return (bps / 1e6).toFixed(2) + ' Mbps';
      if (bps > 1e3) return (bps / 1e3).toFixed(0) + ' kbps';
      return bps.toFixed(0) + ' bps';
    },
    tick(hls) {
      if (!hls) return;
      const lvl = hls.levels?.[hls.currentLevel];
      if (lvl) {
        this.set('s-res', `${lvl.width}×${lvl.height}`);
        this.set('s-vbr', this.fmt(lvl.bitrate));
      }
      this.set('s-bw', this.fmt(hls.bandwidthEstimate));

      const buf = video.buffered;
      const bufLen = buf.length ? Math.max(0, buf.end(buf.length - 1) - video.currentTime) : 0;
      this.set('s-buf', bufLen.toFixed(1) + ' s', bufLen > 4 ? 'good' : bufLen > 1 ? 'warn' : 'bad');

      if (hls.liveSyncPosition !== undefined && hls.liveSyncPosition !== null) {
        const lat = Math.max(0, hls.liveSyncPosition - video.currentTime + bufLen);
        this.set('s-lat', lat.toFixed(1) + ' s', lat < 6 ? 'good' : lat < 12 ? 'warn' : 'bad');
      }

      const q = video.getVideoPlaybackQuality?.();
      if (q) {
        this.set('s-drop', q.droppedVideoFrames,
          q.droppedVideoFrames === 0 ? 'good' : q.droppedVideoFrames < 30 ? 'warn' : 'bad');
      }
      this.set('s-stall', this.stalls, this.stalls === 0 ? 'good' : this.stalls < 3 ? 'warn' : 'bad');
    },
  };

  /* ---- Controls ---- */
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
  fsBtn.innerHTML = ICONS.fs;
  pipBtn.innerHTML = ICONS.pip;

  const updatePlay = () => { playBtn.innerHTML = video.paused ? ICONS.play : ICONS.pause; };
  const updateMute = () => { muteBtn.innerHTML = (video.muted || video.volume === 0) ? ICONS.muted : ICONS.mute; };

  playBtn.onclick = () => video.paused ? video.play() : video.pause();
  muteBtn.onclick = () => { video.muted = !video.muted; updateMute(); };
  volSlider.oninput = () => { video.volume = +volSlider.value; video.muted = video.volume === 0; updateMute(); };

  fsBtn.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else wrap.requestFullscreen?.();
  };

  pipBtn.onclick = async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch (e) { /* PiP may be blocked */ }
  };

  liveBtn.onclick = () => {
    if (hls && hls.liveSyncPosition !== undefined) {
      video.currentTime = hls.liveSyncPosition;
      video.play().catch(() => {});
    }
  };

  video.addEventListener('play', updatePlay);
  video.addEventListener('pause', updatePlay);
  video.addEventListener('volumechange', updateMute);
  video.addEventListener('waiting', () => { stats.stalls++; });

  // Click-to-toggle play; double-click for fullscreen
  let clickTimer = null;
  wrap.addEventListener('click', (e) => {
    if (e.target.closest('.controls')) return;
    if (clickTimer) {
      clearTimeout(clickTimer); clickTimer = null;
      fsBtn.click();
    } else {
      clickTimer = setTimeout(() => {
        clickTimer = null;
        playBtn.click();
      }, 200);
    }
  });

  // Show controls briefly on touch / cursor inactivity
  let hideTimer;
  const showControls = () => {
    wrap.classList.add('show-controls');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => wrap.classList.remove('show-controls'), 2500);
  };
  wrap.addEventListener('mousemove', showControls);
  wrap.addEventListener('touchstart', showControls);

  // Live-sync indicator
  setInterval(() => {
    if (!hls || hls.liveSyncPosition === undefined) return;
    const drift = hls.liveSyncPosition - video.currentTime;
    if (drift < 3) liveBtn.classList.add('synced');
    else liveBtn.classList.remove('synced');
  }, 1000);

  /* ---- Stats card toggle ---- */
  let statsVisible = localStorage.getItem('castaway:stats') !== 'hidden';
  const applyStatsVisible = () => {
    statsCard.style.display = statsVisible ? '' : 'none';
    statsToggle.textContent = statsVisible ? 'Hide' : 'Show';
  };
  statsToggle.onclick = () => {
    statsVisible = !statsVisible;
    localStorage.setItem('castaway:stats', statsVisible ? 'visible' : 'hidden');
    applyStatsVisible();
  };
  applyStatsVisible();

  /* ---- Channel switching ---- */
  const switchChannel = (newKey) => {
    if (!newKey || newKey === channel) return;
    const u = new URL(location.href);
    u.searchParams.set('c', newKey);
    location.href = u.toString();
  };
  channelInput.addEventListener('change', () => switchChannel(channelInput.value.trim()));
  channelInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') switchChannel(channelInput.value.trim());
  });

  /* ---- HLS lifecycle ---- */
  let hls;
  let reconnectTimer;
  let consecutiveErrors = 0;

  const src = `/hls/${channel}.m3u8`;

  const start = () => {
    setOffline(true,
      `<span class="reconnect-dot"></span>Connecting to <code>${channel}</code>…`);

    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({
        lowLatencyMode: true,
        liveSyncDuration: 4,
        liveMaxLatencyDuration: 10,
        manifestLoadingMaxRetry: 0,
        levelLoadingMaxRetry: 0,
        fragLoadingMaxRetry: 1,
      });
      hls.loadSource(src);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        consecutiveErrors = 0;
        setOffline(false);
        setPill(true);
        video.play().catch(() => {});
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        consecutiveErrors++;
        setPill(false);
        const wait = Math.min(15000, 1500 * consecutiveErrors);
        setOffline(true,
          `<span class="reconnect-dot"></span>Stream offline. Reconnecting in ${(wait/1000).toFixed(0)}s…`);
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          try { hls.destroy(); } catch {}
          start();
        }, wait);
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari / iOS native HLS path.
      video.src = src;
      video.addEventListener('loadedmetadata', () => { setOffline(false); setPill(true); video.play().catch(() => {}); });
      video.addEventListener('error', () => {
        setPill(false);
        setOffline(true, '<span class="reconnect-dot"></span>Stream offline. Reconnecting…');
        setTimeout(start, 4000);
      });
    } else {
      setOffline(true, 'Your browser does not support HLS playback.');
    }
  };

  start();
  setInterval(() => stats.tick(hls), 1000);

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); playBtn.click(); }
    else if (e.key === 'm' || e.key === 'M') muteBtn.click();
    else if (e.key === 'f' || e.key === 'F') fsBtn.click();
    else if (e.key === 'l' || e.key === 'L') liveBtn.click();
    else if (e.key === 'i' || e.key === 'I') statsToggle.click();
  });
})();
