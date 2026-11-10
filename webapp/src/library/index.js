'use strict';

// The live library: scans on start, rescans when files change (chokidar) and on a timer,
// then probes new files and grabs poster frames in the background.

const EventEmitter = require('node:events');
const chokidar = require('chokidar');
const config = require('../config');
const { scanMedia } = require('./scanner');
const probe = require('../media/probe');
const artwork = require('../media/artwork');

const library = new EventEmitter();
let catalog = { items: new Map(), rows: { kids: [], adults: [], music: [] }, version: '' };
let artVersion = 0;
let scanning = null;
let rescanAgain = false;

library.current = () => catalog;
library.version = () => `${catalog.version}.${artVersion}`;
library.get = id => catalog.items.get(id) || null;

// The video a series' art comes from: its first episode. A playlist's cover comes from the
// first song with embedded album art, or the first music video (once they are probed).
library.sourceVideo = item => {
  if (!item) return null;
  if (item.type === 'series') return catalog.items.get(item.episodes[0]) || null;
  if (item.type === 'playlist') {
    for (const id of item.tracks) {
      const track = catalog.items.get(id);
      const info = track && probe.cached(track);
      if (info && (info.picture || info.video)) return track;
    }
    return null;
  }
  return item;
};

library.rescan = async function rescan(reason) {
  if (scanning) {
    rescanAgain = true;
    return scanning;
  }
  scanning = (async () => {
    do {
      rescanAgain = false;
      const started = Date.now();
      const next = await scanMedia(config.mediaRoot);
      if (next.version !== catalog.version) {
        const count = [...next.items.values()].filter(i => i.type !== 'episode' && i.type !== 'track').length;
        console.log(`[cinehome] library ${catalog.version ? 'changed' : 'loaded'} (${reason}): ${count} titles in ${Date.now() - started} ms`);
        catalog = next;
        probe.prune(new Set([...next.items.values()].filter(i => i.file).map(i => i.file)));
        library.emit('changed', library.version());
        processBackground();
      }
    } while (rescanAgain);
  })().finally(() => {
    scanning = null;
  });
  return scanning;
};

// Probe every video and make sure each title has art; announce once if new art appeared
let backgroundRunning = false;
let backgroundPending = false;
async function processBackground() {
  backgroundPending = true;
  if (backgroundRunning) return;
  backgroundRunning = true;
  let unannounced = 0;
  while (backgroundPending) {
    backgroundPending = false;
    for (const item of [...catalog.items.values()]) {
      if (item.file) await probe.probe(item);
      if (await artwork.ensure(item, library.sourceVideo(item))) unannounced += 1;
      if (unannounced >= 25) {
        announceArt();
        unannounced = 0;
      }
    }
  }
  backgroundRunning = false;
  if (unannounced) announceArt();
}

function announceArt() {
  artVersion += 1;
  library.emit('changed', library.version());
}

library.watch = function watch() {
  let timer = null;
  const soon = what => {
    clearTimeout(timer);
    timer = setTimeout(() => library.rescan(what), 1500);
  };
  const watcher = chokidar.watch(config.mediaRoot, {
    ignoreInitial: true,
    ignored: p => /(^|[/\\])[.@$#]/.test(p.slice(config.mediaRoot.length)),
    // Big files are copied slowly; wait until the size stops changing
    awaitWriteFinish: { stabilityThreshold: 5000, pollInterval: 1000 },
  });
  watcher.on('all', (event, file) => soon(`${event} ${file.slice(config.mediaRoot.length + 1)}`));
  watcher.on('error', err => console.warn(`[cinehome] watcher: ${err.message}`));

  // File events across Docker Desktop bind mounts are not always delivered, so also poll
  setInterval(() => library.rescan('periodic'), config.rescanIntervalMs).unref();
  return watcher;
};

module.exports = library;
