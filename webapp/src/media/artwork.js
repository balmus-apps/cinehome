'use strict';

// Every image the apps show comes in one fixed size per kind, made once with ffmpeg and cached:
//   poster   480x720  (2:3)   cards and the detail page
//   backdrop 1280x720 (16:9)  hero banner and detail background
//   thumb    480x270  (16:9)  episode lists and Continue watching
//   cover    480x480  (1:1)   music playlists
// Sources: a sidecar image if there is one (odd shapes are fitted onto a blurred copy of
// themselves rather than cropped), then for posters one downloaded by scripts/fetch-posters.js,
// otherwise a frame from the video with black bars trimmed, or for songs the album art embedded in the file.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const config = require('../config');
const { probe } = require('./probe');

// Bump the folder name when the image recipe changes; older caches are removed at startup
const ART_DIR = path.join(config.cacheDir, 'art-v2');
const DOWNLOADED_DIR = path.join(config.dataDir, 'posters');
const SIZES = { poster: [480, 720], backdrop: [1280, 720], thumb: [480, 270], cover: [480, 480] };
const KINDS = new Set(Object.keys(SIZES));
const KINDS_BY_TYPE = { movie: ['poster', 'backdrop', 'thumb'], series: ['poster', 'backdrop', 'thumb'], episode: ['thumb'], playlist: ['cover'] };
// Sidecar images closer than this to the target shape are cropped; others are fitted on blur
const CROP_TOLERANCE = 0.1;

const inFlight = new Map();
const failed = new Map(); // id -> signature of sources that failed, so we don't retry on every request
let running = 0;
const waiting = [];

fs.rmSync(path.join(config.cacheDir, 'art'), { recursive: true, force: true });

const mtime = file => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

function cachePath(id, kind) {
  return path.join(ART_DIR, `${id}-${kind}.jpg`);
}

// A poster fetched from the internet, if there is one
function downloadedPoster(item) {
  const file = path.join(DOWNLOADED_DIR, `${item.id}.jpg`);
  return mtime(file) ? file : null;
}

// Where a kind comes from: the sidecar image, a downloaded poster, else the video
function sourceOf(item, video, kind) {
  let image = kind === 'poster' || kind === 'cover' ? item.poster : item.backdrop;
  if (!image && kind === 'poster') image = downloadedPoster(item);
  if (image) return { image, time: mtime(image) };
  return video ? { video, time: video.mtimeMs } : null;
}

function isFresh(item, video, kind) {
  const src = sourceOf(item, video, kind);
  return Boolean(src) && mtime(cachePath(item.id, kind)) >= src.time;
}

// Cache-busting stamp for URLs; 0 means "not made yet"
function stamp(item, video, kind) {
  return isFresh(item, video, kind) ? Math.round(mtime(cachePath(item.id, kind))) : 0;
}

function run(cmd, args, timeout = 60_000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr })));
  });
}

async function withSlot(fn) {
  if (running >= 2) await new Promise(r => waiting.push(r));
  running += 1;
  try {
    return await fn();
  } finally {
    running -= 1;
    const next = waiting.shift();
    if (next) next();
  }
}

const cover = ([w, h]) => `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;
const fitOnBlur = ([w, h]) => `split=2[bg][fg];[bg]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=20:2,eq=brightness=-0.08[bgb];`
  + `[fg]scale=${w}:${h}:force_original_aspect_ratio=decrease[fgs];[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1`;

async function imageSize(file) {
  const { stdout } = await run(config.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
  const [w, h] = stdout.trim().split(',').map(Number);
  return w && h ? { w, h } : null;
}

async function fromImage(image, kind, out) {
  const size = SIZES[kind];
  const dims = await imageSize(image);
  const target = size[0] / size[1];
  const close = dims && Math.abs(dims.w / dims.h - target) / target <= CROP_TOLERANCE;
  await run(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', image,
    '-filter_complex', `[0:v:0]${close ? cover(size) : fitOnBlur(size)}`, '-frames:v', '1', '-q:v', '3', out]);
}

// Letterbox/pillarbox bars of a frame, as an ffmpeg crop filter (or '' when there are none)
async function detectBars(file, at, info) {
  try {
    const { stderr } = await run(config.ffmpeg, ['-hide_banner', '-nostdin', '-ss', String(at), '-i', file,
      '-map', `0:${info.video.index}`, '-vf', 'cropdetect=limit=24:round=2:reset=0', '-frames:v', '8', '-f', 'null', '-'], 30_000);
    const all = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
    if (!all.length) return '';
    const [, w, h, x, y] = all[all.length - 1].map(Number);
    const { width, height } = info.video;
    // Ignore nearly-black frames (tiny crops) and bars too thin to matter
    if (w < width * 0.4 || h < height * 0.4) return '';
    if (w > width * 0.97 && h > height * 0.97) return '';
    return `crop=${w}:${h}:${x}:${y},`;
  } catch {
    return '';
  }
}

async function fromVideo(video, kinds, outs) {
  const info = await probe(video);
  // A song has no picture stream except its embedded album art: take that, no seeking
  const still = info && !info.video ? info.picture : null;
  const stream = info && (info.video || still);
  if (!stream) throw new Error('no video stream');
  const duration = info.duration || 0;
  const at = still ? 0 : (duration ? Math.min(Math.max(duration * 0.12, 1), 900) : 30);
  const bars = still ? '' : await detectBars(video.file, at, info);
  const labels = kinds.map((_, i) => `o${i}`);
  const filter = `[0:${stream.index}]${bars}scale='if(gt(sar,0),iw*sar,iw)':ih,setsar=1,split=${kinds.length}${labels.map(l => `[${l}i]`).join('')};`
    + kinds.map((kind, i) => `[${labels[i]}i]${cover(SIZES[kind])}[${labels[i]}]`).join(';');
  // (any -ss, even 0, drops an embedded picture, so stills are read without one)
  const args = seek => ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...(still ? [] : ['-ss', String(seek)]), '-i', video.file,
    '-filter_complex', filter,
    ...kinds.flatMap((kind, i) => ['-map', `[${labels[i]}]`, '-frames:v', '1', '-q:v', '3', outs[i]])];
  // Damaged or oddly indexed files sometimes can't seek that far: try earlier before giving up
  for (const seek of still ? [0] : [at, Math.min(at / 4, 30), 0]) {
    try {
      await run(config.ffmpeg, args(seek));
      if (fs.existsSync(outs[0])) return;
    } catch (err) {
      if (seek === 0) throw err;
    }
  }
  throw new Error('no frame could be read');
}

async function build(item, video, kinds) {
  fs.mkdirSync(ART_DIR, { recursive: true });
  const tmp = kind => path.join(ART_DIR, `${item.id}-${kind}.tmp.jpg`);
  const fromVideoKinds = [];
  for (const kind of kinds) {
    const src = sourceOf(item, video, kind);
    if (src.image) await fromImage(src.image, kind, tmp(kind));
    else fromVideoKinds.push(kind);
  }
  if (fromVideoKinds.length) await fromVideo(video, fromVideoKinds, fromVideoKinds.map(tmp));
  for (const kind of kinds) fs.renameSync(tmp(kind), cachePath(item.id, kind));
}

// Make every image of an item exist at its fixed size; resolves true if anything was made
async function ensure(item, video) {
  const kinds = (KINDS_BY_TYPE[item.type] || []).filter(kind => sourceOf(item, video, kind) && !isFresh(item, video, kind));
  if (!kinds.length) return false;
  const signature = kinds.map(kind => `${kind}:${sourceOf(item, video, kind).time}`).join('|');
  if (failed.get(item.id) === signature) return false;
  if (inFlight.has(item.id)) return inFlight.get(item.id);

  const job = withSlot(() => build(item, video, kinds))
    .then(() => true)
    .catch(err => {
      failed.set(item.id, signature);
      const reason = err.message.trim().split('\n').filter(Boolean).pop();
      console.warn(`[cinehome] could not make images for ${item.rel}: ${reason}`);
      return false;
    })
    .finally(() => inFlight.delete(item.id));
  inFlight.set(item.id, job);
  return job;
}

// Absolute path of the image to serve, making it on demand; null if there is none
async function resolve(item, video, kind) {
  if (!KINDS.has(kind)) return null;
  await ensure(item, video);
  const file = cachePath(item.id, kind);
  if (fs.existsSync(file)) return file;
  // Last resort: the sidecar as it is, if resizing it failed
  const src = sourceOf(item, video, kind);
  return src && src.image && fs.existsSync(src.image) ? src.image : null;
}

module.exports = { resolve, ensure, stamp, KINDS, SIZES };
