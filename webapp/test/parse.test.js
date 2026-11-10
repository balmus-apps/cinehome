'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/library/parse');

test('parseTitle strips release noise and finds the year', () => {
  assert.deepEqual(P.parseTitle('Frozen.2013.1080p.BluRay.x264'), { title: 'Frozen', year: 2013 });
  assert.deepEqual(P.parseTitle('Frozen (2013)'), { title: 'Frozen', year: 2013 });
  assert.deepEqual(P.parseTitle('The_Lion_King'), { title: 'The Lion King', year: null });
  assert.deepEqual(P.parseTitle('1917 (2019)'), { title: '1917', year: 2019 });
  assert.deepEqual(P.parseTitle('Blade Runner 2049 (2017)'), { title: 'Blade Runner 2049', year: 2017 });
  assert.deepEqual(P.parseTitle('Inside Out 2 [YTS.MX] 720p WEB-DL'), { title: 'Inside Out 2', year: null });
  assert.deepEqual(P.parseTitle('2012'), { title: '2012', year: null });
  assert.deepEqual(P.parseTitle('Home.Alone.1990.H.264.DDP5.1'), { title: 'Home Alone', year: 1990 });
});

test('parseEpisode understands SxxEyy, 1x02 and bare episode numbers', () => {
  assert.deepEqual(P.parseEpisode('Bluey.S01E05.The.Beach.720p'), { season: 1, episode: 5, title: 'The Beach' });
  assert.deepEqual(P.parseEpisode('Bluey - 2x03 - Hammerbarn'), { season: 2, episode: 3, title: 'Hammerbarn' });
  assert.deepEqual(P.parseEpisode('S03E10'), { season: 3, episode: 10, title: null });
  assert.deepEqual(P.parseEpisode('Episode 7'), { season: null, episode: 7, title: null });
  assert.deepEqual(P.parseEpisode('Frozen 2013'), { season: null, episode: null, title: null });
});

test('parseSeasonDir recognises season folders', () => {
  assert.equal(P.parseSeasonDir('Season 1'), 1);
  assert.equal(P.parseSeasonDir('Sezonul 2'), 2);
  assert.equal(P.parseSeasonDir('S03'), 3);
  assert.equal(P.parseSeasonDir('season_04'), 4);
  assert.equal(P.parseSeasonDir('Specials'), 0);
  assert.equal(P.parseSeasonDir('Disney'), null);
  assert.equal(P.parseSeasonDir('Shrek 2'), null);
});

test('parseSubtitleName reads the language suffix', () => {
  assert.deepEqual(P.parseSubtitleName('Frozen (2013)', 'Frozen (2013).ro.srt'), { lang: 'ro', label: 'Română', forced: false });
  assert.deepEqual(P.parseSubtitleName('Frozen', 'Frozen.eng.forced.srt'), { lang: 'en', label: 'English (forced)', forced: true });
  assert.deepEqual(P.parseSubtitleName('Frozen', 'Frozen.srt'), { lang: null, label: null, forced: false });
});

test('real-world release names', () => {
  assert.deepEqual(P.parseTitle('K-Pop.Demon.Hunters.2025.1080p.BluRay.DD+7.1.x264-playHD'), { title: 'K-Pop Demon Hunters', year: 2025 });
  assert.deepEqual(P.parseSeriesTitle('Life.with.Louie.S01.DVDRip.MPA2.0.x264.RoDubbed-playSD'), { title: 'Life with Louie', year: null });
  assert.deepEqual(P.parseSeriesTitle('Bluey Season 2'), { title: 'Bluey', year: null });
  assert.deepEqual(P.parseSeriesTitle('Peppa Pig'), { title: 'Peppa Pig', year: null });
  const ep = name => P.parseEpisode(name);
  assert.deepEqual(ep('Life.with.Louie.S01E01.Dad.Gets.Canned.DVDRip.MPA2.0.x264.RoDubbed-playSD'), { season: 1, episode: 1, title: 'Dad Gets Canned' });
  assert.deepEqual(ep('Life.with.Louie.S01E12.Born.a.Rambler.Man.TVRip.MPA2.0.XviD.RoDubbed-[s-mouche]'), { season: 1, episode: 12, title: 'Born a Rambler Man' });
  assert.equal(ep('Life.with.Louie.S01E00.PILOT.A.Christmas.Surprise.for.Mrs.Stillman.DVDRip').episode, 0);
});

test('parseTrack reads track numbers, artists and titles from song names', () => {
  assert.deepEqual(P.parseTrack('03 - Holograf - Ce mai faci'), { number: 3, artist: 'Holograf', title: 'Ce mai faci' });
  assert.deepEqual(P.parseTrack('07 Sweet Child O Mine'), { number: 7, artist: null, title: 'Sweet Child O Mine' });
  assert.deepEqual(P.parseTrack('1. Queen - Bohemian Rhapsody'), { number: 1, artist: 'Queen', title: 'Bohemian Rhapsody' });
  assert.deepEqual(P.parseTrack('50 Cent - In Da Club'), { number: null, artist: '50 Cent', title: 'In Da Club' });
  assert.deepEqual(P.parseTrack('2Pac - Changes [www.site.ro]'), { number: null, artist: '2Pac', title: 'Changes' });
  assert.deepEqual(P.parseTrack('Smiley_-_Dead_Tired'), { number: null, artist: 'Smiley', title: 'Dead Tired' });
  assert.equal(P.isAudio('a.MP3'), true);
  assert.equal(P.isAudio('a.mkv'), false);
});
