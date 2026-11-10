// The video player: direct files (native seeking) and on-the-fly HLS (seeking past the
// converted part restarts the conversion there). Positions shown are always absolute: offset + currentTime.

import { t } from './strings.js';
import { h, api, storage } from './ui.js';
import { isTv, isWebos, android, remoteKey } from './tv.js';

const ICONS = {
  play: '<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>',
  pause: '<path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z"/>',
  back: '<path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z"/>',
  rewind: '<path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/><text x="12" y="16.2" font-size="6.5" text-anchor="middle" font-family="sans-serif" font-weight="700">10</text>',
  forward: '<path d="M12 5V1l5 5-5 5V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/><text x="12" y="16.2" font-size="6.5" text-anchor="middle" font-family="sans-serif" font-weight="700">10</text>',
  volume: '<path d="M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/>',
  muted: '<path d="M16.5 12A4.5 4.5 0 0 0 14 8v2.2l2.45 2.45c.03-.2.05-.42.05-.65zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12a9 9 0 0 0-7-8.77v2.06A7 7 0 0 1 19 12zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a9 9 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9zM12 4 9.91 6.09 12 8.18z"/>',
  subtitles: '<path d="M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM11 11H9.5v-.5h-2v3h2V13H11v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1zm7 0h-1.5v-.5h-2v3h2V13H18v1a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1z"/>',
  next: '<path d="M6 18l8.5-6L6 6zm10-12v12h2V6z"/>',
  fullscreen: '<path d="M7 14H5v5h5v-2H7zm-2-4h2V7h3V5H5zm12 7h-3v2h5v-5h-2zM14 5v2h3v3h2V5z"/>',
  exitFullscreen: '<path d="M5 16h3v3h2v-5H5zm3-8H5v2h5V5H8zm6 11h2v-3h3v-2h-5zm2-11V5h-2v5h5V8z"/>',
};
const svg = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

const SEEK_STEP = 10;
const REPORT_EVERY_MS = 10000;
const HIDE_CONTROLS_MS = 3000;
const UP_NEXT_SECONDS = 8;

let hlsLoading = null;
export function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsLoading) {
    hlsLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/hls.min.js';
      s.onload = () => resolve(window.Hls);
      s.onerror = () => reject(new Error('hls.js failed to load'));
      document.head.append(s);
    });
  }
  return hlsLoading;
}

// One conversion per browser tab: the server replaces the previous one for the same key
function tabKey() {
  try {
    let key = sessionStorage.getItem('cinehome.sid');
    if (!key) {
      key = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
      sessionStorage.setItem('cinehome.sid', key);
    }
    return key;
  } catch {
    return String(Math.random()).slice(2);
  }
}

export function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

export function mountPlayer(container, { id: requestedId, profile, start, onExit, onNext }) {
  const sid = tabKey();
  let id = requestedId; // a series id resolves to an episode on the first load; reloads keep that episode
  let info = null;
  let offset = 0;
  let hls = null;
  let destroyed = false;
  let started = false;
  let pendingSeek = null;
  let seekTimer = null;
  let hideTimer = null;
  let reportTimer = null;
  let upNextTimer = null;
  let dragging = false;
  let recoveries = 0;
  let subtitleKey = null;
  let lastPointer = 'mouse';
  let tapWasIdle = false;
  const keepScreenOn = on => {
    if (android) android.keepScreenOn(on);
  };
  // On LG TVs the TV plays MKV/HEVC/AC3 itself; if a file fails anyway, retry once the browser way
  let client = isWebos ? 'webos' : 'web';

  // ---- DOM ----
  const video = h('video', { playsinline: true, preload: 'auto' });
  const btn = (name, label, onclick, cls = '') => h('button', { class: `pbtn ${cls}`, 'aria-label': label, title: label, html: svg(name), onclick });

  const titleEl = h('div', { class: 'player-title' });
  const subEl = h('div', { class: 'player-sub' });
  const backBtn = btn('back', t.back, () => exit());
  const centerBtn = h('button', { class: 'player-center', 'aria-label': t.play, html: svg('play'), onclick: () => togglePlay() });
  const spinner = h('div', { class: 'player-spinner' }, h('span'), h('div', { class: 'player-spinner-text' }, t.preparing));
  const errorBox = h('div', { class: 'player-error', hidden: true });

  const seekBuffer = h('div', { class: 'seek-buffer' });
  const seekFill = h('div', { class: 'seek-fill' });
  const seekThumb = h('div', { class: 'seek-thumb' });
  const seekTip = h('div', { class: 'seek-tip' });
  const seek = h('div', { class: 'seek', role: 'slider', 'aria-label': 'Seek', tabindex: '-1' }, h('div', { class: 'seek-rail' }, seekBuffer, seekFill), seekThumb, seekTip);

  const playBtn = btn('play', t.play, () => togglePlay(), 'play');
  const rewBtn = btn('rewind', t.rewind, () => seekBy(-SEEK_STEP));
  const fwdBtn = btn('forward', t.forward, () => seekBy(SEEK_STEP));
  const muteBtn = btn('volume', t.mute, () => {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = 0.5;
  });
  const volume = h('input', { class: 'volume', type: 'range', min: '0', max: '1', step: '0.05', 'aria-label': 'Volume' });
  const timeEl = h('div', { class: 'player-time' });
  const subsBtn = btn('subtitles', t.audioAndSubtitles, () => toggleSubsMenu());
  const nextBtn = btn('next', t.nextEpisode, () => playNext(), 'next');
  const fsBtn = btn('fullscreen', t.fullscreen, () => toggleFullscreen());
  const subsMenu = h('div', { class: 'subs-menu', hidden: true });

  const upNext = h('div', { class: 'upnext', hidden: true });

  const root = h('div', { class: 'player' },
    video,
    spinner,
    centerBtn,
    h('div', { class: 'player-top' }, backBtn, h('div', { class: 'player-titles' }, titleEl, subEl)),
    h('div', { class: 'player-bottom' },
      seek,
      h('div', { class: 'player-controls' },
        h('div', { class: 'group' }, playBtn, rewBtn, fwdBtn, h('div', { class: 'volume-wrap' }, muteBtn, volume), timeEl),
        h('div', { class: 'group' }, subsBtn, nextBtn, fsBtn))),
    subsMenu,
    upNext,
    errorBox);
  container.append(root);

  try {
    const v = Number(storage.get('volume'));
    if (storage.get('volume') !== null && v >= 0 && v <= 1) video.volume = v;
  } catch { /* ignore */ }
  volume.value = String(video.volume);

  // ---- time model ----
  const duration = () => (info && info.duration) || (Number.isFinite(video.duration) ? video.duration : 0);
  const absTime = () => (pendingSeek !== null ? pendingSeek : offset + (video.currentTime || 0));
  const isHls = () => info && info.mode !== 'direct';

  // How far into the stream the converted part goes (absolute seconds)
  function availableEnd() {
    if (!isHls()) return duration();
    const r = video.seekable;
    const end = r && r.length ? r.end(r.length - 1) : 0;
    return offset + (Number.isFinite(end) ? end : 0);
  }

  // ---- loading ----
  // audioIndex: a stream picked in the menu; otherwise keep the current one, or ask for the remembered language
  async function load(startAbs, audioIndex = info ? info.audioIndex : null) {
    showSpinner(true);
    errorBox.hidden = true;
    const q = new URLSearchParams({ profile, sid, client });
    if (startAbs !== null && startAbs !== undefined) q.set('start', String(Math.floor(startAbs)));
    if (audioIndex !== null && audioIndex !== undefined) {
      q.set('audio', String(audioIndex));
    } else {
      const pref = audioPref();
      if (pref.lang) q.set('audioLang', pref.lang);
      if (pref.pos !== undefined) q.set('audioPos', String(pref.pos));
    }
    let data;
    try {
      data = await api(`/api/play/${id}?${q}`);
    } catch (err) {
      return showError(err.status === 503 || err.status === 404 ? err.message : t.playbackError);
    }
    if (destroyed) {
      if (data.sessionId) stopSession(data.sessionId);
      return;
    }
    const previous = info;
    info = data;
    id = data.id;
    offset = data.offset || 0;
    pendingSeek = null;
    if (previous && previous.sessionId && previous.sessionId !== data.sessionId) stopSession(previous.sessionId);

    titleEl.textContent = data.title;
    subEl.textContent = data.subtitle || '';
    document.title = `${data.title} · CineHome`;
    nextBtn.hidden = !data.next;
    fsBtn.hidden = isTv || Boolean(android); // the apps are full screen already
    subsBtn.hidden = !data.subtitles.length && data.audio.length < 2;

    await attach(data);
    setTracks(data.subtitles);
    render();
  }

  async function attach(data) {
    if (hls) {
      hls.destroy();
      hls = null;
    }
    const startRel = data.mode === 'direct' ? (data.startAt || 0) : 0;
    if (data.mode === 'direct') {
      video.src = data.url;
    } else {
      let Hls = null;
      try {
        Hls = await loadHls();
      } catch { /* fall back to native HLS */ }
      if (destroyed) return;
      if (Hls && Hls.isSupported()) {
        hls = new Hls({ startPosition: 0, maxBufferLength: 60, backBufferLength: 90, liveDurationInfinity: false });
        hls.on(Hls.Events.ERROR, (_, e) => onHlsError(Hls, e));
        hls.loadSource(data.url);
        hls.attachMedia(video);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = data.url;
      } else {
        return showError(t.playbackError);
      }
    }
    const once = () => {
      video.removeEventListener('loadedmetadata', once);
      if (startRel > 0) video.currentTime = startRel;
      else if (data.mode !== 'direct' && video.currentTime > 1) video.currentTime = 0;
    };
    video.addEventListener('loadedmetadata', once);
    video.play().catch(() => {
      showSpinner(false);
      render();
    });
  }

  function onHlsError(Hls, e) {
    if (!e.fatal) return;
    if (e.type === Hls.ErrorTypes.MEDIA_ERROR && recoveries < 2) {
      recoveries += 1;
      hls.recoverMediaError();
      return;
    }
    // The conversion was dropped (e.g. paused too long): start a new one where we are
    if (e.type === Hls.ErrorTypes.NETWORK_ERROR && recoveries < 3) {
      recoveries += 1;
      load(absTime());
      return;
    }
    showError(t.playbackError);
  }

  function stopSession(sessionId) {
    const url = `/api/hls/${sessionId}/stop`;
    if (navigator.sendBeacon) navigator.sendBeacon(url, '');
    else fetch(url, { method: 'POST', keepalive: true }).catch(() => {});
  }

  // ---- audio ----
  // Remembered per profile: { lang, pos }. Kids default to the Romanian dub when a file has one.
  function audioPref() {
    try {
      const saved = JSON.parse(storage.get(`audio.${profile}`) || 'null');
      if (saved) return saved;
    } catch { /* ignore */ }
    return profile === 'kids' ? { lang: 'ro' } : {};
  }

  function chooseAudio(track) {
    subsMenu.hidden = true;
    storage.set(`audio.${profile}`, JSON.stringify({ lang: track.lang || undefined, pos: track.pos }));
    if (!info || track.index === info.audioIndex) return renderSubsMenu();
    const at = absTime();
    video.pause();
    load(at, track.index);
  }

  // ---- subtitles ----
  function preferredLang() {
    return storage.get(`subs.${profile}`);
  }

  function setTracks(list) {
    for (const tr of [...video.querySelectorAll('track')]) tr.remove();
    for (const s of list) {
      video.append(h('track', { kind: 'subtitles', src: s.url, srclang: s.lang || 'und', label: s.label, 'data-key': s.key }));
    }
    if (subtitleKey === null) {
      const pref = preferredLang();
      const match = pref && pref !== 'off' && (list.find(s => s.lang === pref && !s.forced) || list.find(s => s.lang === pref));
      subtitleKey = match ? match.key : 'off';
    }
    applySubtitle();
    renderSubsMenu();
  }

  function applySubtitle() {
    const els = [...video.querySelectorAll('track')];
    els.forEach(el => {
      el.track.mode = el.dataset.key === subtitleKey ? 'showing' : 'disabled';
    });
  }

  function chooseSubtitle(key) {
    subtitleKey = key;
    const s = info.subtitles.find(x => x.key === key);
    storage.set(`subs.${profile}`, s ? (s.lang || 'und') : 'off');
    applySubtitle();
    renderSubsMenu();
    subsMenu.hidden = true;
  }

  function renderSubsMenu() {
    const opt = (on, label, onclick) => h('button', { class: `subs-opt ${on ? 'on' : ''}`, onclick }, label);
    const audio = info ? info.audio : [];
    const subs = info ? info.subtitles : [];
    const columns = [];
    if (audio.length > 1) {
      columns.push(h('div', { class: 'subs-col' }, h('div', { class: 'subs-head' }, t.audio),
        ...audio.map(a => opt(a.index === info.audioIndex, a.label, () => chooseAudio(a)))));
    }
    if (subs.length) {
      columns.push(h('div', { class: 'subs-col' }, h('div', { class: 'subs-head' }, t.subtitles),
        opt(subtitleKey === 'off', t.subtitlesOff, () => chooseSubtitle('off')),
        ...subs.map(s => opt(subtitleKey === s.key, s.label, () => chooseSubtitle(s.key)))));
    }
    subsMenu.replaceChildren(...columns);
  }

  function toggleSubsMenu() {
    subsMenu.hidden = !subsMenu.hidden;
    if (!subsMenu.hidden) {
      const on = subsMenu.querySelector('.on') || subsMenu.querySelector('.subs-opt');
      if (on) on.focus();
    }
  }

  // ---- seeking ----
  function seekTo(target) {
    if (!info) return;
    const total = duration();
    const abs = Math.max(0, Math.min(target, total ? total - 1 : target));
    hideUpNext();
    if (!isHls()) {
      video.currentTime = abs;
      render();
      return;
    }
    const rel = abs - offset;
    if (rel >= 0 && abs <= availableEnd() - 2) {
      pendingSeek = null;
      video.currentTime = rel;
      render();
      return;
    }
    // Outside what is converted: restart there, after the user stops pressing/dragging
    pendingSeek = abs;
    render();
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => {
      const at = pendingSeek;
      if (at === null) return;
      video.pause();
      load(at);
    }, 500);
  }

  function seekBy(delta) {
    seekTo(absTime() + delta);
  }

  function fractionAt(e) {
    const r = seek.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  }

  seek.addEventListener('pointerdown', e => {
    if (!duration()) return;
    dragging = true;
    seek.setPointerCapture(e.pointerId);
    previewAt(fractionAt(e));
  });
  seek.addEventListener('pointermove', e => {
    if (!duration()) return;
    const f = fractionAt(e);
    seekTip.textContent = formatTime(f * duration());
    seekTip.style.left = `${f * 100}%`;
    if (dragging) previewAt(f);
  });
  seek.addEventListener('pointerup', e => {
    if (!dragging) return;
    dragging = false;
    seekTo(fractionAt(e) * duration());
  });
  seek.addEventListener('pointercancel', () => {
    dragging = false;
    render();
  });

  function previewAt(f) {
    seekFill.style.width = `${f * 100}%`;
    seekThumb.style.left = `${f * 100}%`;
    timeEl.textContent = `${formatTime(f * duration())} / ${formatTime(duration())}`;
  }

  // ---- controls ----
  function togglePlay() {
    if (!info) return;
    if (video.paused || video.ended) video.play().catch(() => {});
    else video.pause();
  }

  function toggleFullscreen() {
    const doc = document;
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc);
    } else if (root.requestFullscreen) {
      root.requestFullscreen().catch(() => {});
    } else if (root.webkitRequestFullscreen) {
      root.webkitRequestFullscreen();
    } else if (video.webkitEnterFullscreen) {
      video.webkitEnterFullscreen(); // iPhone
    }
  }

  function showControls() {
    root.classList.remove('idle');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!video.paused && subsMenu.hidden && !dragging) root.classList.add('idle');
    }, HIDE_CONTROLS_MS);
  }

  function showSpinner(on) {
    spinner.classList.toggle('on', on);
  }

  function showError(message) {
    showSpinner(false);
    errorBox.replaceChildren(h('p', {}, message), h('button', { class: 'btn', onclick: () => exit() }, t.back));
    errorBox.hidden = false;
  }

  function render() {
    if (dragging) return;
    const total = duration();
    const now = absTime();
    const f = total ? now / total : 0;
    seekFill.style.width = `${f * 100}%`;
    seekThumb.style.left = `${f * 100}%`;
    // Buffered range around the playhead, in absolute time
    let bufStart = 0;
    let bufEnd = 0;
    const b = video.buffered;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= video.currentTime + 1 && b.end(i) >= video.currentTime) {
        bufStart = b.start(i);
        bufEnd = b.end(i);
      }
    }
    seekBuffer.style.left = `${total ? ((offset + bufStart) / total) * 100 : 0}%`;
    seekBuffer.style.width = `${total ? ((bufEnd - bufStart) / total) * 100 : 0}%`;
    timeEl.textContent = `${formatTime(now)} / ${formatTime(total)}`;
    const paused = video.paused || video.ended;
    playBtn.innerHTML = svg(paused ? 'play' : 'pause');
    playBtn.setAttribute('aria-label', paused ? t.play : 'Pause');
    centerBtn.classList.toggle('on', paused && started && !spinner.classList.contains('on') && errorBox.hidden);
    muteBtn.innerHTML = svg(video.muted || video.volume === 0 ? 'muted' : 'volume');
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    fsBtn.innerHTML = svg(fs ? 'exitFullscreen' : 'fullscreen');
  }

  // ---- progress ----
  function report({ beacon = false } = {}) {
    if (!info || !started) return;
    const total = duration();
    if (!total) return;
    const body = JSON.stringify({ profile, id: info.id, position: video.ended ? total : absTime(), duration: total });
    if (beacon && navigator.sendBeacon) navigator.sendBeacon('/api/progress', body);
    else fetch('/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  }

  // ---- up next ----
  function showUpNext() {
    if (!info || !info.next) return exit();
    let left = UP_NEXT_SECONDS;
    const count = h('div', { class: 'upnext-count' }, t.upNextIn(left));
    upNext.replaceChildren(
      h('div', { class: 'upnext-label' }, t.nextEpisode),
      h('div', { class: 'upnext-title' }, info.next.label),
      count,
      h('div', { class: 'upnext-actions' },
        h('button', { class: 'btn primary', onclick: () => playNext() }, t.playNow),
        h('button', { class: 'btn ghost', onclick: () => hideUpNext() }, t.cancel)));
    upNext.hidden = false;
    upNext.querySelector('.btn').focus();
    clearInterval(upNextTimer);
    upNextTimer = setInterval(() => {
      left -= 1;
      count.textContent = t.upNextIn(left);
      if (left <= 0) playNext();
    }, 1000);
  }

  function hideUpNext() {
    clearInterval(upNextTimer);
    upNext.hidden = true;
  }

  function playNext() {
    if (!info || !info.next) return;
    hideUpNext();
    report();
    onNext(info.next.id);
  }

  function exit() {
    onExit(info ? info.titleId : null);
  }

  // ---- events ----
  const on = (target, event, fn, opts) => {
    target.addEventListener(event, fn, opts);
    return () => target.removeEventListener(event, fn, opts);
  };
  const offs = [
    on(video, 'timeupdate', render),
    on(video, 'progress', render),
    on(video, 'volumechange', () => {
      volume.value = String(video.muted ? 0 : video.volume);
      storage.set('volume', String(video.volume));
      render();
    }),
    on(video, 'playing', () => {
      keepScreenOn(true);
      started = true;
      recoveries = 0;
      showSpinner(false);
      render();
      showControls();
    }),
    on(video, 'waiting', () => showSpinner(true)),
    on(video, 'canplay', () => showSpinner(false)),
    on(video, 'pause', () => {
      keepScreenOn(false);
      render();
      showControls();
      report();
    }),
    on(video, 'play', render),
    on(video, 'ended', () => {
      render();
      report();
      showUpNext();
    }),
    on(video, 'error', () => {
      if (isHls()) return;
      if (client === 'webos' && info && info.mode === 'direct') {
        client = 'web';
        load(absTime());
        return;
      }
      showError(t.playbackError);
    }),
    on(video, 'click', () => {
      if (lastPointer !== 'touch') return togglePlay();
      // Touch: a tap shows the controls and a second tap hides them; pausing is the button's job
      if (!tapWasIdle && !video.paused) {
        clearTimeout(hideTimer);
        root.classList.add('idle');
      }
    }),
    on(video, 'dblclick', () => {
      if (lastPointer !== 'touch') toggleFullscreen();
    }),
    on(volume, 'input', () => {
      video.volume = Number(volume.value);
      video.muted = video.volume === 0;
    }),
    on(root, 'pointermove', showControls),
    on(root, 'pointerdown', e => {
      lastPointer = e.pointerType;
      tapWasIdle = root.classList.contains('idle');
      showControls();
    }),
    on(document, 'fullscreenchange', render),
    on(document, 'keydown', e => {
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      showControls();
      const inMenu = !subsMenu.hidden || !upNext.hidden;
      if (!subsMenu.hidden && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const cols = [...subsMenu.querySelectorAll('.subs-col')];
        const col = cols[cols.findIndex(c => c.contains(document.activeElement)) + (e.key === 'ArrowRight' ? 1 : -1)];
        const target = col && (col.querySelector('.on') || col.querySelector('button'));
        if (target) target.focus();
        e.preventDefault();
        return;
      }
      if (inMenu && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const scope = upNext.hidden ? (document.activeElement.closest('.subs-col') || subsMenu) : upNext;
        const opts = [...scope.querySelectorAll('button')];
        const i = opts.indexOf(document.activeElement);
        const next = opts[Math.max(0, Math.min(opts.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (next) next.focus();
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape' && !subsMenu.hidden) {
        subsMenu.hidden = true;
        return;
      }
      const onButton = document.activeElement && document.activeElement.tagName === 'BUTTON' && root.contains(document.activeElement);
      const remote = remoteKey(e);
      if (remote) {
        e.preventDefault();
        if (remote === 'Back') {
          if (!subsMenu.hidden) subsMenu.hidden = true;
          else if (!upNext.hidden) hideUpNext();
          else exit();
        } else if (remote === 'Play') video.play().catch(() => {});
        else if (remote === 'Pause') video.pause();
        else if (remote === 'PlayPause') togglePlay();
        else if (remote === 'Stop') exit();
        else if (remote === 'FastForward') seekBy(30);
        else if (remote === 'Rewind') seekBy(-30);
        return;
      }
      // TV: Down reaches the control bar, Left/Right move along it, Up goes back to seeking
      const inBar = onButton && document.activeElement.classList.contains('pbtn');
      if (isTv && inBar && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const buttons = [...root.querySelectorAll('.player-top .pbtn, .player-controls .pbtn')].filter(b => !b.hidden);
        const i = buttons.indexOf(document.activeElement) + (e.key === 'ArrowRight' ? 1 : -1);
        if (buttons[i]) buttons[i].focus();
        e.preventDefault();
        return;
      }
      if (isTv && e.key === 'ArrowUp' && inBar) {
        document.activeElement.blur();
        e.preventDefault();
        return;
      }
      if (isTv && e.key === 'ArrowDown' && !onButton) {
        playBtn.focus();
        e.preventDefault();
        return;
      }
      if (isTv && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        return;
      }
      switch (e.key) {
        case ' ':
        case 'k':
        case 'MediaPlayPause':
          if (onButton && e.key === ' ') return;
          togglePlay();
          break;
        case 'Enter':
          if (onButton) return;
          togglePlay();
          break;
        case 'ArrowLeft':
        case 'j':
          seekBy(-SEEK_STEP);
          break;
        case 'ArrowRight':
        case 'l':
          seekBy(SEEK_STEP);
          break;
        case 'ArrowUp':
          video.volume = Math.min(1, video.volume + 0.1);
          break;
        case 'ArrowDown':
          video.volume = Math.max(0, video.volume - 0.1);
          break;
        case 'f':
          toggleFullscreen();
          break;
        case 'm':
          video.muted = !video.muted;
          break;
        case 'c':
          if (info && info.subtitles.length) {
            const keys = ['off', ...info.subtitles.map(s => s.key)];
            chooseSubtitle(keys[(keys.indexOf(subtitleKey) + 1) % keys.length]);
          }
          break;
        case 'a':
          if (info && info.audio.length > 1) {
            const i = info.audio.findIndex(a => a.index === info.audioIndex);
            chooseAudio(info.audio[(i + 1) % info.audio.length]);
          }
          break;
        case 'n':
          playNext();
          break;
        case 'Escape':
        case 'Backspace':
        case 'BrowserBack':
          if (!document.fullscreenElement) exit();
          return;
        default:
          return;
      }
      e.preventDefault();
    }),
    on(window, 'pagehide', () => {
      report({ beacon: true });
      if (info && info.sessionId) stopSession(info.sessionId);
    }),
  ];

  reportTimer = setInterval(() => {
    if (!video.paused) report();
  }, REPORT_EVERY_MS);

  renderSubsMenu();
  showControls();
  load(start);

  return {
    destroy() {
      if (destroyed) return;
      keepScreenOn(false);
      report({ beacon: true });
      destroyed = true;
      offs.forEach(off => off());
      clearInterval(reportTimer);
      clearInterval(upNextTimer);
      clearTimeout(hideTimer);
      clearTimeout(seekTimer);
      if (info && info.sessionId) stopSession(info.sessionId);
      if (hls) hls.destroy();
      video.removeAttribute('src');
      video.load();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      document.title = 'CineHome';
      root.remove();
    },
  };
}
