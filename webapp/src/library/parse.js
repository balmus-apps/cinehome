'use strict';

// Turns file and folder names into titles, years, seasons and episodes.

const path = require('node:path');

const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.mkv', '.avi', '.mov', '.webm', '.ts', '.m2ts', '.wmv', '.mpg', '.mpeg', '.flv']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const SUBTITLE_EXTS = new Set(['.srt', '.vtt']);
const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.wav', '.wma', '.aiff', '.aif', '.ape', '.mka', '.wv']);

// Release-name noise: everything from the first of these onwards is dropped from the title
const TAGS = /(?:^|\s)(2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr10\+?|hdr|bluray|blu-ray|bdrip|brrip|bdremux|remux|web-?dl|webrip|hdtv|hdrip|dvdrip|dvdscr|xvid|divx|[xh]\s?26[45]|hevc|avc|aac(?:\s?\d\s\d)?|e?ac3|dts(?:-hd)?|truehd|atmos|ddp?\s?5\s1|10bit|proper|repack|extended|unrated|imax|dubbed|subbed|rodubbed|tvrip|dvd|mpa\d(?:\s\d)?)(?=\s|$)/i;

const LANGUAGES = {
  ro: 'Română', ron: 'Română', rum: 'Română', romanian: 'Română', romana: 'Română',
  en: 'English', eng: 'English', english: 'English',
  fr: 'Français', fre: 'Français', fra: 'Français', french: 'Français',
  de: 'Deutsch', ger: 'Deutsch', deu: 'Deutsch', german: 'Deutsch',
  es: 'Español', spa: 'Español', spanish: 'Español',
  it: 'Italiano', ita: 'Italiano', italian: 'Italiano',
  hu: 'Magyar', hun: 'Magyar', hungarian: 'Magyar',
};
const LANGUAGE_CODES = {
  ron: 'ro', rum: 'ro', romanian: 'ro', romana: 'ro', eng: 'en', english: 'en', fre: 'fr', fra: 'fr', french: 'fr',
  ger: 'de', deu: 'de', german: 'de', spa: 'es', spanish: 'es', ita: 'it', italian: 'it', hun: 'hu', hungarian: 'hu',
};

const ext = name => path.extname(name).toLowerCase();
const stem = name => name.slice(0, name.length - path.extname(name).length);
const isVideo = name => VIDEO_EXTS.has(ext(name));
const isImage = name => IMAGE_EXTS.has(ext(name));
const isSubtitle = name => SUBTITLE_EXTS.has(ext(name));
const isAudio = name => AUDIO_EXTS.has(ext(name));

function tidy(s) {
  return s.replace(/\[[^\]]*\]/g, ' ').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// "Frozen.2013.1080p.BluRay.x264" -> { title: "Frozen", year: 2013 }
function parseTitle(base) {
  const s = tidy(base);
  let year = null;
  let cut = s.length;

  const paren = /\(((?:19|20)\d{2})\)/.exec(s);
  if (paren && paren.index > 0) {
    year = Number(paren[1]);
    cut = paren.index;
  } else {
    let m;
    const bare = /[\s-]((?:19|20)\d{2})(?=[\s-]|$)/g;
    while ((m = bare.exec(s))) {
      year = Number(m[1]);
      cut = m.index;
    }
  }

  const tag = TAGS.exec(s);
  if (tag && tag.index > 0) cut = Math.min(cut, tag.index);

  const title = s.slice(0, cut).replace(/[\s\-–(]+$/, '').trim();
  return { title: title || s, year };
}

// "Life.with.Louie.S01.DVDRip.x264" -> { title: "Life with Louie", year: null }
function parseSeriesTitle(base) {
  const parsed = parseTitle(base);
  const m = /(?:^|\s)(?:S\d{1,2}(?:\s?-\s?S\d{1,2})?|(?:season|sezonul|sezon)\s?\d{1,2}|complete)(?=\s|$)/i.exec(parsed.title);
  const title = m && m.index > 0 ? parsed.title.slice(0, m.index).replace(/[\s\-–(]+$/, '') : parsed.title;
  return { title, year: parsed.year };
}

// "Bluey.S01E05.The.Beach" -> { season: 1, episode: 5, title: "The Beach" }
function parseEpisode(base) {
  const s = tidy(base);
  let m = /(?:^|[\s-])S(\d{1,2})\s?E(\d{1,3})(?:\s?-?\s?E\d{1,3})*/i.exec(s)
    || /(?:^|[\s-])(\d{1,2})x(\d{2,3})(?=[\s-]|$)/i.exec(s);
  let season = null;
  let episode = null;
  if (m) {
    season = Number(m[1]);
    episode = Number(m[2]);
  } else {
    m = /(?:^|[\s-])(?:episode|episodul|ep|e)\s?(\d{1,3})(?=[\s-]|$)/i.exec(s);
    if (!m) return { season: null, episode: null, title: null };
    episode = Number(m[1]);
  }
  const rest = s.slice(m.index + m[0].length).replace(/^[\s\-–:]+/, '');
  const title = rest ? parseTitle(rest).title : null;
  return { season, episode, title: title || null };
}

// "03 - Holograf - Ce mai faci" -> { number: 3, artist: "Holograf", title: "Ce mai faci" }
// A number followed only by a space counts when zero-padded ("07 Song"), so "50 Cent - ..." stays whole.
function parseTrack(base) {
  let s = base.replace(/\[[^\]]*\]/g, ' ').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  let number = null;
  const num = /^(\d{1,3})\s*[-.)]\s*(?=\S)|^(0\d{1,2})\s+(?=\S)/.exec(s);
  if (num) {
    number = Number(num[1] || num[2]);
    s = s.slice(num[0].length);
  }
  const dash = /\s+[-–]\s+/.exec(s);
  if (dash && dash.index > 0) {
    return { number, artist: s.slice(0, dash.index).trim(), title: s.slice(dash.index + dash[0].length).trim() || s };
  }
  return { number, artist: null, title: s || base };
}

// "Season 2", "Sezonul 2", "S02" -> 2, "Specials" -> 0
function parseSeasonDir(name) {
  const s = tidy(name);
  if (/^specials?$/i.test(s)) return 0;
  const m = /^(?:season|sezonul|sezon|saison|staffel|temporada|series|s)\s?-?\s?(\d{1,3})$/i.exec(s);
  return m ? Number(m[1]) : null;
}

// Language suffix of a subtitle next to a video: "Frozen.ro.srt" -> { lang: "ro", label: "Română" }
function parseSubtitleName(videoStem, subName) {
  const rest = stem(subName).slice(videoStem.length);
  const parts = rest.split(/[\s._-]+/).filter(Boolean).map(p => p.toLowerCase());
  const forced = parts.includes('forced');
  const code = parts.find(p => p !== 'forced' && p !== 'sdh' && p !== 'cc');
  const lang = code ? (LANGUAGE_CODES[code] || code) : null;
  let label = lang ? (LANGUAGES[code] || LANGUAGES[lang] || code.toUpperCase()) : null;
  if (label && forced) label += ' (forced)';
  return { lang, label, forced };
}

// "rum" / "ron" / "romanian" -> "ro"; unknown codes pass through lowercased
function normalizeLang(code) {
  if (!code || code.toLowerCase() === 'und') return null;
  const c = code.toLowerCase();
  return LANGUAGE_CODES[c] || c;
}

const displayNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });

// "ron" / "ro" -> "Română", "ara" -> "Arabic"
function languageLabel(code) {
  if (!code || code === 'und') return null;
  const c = code.toLowerCase();
  if (LANGUAGES[c]) return LANGUAGES[c];
  try {
    return displayNames.of(c) || c.toUpperCase();
  } catch {
    return c.toUpperCase();
  }
}

module.exports = {
  ext, stem, isVideo, isImage, isSubtitle, isAudio,
  parseTitle, parseSeriesTitle, parseEpisode, parseTrack, parseSeasonDir, parseSubtitleName, languageLabel, normalizeLang,
};
