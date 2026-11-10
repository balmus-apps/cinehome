'use strict';

// On-the-fly HLS: one ffmpeg process per player, writing into <cache>/hls/<session>/.
// Sessions are dropped when the player leaves, when it starts another one, or after 2 idle minutes.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const config = require('../config');
const { hlsArgs } = require('./playback');

const HLS_DIR = path.join(config.cacheDir, 'hls');
const IDLE_MS = 2 * 60 * 1000;
const READY_TIMEOUT_MS = 45 * 1000;
const FILE_RE = /^(index\.m3u8|seg\d{5}\.ts)$/;

const sessions = new Map();

fs.rmSync(HLS_DIR, { recursive: true, force: true });

function stop(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  if (s.proc.exitCode === null) s.proc.kill('SIGKILL');
  fs.rm(s.dir, { recursive: true, force: true }, () => {});
}

function makeRoom(clientKey) {
  for (const s of [...sessions.values()]) if (s.clientKey === clientKey) stop(s.id);
  const live = [...sessions.values()].sort((a, b) => a.lastAccess - b.lastAccess);
  while (live.length >= config.maxTranscodes) stop(live.shift().id);
}

function waitForFirstSegment(s) {
  const playlist = path.join(s.dir, 'index.m3u8');
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let text = '';
      try {
        text = fs.readFileSync(playlist, 'utf8');
      } catch { /* not written yet */ }
      if (text.includes('#EXTINF')) return resolve();
      if (s.exited) return reject(new Error(s.stderr.trim().split('\n').pop() || 'ffmpeg stopped'));
      if (!sessions.has(s.id)) return reject(new Error('session stopped'));
      if (Date.now() - started > READY_TIMEOUT_MS) return reject(new Error('conversion did not start in time'));
      setTimeout(tick, 250);
    };
    tick();
  });
}

async function start({ clientKey, item, info, mode, audio, startAt }) {
  makeRoom(clientKey);
  const id = crypto.randomUUID();
  const dir = path.join(HLS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  const args = hlsArgs({ file: item.file, mode, audio, video: info && info.video, startAt, outDir: dir });
  const proc = spawn(config.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const s = { id, clientKey, itemId: item.id, mode, startAt, dir, proc, stderr: '', exited: false, lastAccess: Date.now() };
  proc.stderr.on('data', chunk => {
    s.stderr = (s.stderr + chunk).slice(-4000);
  });
  proc.on('exit', code => {
    s.exited = true;
    if (code && sessions.has(id)) console.warn(`[cinehome] ffmpeg ${mode} of ${item.rel} exited with ${code}: ${s.stderr.trim().split('\n').pop()}`);
  });
  proc.on('error', err => {
    s.exited = true;
    s.stderr += err.message;
  });
  sessions.set(id, s);

  try {
    await waitForFirstSegment(s);
  } catch (err) {
    stop(id);
    throw err;
  }
  return s;
}

// Path of a session file to serve, or null
function file(id, name) {
  const s = sessions.get(id);
  if (!s || !FILE_RE.test(name)) return null;
  s.lastAccess = Date.now();
  return path.join(s.dir, name);
}

setInterval(() => {
  const now = Date.now();
  for (const s of [...sessions.values()]) if (now - s.lastAccess > IDLE_MS) stop(s.id);
}, 30 * 1000).unref();

function stopAll() {
  for (const id of [...sessions.keys()]) stop(id);
}

module.exports = { start, stop, file, stopAll };
