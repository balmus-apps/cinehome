import './compat.js';
import { t } from './strings.js';
import { isTv, remoteKey, exitApp, lockedProfile as lockParam } from './tv.js';
import { initNav, focusEl } from './nav.js';
import { mountPlayer, formatTime } from './player.js';
import * as music from './music.js';
import { h, api, storage, formatDuration } from './ui.js';

const app = document.getElementById('app');

// ---------- helpers ----------

function hue(text) {
  let x = 0;
  for (const ch of text) x = (x * 31 + ch.charCodeAt(0)) % 360;
  return x;
}

// An image that falls back to a colored tile with the title when the server has no art yet
function art(src, title, cls) {
  const box = h('div', { class: `art ${cls || ''}`, style: `--h:${hue(title || '')}` },
    h('span', { class: 'art-fallback' }, title));
  if (src) {
    const img = h('img', { src, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
    img.addEventListener('load', () => box.classList.add('loaded'));
    img.addEventListener('error', () => img.remove());
    box.prepend(img);
  }
  return box;
}

function progressBar(fraction) {
  if (!fraction) return null;
  return h('div', { class: 'progress' }, h('div', { style: `width:${Math.max(3, Math.round(fraction * 100))}%` }));
}

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2zm0-8h-2V7h2z"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z"/></svg>',
  left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z"/></svg>',
  right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.6 16.6 10 18l6-6-6-6-1.4 1.4 4.6 4.6z"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.6 9.2 5.4 4 4 5.4l5.2 5.2zM14.5 4l2 2L4 18.6 5.4 20 18 7.5l2 2V4zm.3 9.4-1.4 1.4 3.1 3.1-2 2.1H20v-5.5l-2 2z"/></svg>',
  video: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11z"/></svg>',
  bars: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10h3v10H4zm6.5-6h3v16h-3zM17 13h3v7h-3z"/></svg>',
  eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zM12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>',
};
const icon = name => h('span', { class: 'icon', html: ICONS[name] });

// How many times a movie or episode was watched (a series adds up its episodes)
function viewCount(n) {
  return n ? h('span', { class: 'views', title: t.views(n) }, icon('eye'), String(n)) : null;
}

// The same count laid over a card's picture
function withViews(box, n) {
  const badge = viewCount(n);
  if (badge) box.append(badge);
  return box;
}

// ---------- profile & theme ----------

const PROFILES = ['adults', 'kids', 'music'];
// The avatar's letter; Music gets a note
const avatarText = id => (id === 'music' ? '♫' : t.profiles[id][0]);
const lockedProfile = PROFILES.includes(lockParam) ? lockParam : null;
let profile = lockedProfile || (PROFILES.includes(storage.get('profile')) ? storage.get('profile') : null);

function setProfile(id) {
  if (id !== profile) {
    scrollMemory.clear();
    music.stop();
  }
  profile = id;
  storage.set('profile', id);
  applyTheme();
}

function applyTheme() {
  document.body.classList.toggle('kids', profile === 'kids');
  document.body.classList.toggle('music', profile === 'music');
}

// ---------- router ----------

let cleanup = null;
let currentRoute = null;
let historyIndex = 0; // how many in-app pages are behind this one
let replacing = false;
let firstRoute = true;
const scrollMemory = new Map();

// Auto-focus only helps keyboard/remote users; mouse and touch users don't want focus rings
let usingKeys = false;
document.addEventListener('keydown', () => { usingKeys = true; }, true);
document.addEventListener('pointerdown', () => { usingKeys = false; }, true);
function autoFocus(el, dir) {
  if (el && usingKeys) focusEl(el, dir);
}

function parseRoute() {
  const [path, query] = location.hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  return { name: parts[0] || '', id: parts[1] || null, params: new URLSearchParams(query || ''), key: path };
}

export function go(hash, { replace = false } = {}) {
  if (replace) {
    replacing = true;
    location.replace(hash);
  } else {
    location.hash = hash;
  }
}

export function goBack(fallback) {
  if (historyIndex > 0) history.back();
  else go(fallback, { replace: true });
}

// Entries we created carry their index; a new entry (link click) has no state yet
function trackHistory() {
  const st = history.state;
  if (st && typeof st.cinehome === 'number') {
    historyIndex = st.cinehome;
  } else {
    if (!firstRoute && !replacing) historyIndex += 1;
    history.replaceState({ cinehome: historyIndex }, '');
  }
  replacing = false;
  firstRoute = false;
}

function rememberScroll() {
  if (!currentRoute) return;
  const rows = {};
  for (const track of app.querySelectorAll('[data-row]')) rows[track.dataset.row] = track.scrollLeft;
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
  scrollMemory.set(currentRoute.key, { y: window.scrollY, rows, focused });
}

function restoreScroll(key, { focus = true } = {}) {
  const mem = scrollMemory.get(key);
  if (!mem) return false;
  for (const track of app.querySelectorAll('[data-row]')) {
    if (mem.rows[track.dataset.row] !== undefined) track.scrollLeft = mem.rows[track.dataset.row];
  }
  window.scrollTo(0, mem.y);
  if (focus && mem.focused) {
    const el = app.querySelector(`[data-key="${CSS.escape(mem.focused)}"]`);
    if (el) el.focus({ preventScroll: true });
  }
  return true;
}

async function route() {
  rememberScroll();
  trackHistory();
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  const r = parseRoute();
  currentRoute = r;
  if (lockedProfile && r.name === 'profiles') return go('#/home', { replace: true });
  if (!profile && r.name !== 'profiles') return go('#/profiles', { replace: true });
  document.body.classList.toggle('in-player', r.name === 'watch');
  document.body.classList.toggle('on-stage', r.name === 'playing');
  if (r.name === 'watch') music.pause();

  try {
    if (r.name === 'profiles') renderProfiles();
    else if (r.name === 'title' && r.id) await renderTitle(r.id);
    else if (r.name === 'watch' && r.id) renderWatch(r.id, r.params);
    else if (r.name === 'playing') renderPlaying();
    else if (r.name === 'home') await renderHome();
    else return go('#/home', { replace: true });
  } catch (err) {
    if (currentRoute === r) renderError(err);
  }
}

function render(...nodes) {
  app.replaceChildren(...nodes);
  window.scrollTo(0, 0);
}

function renderError(err) {
  const msg = err.status === 404 ? t.notFound : (err.status ? err.message : t.loadError);
  render(header(), h('main', { class: 'message' },
    h('p', {}, msg),
    h('button', { class: 'btn', 'data-nav': true, onclick: () => route() }, t.retry),
    h('a', { class: 'btn ghost', href: '#/home', 'data-nav': true }, t.home)));
}

// ---------- header ----------

function header() {
  const bar = h('header', { class: 'topbar' },
    h('a', { class: 'logo', href: '#/home', 'data-nav': true }, h('img', { src: '/icon.svg', alt: '' }), t.appName),
    lockedProfile ? null : h('a', { class: 'profile-chip', href: '#/profiles', 'data-nav': true, title: t.switchProfile },
      h('span', { class: `avatar small ${profile}` }, avatarText(profile)),
      h('span', { class: 'profile-name' }, t.profiles[profile])));
  const onScroll = () => bar.classList.toggle('solid', window.scrollY > 40);
  window.addEventListener('scroll', onScroll, { passive: true });
  const prev = cleanup;
  cleanup = () => {
    window.removeEventListener('scroll', onScroll);
    if (prev) prev();
  };
  return bar;
}

// ---------- profiles ----------

function renderProfiles() {
  document.body.classList.remove('kids', 'music');
  const tile = id => h('button', {
    class: 'profile-tile', 'data-nav': true, 'data-key': `profile:${id}`,
    onclick: () => {
      setProfile(id);
      go('#/home');
    },
  }, h('span', { class: `avatar ${id}` }, avatarText(id)), h('span', { class: 'profile-label' }, t.profiles[id]));
  render(h('main', { class: 'profiles' },
    h('div', { class: 'logo big' }, h('img', { src: '/icon.svg', alt: '' }), t.appName),
    h('h1', {}, t.whoIsWatching),
    h('div', { class: 'profile-grid' }, PROFILES.map(tile))));
  autoFocus(app.querySelector(`[data-key="profile:${profile || 'adults'}"]`));
}

// ---------- home ----------

function posterCard(item, rowName) {
  return h('a', {
    class: 'card', href: `#/title/${item.id}`, 'data-nav': true, 'data-key': `${rowName}:${item.id}`,
    title: item.year ? `${item.title} (${item.year})` : item.title,
  }, withViews(art(item.poster, item.title, 'poster'), item.views), h('span', { class: 'card-title' }, item.title));
}

function playlistCard(item, rowName) {
  return h('a', {
    class: 'card', href: `#/title/${item.id}`, 'data-nav': true, 'data-key': `${rowName}:${item.id}`, title: item.title,
  }, art(item.cover, item.title, 'square'), h('span', { class: 'card-title' }, item.title), h('span', { class: 'card-sub' }, t.songs(item.count)));
}

// Playlists and movies share the rows; each gets its own card
const titleCard = (item, rowName) => (item.type === 'playlist' ? playlistCard(item, rowName) : posterCard(item, rowName));

function continueCard(item) {
  return h('a', {
    class: 'card wide', href: `#/watch/${item.id}`, 'data-nav': true, 'data-key': `continue:${item.id}`,
  },
  h('div', { class: 'wide-art' }, art(item.thumb, item.title, 'backdrop'), h('span', { class: 'card-play' }, icon('play')), progressBar(item.progress)),
  h('span', { class: 'card-title' }, item.title),
  item.subtitle ? h('span', { class: 'card-sub' }, item.subtitle) : null);
}

function suggestionCard(item) {
  return h('a', {
    class: 'card wide', href: `#/title/${item.id}`, 'data-nav': true, 'data-key': `suggested:${item.id}`,
    title: item.year ? `${item.title} (${item.year})` : item.title,
  },
  h('div', { class: 'wide-art' }, withViews(art(item.backdrop, item.title, 'backdrop'), item.views)),
  h('span', { class: 'card-title' }, item.title),
  item.year ? h('span', { class: 'card-sub' }, item.year) : null);
}

function row(name, cards, key = name, action = null) {
  if (!cards.length) return null;
  const track = h('div', { class: 'row-track', 'data-row': key }, cards);
  const scrollBy = dir => track.scrollBy({ left: dir * track.clientWidth * 0.85, behavior: 'smooth' });
  return h('section', { class: 'row' },
    h('h2', {}, name, action),
    h('div', { class: 'row-wrap' },
      h('button', { class: 'row-arrow left', tabindex: '-1', 'aria-label': 'Scroll left', onclick: () => scrollBy(-1) }, icon('left')),
      track,
      h('button', { class: 'row-arrow right', tabindex: '-1', 'aria-label': 'Scroll right', onclick: () => scrollBy(1) }, icon('right'))));
}

// All the cards at once, wrapping onto as many lines as they need
function gridRow(name, cards) {
  if (!cards.length) return null;
  return h('section', { class: 'row grid-row' }, h('h2', {}, name), h('div', { class: 'grid' }, cards));
}

function hero(items) {
  if (!items.length) return null;
  let index = 0;
  const bg = h('div', { class: 'hero-bg' });
  const title = h('h1', { class: 'hero-title' });
  const meta = h('div', { class: 'hero-meta' });
  const playBtn = h('a', { class: 'btn primary', 'data-nav': true, 'data-key': 'hero:play' }, icon('play'), t.play);
  const infoBtn = h('a', { class: 'btn ghost', 'data-nav': true, 'data-key': 'hero:info' }, icon('info'), t.moreInfo);
  const dots = h('div', { class: 'hero-dots' }, items.length > 1 ? items.map((_, i) => h('span', { 'data-i': i })) : []);

  const show = i => {
    index = i;
    const item = items[i];
    const layer = art(item.backdrop, item.title, 'backdrop');
    bg.append(layer);
    requestAnimationFrame(() => layer.classList.add('in'));
    [...bg.children].slice(0, -2).forEach(n => n.remove());
    title.textContent = item.title;
    meta.replaceChildren(...[item.year, item.type === 'series' ? t.series : t.movie].filter(Boolean).map(x => h('span', {}, x)));
    playBtn.href = `#/watch/${item.id}`;
    infoBtn.href = `#/title/${item.id}`;
    [...dots.children].forEach((d, j) => d.classList.toggle('on', j === i));
  };
  show(0);

  let timer = null;
  if (items.length > 1) {
    timer = setInterval(() => {
      if (!document.hidden && !(document.activeElement && document.activeElement.closest('.hero'))) show((index + 1) % items.length);
    }, 9000);
    const prev = cleanup;
    cleanup = () => {
      clearInterval(timer);
      if (prev) prev();
    };
  }
  return h('section', { class: 'hero' }, bg, h('div', { class: 'hero-content' }, title, meta, h('div', { class: 'hero-actions' }, playBtn, infoBtn)), dots);
}

let homeVersion = null;
// Kept while the app is open, so the suggestions only change on the next visit or with Shuffle
let suggestionSeed = Math.random().toString(36).slice(2);

async function renderHome({ refresh = false } = {}) {
  const data = await api(`/api/catalog?profile=${profile}&seed=${suggestionSeed}`);
  if (currentRoute.name !== 'home') return;
  homeVersion = data.version;
  if (refresh) {
    rememberScroll();
    if (cleanup) cleanup();
    cleanup = null;
  }

  const titleCount = data.rows.reduce((n, r) => n + r.items.length, 0);
  const empty = profile === 'music'
    ? [t.emptyMusicTitle, t.emptyMusic]
    : [t.emptyTitle, profile === 'kids' ? t.emptyKids : t.emptyAdults];
  const content = titleCount === 0
    ? h('main', { class: 'message' }, h('h1', {}, empty[0]), h('p', {}, empty[1]))
    : h('main', { class: data.hero.length ? 'home' : 'home no-hero' },
      hero(data.hero),
      h('div', { class: 'rows' },
        row(t.suggestions, (data.suggestions || []).map(suggestionCard), 'suggested',
          h('button', {
            class: 'row-action', 'data-nav': true, 'data-key': 'suggested:shuffle', title: t.otherSuggestions,
            onclick: () => {
              suggestionSeed = Math.random().toString(36).slice(2);
              renderHome({ refresh: true }).catch(() => {});
            },
          }, icon('shuffle'), t.shuffle)),
        row(t.continueWatching, data.continueWatching.map(continueCard), 'continue'),
        titleCount > 8 ? row(t.recentlyAdded, data.recentlyAdded.map(i => titleCard(i, 'recent')), 'recent') : null,
        data.rows.map(r => {
          const cards = r.items.map(i => titleCard(i, r.name));
          return r.grid ? gridRow(r.name, cards) : row(r.name, cards);
        })));

  render(header(), content);
  if (!restoreScroll(currentRoute.key) && !refresh) {
    autoFocus(app.querySelector('.hero [data-nav], .row [data-nav]'));
  }
}

// ---------- title details ----------

async function renderTitle(id) {
  const item = await api(`/api/items/${id}?profile=${profile}`);
  if (currentRoute.name !== 'title' || currentRoute.id !== id) return;
  if (item.type === 'playlist') return renderPlaylist(item);
  const isSeries = item.type === 'series';

  const meta = [item.year];
  if (isSeries) {
    meta.push(t.seasons(item.seasons.length));
    meta.push(t.episodes(item.seasons.reduce((n, s) => n + s.episodes.length, 0)));
  } else {
    meta.push(formatDuration(item.duration));
  }
  meta.push(item.views ? t.views(item.views) : t.noViews);

  let playLabel = item.play.resumeAt > 0 ? t.resume : t.play;
  if (isSeries && item.play.label && (item.play.resumeAt > 0 || item.play.id !== item.seasons[0].episodes[0].id)) {
    playLabel = item.play.resumeAt > 0 ? t.resumeEpisode(item.play.label) : t.playEpisode(item.play.label);
  }
  const movieProgress = !isSeries && item.progress && !item.progress.finished && item.play.resumeAt > 0
    ? h('div', { class: 'detail-progress' }, progressBar(item.progress.position / item.progress.duration),
      h('span', {}, t.minutesLeft(Math.max(1, Math.round((item.progress.duration - item.progress.position) / 60)))))
    : null;

  const focusSeason = item.episodeId
    ? item.seasons.find(s => s.episodes.some(e => e.id === item.episodeId))
    : (isSeries ? item.seasons.find(s => s.number === item.play.season) : null);

  render(header(), h('main', { class: 'detail' },
    h('div', { class: 'detail-bg' }, art(item.backdrop, item.title, 'backdrop in')),
    h('div', { class: 'detail-body' },
      art(item.poster, item.title, 'poster detail-poster'),
      h('div', { class: 'detail-info' },
        h('h1', {}, item.title),
        h('div', { class: 'hero-meta' }, meta.filter(Boolean).map(x => h('span', {}, x))),
        movieProgress,
        h('div', { class: 'hero-actions' },
          h('a', { class: 'btn primary', href: `#/watch/${item.play.id}`, 'data-nav': true, 'data-key': 'detail:play' }, icon('play'), playLabel),
          h('button', { class: 'btn ghost', 'data-nav': true, onclick: () => goBack('#/home') }, icon('back'), t.back)))),
    isSeries ? episodesSection(item, focusSeason || item.seasons[0]) : null));

  if (!restoreScroll(currentRoute.key)) {
    const target = item.episodeId && app.querySelector(`[data-key="ep:${item.episodeId}"]`);
    if (target) focusEl(target, 'down');
    else autoFocus(app.querySelector('[data-key="detail:play"]'));
  }
}

function episodesSection(item, initial) {
  const list = h('div', { class: 'episodes' });
  const tabs = h('div', { class: 'season-tabs', role: 'tablist' });
  const select = season => {
    list.replaceChildren(...season.episodes.map(ep => {
      const p = ep.progress;
      const fraction = p ? (p.finished ? 1 : p.position / p.duration) : 0;
      return h('a', { class: 'episode', href: `#/watch/${ep.id}`, 'data-nav': true, 'data-key': `ep:${ep.id}` },
        h('div', { class: 'episode-thumb' }, art(ep.thumb, t.episode(ep.episode), 'backdrop'), h('span', { class: 'card-play' }, icon('play')), progressBar(fraction)),
        h('div', { class: 'episode-text' },
          h('div', { class: 'episode-title' }, `${ep.episode}. ${ep.title || t.episode(ep.episode)}`),
          h('div', { class: 'episode-meta' }, formatDuration(ep.duration), viewCount(ep.views), p && p.finished ? h('span', { class: 'watched' }, icon('check'), t.watched) : null)));
    }));
    [...tabs.children].forEach(b => b.classList.toggle('on', Number(b.dataset.season) === season.number));
  };
  if (item.seasons.length > 1) {
    for (const s of item.seasons) {
      tabs.append(h('button', { class: 'season-tab', 'data-nav': true, 'data-season': s.number, 'data-key': `season:${s.number}`, onclick: () => select(s) }, t.season(s.number)));
    }
  }
  select(initial);
  return h('section', { class: 'episodes-section' }, item.seasons.length > 1 ? tabs : h('h2', {}, t.season(initial.number)), list);
}

// ---------- music ----------

function renderPlaylist(item) {
  const start = (i, opts) => {
    music.play(item, item.tracks, i, opts);
    // A music video is for watching: open it big
    const first = music.current();
    if (first && first.kind === 'video') go('#/playing');
  };
  const list = h('ol', { class: 'tracks' }, item.tracks.map((tr, i) => h('li', {},
    h('button', { class: 'track', 'data-nav': true, 'data-key': `track:${tr.id}`, 'data-id': tr.id, onclick: () => start(i) },
      h('span', { class: 'track-num' }, h('span', { class: 'track-index' }, String(i + 1)), icon('bars')),
      h('span', { class: 'track-text' },
        h('span', { class: 'track-title' }, tr.title),
        tr.artist ? h('span', { class: 'track-artist' }, tr.artist) : null),
      tr.kind === 'video' ? h('span', { class: 'track-kind', title: t.musicVideo }, icon('video')) : null,
      h('span', { class: 'track-time' }, tr.duration ? formatTime(tr.duration) : '')))));

  const highlight = now => {
    for (const el of list.querySelectorAll('.track')) {
      const on = Boolean(now && now.playlistId === item.id && now.songId === el.dataset.id);
      el.classList.toggle('on', on);
      el.classList.toggle('paused', on && now.paused);
    }
  };
  const off = music.onChange(highlight);
  const prev = cleanup;
  cleanup = () => {
    off();
    if (prev) prev();
  };

  render(header(), h('main', { class: 'playlist' },
    h('div', { class: 'playlist-head' },
      art(item.cover, item.title, 'square playlist-cover'),
      h('div', { class: 'detail-info' },
        h('h1', {}, item.title),
        h('div', { class: 'hero-meta' }, [t.songs(item.tracks.length), formatDuration(item.duration)].filter(Boolean).map(x => h('span', {}, x))),
        h('div', { class: 'hero-actions' },
          h('button', { class: 'btn primary', 'data-nav': true, 'data-key': 'detail:play', onclick: () => start(0) }, icon('play'), t.play),
          h('button', { class: 'btn ghost', 'data-nav': true, onclick: () => start(-1, { shuffle: true }) }, icon('shuffle'), t.shuffle),
          h('button', { class: 'btn ghost', 'data-nav': true, onclick: () => goBack('#/home') }, icon('back'), t.back)))),
    list));
  highlight(music.current());

  if (!restoreScroll(currentRoute.key)) {
    const target = item.trackId && app.querySelector(`[data-key="track:${item.trackId}"]`);
    if (target) focusEl(target, 'down');
    else autoFocus(app.querySelector('[data-key="detail:play"]'));
  }
}

function renderPlaying() {
  if (!music.current()) return go('#/home', { replace: true });
  render(header());
  const stage = music.mountStage(app, { onEmpty: () => goBack('#/home') });
  const prev = cleanup;
  cleanup = () => {
    stage.destroy();
    if (prev) prev();
  };
  autoFocus(app.querySelector('[data-key="np:play"]'));
}

// ---------- player ----------

function renderWatch(id, params) {
  app.replaceChildren();
  const player = mountPlayer(app, {
    id,
    profile,
    start: params.has('start') ? Number(params.get('start')) : null,
    onExit: titleId => goBack(`#/title/${titleId || id}`),
    onNext: nextId => go(`#/watch/${nextId}`, { replace: true }),
  });
  cleanup = () => player.destroy();
}

// ---------- live library updates ----------

function listen() {
  if (!window.EventSource) return;
  const es = new EventSource('/api/events');
  es.addEventListener('library-changed', e => {
    const { version } = JSON.parse(e.data);
    if (!currentRoute) return;
    if (currentRoute.name === 'home' && version !== homeVersion) {
      renderHome({ refresh: true }).catch(() => {});
    }
  });
}

// ---------- start ----------

initNav(() => !document.body.classList.contains('in-player'));
applyTheme();
document.body.classList.toggle('tv', isTv);

// Remote Back outside the player: one page back, or leave the app from the first page
document.addEventListener('keydown', e => {
  if (remoteKey(e) !== 'Back' || document.body.classList.contains('in-player')) return;
  e.preventDefault();
  const atRoot = historyIndex === 0 || (currentRoute && currentRoute.name === 'home');
  if (atRoot) exitApp();
  else goBack('#/home');
});
window.addEventListener('hashchange', route);
listen();
route();
