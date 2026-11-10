'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanMedia } = require('../src/library/scanner');

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cinehome-'));
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), 'x');
  }
  return root;
}

const byTitle = (catalog, title) => [...catalog.items.values()].find(i => i.title === title);

test('first-level folders become rows, loose files go to Movies', async () => {
  const root = tree([
    'kids/Frozen (2013).mp4',
    'kids/Frozen (2013).jpg',
    'kids/Frozen (2013).ro.srt',
    'kids/Disney/Moana.2016.1080p.mkv',
    'kids/Disney/Pixar/Cars (2006)/Cars.mp4',
    'kids/Disney/Pixar/Cars (2006)/poster.jpg',
    'adults/Heat (1995).mkv',
    'adults/.hidden/Secret.mp4',
  ]);
  const catalog = await scanMedia(root);
  assert.deepEqual(catalog.rows.kids.map(r => r.name), ['Disney', 'Movies']);
  assert.deepEqual(catalog.rows.adults.map(r => r.name), ['Movies']);

  const disney = catalog.rows.kids[0].ids.map(id => catalog.items.get(id).title);
  assert.deepEqual(disney, ['Cars', 'Moana']);

  const frozen = byTitle(catalog, 'Frozen');
  assert.equal(frozen.year, 2013);
  assert.equal(path.basename(frozen.poster), 'Frozen (2013).jpg');
  assert.equal(frozen.subtitles[0].lang, 'ro');
  assert.equal(path.basename(byTitle(catalog, 'Cars').poster), 'poster.jpg');
  assert.equal(byTitle(catalog, 'Secret'), undefined);
});

test('season folders and SxxEyy files are detected as series', async () => {
  const root = tree([
    'kids/Bluey/Season 1/Bluey.S01E02.Hospital.mp4',
    'kids/Bluey/Season 1/Bluey.S01E01.Magic.Xylophone.mp4',
    'kids/Bluey/Season 2/01.mp4',
    'kids/Bluey/Season 2/02.mp4',
    'kids/Bluey/poster.jpg',
    'kids/Cartoons/Peppa Pig/Peppa.S01E01.mp4',
    'kids/Cartoons/Peppa Pig/Peppa.S01E02.mp4',
    'kids/Cartoons/Tom and Jerry.avi',
  ]);
  const catalog = await scanMedia(root);
  assert.deepEqual(catalog.rows.kids.map(r => r.name), ['Cartoons', 'Series']);

  const bluey = byTitle(catalog, 'Bluey');
  assert.equal(bluey.type, 'series');
  assert.equal(path.basename(bluey.poster), 'poster.jpg');
  assert.deepEqual(bluey.seasons.map(s => s.number), [1, 2]);
  const s1 = bluey.seasons[0].episodes.map(id => catalog.items.get(id));
  assert.deepEqual(s1.map(e => [e.episode, e.title]), [[1, 'Magic Xylophone'], [2, 'Hospital']]);
  const s2 = bluey.seasons[1].episodes.map(id => catalog.items.get(id));
  assert.deepEqual(s2.map(e => [e.season, e.episode]), [[2, 1], [2, 2]]);

  const cartoons = catalog.rows.kids[0].ids.map(id => catalog.items.get(id));
  assert.deepEqual(cartoons.map(i => [i.title, i.type]), [['Peppa Pig', 'series'], ['Tom and Jerry', 'movie']]);
});

test('ids are stable across scans and the version changes when files change', async () => {
  const root = tree(['kids/A.mp4']);
  const first = await scanMedia(root);
  const again = await scanMedia(root);
  assert.equal(first.version, again.version);
  fs.writeFileSync(path.join(root, 'kids/B.mp4'), 'x');
  const third = await scanMedia(root);
  assert.notEqual(first.version, third.version);
  assert.ok(third.items.has([...first.items.keys()][0]));
});

test('a folder holding a single movie goes to Movies; junk folders are skipped', async () => {
  const root = tree([
    'kids/K-Pop.Demon.Hunters/K-Pop.Demon.Hunters.2025.1080p.BluRay.x264.mkv',
    'kids/K-Pop.Demon.Hunters/poster.jpg',
    'kids/Up (2009)/Up.mp4',
    'kids/Up (2009)/Sample/up-sample.mp4',
    'kids/Desene.Animate/Shrek.mkv',
    'kids/Desene.Animate/Shrek 2.mkv',
    'kids/Life.with.Louie.S01.DVDRip/Life.with.Louie.S01E01.mkv',
    'kids/Life.with.Louie.S01.DVDRip/Life.with.Louie.S01E02.mkv',
  ]);
  const catalog = await scanMedia(root);
  assert.deepEqual(catalog.rows.kids.map(r => r.name), ['Desene Animate', 'Movies', 'Series']);
  const movies = catalog.rows.kids[1].ids.map(id => catalog.items.get(id).title);
  assert.deepEqual(movies, ['K-Pop Demon Hunters', 'Up']);
  assert.equal(path.basename(byTitle(catalog, 'K-Pop Demon Hunters').poster), 'poster.jpg');
  assert.equal(byTitle(catalog, 'Life with Louie').type, 'series');
});

test('a lone image in a movie folder is its poster, whatever its name', async () => {
  const root = tree([
    'kids/Ice Age 2 -The Meltdown/Ice Age 2@XPoWeR]XtReMe].avi',
    'kids/Ice Age 2 -The Meltdown/Ice Age 2 - The Meltdown.jpg',
    'kids/Two Images/Film.avi',
    'kids/Two Images/a.jpg',
    'kids/Two Images/b.jpg',
    'kids/Frumoasa si Bestia 2/Beauty and the Beast - The Enchanted Christmas.avi',
  ]);
  const catalog = await scanMedia(root);
  const items = [...catalog.items.values()];
  const iceAge = items.find(i => i.title.startsWith('Ice Age'));
  assert.equal(iceAge.title, 'Ice Age 2 -The Meltdown');
  assert.equal(path.basename(iceAge.poster), 'Ice Age 2 - The Meltdown.jpg');
  assert.equal(items.find(i => i.title === 'Film').poster, null);
  assert.ok(items.some(i => i.title === 'Beauty and the Beast - The Enchanted Christmas'));
});

test('music folders become playlists; folders of folders become rows', async () => {
  const root = tree([
    'music/Top 2024/01 - Smiley - Dead Tired.mp3',
    'music/Top 2024/02 - Inna - Hot.m4a',
    'music/Top 2024/cover.jpg',
    'music/Anii 80/Modern Talking - Brother Louie.mp3',
    'music/Anii 80/Scans/back.jpg',
    'music/Tops/Top 2023/A - B.mp3',
    'music/Tops/Top 2022/C - D.flac',
    'music/Album/CD1/01 Intro.mp3',
    'music/Album/CD2/01 Outro.mp3',
    'music/Clips/Queen - Bohemian Rhapsody.mp4',
    'music/Loose song.mp3',
    'kids/Frozen.mp4',
  ]);
  const catalog = await scanMedia(root);
  const rows = Object.fromEntries(catalog.rows.music.map(r => [r.name, r.ids.map(id => catalog.items.get(id).title)]));
  assert.deepEqual(Object.keys(rows), ['Playlists', 'Tops']);
  assert.deepEqual(rows.Playlists, ['Album', 'Anii 80', 'Clips', 'Songs', 'Top 2024']);
  assert.deepEqual(rows.Tops, ['Top 2022', 'Top 2023']);

  const top = byTitle(catalog, 'Top 2024');
  assert.equal(top.type, 'playlist');
  assert.equal(path.basename(top.poster), 'cover.jpg');
  const songs = top.tracks.map(id => catalog.items.get(id));
  assert.deepEqual(songs.map(s => [s.number, s.artist, s.title, s.kind]), [[1, 'Smiley', 'Dead Tired', 'audio'], [2, 'Inna', 'Hot', 'audio']]);
  assert.equal(songs[0].playlistId, top.id);

  // CD1 and CD2 are one album; a music video is a song of kind "video"
  assert.deepEqual(byTitle(catalog, 'Album').tracks.map(id => catalog.items.get(id).title), ['Intro', 'Outro']);
  assert.equal(catalog.items.get(byTitle(catalog, 'Clips').tracks[0]).kind, 'video');
  // Music stays out of the movie libraries and movies out of music
  assert.deepEqual(catalog.rows.kids.map(r => r.name), ['Movies']);
});
