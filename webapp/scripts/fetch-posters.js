'use strict';

// Downloads film posters from Wikipedia for the movies in the Movies rows (or every movie with --all)
// that have no poster image of their own. Run it while CineHome is running:
//
//   cd webapp && DATA_DIR=../data node scripts/fetch-posters.js [--all] [--force]
//
// Posters land in <data>/posters/<movie id>.jpg; the server prefers them to a video frame.
// <data>/posters/titles.json maps a movie's title to its English Wikipedia article. Titles not in
// it are searched for and only taken when the article has the same name; edit the file to fix a
// wrong poster ("Title": "Wikipedia article") or to keep one movie on its video frame ("Title": null).

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data');
const SERVER = process.env.CINEHOME_URL || 'http://localhost:8080';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const DIR = path.join(DATA_DIR, 'posters');
const TITLES = path.join(DIR, 'titles.json');
const WIKI = 'https://en.wikipedia.org/w/api.php';
// Wikipedia asks API users to say who they are
const HEADERS = { 'User-Agent': 'CineHome/1.0 (home media app; posters for a private library)' };

const all = process.argv.includes('--all');
const force = process.argv.includes('--force');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function json(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

const normalize = s => s.toLowerCase().replace(/&/g, 'and').replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]+/g, '');

// The article for a title not in titles.json: only an exact name match counts, "(film)" suffixes aside
async function search(title, year) {
  const q = new URLSearchParams({ action: 'query', format: 'json', list: 'search', srsearch: `${title} ${year || ''} film`, srlimit: '5' });
  const { query } = await json(`${WIKI}?${q}`);
  const want = normalize(title);
  const hit = (query.search || []).find(r => normalize(r.title) === want);
  return hit ? hit.title : null;
}

// Main image of each article (non-free film posters included), 50 articles per request
async function images(articles) {
  const out = new Map();
  for (let i = 0; i < articles.length; i += 50) {
    const batch = articles.slice(i, i + 50);
    const q = new URLSearchParams({
      action: 'query', format: 'json', redirects: '1', prop: 'pageimages', piprop: 'original', pilicense: 'any', titles: batch.join('|'),
    });
    const { query } = await json(`${WIKI}?${q}`);
    // Follow normalized and redirected names back to what was asked for
    const asked = new Map(batch.map(a => [a, a]));
    for (const step of [...(query.normalized || []), ...(query.redirects || [])]) {
      for (const [a, now] of asked) if (now === step.from) asked.set(a, step.to);
    }
    const byTitle = new Map(Object.values(query.pages || {}).map(p => [p.title, p.original]));
    for (const [a, now] of asked) out.set(a, byTitle.get(now) || null);
  }
  return out;
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const titles = fs.existsSync(TITLES) ? JSON.parse(fs.readFileSync(TITLES, 'utf8')) : {};
  const catalog = await json(`${SERVER}/api/catalog?profile=adults`);
  const movies = new Map();
  for (const row of catalog.rows) {
    if (!all && !row.grid) continue;
    for (const item of row.items) if (item.type === 'movie') movies.set(item.id, item);
  }

  const wanted = [];
  for (const movie of movies.values()) {
    const file = path.join(DIR, `${movie.id}.jpg`);
    if (fs.existsSync(file) && !force) continue;
    let article = titles[movie.title];
    if (article === undefined) {
      article = await search(movie.title, movie.year);
      titles[movie.title] = article;
      await sleep(300);
    }
    if (article) wanted.push({ movie, article, file });
  }
  fs.writeFileSync(TITLES, `${JSON.stringify(titles, null, 2)}\n`);

  const found = await images([...new Set(wanted.map(w => w.article))]);
  let saved = 0;
  for (const { movie, article, file } of wanted) {
    const image = found.get(article);
    // A poster is portrait; a landscape picture is a scene or a logo, not worth more than the video frame
    if (!image || image.height < image.width * 1.2) {
      console.log(`no poster   ${movie.title}  (${article})`);
      continue;
    }
    const res = await fetch(image.source, { headers: HEADERS });
    if (!res.ok) {
      console.log(`failed      ${movie.title}  (${res.status})`);
      continue;
    }
    // Wikipedia serves PNGs too, and some originals are huge: store every poster as a JPEG at most 1080 high
    const download = `${file}.download`;
    fs.writeFileSync(download, Buffer.from(await res.arrayBuffer()));
    try {
      execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', download,
        '-vf', "scale=-2:'min(1080,ih)'", '-frames:v', '1', '-q:v', '2', '-f', 'mjpeg', file]);
    } catch {
      console.log(`unreadable  ${movie.title}  (${image.source})`);
      continue;
    } finally {
      fs.rmSync(download, { force: true });
    }
    saved += 1;
    console.log(`poster      ${movie.title}  <- ${article}  ${image.width}x${image.height}`);
    await sleep(300);
  }
  const skipped = [...movies.values()].filter(m => titles[m.title] == null);
  console.log(`\n${saved} posters saved in ${DIR}`);
  if (skipped.length) console.log(`kept on their video frame: ${skipped.map(m => m.title).join(', ')}`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
