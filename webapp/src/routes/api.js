'use strict';

const express = require('express');
const crypto = require('node:crypto');
const library = require('../library');
const catalog = require('../catalog');
const state = require('../state');
const events = require('../events');
const probe = require('../media/probe');
const artwork = require('../media/artwork');
const playback = require('../media/playback');
const hls = require('../media/hls');
const subtitles = require('../media/subtitles');
const songs = require('../media/audio');
const { ext } = require('../library/parse');

const router = express.Router();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// No accounts: the profile only decides what is listed. Unknown or missing means kids.
function profileOf(req) {
  const id = req.query.profile || (req.body && req.body.profile);
  return state.profile(id) ? id : 'kids';
}

function visibleItem(req, types) {
  const item = library.get(req.params.id);
  if (!item || !catalog.canSee(profileOf(req), item) || (types && !types.includes(item.type))) {
    throw new HttpError(404, 'Not found');
  }
  return item;
}

router.get('/profiles', (req, res) => {
  res.json(state.PROFILES.map(({ id, name }) => ({ id, name })));
});

// seed: the apps pick one when they open and keep it, so the suggestions only change on a new visit or a shuffle
router.get('/catalog', (req, res) => {
  res.json(catalog.home(profileOf(req), { seed: req.query.seed }));
});

router.get('/items/:id', (req, res) => {
  let item = visibleItem(req);
  let episodeId = null;
  let trackId = null;
  if (item.type === 'episode') {
    episodeId = item.id;
    item = library.get(item.seriesId);
  } else if (item.type === 'track') {
    trackId = item.id;
    item = library.get(item.playlistId);
  }
  res.json({ ...catalog.details(profileOf(req), item), episodeId, trackId });
});

// Images are not filtered by profile: their URLs carry none, and a poster gives nothing away
router.get('/art/:id/:kind', wrap(async (req, res) => {
  const item = library.get(req.params.id);
  if (!item) throw new HttpError(404, 'Not found');
  const file = await artwork.resolve(item, library.sourceVideo(item), req.params.kind);
  if (!file) throw new HttpError(404, 'No image');
  const versioned = req.query.v && req.query.v !== '0';
  res.set('Cache-Control', versioned ? 'public, max-age=604800, immutable' : 'no-cache');
  res.sendFile(file, { dotfiles: 'allow' });
}));

router.get('/play/:id', wrap(async (req, res) => {
  const profileId = profileOf(req);
  let item = visibleItem(req, ['movie', 'episode', 'series', 'track']);
  if (item.type === 'series') item = library.get(catalog.details(profileId, item).play.id);

  const info = await probe.probe(item);
  if (!info) throw new HttpError(503, 'This file can not be read yet. If it is still being copied, try again in a minute.');

  const startAt = req.query.start !== undefined
    ? Math.max(0, Math.min(Number(req.query.start) || 0, (info.duration || 1) - 1))
    : state.resumeAt(profileId, item.id);
  const audio = playback.chooseAudio(info, { index: req.query.audio, lang: req.query.audioLang, pos: req.query.audioPos });
  // A song (no picture besides album art) always plays directly, converted once if it must be
  const isSong = item.type === 'track' && !info.video;
  // ExoPlayer on Android plays nearly everything itself and switches audio tracks on its own
  const decision = req.query.client === 'android' || isSong
    ? { mode: 'direct', audio }
    : playback.decide(info, ext(item.file), audio, req.query.client === 'webos' ? 'webos' : 'web');

  let url;
  let offset = 0;
  let sessionId = null;
  if (isSong) {
    url = `/api/audio/${item.id}?profile=${profileId}`;
  } else if (decision.mode === 'direct') {
    url = `/api/stream/${item.id}?profile=${profileId}`;
  } else {
    const session = await hls.start({
      clientKey: req.query.sid || crypto.randomUUID(),
      item, info, mode: decision.mode, audio: decision.audio, startAt,
    });
    sessionId = session.id;
    offset = startAt;
    url = `/api/hls/${session.id}/index.m3u8`;
  }

  const series = item.type === 'episode' ? library.get(item.seriesId) : null;
  const next = item.type === 'episode' ? catalog.nextEpisode(item) : null;
  const song = item.type === 'track' ? catalog.trackView(item) : null;
  let subtitle = item.year ? String(item.year) : null;
  if (series) subtitle = [catalog.episodeLabel(item), item.title].filter(Boolean).join(' · ');
  else if (song) subtitle = song.artist;
  res.json({
    id: item.id,
    titleId: series ? series.id : (song ? item.playlistId : item.id),
    title: series ? series.title : (song ? song.title : item.title),
    subtitle,
    kind: song ? (isSong ? 'audio' : 'video') : 'video',
    mode: decision.mode,
    url,
    sessionId,
    offset,
    startAt,
    duration: info.duration,
    audio: playback.audioTracks(info),
    audioIndex: decision.audio ? decision.audio.index : null,
    subtitles: subtitles.tracks(item, info).map(t => ({
      ...t,
      url: `/api/subtitles/${item.id}/${t.key}.vtt?profile=${profileId}&offset=${offset}`,
    })),
    next: next ? { id: next.id, label: [catalog.episodeLabel(next), next.title].filter(Boolean).join(' · ') } : null,
  });
}));

router.get('/stream/:id', (req, res, next) => {
  const item = visibleItem(req, ['movie', 'episode', 'track']);
  const type = ext(item.file) === '.webm' ? 'video/webm' : 'video/mp4';
  res.sendFile(item.file, { dotfiles: 'allow', headers: { 'Content-Type': type } }, err => {
    if (err && !res.headersSent) next(err);
  });
});

router.get('/audio/:id', wrap(async (req, res, next) => {
  const item = visibleItem(req, ['track']);
  const info = await probe.probe(item);
  if (!info || !info.audio.length) throw new HttpError(404, 'This song can not be played.');
  const { file, type } = await songs.source(item, info, ext(item.file));
  res.sendFile(file, { dotfiles: 'allow', headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=3600' } }, err => {
    if (err && !res.headersSent) next(err);
  });
}));

router.get('/hls/:session/:file', (req, res) => {
  const file = hls.file(req.params.session, req.params.file);
  if (!file) throw new HttpError(404, 'Session ended');
  const isPlaylist = req.params.file.endsWith('.m3u8');
  res.sendFile(file, {
    headers: {
      'Content-Type': isPlaylist ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
      'Cache-Control': isPlaylist ? 'no-cache' : 'private, max-age=3600',
    },
  }, err => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// sendBeacon-friendly: the player calls this when it closes
router.post('/hls/:session/stop', (req, res) => {
  hls.stop(req.params.session);
  res.status(204).end();
});

router.get('/subtitles/:id/:key.vtt', wrap(async (req, res) => {
  const item = visibleItem(req, ['movie', 'episode']);
  const info = await probe.probe(item);
  const vtt = await subtitles.load(item, info, req.params.key);
  if (vtt === null) throw new HttpError(404, 'No such subtitle');
  res.type('text/vtt; charset=utf-8').send(subtitles.shiftVtt(vtt, Number(req.query.offset) || 0));
}));

router.post('/progress', (req, res) => {
  const { id, position, duration } = req.body || {};
  const item = library.get(id);
  const profileId = profileOf(req);
  if (!item || !catalog.canSee(profileId, item) || !item.file) throw new HttpError(404, 'Not found');
  const pos = Number(position);
  const dur = Number(duration);
  if (!Number.isFinite(pos) || !Number.isFinite(dur) || pos < 0 || dur <= 0) throw new HttpError(400, 'Bad position');
  const countViews = item.type === 'movie' || item.type === 'episode';
  res.json(state.setProgress(profileId, id, Math.min(pos, dur), dur, { countViews }));
});

router.get('/events', events.handler);

router.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(`[cinehome] ${req.method} ${req.originalUrl}: ${err.stack || err.message}`);
  res.status(status).json({ error: status >= 500 && !err.status ? 'Something went wrong' : err.message });
});

module.exports = router;
