/* Castaway player — fullscreen, single-stream, polling-driven state machine.
   Polls /api/streamstate every 3s. HLS instance only exists when actually
   publishing — no error-loop blink while waiting for a stream to start. */
(() => {
  const $ = (id) => document.getElementById(id);

  const HLS_URL = '/hls/stream.m3u8';
  const STATE_URL  = '/api/streamstate';
  const HEARTBEAT_URL = '/api/heartbeat';

  // Per-page-load random session id used by the heartbeat call.
  const SESSION_ID = (crypto.randomUUID && crypto.randomUUID()) ||
    (Date.now() + '-' + Math.random().toString(36).slice(2));

  const stage   = $('stage');
  const video   = $('video');
  const playBtn = $('play-btn');
  const muteBtn = $('mute-btn');
  const fsBtn   = $('fs-btn');
  const pipBtn  = $('pip-btn');
  const volSlider = $('vol-slider');
  const offline = $('offline');
  const offlineMsg = $('offline-msg');
  const livePill = $('live-pill');
  const titleText = $('title-text');
  const drawer = $('drawer');
  const drawerCloseBtn = $('drawer-close');
  const statsBtn = $('stats-btn');

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
    const el = $(id); if (!el) return;
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

  /* ---- Icons / controls ---- */
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
  statsBtn.onclick = () => drawer.classList.toggle('open');
  drawerCloseBtn.onclick = () => drawer.classList.remove('open');

  video.addEventListener('play', updatePlay);
  video.addEventListener('pause', updatePlay);
  video.addEventListener('volumechange', updateMute);

  /* ---- Auto-hide UI ---- */
  let hideTimer;
  const showUI = () => {
    stage.classList.remove('hide-ui');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => stage.classList.add('hide-ui'), 2500);
  };
  stage.addEventListener('mousemove', showUI);
  stage.addEventListener('touchstart', showUI);
  showUI();

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
  let recentFragBytes = 0;
  let recentFragSecs = 0;
  video.addEventListener('waiting', () => { stallCount++; });

  const tickStats = () => {
    if (!hls) {
      ['s-res','s-vbr','s-bw','s-buf','s-lat','s-drop'].forEach(id => setVal(id, '—'));
      return;
    }
    if (video.videoWidth > 0) {
      setVal('s-res', `${video.videoWidth}×${video.videoHeight}`);
    }
    if (recentFragSecs > 0) {
      setVal('s-vbr', fmtBps((recentFragBytes * 8) / recentFragSecs));
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
  };

  /* ---- HLS lifecycle (state-machine driven by polling) ---- */
  let hls = null;

  function teardownHls() {
    if (hls) { try { hls.destroy(); } catch {} ; hls = null; }
  }

  function initHls() {
    teardownHls();
    if (!window.Hls || !Hls.isSupported()) {
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = HLS_URL;
        video.play().catch(() => {});
      } else {
        setOffline(true, 'Your browser does not support HLS playback.');
      }
      return;
    }
    hls = new Hls({
      lowLatencyMode: true,
      liveSyncDuration: 4,
      liveMaxLatencyDuration: 10,
      manifestLoadingMaxRetry: 1,
      levelLoadingMaxRetry: 1,
      fragLoadingMaxRetry: 2,
      xhrSetup: (xhr) => { xhr.withCredentials = true; },
    });
    hls.loadSource(HLS_URL);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      setOffline(false);
      setPill(true);
      video.play().catch(() => {});
    });
    hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
      const bytes = data.frag?.stats?.total || data.payload?.byteLength || 0;
      const secs = data.frag?.duration || 0;
      if (bytes > 0 && secs > 0) {
        // Rolling average over last 4 fragments.
        recentFragBytes = recentFragBytes * 0.75 + bytes * 0.25;
        recentFragSecs  = recentFragSecs  * 0.75 + secs  * 0.25;
      }
    });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      // Tear down and let the polling loop bring us back when publishing
      // flips true again. No reconnect-loop blink.
      teardownHls();
    });
  }

  /* ---- State machine: poll /api/streamstate ---- */
  let publishing = null;  // null = unknown, true/false thereafter
  let suspended = 0;      // backoff count when /api/streamstate fails

  async function pollState() {
    try {
      const r = await fetch(STATE_URL, { credentials: 'same-origin' });
      if (!r.ok) {
        // 401 = lost auth; reload to bounce through login.
        if (r.status === 401) { location.reload(); return; }
        throw new Error('http ' + r.status);
      }
      suspended = 0;
      const s = await r.json();
      titleText.textContent = s.title || 'Live Stream';
      document.title = `${s.title || 'Live Stream'} · Castaway`;

      const next = !!s.publishing;
      if (publishing !== next) {
        publishing = next;
        if (!publishing) {
          setPill(false);
          setOffline(true, 'Stream offline. Waiting for the broadcast to start…');
          teardownHls();
        }
      }
      // Retry initHls every poll tick while publishing is true but hls is torn
      // down (first manifest may 404 if admin detects publisher before nginx-rtmp
      // has written the first fragment).
      if (publishing && !hls) {
        setOffline(true, '<span class="reconnect-dot"></span>Connecting…');
        initHls();
      }
    } catch {
      suspended = Math.min(suspended + 1, 8);
    }
  }

  /* ---- Heartbeat ---- */
  function heartbeat() {
    fetch(HEARTBEAT_URL, {
      method: 'POST',
      headers: { 'X-Castaway-Session': SESSION_ID },
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => {});
  }

  // Initial state + intervals.
  setOffline(true, 'Connecting…');
  setPill(false);
  pollState(); heartbeat();
  setInterval(() => { if (suspended === 0) pollState(); else if (--suspended === 0) pollState(); }, 3000);
  setInterval(heartbeat, 5000);
  setInterval(tickStats, 1000);

})();
