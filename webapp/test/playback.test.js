'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = path.join(os.tmpdir(), `cinehome-test-${process.pid}`);
const { decide, hlsArgs, videoEncoding, chooseAudio, audioTracks } = require('../src/media/playback');
const { shiftVtt, srtToVtt } = require('../src/media/subtitles');

const info = (video, audio = [{ index: 1, codec: 'aac', isDefault: true }]) => ({
  duration: 600,
  video: { index: 0, pixFmt: 'yuv420p', ...video },
  audio,
  subtitles: [],
});

test('decide: what the browser can play directly', () => {
  assert.equal(decide(info({ codec: 'h264' }), '.mp4').mode, 'direct');
  assert.equal(decide(info({ codec: 'h264' }), '.m4v').mode, 'direct');
  assert.equal(decide(info({ codec: 'vp9' }, [{ index: 1, codec: 'opus' }]), '.webm').mode, 'direct');
  assert.equal(decide(info({ codec: 'h264' }, []), '.mp4').mode, 'direct');
});

test('decide: H.264 in the wrong box or with AC3/DTS audio is remuxed', () => {
  assert.equal(decide(info({ codec: 'h264' }), '.mkv').mode, 'remux');
  assert.equal(decide(info({ codec: 'h264' }, [{ index: 1, codec: 'ac3' }]), '.mp4').mode, 'remux');
  assert.equal(decide(info({ codec: 'h264' }, [{ index: 1, codec: 'dts' }]), '.mkv').mode, 'remux');
  // Default audio is not the first track: the browser would play the wrong one
  const twoTracks = [{ index: 1, codec: 'aac' }, { index: 2, codec: 'aac', isDefault: true }];
  const d = decide(info({ codec: 'h264' }, twoTracks), '.mp4');
  assert.equal(d.mode, 'remux');
  assert.equal(d.audio.index, 2);
});

test('decide: other video codecs are transcoded', () => {
  assert.equal(decide(info({ codec: 'hevc' }), '.mkv').mode, 'transcode');
  assert.equal(decide(info({ codec: 'hevc' }), '.mp4').mode, 'transcode');
  assert.equal(decide(info({ codec: 'mpeg4' }), '.avi').mode, 'transcode');
  assert.equal(decide(info({ codec: 'h264', pixFmt: 'yuv420p10le' }), '.mp4').mode, 'transcode');
  assert.equal(decide(null, '.mkv').mode, 'transcode');
});

test('hlsArgs: copies video for remux, encodes for transcode, seeks before input', () => {
  const base = { file: '/media/a.mkv', audio: { index: 1 }, video: { index: 0 }, outDir: '/tmp/x' };
  const remux = hlsArgs({ ...base, mode: 'remux', startAt: 0 });
  assert.ok(remux.includes('copy'));
  assert.ok(!remux.includes('-ss'));
  const trans = hlsArgs({ ...base, mode: 'transcode', startAt: 125.5 });
  assert.ok(trans.includes('libx264'));
  assert.ok(trans.indexOf('-ss') < trans.indexOf('-i'));
  assert.equal(trans[trans.indexOf('-ss') + 1], '125.500');
});

test('srtToVtt converts timestamps and adds the header', () => {
  const vtt = srtToVtt('﻿1\r\n00:00:01,500 --> 00:00:03,000\r\n{\\an8}Salut!\r\n');
  assert.equal(vtt, 'WEBVTT\n\n1\n00:00:01.500 --> 00:00:03.000\nSalut!\n');
});

test('shiftVtt moves cues earlier and drops the ones before the offset', () => {
  const vtt = 'WEBVTT\n\n1\n00:00:05.000 --> 00:00:06.000\nA\n\n2\n00:01:05.000 --> 00:01:07.250\nB\n';
  assert.equal(shiftVtt(vtt, 60), 'WEBVTT\n\n2\n00:00:05.000 --> 00:00:07.250\nB\n');
  assert.equal(shiftVtt(vtt, 0), vtt);
});

test('chooseAudio: index, then language, then position for untagged files', () => {
  const louie = info({ codec: 'h264' }, [
    { index: 1, codec: 'mp3', lang: 'eng', isDefault: true, channels: 2 },
    { index: 2, codec: 'mp3', lang: 'rum', channels: 2 },
  ]);
  assert.equal(chooseAudio(louie, {}).index, 1);
  assert.equal(chooseAudio(louie, { lang: 'ro' }).index, 2);
  assert.equal(chooseAudio(louie, { index: '2', lang: 'en' }).index, 2);
  assert.equal(chooseAudio(louie, { lang: 'de' }).index, 1);
  assert.equal(chooseAudio(louie, { pos: 1 }).index, 1); // tagged files ignore position
  // Picking the Romanian track in an MP4 means the browser can't play it directly
  assert.equal(decide(louie, '.mp4', chooseAudio(louie, { lang: 'ro' })).mode, 'remux');
  assert.deepEqual(audioTracks(louie).map(a => [a.lang, a.label]), [['en', 'English'], ['ro', 'Română']]);

  const avi = info({ codec: 'mpeg4' }, [{ index: 1, codec: 'mp3', channels: 2 }, { index: 2, codec: 'mp3', channels: 6 }]);
  assert.equal(chooseAudio(avi, { lang: 'ro', pos: 1 }).index, 2);
  assert.deepEqual(audioTracks(avi).map(a => a.label), ['Audio 1', 'Audio 2 · 5.1']);
});

test('decide: LG webOS plays MKV, HEVC and AC3 itself', () => {
  const webos = (i, ext, audio) => decide(i, ext, audio, 'webos').mode;
  assert.equal(webos(info({ codec: 'hevc', pixFmt: 'yuv420p10le' }, [{ index: 1, codec: 'eac3' }]), '.mkv'), 'direct');
  assert.equal(webos(info({ codec: 'h264' }, [{ index: 1, codec: 'ac3' }]), '.mkv'), 'direct');
  assert.equal(webos(info({ codec: 'h264' }, [{ index: 1, codec: 'dts' }]), '.mkv'), 'remux');
  assert.equal(webos(info({ codec: 'hevc' }, [{ index: 1, codec: 'truehd' }]), '.mkv'), 'remux');
  assert.equal(webos(info({ codec: 'mpeg4' }), '.avi'), 'transcode');
  // The Romanian dub is the second track: the TV gets it through a light remux
  const tracks = [{ index: 1, codec: 'mp3', lang: 'eng' }, { index: 2, codec: 'mp3', lang: 'rum' }];
  const i = info({ codec: 'h264' }, tracks);
  assert.equal(webos(i, '.mkv', i.audio[0]), 'direct');
  assert.equal(webos(i, '.mkv', i.audio[1]), 'remux');
});

test('videoEncoding: careful + de-blocked for old SD files, fast for HD', () => {
  const divx = videoEncoding({ codec: 'msmpeg4v3', height: 288 });
  assert.equal(divx.crf, '18');
  assert.equal(divx.preset, 'medium');
  assert.match(divx.filter, /^deblock=/);
  const dvdH264 = videoEncoding({ codec: 'h264', height: 576, pixFmt: 'yuv420p10le' });
  assert.equal(dvdH264.crf, '18');
  assert.doesNotMatch(dvdH264.filter, /deblock/);
  const hevc = videoEncoding({ codec: 'hevc', height: 2160 });
  assert.deepEqual([hevc.preset, hevc.crf], ['veryfast', '21']);
  assert.doesNotMatch(hevc.filter, /deblock/);
});

test('songs play directly when browsers can, otherwise they are converted', () => {
  const { plan } = require('../src/media/audio');
  const song = codec => ({ audio: [{ index: 0, codec }] });
  assert.deepEqual(plan(song('mp3'), '.mp3'), { direct: true, type: 'audio/mpeg' });
  assert.deepEqual(plan(song('aac'), '.m4a'), { direct: true, type: 'audio/mp4' });
  assert.deepEqual(plan(song('flac'), '.flac'), { direct: true, type: 'audio/flac' });
  assert.equal(plan(song('alac'), '.m4a').direct, false);
  assert.equal(plan(song('wmav2'), '.wma').direct, false);
  assert.equal(plan(song('ape'), '.ape').direct, false);
});
