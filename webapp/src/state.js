'use strict';

// Watch progress per profile and view counts per title, kept in <data>/state.json.

const path = require('node:path');
const config = require('./config');
const { readJson, debouncedWriter } = require('./jsonfile');
const { viewThreshold, viewStep } = require('./views');

const PROFILES = [
  { id: 'adults', name: 'Adults', libraries: ['adults', 'kids'] },
  { id: 'kids', name: 'Kids', libraries: ['kids'] },
  { id: 'music', name: 'Music', libraries: ['music'] },
];
const FINISHED_RATIO = 0.92;
const MIN_RESUME_SECONDS = 30;

const FILE = path.join(config.dataDir, 'state.json');
const state = readJson(FILE, {});
state.progress = state.progress || {};
for (const p of PROFILES) state.progress[p.id] = state.progress[p.id] || {};
const writer = debouncedWriter(FILE, () => state, 1000);

// Views across all profiles: id -> { count, lastAt }. Counting started after some watching was
// already saved, so each title watched far enough by then starts with one view.
if (!state.views) {
  state.views = {};
  for (const records of Object.values(state.progress)) {
    for (const [id, p] of Object.entries(records)) {
      if (!p.finished && !(p.duration > 0 && p.position >= viewThreshold(p.duration))) continue;
      p.counted = true;
      const v = state.views[id] || (state.views[id] = { count: 0, lastAt: 0 });
      v.count += 1;
      v.lastAt = Math.max(v.lastAt, p.updatedAt || 0);
    }
  }
  writer.schedule();
}

const profile = id => PROFILES.find(p => p.id === id) || null;

function progressOf(profileId, id) {
  return (state.progress[profileId] || {})[id] || null;
}

function allProgress(profileId) {
  return state.progress[profileId] || {};
}

const viewsOf = id => (state.views[id] ? state.views[id].count : 0);

function setProgress(profileId, id, position, duration, { countViews = true } = {}) {
  const finished = duration > 0 && position / duration >= FINISHED_RATIO;
  const now = Date.now();
  const view = countViews ? viewStep(progressOf(profileId, id), position, duration, now) : { counted: false, add: false };
  if (view.add) {
    const v = state.views[id] || (state.views[id] = { count: 0, lastAt: 0 });
    v.count += 1;
    v.lastAt = now;
  }
  state.progress[profileId][id] = {
    position: Math.round(position),
    duration: Math.round(duration),
    finished,
    counted: view.counted,
    updatedAt: now,
  };
  writer.schedule();
  return state.progress[profileId][id];
}

// Where playback should start: the saved position, unless it's at the very start or finished
function resumeAt(profileId, id) {
  const p = progressOf(profileId, id);
  return p && !p.finished && p.position >= MIN_RESUME_SECONDS ? p.position : 0;
}

module.exports = { PROFILES, MIN_RESUME_SECONDS, profile, progressOf, allProgress, setProgress, resumeAt, viewsOf, flush: writer.flush };
