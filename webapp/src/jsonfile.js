'use strict';

// Small JSON files on the data volume: read once, write atomically (tmp + rename) and debounced.

const fs = require('node:fs');
const path = require('node:path');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function debouncedWriter(file, getData, delayMs = 1000) {
  let timer = null;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    try {
      writeJsonAtomic(file, getData());
    } catch (err) {
      console.error(`[cinehome] could not write ${file}: ${err.message}`);
    }
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(flush, delayMs);
  };
  return { schedule, flush };
}

module.exports = { readJson, writeJsonAtomic, debouncedWriter };
