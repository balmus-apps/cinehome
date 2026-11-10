'use strict';

// Subtitles as WebVTT: sidecar .srt/.vtt files and text tracks embedded in the video.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const config = require('../config');
const { languageLabel, normalizeLang } = require('../library/parse');

const SUBS_DIR = path.join(config.cacheDir, 'subs');
const TEXT_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);

// Older Romanian subtitles are often Windows-1250, not UTF-8
function decode(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('windows-1250').decode(buf);
    } catch {
      return buf.toString('latin1');
    }
  }
}

function srtToVtt(text) {
  const body = text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .replace(/\{\\[^}]*\}/g, '') // {\an8} style overrides
    .trim();
  return body.startsWith('WEBVTT') ? `${body}\n` : `WEBVTT\n\n${body}\n`;
}

const toSeconds = t => {
  const parts = t.split(':').map(Number);
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
};
const toStamp = s => {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = ((ms % 60000) / 1000).toFixed(3).padStart(6, '0');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec}`;
};

// Shift every cue earlier by offset seconds (the converted stream starts at offset), dropping cues that end before 0
function shiftVtt(vtt, offset) {
  if (!offset) return vtt;
  const blocks = vtt.trim().split(/\n{2,}/);
  const timing = /^((?:\d+:)?\d{1,2}:\d{2}\.\d{3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}\.\d{3})(.*)$/;
  const out = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const i = lines.findIndex(l => timing.test(l));
    if (i === -1) {
      out.push(block);
      continue;
    }
    const [, start, end, rest] = timing.exec(lines[i]);
    const s = toSeconds(start) - offset;
    const e = toSeconds(end) - offset;
    if (e <= 0) continue;
    lines[i] = `${toStamp(Math.max(0, s))} --> ${toStamp(e)}${rest}`;
    out.push(lines.join('\n'));
  }
  return `${out.join('\n\n')}\n`;
}

// The list the player shows. Keys: s<n> = sidecar, e<stream index> = embedded
function tracks(item, info) {
  const list = (item.subtitles || []).map((s, i) => ({
    key: `s${i}`,
    lang: s.lang,
    label: s.label || (item.subtitles.length > 1 ? `Subtitle ${i + 1}` : 'Subtitles'),
    forced: s.forced,
  }));
  for (const s of (info && info.subtitles) || []) {
    if (!TEXT_CODECS.has(s.codec)) continue; // image-based (PGS/VobSub) can't become WebVTT
    const lang = languageLabel(s.lang);
    let label = lang && s.title && !s.title.toLowerCase().includes(lang.toLowerCase()) ? `${lang} (${s.title})` : (lang || s.title || `Track ${s.index}`);
    if (s.forced && !/forced/i.test(label)) label += ' (forced)';
    list.push({ key: `e${s.index}`, lang: normalizeLang(s.lang), label, forced: s.forced });
  }
  return list;
}

function extractEmbedded(item, index) {
  fs.mkdirSync(SUBS_DIR, { recursive: true });
  const out = path.join(SUBS_DIR, `${item.id}-${index}-${Math.round(item.mtimeMs)}.vtt`);
  if (fs.existsSync(out)) return Promise.resolve(fs.readFileSync(out, 'utf8'));
  const tmp = `${out}.tmp.vtt`;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', item.file, '-map', `0:${index}`, '-f', 'webvtt', tmp];
  return new Promise((resolve, reject) => {
    execFile(config.ffmpeg, args, { timeout: 180_000 }, err => {
      if (err) return reject(err);
      fs.renameSync(tmp, out);
      resolve(fs.readFileSync(out, 'utf8'));
    });
  });
}

// WebVTT text for a track key, or null if the key doesn't exist
async function load(item, info, key) {
  const m = /^([se])(\d+)$/.exec(key);
  if (!m) return null;
  if (m[1] === 's') {
    const side = (item.subtitles || [])[Number(m[2])];
    if (!side) return null;
    // srtToVtt also normalizes .vtt files (BOM, line endings)
    return srtToVtt(decode(fs.readFileSync(side.file)));
  }
  const index = Number(m[2]);
  const stream = ((info && info.subtitles) || []).find(s => s.index === index);
  if (!stream || !TEXT_CODECS.has(stream.codec)) return null;
  return extractEmbedded(item, index);
}

module.exports = { tracks, load, shiftVtt, srtToVtt };
