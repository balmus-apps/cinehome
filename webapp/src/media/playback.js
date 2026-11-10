'use strict';

// Decides how a file reaches the browser:
//   direct    - the browser plays the file as is (HTTP Range, no CPU cost)
//   remux     - video is fine, container/audio is not: copy video, convert audio to AAC
//   transcode - video codec the browser can't play: re-encode to H.264

const { normalizeLang, languageLabel } = require('../library/parse');

const MP4_FAMILY = new Set(['.mp4', '.m4v', '.mov']);
const WEBM = new Set(['.webm']);
const MP4_VIDEO = new Set(['h264', 'av1']);
const WEBM_VIDEO = new Set(['vp8', 'vp9', 'av1']);
const MP4_AUDIO = new Set(['aac', 'mp3', 'opus']);
const WEBM_AUDIO = new Set(['opus', 'vorbis']);
const HLS_COPY_VIDEO = new Set(['h264']);

// LG webOS 5+ (2020 and newer) decodes these itself, like Jellyfin's webOS profile.
// DTS / TrueHD are missing on many LG models, so those files still get their audio converted.
const WEBOS = {
  containers: new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.ts', '.m2ts']),
  video: new Set(['h264', 'hevc', 'vp9', 'av1']),
  audio: new Set(['aac', 'mp3', 'ac3', 'eac3', 'opus', 'vorbis', 'flac']),
  hlsCopyVideo: new Set(['h264', 'hevc']),
};

// Browsers decode 8-bit 4:2:0 H.264 only (no "High 10" / 4:2:2)
function isPlainH264(video) {
  return video.codec === 'h264' && (!video.pixFmt || video.pixFmt === 'yuv420p' || video.pixFmt === 'yuvj420p');
}

function pickAudio(info) {
  return info.audio.find(a => a.isDefault) || info.audio[0] || null;
}

// Audio track to play: an explicit stream index, else the preferred language,
// else (files without language tags) the same position as last time, else the file's default
function chooseAudio(info, { index, lang, pos } = {}) {
  const tracks = (info && info.audio) || [];
  if (index !== undefined && index !== null && index !== '') {
    const byIndex = tracks.find(a => a.index === Number(index));
    if (byIndex) return byIndex;
  }
  const want = normalizeLang(lang);
  if (want) {
    const byLang = tracks.find(a => normalizeLang(a.lang) === want);
    if (byLang) return byLang;
  }
  if (pos !== undefined && pos !== null && pos !== '' && tracks.every(a => !normalizeLang(a.lang))) {
    const byPos = tracks[Number(pos)];
    if (byPos) return byPos;
  }
  return pickAudio(info);
}

function audioTracks(info) {
  const tracks = (info && info.audio) || [];
  return tracks.map((a, pos) => {
    const lang = normalizeLang(a.lang);
    const name = languageLabel(a.lang);
    const layout = a.channels > 2 ? (a.channels === 6 ? '5.1' : a.channels === 8 ? '7.1' : `${a.channels} ch`) : null;
    let label = name || a.title || `Audio ${pos + 1}`;
    if (name && a.title && !a.title.toLowerCase().includes(name.toLowerCase())) label += ` (${a.title})`;
    if (layout) label += ` · ${layout}`;
    return { index: a.index, pos, lang, label };
  });
}

function decideWebos(info, ext, audio) {
  const { video } = info;
  const audioOk = !audio || WEBOS.audio.has(audio.codec);
  const firstTrack = !audio || info.audio[0] === audio;
  if (WEBOS.containers.has(ext) && WEBOS.video.has(video.codec) && audioOk && firstTrack) return { mode: 'direct', audio };
  if (WEBOS.hlsCopyVideo.has(video.codec)) return { mode: 'remux', audio };
  return { mode: 'transcode', audio };
}

function decide(info, ext, audio = info ? pickAudio(info) : null, client = 'web') {
  if (!info || !info.video) return { mode: 'transcode', audio };
  if (client === 'webos') return decideWebos(info, ext, audio);
  const { video } = info;
  const videoOkMp4 = MP4_VIDEO.has(video.codec) && (video.codec !== 'h264' || isPlainH264(video));

  let direct = false;
  if (MP4_FAMILY.has(ext)) direct = videoOkMp4 && (!audio || MP4_AUDIO.has(audio.codec));
  else if (WEBM.has(ext)) direct = WEBM_VIDEO.has(video.codec) && (!audio || WEBM_AUDIO.has(audio.codec));
  // The browser always plays the first audio track; any other choice needs converting
  if (direct && audio && info.audio[0] !== audio) direct = false;
  if (direct) return { mode: 'direct', audio };

  if (HLS_COPY_VIDEO.has(video.codec) && isPlainH264(video)) return { mode: 'remux', audio };
  return { mode: 'transcode', audio };
}

// Old DVD/VideoCD-era codecs: blocky at the edges, and small enough to encode carefully in real time
const OLD_CODECS = new Set(['mpeg4', 'msmpeg4v1', 'msmpeg4v2', 'msmpeg4v3', 'mpeg1video', 'mpeg2video', 'wmv1', 'wmv2', 'wmv3', 'h263', 'flv1']);
const SD_MAX_HEIGHT = 576;

// x264 settings: careful for SD (crf 18 loses half as much as crf 23 and still runs ~40x realtime),
// fast for HD so a CPU-only Mac keeps up. Old codecs also get de-blocked; noise reduction and
// upscaling are left to the TV.
function videoEncoding(video) {
  const sd = video && video.height && video.height <= SD_MAX_HEIGHT;
  const filters = [];
  if (sd && OLD_CODECS.has(video.codec)) filters.push('deblock=filter=weak:block=8');
  filters.push("scale='min(1920,iw)':-2");
  return {
    preset: sd ? 'medium' : 'veryfast',
    crf: sd ? '18' : '21',
    filter: filters.join(','),
  };
}

// ffmpeg arguments that write an HLS playlist + segments into outDir, starting at startAt seconds
function hlsArgs({ file, mode, audio, video, startAt, outDir }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  if (startAt > 0) args.push('-ss', startAt.toFixed(3));
  // Stay a bit ahead of playback instead of converting the whole film into the cache at once
  args.push('-readrate', '4', '-readrate_initial_burst', '60');
  args.push('-i', file, '-map', video ? `0:${video.index}` : '0:v:0');
  if (audio) args.push('-map', `0:${audio.index}`);

  if (mode === 'remux') {
    args.push('-c:v', 'copy');
  } else {
    const enc = videoEncoding(video);
    args.push(
      '-c:v', 'libx264', '-preset', enc.preset, '-crf', enc.crf, '-pix_fmt', 'yuv420p',
      '-vf', enc.filter,
      '-force_key_frames', 'expr:gte(t,n_forced*6)',
    );
  }
  if (audio) args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k');
  args.push(
    '-sn', '-dn',
    // temp_file: segments and playlist appear atomically, so the player never reads half a file
    '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'temp_file',
    '-hls_segment_filename', `${outDir}/seg%05d.ts`,
    `${outDir}/index.m3u8`,
  );
  return args;
}

module.exports = { decide, hlsArgs, videoEncoding, pickAudio, chooseAudio, audioTracks };
