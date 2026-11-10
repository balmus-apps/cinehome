'use strict';

// Shapes the library into what the apps show: home rows, suggestions, continue watching, title details,
// and for the Music profile, playlists and their songs.

const library = require('./library');
const state = require('./state');
const artwork = require('./media/artwork');
const probe = require('./media/probe');
const { pickRandom } = require('./views');
const { MOVIES_ROW } = require('./library/scanner');

const RECENT_COUNT = 20;
const HERO_COUNT = 5;
const CONTINUE_COUNT = 20;
const SUGGESTION_COUNT = 4;

function canSee(profileId, item) {
  const profile = state.profile(profileId);
  return Boolean(profile && item && profile.libraries.includes(item.library));
}

function artUrl(item, kind) {
  const v = artwork.stamp(item, library.sourceVideo(item), kind);
  return `/api/art/${item.id}/${kind}?v=${v}`;
}

function durationOf(item) {
  const info = item.file ? probe.cached(item) : null;
  return info && info.duration ? Math.round(info.duration) : null;
}

// A series counts the views of all its episodes
function viewsOf(item) {
  if (item.type === 'series') return item.episodes.reduce((n, id) => n + state.viewsOf(id), 0);
  return state.viewsOf(item.id);
}

function card(item) {
  if (item.type === 'playlist') {
    return { id: item.id, type: item.type, title: item.title, cover: artUrl(item, 'cover'), count: item.tracks.length };
  }
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    year: item.year,
    poster: artUrl(item, 'poster'),
    backdrop: artUrl(item, 'backdrop'),
    hasBackdrop: artwork.stamp(item, library.sourceVideo(item), 'backdrop') > 0,
    views: viewsOf(item),
  };
}

// A song as the apps show it. "Artist - Title" in the file name wins over the file's own tags,
// which in downloaded collections are often missing or full of website names.
function trackView(track) {
  const info = probe.cached(track);
  const tags = (info && info.tags) || {};
  const named = Boolean(track.artist);
  return {
    id: track.id,
    kind: track.kind,
    title: named ? track.title : (tags.title || track.title),
    artist: named ? track.artist : (tags.artist || null),
    duration: info && info.duration ? Math.round(info.duration) : null,
  };
}

function episodeLabel(ep) {
  return `S${ep.season}:E${ep.episode}`;
}

function nextEpisode(ep) {
  const series = library.get(ep.seriesId);
  if (!series) return null;
  const i = series.episodes.indexOf(ep.id);
  return i >= 0 && i + 1 < series.episodes.length ? library.get(series.episodes[i + 1]) : null;
}

// Most recent unfinished thing per title; a finished episode is replaced by the next one
function continueWatching(profileId) {
  const best = new Map();
  for (const [id, p] of Object.entries(state.allProgress(profileId))) {
    let item = library.get(id);
    if (!item || !canSee(profileId, item)) continue;
    let position = p.position;
    if (p.finished || p.position < state.MIN_RESUME_SECONDS) {
      if (!p.finished || item.type !== 'episode') continue;
      item = nextEpisode(item);
      const np = item && state.progressOf(profileId, item.id);
      if (!item || (np && np.finished)) continue;
      position = np ? np.position : 0;
    }
    const titleId = item.type === 'episode' ? item.seriesId : item.id;
    const prev = best.get(titleId);
    if (!prev || prev.updatedAt < p.updatedAt) best.set(titleId, { item, position, duration: p.duration, updatedAt: p.updatedAt });
  }
  return [...best.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, CONTINUE_COUNT)
    .map(({ item, position, duration }) => {
      const series = item.type === 'episode' ? library.get(item.seriesId) : null;
      const total = durationOf(item) || (position ? duration : 0);
      return {
        id: item.id,
        titleId: series ? series.id : item.id,
        type: item.type,
        title: series ? series.title : item.title,
        subtitle: series ? [episodeLabel(item), item.title].filter(Boolean).join(' · ') : null,
        thumb: artUrl(item, 'thumb'),
        progress: total ? Math.min(1, position / total) : 0,
      };
    });
}

// Random movies, from the profile's own library first and skipping ones already watched to the end
function suggestions(profileId, titles, seed) {
  const own = state.profile(profileId).libraries[0];
  const movies = titles.filter(i => i.type === 'movie');
  const unwatched = i => {
    const p = state.progressOf(profileId, i.id);
    return !(p && p.finished);
  };
  const picked = [];
  for (const group of [
    movies.filter(i => i.library === own && unwatched(i)),
    movies.filter(i => i.library !== own && unwatched(i)),
    movies.filter(i => !unwatched(i)),
  ]) {
    picked.push(...pickRandom(group, SUGGESTION_COUNT - picked.length, seed));
  }
  return picked;
}

function home(profileId, { seed } = {}) {
  const profile = state.profile(profileId);
  const { rows } = library.current();
  const titles = [];
  const outRows = [];
  for (const lib of profile.libraries) {
    for (const row of rows[lib] || []) {
      const items = row.ids.map(library.get).filter(Boolean);
      titles.push(...items);
      const name = profileId === 'adults' && lib === 'kids' ? `Kids · ${row.name}` : row.name;
      // Movies (single films not in a series or character folder) are shown last, as a grid
      outRows.push({ name, items: items.map(card), grid: row.name === MOVIES_ROW });
    }
  }
  const recent = [...titles].sort((a, b) => b.addedAt - a.addedAt).slice(0, RECENT_COUNT);
  const withArt = recent.filter(i => artwork.stamp(i, library.sourceVideo(i), 'backdrop') > 0);
  const music = profileId === 'music';
  return {
    version: library.version(),
    profile: { id: profile.id, name: profile.name },
    hero: music ? [] : (withArt.length ? withArt : recent).slice(0, HERO_COUNT).map(card),
    suggestions: music ? [] : suggestions(profileId, titles, seed || `${profileId}:${new Date().toDateString()}`).map(card),
    continueWatching: music ? [] : continueWatching(profileId),
    recentlyAdded: recent.map(card),
    rows: [...outRows.filter(r => !r.grid), ...outRows.filter(r => r.grid)],
  };
}

function progressView(profileId, id) {
  const p = state.progressOf(profileId, id);
  return p ? { position: p.position, duration: p.duration, finished: p.finished } : null;
}

// Episode to play when pressing Play on a series: the last one touched, or the next after it
function nextUp(profileId, series) {
  let latest = null;
  for (const id of series.episodes) {
    const p = state.progressOf(profileId, id);
    if (p && (!latest || p.updatedAt > latest.p.updatedAt)) latest = { id, p };
  }
  if (!latest) return { id: series.episodes[0], resumeAt: 0 };
  if (!latest.p.finished) return { id: latest.id, resumeAt: state.resumeAt(profileId, latest.id) };
  const next = nextEpisode(library.get(latest.id));
  return next ? { id: next.id, resumeAt: state.resumeAt(profileId, next.id) } : { id: series.episodes[0], resumeAt: 0 };
}

function details(profileId, item) {
  const base = {
    ...card(item),
    library: item.library,
    row: item.row,
  };
  if (item.type === 'playlist') {
    const tracks = item.tracks.map(library.get).filter(Boolean).map(trackView);
    return { ...base, tracks, duration: tracks.reduce((n, tr) => n + (tr.duration || 0), 0) || null };
  }
  if (item.type === 'movie') {
    return {
      ...base,
      duration: durationOf(item),
      progress: progressView(profileId, item.id),
      play: { id: item.id, resumeAt: state.resumeAt(profileId, item.id) },
    };
  }
  const up = nextUp(profileId, item);
  const upEp = library.get(up.id);
  return {
    ...base,
    seasons: item.seasons.map(s => ({
      number: s.number,
      episodes: s.episodes.map(library.get).filter(Boolean).map(ep => ({
        id: ep.id,
        season: ep.season,
        episode: ep.episode,
        title: ep.title,
        duration: durationOf(ep),
        thumb: artUrl(ep, 'thumb'),
        progress: progressView(profileId, ep.id),
        views: state.viewsOf(ep.id),
      })),
    })),
    play: { ...up, label: upEp ? episodeLabel(upEp) : null, season: upEp ? upEp.season : null },
  };
}

module.exports = { canSee, home, details, nextEpisode, episodeLabel, durationOf, trackView };
