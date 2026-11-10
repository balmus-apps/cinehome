'use strict';

// When playing a movie or episode counts as a view, and the seeded pick behind the home page suggestions.

const VIEW_SECONDS = 120;
// Coming back to an unfinished title after this long and starting from the top is a new viewing
const NEW_VIEWING_GAP_MS = 6 * 3600_000;

// Two minutes in counts, or half of anything shorter than four minutes
const viewThreshold = duration => Math.min(VIEW_SECONDS, duration / 2);

// From the previous progress record and a new position: is this viewing already counted, and does this update add a view?
function viewStep(prev, position, duration, now) {
  const threshold = viewThreshold(duration);
  let counted = Boolean(prev && prev.counted);
  if (counted && position < threshold && (prev.finished || now - prev.updatedAt > NEW_VIEWING_GAP_MS)) counted = false;
  const add = !counted && position >= threshold;
  return { counted: counted || add, add };
}

// Same seed, same order: the suggestions stay put while the page refreshes itself
function seededRandom(seed) {
  let a = 0;
  for (const ch of String(seed)) a = (Math.imul(a, 31) + ch.charCodeAt(0)) | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickRandom(items, count, seed) {
  const random = seededRandom(seed);
  const pool = [...items];
  const n = Math.min(count, pool.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

module.exports = { viewThreshold, viewStep, pickRandom };
