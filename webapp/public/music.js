// The music player: one media element for songs and music videos, a bar at the bottom that
// keeps playing while you browse, and the big "Now playing" page (#/playing).

import { t } from './strings.js';
import { h, api } from './ui.js';
import { isTv, isWebos, android, remoteKey } from './tv.js';
import { loadHls, formatTime } from './player.js';

const svg = path => `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
const ICONS = {
  play: svg('<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>'),
  pause: svg('<path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z"/>'),
  prev: svg('<path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/>'),
  next: svg('<path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/>'),
  close: svg('<path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4l5.6 5.6L5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z"/>'),
  fullscreen: svg('<path d="M7 14H5v5h5v-2H7zm-2-4h2V7h3V5H5zm12 7h-3v2h5v-5h-2zM14 5v2h3v3h2V5z"/>'),
};
const SEEK_STEP = 10;

// The server keeps one music-video conversion per key, separate from the movie player's
const sid = `music-${Math.random().toString(36).slice(2)}`;
const media = h('video', { playsinline: true, preload: 'auto' });
// Off screen while browsing: songs (and a music video's sound) keep playing from here
const holder = h('div', { class: 'music-holder', 'aria-hidden': 'true' }, media);
document.body.append(holder);

let playlist = null; // { id, title, cover }
let queue = []; // songs in play order: { id, kind, title, artist, duration }
let index = -1;
let info = null; // what /api/play answered for the song playing now
let hls = null;
let loadToken = 0;
let failures = 0;
const listeners = new Set();

const song = () => queue[index] || null;
const duration = () => (info && info.duration) || (Number.isFinite(media.duration) ? media.duration : 0);

function changed() {
  paintBar();
  for (const fn of listeners) fn(current());
}

// ---------- loading ----------

async function load(i, client = isWebos ? 'webos' : 'web') {
  index = i;
  const token = ++loadToken;
  const s = queue[i];
  changed();
  let data;
  try {
    data = await api(`/api/play/${s.id}?${new URLSearchParams({ profile: 'music', sid, client, start: '0' })}`);
  } catch {
    if (token === loadToken) failed();
    return;
  }
  if (token !== loadToken) {
    if (data.sessionId) stopSession(data.sessionId);
    return;
  }
  const previous = info;
  info = { ...data, client };
  if (previous && previous.sessionId && previous.sessionId !== data.sessionId) stopSession(previous.sessionId);
  showMetadata();
  await attach(data, token);
  changed();
}

async function attach(data, token) {
  if (hls) {
    hls.destroy();
    hls = null;
  }
  if (data.mode === 'direct') {
    media.src = data.url;
  } else {
    let Hls = null;
    try {
      Hls = await loadHls();
    } catch { /* fall back to native HLS */ }
    if (token !== loadToken) return;
    if (Hls && Hls.isSupported()) {
      hls = new Hls({ maxBufferLength: 60 });
      hls.on(Hls.Events.ERROR, (_, e) => {
        if (e.fatal) failed();
      });
      hls.loadSource(data.url);
      hls.attachMedia(media);
    } else if (media.canPlayType('application/vnd.apple.mpegurl')) {
      media.src = data.url;
    } else {
      failed();
      return;
    }
  }
  media.play().catch(() => changed());
}

// A file that can't be played: on the TV retry once the browser way, otherwise go on with the next
function failed() {
  const s = song();
  if (!s) return;
  if (info && info.id === s.id && info.client === 'webos' && info.mode === 'direct' && info.kind === 'video') {
    load(index, 'web');
    return;
  }
  failures += 1;
  if (failures >= queue.length) {
    stop();
    return;
  }
  setTimeout(() => {
    if (song() === s) next();
  }, 800);
}

function stopSession(sessionId) {
  const url = `/api/hls/${sessionId}/stop`;
  if (navigator.sendBeacon) navigator.sendBeacon(url, '');
  else fetch(url, { method: 'POST', keepalive: true }).catch(() => {});
}

function showMetadata() {
  const s = song();
  if (!s || !('mediaSession' in navigator) || !window.MediaMetadata) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: s.title,
    artist: s.artist || '',
    album: playlist.title,
    artwork: playlist.cover ? [{ src: new URL(playlist.cover, location.href).href, sizes: '480x480', type: 'image/jpeg' }] : [],
  });
}

// ---------- controls ----------

// Plays [songs] of [list] from [start]; shuffled keeps the chosen song first (start -1: any)
export function play(list, songs, start = 0, { shuffle = false } = {}) {
  if (!songs.length) return;
  playlist = { id: list.id, title: list.title, cover: list.cover };
  queue = songs.slice();
  let first = Math.max(0, start);
  if (shuffle) {
    const picked = start >= 0 ? queue.splice(start, 1) : [];
    for (let i = queue.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
    queue = picked.concat(queue);
    first = 0;
  }
  failures = 0;
  load(first);
}

export function jump(i) {
  if (i >= 0 && i < queue.length) load(i);
}

export function toggle() {
  if (!song()) return;
  if (media.paused || media.ended) media.play().catch(() => {});
  else media.pause();
}

export function next() {
  if (index + 1 < queue.length) load(index + 1);
  else stop();
}

export function previous() {
  // Like every music player: back to the start of the song first, then the song before
  if (media.currentTime > 3 || index === 0) media.currentTime = 0;
  else load(index - 1);
}

export function seekTo(sec) {
  if (!song()) return;
  let max = duration();
  // A music video still being converted can only seek as far as it is converted
  if (info && info.mode !== 'direct') {
    const r = media.seekable;
    max = r && r.length ? r.end(r.length - 1) : 0;
  }
  media.currentTime = Math.max(0, Math.min(sec, Math.max(0, max - 0.5)));
}

export function stop() {
  loadToken += 1;
  if (info && info.sessionId) stopSession(info.sessionId);
  if (hls) {
    hls.destroy();
    hls = null;
  }
  media.pause();
  media.removeAttribute('src');
  media.load();
  queue = [];
  index = -1;
  info = null;
  playlist = null;
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  changed();
}

export function pause() {
  if (song()) media.pause();
}

// What is playing now, for pages to highlight: { playlistId, songId, kind, paused } or null
export function current() {
  const s = song();
  return s ? { playlistId: playlist.id, songId: s.id, kind: s.kind, paused: media.paused } : null;
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------- the bar ----------

const pbtn = (name, label, onclick) => h('button', { class: 'pbtn', 'data-nav': true, 'aria-label': label, title: label, html: ICONS[name], onclick });
const barCover = h('div', { class: 'music-cover' });
const barTitle = h('div', { class: 'music-title' });
const barArtist = h('div', { class: 'music-artist' });
const barFill = h('div', { class: 'music-progress-fill' });
const barTime = h('span', { class: 'music-time' });
const barPlay = pbtn('play', t.play, () => toggle());
const bar = h('div', { class: 'music-bar', hidden: true },
  h('div', { class: 'music-progress' }, barFill),
  h('a', { class: 'music-now', href: '#/playing', 'data-nav': true, 'data-key': 'music:now', title: t.nowPlaying },
    barCover, h('div', { class: 'music-text' }, barTitle, barArtist)),
  h('div', { class: 'music-buttons' },
    pbtn('prev', t.previous, () => previous()),
    barPlay,
    pbtn('next', t.next, () => next()),
    barTime,
    pbtn('close', t.close, () => stop())));
document.body.append(bar);

let barCoverSrc = null;
function paintBar() {
  const s = song();
  bar.hidden = !s;
  document.body.classList.toggle('has-music', Boolean(s));
  if (!s) return;
  barPlay.innerHTML = media.paused ? ICONS.play : ICONS.pause;
  barPlay.setAttribute('aria-label', media.paused ? t.play : t.pause);
  barTitle.textContent = s.title;
  barArtist.textContent = s.kind === 'video' ? [s.artist, t.musicVideo].filter(Boolean).join(' · ') : (s.artist || playlist.title);
  if (barCoverSrc !== playlist.cover) {
    barCoverSrc = playlist.cover;
    barCover.replaceChildren();
    if (playlist.cover) {
      const img = h('img', { src: playlist.cover, alt: '' });
      img.addEventListener('error', () => img.remove());
      barCover.append(img);
    }
  }
  paintTime();
}

function paintTime() {
  const d = duration();
  barFill.style.width = d ? `${Math.min(100, (media.currentTime / d) * 100)}%` : '0';
  barTime.textContent = `${formatTime(media.currentTime)} / ${formatTime(d || (song() && song().duration))}`;
}

// ---------- the Now playing page ----------

export function mountStage(container, { onEmpty }) {
  const screen = h('div', { class: 'np-screen' });
  const cover = h('div', { class: 'np-cover' });
  const title = h('h1', { class: 'np-title' });
  const artist = h('div', { class: 'np-artist' });
  const from = h('a', { class: 'np-from', 'data-nav': true });
  const fill = h('div', { class: 'seek-fill' });
  const cur = h('span');
  const total = h('span');
  const seek = h('div', { class: 'np-seek', role: 'slider', 'aria-label': 'Seek', tabindex: '0', 'data-nav': true },
    h('div', { class: 'seek-rail' }, fill));
  const playBtn = h('button', { class: 'pbtn np-play', 'data-nav': true, 'data-key': 'np:play', 'aria-label': t.play, html: ICONS.play, onclick: () => toggle() });
  const fsBtn = h('button', {
    class: 'pbtn', 'data-nav': true, 'aria-label': t.fullscreen, title: t.fullscreen, html: ICONS.fullscreen,
    onclick: () => (screen.requestFullscreen ? screen.requestFullscreen() : media.webkitEnterFullscreen && media.webkitEnterFullscreen()),
  });
  const list = h('ol', { class: 'np-queue' });

  screen.append(media, cover);
  container.append(h('main', { class: 'np' },
    screen,
    h('div', { class: 'np-info' },
      title, artist, from,
      seek,
      h('div', { class: 'np-times' }, cur, total),
      h('div', { class: 'np-controls' }, pbtn('prev', t.previous, () => previous()), playBtn, pbtn('next', t.next, () => next()), fsBtn)),
    h('section', { class: 'np-up' }, h('h2', {}, t.queue), list)));

  seek.addEventListener('pointerdown', e => {
    const r = seek.getBoundingClientRect();
    seekTo(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration());
  });
  // Remote: ◀ ▶ on the bar seek, like in the video player
  seek.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    seekTo(media.currentTime + (e.key === 'ArrowLeft' ? -SEEK_STEP : SEEK_STEP));
  });

  let shownSong = null;
  let shownQueue = null;
  const paint = () => {
    const s = song();
    if (!s) {
      onEmpty();
      return;
    }
    screen.classList.toggle('video', s.kind === 'video');
    fsBtn.hidden = s.kind !== 'video' || isTv || Boolean(android);
    playBtn.innerHTML = media.paused ? ICONS.play : ICONS.pause;
    playBtn.setAttribute('aria-label', media.paused ? t.play : t.pause);
    if (shownSong !== s) {
      shownSong = s;
      title.textContent = s.title;
      artist.textContent = s.artist || '';
      from.textContent = t.playingFrom(playlist.title);
      from.href = `#/title/${playlist.id}`;
      cover.replaceChildren(h('span', { class: 'np-cover-fallback' }, playlist.title));
      if (playlist.cover) {
        const img = h('img', { src: playlist.cover, alt: '' });
        img.addEventListener('error', () => img.remove());
        cover.append(img);
      }
      document.title = `${s.title} · CineHome`;
    }
    if (shownQueue !== queue) {
      shownQueue = queue;
      list.replaceChildren(...queue.map((q, i) => h('li', {},
        h('button', { class: 'np-song', 'data-nav': true, 'data-key': `np:${q.id}`, onclick: () => jump(i) },
          h('span', { class: 'np-song-title' }, q.title),
          h('span', { class: 'np-song-artist' }, [q.artist, q.kind === 'video' ? t.musicVideo : null].filter(Boolean).join(' · '))))));
    }
    [...list.children].forEach((li, i) => li.classList.toggle('on', i === index));
    time();
  };
  const time = () => {
    const d = duration();
    fill.style.width = d ? `${Math.min(100, (media.currentTime / d) * 100)}%` : '0';
    cur.textContent = formatTime(media.currentTime);
    total.textContent = formatTime(d || (song() && song().duration));
  };

  const off = onChange(paint);
  media.addEventListener('timeupdate', time);
  paint();
  return {
    destroy() {
      off();
      media.removeEventListener('timeupdate', time);
      // Moved, not removed: the song goes on playing
      holder.append(media);
    },
  };
}

// ---------- events ----------

media.addEventListener('play', changed);
media.addEventListener('pause', changed);
media.addEventListener('playing', () => {
  failures = 0;
});
media.addEventListener('timeupdate', paintTime);
media.addEventListener('durationchange', paintTime);
media.addEventListener('ended', () => next());
media.addEventListener('error', () => {
  if (!hls && media.getAttribute('src')) failed();
});

if ('mediaSession' in navigator) {
  const actions = { play: () => media.play().catch(() => {}), pause: () => media.pause(), previoustrack: previous, nexttrack: next, stop };
  for (const [action, fn] of Object.entries(actions)) {
    try {
      navigator.mediaSession.setActionHandler(action, () => fn());
    } catch { /* not supported here */ }
  }
}

// Remote and keyboard media keys (the video player handles its own)
document.addEventListener('keydown', e => {
  if (!song() || document.body.classList.contains('in-player')) return;
  const key = remoteKey(e);
  if (key === 'Play') media.play().catch(() => {});
  else if (key === 'Pause') media.pause();
  else if (key === 'PlayPause') toggle();
  else if (key === 'FastForward' || e.key === 'MediaTrackNext') next();
  else if (key === 'Rewind' || e.key === 'MediaTrackPrevious') previous();
  else if (key === 'Stop') stop();
  else return;
  e.preventDefault();
});
