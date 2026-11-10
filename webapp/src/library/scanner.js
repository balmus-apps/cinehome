'use strict';

// Walks <mediaRoot>/{kids,adults} and builds the catalog.
// Rules: the first-level folder is the row; loose files at the top go to "Movies";
// a folder with season folders (or SxxEyy files) is a series.
// <mediaRoot>/music: every folder with songs (or music videos) is a playlist; a first-level
// folder that holds more folders is a row of playlists, the rest go to "Playlists".

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const P = require('./parse');

const LIBRARIES = ['kids', 'adults'];
const MOVIES_ROW = 'Movies';
const SERIES_ROW = 'Series';
const MUSIC = 'music';
const PLAYLISTS_ROW = 'Playlists';
const LOOSE_SONGS = 'Songs';
const MAX_DEPTH = 8;
const SAMPLE_MAX_BYTES = 150 * 1024 * 1024;

const POSTER_NAMES = ['poster', 'folder', 'cover'];
const COVER_NAMES = ['cover', 'folder', 'front', 'albumart', 'album', 'poster'];
const BACKDROP_NAMES = ['fanart', 'backdrop', 'background'];

const compareNames = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const isIgnored = name => name.startsWith('.') || name.startsWith('@') || name.startsWith('$') || name === '#recycle';
// Folders that come with downloads but hold no titles of their own
const JUNK_DIRS = new Set(['sample', 'samples', 'subs', 'subtitles', 'extras', 'featurettes', 'proof', 'screens', 'covers']);
// Row names from folders: "Desene.Animate" reads as "Desene Animate"
const rowName = dir => (dir.includes(' ') ? dir : dir.replace(/[._]+/g, ' ').trim());
// A folder with one video and nothing else is that movie's own folder, not a category
const isMovieDir = listing => listing.dirs.length === 0 && listing.files.filter(P.isVideo).length === 1;
const isSongFile = name => P.isAudio(name) || P.isVideo(name);
// "CD1", "Disc 2": parts of the same album, joined into one playlist
const isDiscDir = name => /^(?:cd|disc|disk)\s?\d{1,2}$/i.test(name.trim());

function makeId(library, rel) {
  return crypto.createHash('sha1').update(`${library}/${rel}`).digest('hex').slice(0, 12);
}

async function listDir(dir) {
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { dirs: [], files: [] };
  }
  const dirs = [];
  const files = [];
  for (const d of dirents) {
    if (isIgnored(d.name)) continue;
    let isDir = d.isDirectory();
    let isFile = d.isFile();
    if (d.isSymbolicLink()) {
      try {
        const st = await fs.stat(path.join(dir, d.name));
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
    }
    if (isDir && !JUNK_DIRS.has(d.name.toLowerCase())) dirs.push(d.name);
    else if (isFile) files.push(d.name);
  }
  dirs.sort(compareNames);
  files.sort(compareNames);
  return { dirs, files };
}

// Images and subtitles next to a video that share its name
function findSidecars(dir, files, videoName, { single = false, thumb = false } = {}) {
  const base = P.stem(videoName).toLowerCase();
  const images = new Map(files.filter(P.isImage).map(f => [P.stem(f).toLowerCase(), path.join(dir, f)]));
  const pick = names => names.map(n => images.get(n)).find(Boolean) || null;

  const posterNames = [base, `${base}-poster`, `${base}.poster`, ...(single ? POSTER_NAMES : [])];
  const backdropNames = [`${base}-backdrop`, `${base}-fanart`, `${base}.fanart`, ...(single ? BACKDROP_NAMES : [])];
  if (thumb) backdropNames.unshift(base, `${base}-thumb`);

  const subtitles = files
    .filter(f => P.isSubtitle(f) && f.toLowerCase().startsWith(base))
    .map(f => ({ file: path.join(dir, f), ...P.parseSubtitleName(P.stem(videoName), f) }));

  const backdrop = pick(backdropNames);
  let poster = thumb ? null : pick(posterNames);
  // In a movie's own folder a lone image is its poster, whatever it is called
  if (!poster && single && !thumb) {
    const others = [...images.values()].filter(f => f !== backdrop);
    if (others.length === 1) poster = others[0];
  }
  return { poster, backdrop, subtitles };
}

class Scanner {
  constructor(mediaRoot) {
    this.mediaRoot = mediaRoot;
  }

  async scan() {
    this.items = new Map();
    this.rows = {};
    for (const library of LIBRARIES) {
      this.rows[library] = new Map();
      await this.scanLibrary(library);
    }
    this.rows[MUSIC] = new Map();
    await this.scanMusic();
    const rows = {};
    for (const library of [...LIBRARIES, MUSIC]) rows[library] = this.finishRows(this.rows[library]);
    const version = crypto.createHash('sha1')
      .update(JSON.stringify([...this.items.values()]))
      .digest('hex').slice(0, 16);
    return { items: this.items, rows, version };
  }

  async scanLibrary(library) {
    const root = path.join(this.mediaRoot, library);
    const listing = await listDir(root);
    await this.addMovies(library, root, '', listing, MOVIES_ROW);
    for (const d of listing.dirs) {
      const dir = path.join(root, d);
      const sub = await listDir(dir);
      if (isSeriesDir(sub)) await this.addSeries(library, dir, d, sub, SERIES_ROW);
      else if (isMovieDir(sub)) await this.addMovies(library, dir, d, sub, MOVIES_ROW);
      else await this.walk(library, dir, d, sub, rowName(d), 1);
    }
  }

  async walk(library, dir, rel, listing, row, depth) {
    await this.addMovies(library, dir, rel, listing, row);
    if (depth >= MAX_DEPTH) return;
    for (const d of listing.dirs) {
      const subDir = path.join(dir, d);
      const subRel = `${rel}/${d}`;
      const sub = await listDir(subDir);
      if (isSeriesDir(sub)) await this.addSeries(library, subDir, subRel, sub, row);
      else await this.walk(library, subDir, subRel, sub, row, depth + 1);
    }
  }

  async addMovies(library, dir, rel, listing, row) {
    const videos = listing.files.filter(P.isVideo);
    for (const name of videos) {
      const file = path.join(dir, name);
      const st = await statFile(file);
      if (!st || (/\bsample\b/i.test(name) && st.size < SAMPLE_MAX_BYTES)) continue;
      const fileRel = rel ? `${rel}/${name}` : name;
      const ownFolder = videos.length === 1 && rel !== '';
      let { title, year } = P.parseTitle(P.stem(name));
      // A movie's own folder usually has the cleaner name ("Ice Age 2 - The Meltdown" vs "Ice Age 2@XPoWeR]")
      if (ownFolder && listing.dirs.length === 0) {
        const folder = P.parseTitle(path.basename(dir));
        if (firstWord(folder.title) === firstWord(title)) {
          title = folder.title;
          year = year || folder.year;
        }
      }
      const side = findSidecars(dir, listing.files, name, { single: ownFolder });
      const item = {
        id: makeId(library, fileRel),
        type: 'movie',
        library,
        row,
        title,
        year,
        rel: fileRel,
        file,
        size: st.size,
        mtimeMs: st.mtimeMs,
        addedAt: Math.max(st.ctimeMs, st.mtimeMs),
        poster: side.poster,
        backdrop: side.backdrop,
        subtitles: side.subtitles,
      };
      this.items.set(item.id, item);
      this.addToRow(library, row, item.id);
    }
  }

  async addSeries(library, dir, rel, listing, row) {
    const seriesId = makeId(library, `${rel}/`);
    const { title, year } = P.parseSeriesTitle(path.basename(dir));
    const episodes = [];

    const collect = async (epDir, epRel, epListing, dirSeason) => {
      const videos = epListing.files.filter(P.isVideo);
      let position = 0;
      for (const name of videos) {
        const file = path.join(epDir, name);
        const st = await statFile(file);
        if (!st || (/\bsample\b/i.test(name) && st.size < SAMPLE_MAX_BYTES)) continue;
        position += 1;
        const parsed = P.parseEpisode(P.stem(name));
        const side = findSidecars(epDir, epListing.files, name, { thumb: true });
        const fileRel = `${epRel}/${name}`;
        episodes.push({
          id: makeId(library, fileRel),
          type: 'episode',
          library,
          seriesId,
          season: dirSeason ?? parsed.season ?? 1,
          episode: parsed.episode ?? position,
          title: parsed.title,
          rel: fileRel,
          file,
          size: st.size,
          mtimeMs: st.mtimeMs,
          addedAt: Math.max(st.ctimeMs, st.mtimeMs),
          poster: null,
          backdrop: side.backdrop,
          subtitles: side.subtitles,
        });
      }
    };

    await collect(dir, rel, listing, null);
    for (const d of listing.dirs) {
      const season = P.parseSeasonDir(d);
      if (season === null) continue;
      await collect(path.join(dir, d), `${rel}/${d}`, await listDir(path.join(dir, d)), season);
    }
    if (!episodes.length) return;

    episodes.sort((a, b) => a.season - b.season || a.episode - b.episode || compareNames(a.rel, b.rel));
    const seasons = new Map();
    for (const ep of episodes) {
      if (!seasons.has(ep.season)) seasons.set(ep.season, []);
      seasons.get(ep.season).push(ep.id);
      this.items.set(ep.id, ep);
    }

    const images = new Map(listing.files.filter(P.isImage).map(f => [P.stem(f).toLowerCase(), path.join(dir, f)]));
    const pick = names => names.map(n => images.get(n.toLowerCase())).find(Boolean) || null;
    const series = {
      id: seriesId,
      type: 'series',
      library,
      row,
      title,
      year,
      rel: `${rel}/`,
      addedAt: Math.max(...episodes.map(e => e.addedAt)),
      mtimeMs: Math.max(...episodes.map(e => e.mtimeMs)),
      poster: pick([...POSTER_NAMES, path.basename(dir)]),
      backdrop: pick(BACKDROP_NAMES),
      seasons: [...seasons.entries()].sort((a, b) => a[0] - b[0]).map(([number, ids]) => ({ number, episodes: ids })),
      episodes: episodes.map(e => e.id),
    };
    this.items.set(series.id, series);
    this.addToRow(library, row, series.id);
  }

  async scanMusic() {
    const root = path.join(this.mediaRoot, MUSIC);
    const listing = await listDir(root);
    await this.addPlaylist(root, '', listing, PLAYLISTS_ROW, LOOSE_SONGS);
    for (const d of listing.dirs) {
      const dir = path.join(root, d);
      const sub = await listDir(dir);
      // Folders of folders are rows ("Tops/Top 2024"); a scans or artwork subfolder doesn't count
      const inner = await Promise.all(sub.dirs.filter(x => !isDiscDir(x)).map(x => listDir(path.join(dir, x))));
      const row = inner.some(l => l.dirs.length || l.files.some(isSongFile)) ? rowName(d) : PLAYLISTS_ROW;
      await this.walkMusic(dir, d, sub, row, 1);
    }
  }

  async walkMusic(dir, rel, listing, row, depth) {
    const discs = listing.dirs.filter(isDiscDir);
    await this.addPlaylist(dir, rel, listing, row, rowName(path.basename(dir)), discs);
    if (depth >= MAX_DEPTH) return;
    for (const d of listing.dirs) {
      if (isDiscDir(d)) continue;
      const subDir = path.join(dir, d);
      await this.walkMusic(subDir, `${rel}/${d}`, await listDir(subDir), row, depth + 1);
    }
  }

  async addPlaylist(dir, rel, listing, row, title, discs = []) {
    const playlistId = makeId(MUSIC, `${rel}/`);
    const parts = [{ dir, rel, files: listing.files }];
    for (const d of discs) {
      parts.push({ dir: path.join(dir, d), rel: rel ? `${rel}/${d}` : d, files: (await listDir(path.join(dir, d))).files });
    }
    const tracks = [];
    for (const part of parts) {
      for (const name of part.files.filter(isSongFile)) {
        const file = path.join(part.dir, name);
        const st = await statFile(file);
        if (!st) continue;
        const fileRel = part.rel ? `${part.rel}/${name}` : name;
        const parsed = P.parseTrack(P.stem(name));
        tracks.push({
          id: makeId(MUSIC, fileRel),
          type: 'track',
          library: MUSIC,
          playlistId,
          kind: P.isVideo(name) ? 'video' : 'audio',
          number: parsed.number,
          artist: parsed.artist,
          title: parsed.title,
          rel: fileRel,
          file,
          size: st.size,
          mtimeMs: st.mtimeMs,
          addedAt: Math.max(st.ctimeMs, st.mtimeMs),
          poster: null,
          backdrop: null,
          subtitles: [],
        });
      }
    }
    if (!tracks.length) return;
    for (const tr of tracks) this.items.set(tr.id, tr);

    const images = listing.files.filter(P.isImage);
    const byName = new Map(images.map(f => [P.stem(f).toLowerCase(), path.join(dir, f)]));
    const cover = COVER_NAMES.map(n => byName.get(n)).find(Boolean) || (images.length ? path.join(dir, images[0]) : null);
    const playlist = {
      id: playlistId,
      type: 'playlist',
      library: MUSIC,
      row,
      title,
      rel: `${rel}/`,
      addedAt: Math.max(...tracks.map(tr => tr.addedAt)),
      mtimeMs: Math.max(...tracks.map(tr => tr.mtimeMs)),
      poster: cover,
      backdrop: null,
      tracks: tracks.map(tr => tr.id),
    };
    this.items.set(playlist.id, playlist);
    this.addToRow(MUSIC, row, playlist.id);
  }

  addToRow(library, row, id) {
    const rows = this.rows[library];
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row).push(id);
  }

  // Folder rows alphabetically, then the catch-all "Movies" and "Series" rows ("Playlists" leads)
  finishRows(rows) {
    const byTitle = (a, b) => compareNames(this.items.get(a).title, this.items.get(b).title);
    const names = [...rows.keys()].filter(n => n !== MOVIES_ROW && n !== SERIES_ROW && n !== PLAYLISTS_ROW).sort(compareNames);
    if (rows.has(PLAYLISTS_ROW)) names.unshift(PLAYLISTS_ROW);
    if (rows.has(MOVIES_ROW)) names.push(MOVIES_ROW);
    if (rows.has(SERIES_ROW)) names.push(SERIES_ROW);
    return names.map(name => ({ name, ids: rows.get(name).sort(byTitle) }));
  }
}

const firstWord = text => (text.toLowerCase().match(/[\p{L}\p{N}]+/u) || [''])[0];

function isSeriesDir(listing) {
  if (listing.dirs.some(d => P.parseSeasonDir(d) !== null)) return true;
  const numbered = listing.files.filter(f => P.isVideo(f) && P.parseEpisode(P.stem(f)).season !== null);
  return numbered.length >= 2;
}

async function statFile(file) {
  try {
    const st = await fs.stat(file);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

async function scanMedia(mediaRoot) {
  return new Scanner(mediaRoot).scan();
}

module.exports = { scanMedia, makeId, LIBRARIES, MUSIC, MOVIES_ROW, SERIES_ROW, PLAYLISTS_ROW };
