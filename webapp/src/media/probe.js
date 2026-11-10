'use strict';

// ffprobe with a cache on the data volume, keyed by path + size + mtime.

const { execFile } = require('node:child_process');
const path = require('node:path');
const config = require('../config');
const { readJson, debouncedWriter } = require('../jsonfile');

const CACHE_FILE = path.join(config.cacheDir, 'probe.json');
const cache = readJson(CACHE_FILE, {});
const writer = debouncedWriter(CACHE_FILE, () => cache, 3000);
const inFlight = new Map();

function run(file) {
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file];
  return new Promise((resolve, reject) => {
    execFile(config.ffprobe, args, { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function normalize(raw) {
  const streams = raw.streams || [];
  const tags = s => s.tags || {};
  const isPicture = s => Boolean(s.disposition && s.disposition.attached_pic);
  const video = streams.find(s => s.codec_type === 'video' && !isPicture(s));
  const picture = streams.find(s => s.codec_type === 'video' && isPicture(s));
  const duration = Number(raw.format && raw.format.duration) || Number(video && video.duration) || null;
  // Song tags sit on the container (mp3, m4a) or on the audio stream (ogg, opus); keys vary in case
  const songTags = {};
  const firstAudio = streams.find(s => s.codec_type === 'audio');
  for (const source of [firstAudio && firstAudio.tags, raw.format && raw.format.tags]) {
    for (const [k, v] of Object.entries(source || {})) {
      const key = k.toLowerCase();
      if ((key === 'title' || key === 'artist' || key === 'album') && String(v).trim()) songTags[key] = String(v).trim();
    }
  }
  return {
    duration,
    formatName: (raw.format && raw.format.format_name) || '',
    tags: songTags,
    // Album art embedded in a song
    picture: picture ? { index: picture.index, width: picture.width, height: picture.height } : null,
    video: video ? {
      index: video.index,
      codec: video.codec_name,
      profile: video.profile || null,
      pixFmt: video.pix_fmt || null,
      width: video.width,
      height: video.height,
    } : null,
    audio: streams.filter(s => s.codec_type === 'audio').map(s => ({
      index: s.index,
      codec: s.codec_name,
      channels: s.channels,
      lang: tags(s).language || null,
      title: tags(s).title || null,
      isDefault: Boolean(s.disposition && s.disposition.default),
    })),
    subtitles: streams.filter(s => s.codec_type === 'subtitle').map(s => ({
      index: s.index,
      codec: s.codec_name,
      lang: tags(s).language || null,
      title: tags(s).title || null,
      forced: Boolean(s.disposition && s.disposition.forced),
    })),
  };
}

function cached(item) {
  const hit = cache[item.file];
  return hit && hit.size === item.size && hit.mtimeMs === item.mtimeMs ? hit.info : null;
}

// Returns normalized stream info, or null when the file can't be read (e.g. still copying)
async function probe(item) {
  const hit = cached(item);
  if (hit) return hit;
  if (inFlight.has(item.file)) return inFlight.get(item.file);
  const job = run(item.file)
    .then(raw => {
      const info = normalize(raw);
      cache[item.file] = { size: item.size, mtimeMs: item.mtimeMs, info };
      writer.schedule();
      return info;
    })
    .catch(err => {
      console.warn(`[cinehome] ffprobe failed for ${item.rel}: ${err.message.split('\n')[0]}`);
      return null;
    })
    .finally(() => inFlight.delete(item.file));
  inFlight.set(item.file, job);
  return job;
}

// Drop cache entries for files that are gone
function prune(liveFiles) {
  let changed = false;
  for (const file of Object.keys(cache)) {
    if (!liveFiles.has(file)) {
      delete cache[file];
      changed = true;
    }
  }
  if (changed) writer.schedule();
}

module.exports = { probe, cached, prune, flush: writer.flush };
