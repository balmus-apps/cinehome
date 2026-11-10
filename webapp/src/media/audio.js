'use strict';

// Songs: sent as they are when every browser (and the TV) can play them, otherwise converted
// once to AAC and cached, so seeking works the same either way.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const config = require('../config');

const AUDIO_DIR = path.join(config.cacheDir, 'audio');
// extension -> codecs that play directly in that container, and the type to send
const DIRECT = {
  '.mp3': { codecs: ['mp3'], type: 'audio/mpeg' },
  '.m4a': { codecs: ['aac'], type: 'audio/mp4' },
  '.aac': { codecs: ['aac'], type: 'audio/aac' },
  '.flac': { codecs: ['flac'], type: 'audio/flac' },
  '.ogg': { codecs: ['vorbis', 'opus'], type: 'audio/ogg' },
  '.oga': { codecs: ['vorbis', 'opus'], type: 'audio/ogg' },
  '.opus': { codecs: ['opus'], type: 'audio/ogg' },
  '.wav': { codecs: ['pcm_s16le', 'pcm_s24le', 'pcm_u8', 'pcm_f32le'], type: 'audio/wav' },
};

const inFlight = new Map();

// { direct: true, type } when the file plays as it is, else { direct: false }
function plan(info, extension) {
  const direct = DIRECT[extension];
  const codec = info && info.audio[0] && info.audio[0].codec;
  return direct && direct.codecs.includes(codec) ? { direct: true, type: direct.type } : { direct: false };
}

function convert(item, info, out) {
  const tmp = `${out}.part`;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', item.file,
    '-map', `0:${info.audio[0].index}`, '-vn', '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    '-movflags', '+faststart', '-f', 'mp4', tmp];
  return new Promise((resolve, reject) => {
    execFile(config.ffmpeg, args, { timeout: 5 * 60_000 }, err => {
      if (err) {
        fs.rmSync(tmp, { force: true });
        return reject(err);
      }
      fs.renameSync(tmp, out);
      resolve();
    });
  });
}

// The file to send for a song: { file, type }
async function source(item, info, extension) {
  const p = plan(info, extension);
  if (p.direct) return { file: item.file, type: p.type };

  const out = path.join(AUDIO_DIR, `${item.id}-${Math.round(item.mtimeMs)}.m4a`);
  if (!fs.existsSync(out)) {
    if (!inFlight.has(out)) {
      fs.mkdirSync(AUDIO_DIR, { recursive: true });
      // An older conversion of the same song (the file changed since) is no longer needed
      for (const old of fs.readdirSync(AUDIO_DIR)) {
        if (old.startsWith(`${item.id}-`)) fs.rmSync(path.join(AUDIO_DIR, old), { force: true });
      }
      inFlight.set(out, convert(item, info, out).finally(() => inFlight.delete(out)));
    }
    await inFlight.get(out);
  }
  return { file: out, type: 'audio/mp4' };
}

module.exports = { plan, source };
