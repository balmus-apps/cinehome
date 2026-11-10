'use strict';

const path = require('node:path');

const env = process.env;
const dataDir = path.resolve(env.DATA_DIR || '/data');

module.exports = {
  port: Number(env.PORT || 8080),
  mediaRoot: path.resolve(env.MEDIA_ROOT || '/media'),
  dataDir,
  cacheDir: path.join(dataDir, 'cache'),
  rescanIntervalMs: Math.max(10, Number(env.RESCAN_INTERVAL || 60)) * 1000,
  maxTranscodes: Math.max(1, Number(env.MAX_TRANSCODES || 2)),
  ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
  ffprobe: env.FFPROBE_PATH || 'ffprobe',
  // Needed for visits from outside the home (through a Cloudflare tunnel); see src/remote.js
  password: env.CINEHOME_PASSWORD || '',
};
