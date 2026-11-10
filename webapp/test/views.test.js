'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { viewThreshold, viewStep, pickRandom } = require('../src/views');

const HOUR = 3600_000;

// Feeds a sequence of progress updates through viewStep the way setProgress does
function watch(updates, duration = 5400) {
  let prev = null;
  let views = 0;
  for (const { position, at = 0 } of updates) {
    const step = viewStep(prev, position, duration, at);
    if (step.add) views += 1;
    prev = { counted: step.counted, finished: position / duration >= 0.92, updatedAt: at };
  }
  return views;
}

test('two minutes in counts, or half of a short video', () => {
  assert.equal(viewThreshold(5400), 120);
  assert.equal(viewThreshold(90), 45);
});

test('a view is counted once per viewing', () => {
  assert.equal(watch([{ position: 10 }, { position: 60 }]), 0);
  assert.equal(watch([{ position: 10 }, { position: 130 }, { position: 3000 }, { position: 5400 }]), 1);
  // Seeking back to the start in the same sitting is not a second view
  assert.equal(watch([{ position: 200, at: 0 }, { position: 5, at: 60_000 }, { position: 300, at: 120_000 }]), 1);
  // Resuming the next day continues the same viewing
  assert.equal(watch([{ position: 1800, at: 0 }, { position: 1810, at: 24 * HOUR }, { position: 5400, at: 25 * HOUR }]), 1);
});

test('watching again counts again', () => {
  // After the end, a new viewing starts from the top
  assert.equal(watch([{ position: 5400, at: 0 }, { position: 10, at: HOUR }, { position: 200, at: HOUR + 200_000 }]), 2);
  // Starting over long after stopping halfway
  assert.equal(watch([{ position: 2000, at: 0 }, { position: 10, at: 7 * HOUR }, { position: 200, at: 7 * HOUR + 200_000 }]), 2);
});

test('suggestions are random but stable for one seed', () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  const a = pickRandom(items, 4, 'abc');
  assert.equal(a.length, 4);
  assert.equal(new Set(a).size, 4);
  assert.deepEqual(pickRandom(items, 4, 'abc'), a);
  assert.notDeepEqual(pickRandom(items, 4, 'xyz'), a);
  assert.deepEqual(pickRandom([1, 2], 4, 'abc').sort(), [1, 2]);
  assert.deepEqual(pickRandom(items, 0, 'abc'), []);
});
