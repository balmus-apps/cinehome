# CineHome

A Netflix-style streaming app for your own movie folders, for the home network. There are no accounts, just two profiles: **Adults** sees everything, **Kids** sees only the kids folder.

```
cinehome/
  storage/kids/      ← kids movies and series
  storage/adults/    ← adults movies and series
  webapp/            ← server + web app (Docker)
  webosapp/          ← LG TV app (webOS), see webosapp/README.md
  androidapp/        ← Android TV / tablet app (later)
  data/              ← created at runtime: watch progress, generated posters, temporary conversions
```

## Run

```sh
cp .env.example .env        # optional: change MEDIA_PATH, PORT
docker compose up -d --build
```

Open <http://localhost:8080>, or `http://<this-computer's-ip>:8080` from other devices on the Wi-Fi.

The movie folder is mounted **read-only** into the container and nothing is copied into the image. To use another disk, set `MEDIA_PATH` in `.env` (for example `MEDIA_PATH=/Volumes/Movies`). That folder needs `kids/` and `adults/` inside.

## Adding movies

Copy files into `storage/kids` or `storage/adults`. They appear within a few seconds, and the open page refreshes by itself. There's nothing to restart. Large files are picked up once copying has finished.

### How folders become the home screen

| On disk | In the app |
|---|---|
| `kids/Frozen (2013).mp4` | movie "Frozen" (2013) in the **Movies** row |
| `kids/Disney/Moana.2016.1080p.mkv` | movie "Moana" (2016) in the **Disney** row |
| `kids/Disney/Pixar/Cars/Cars.mp4` | in the **Disney** row (the first folder level is the row) |
| `kids/Bluey/Season 1/Bluey.S01E01.mp4` | series "Bluey" in the **Series** row |
| `kids/Cartoons/Peppa Pig/Peppa.S01E01.mp4` | series "Peppa Pig" in the **Cartoons** row |

- Titles come from the filename. Dots and underscores become spaces, and release tags like `1080p`, `BluRay`, `x264` are dropped. A year such as `(2013)` or `.2013.` is detected.
- A folder is a **series** when it has season folders (`Season 1`, `Sezonul 1`, `S01`, `Specials`), or at least two files named like `S01E02` or `1x02`.
- Episodes are ordered by their number, or by filename when they have none.
- Files and folders starting with `.` or `@` are ignored. So are files with `sample` in the name.

### Posters and backdrops

You don't have to do anything: CineHome grabs a frame from each video and uses it.

To use a real poster, put an image **next to the video with the same name**:

```
Frozen (2013).mp4
Frozen (2013).jpg            ← poster (2:3 portrait works best)
Frozen (2013)-backdrop.jpg   ← optional wide image for the banner (16:9)
```

- Inside a movie's own folder, or a series folder, `poster.jpg` / `folder.jpg` and `fanart.jpg` / `backdrop.jpg` also work.
- Episode thumbnails: `Bluey.S01E01.jpg` next to the episode.
- `.jpg`, `.png` and `.webp` are all fine.

### Subtitles

Put `.srt` or `.vtt` files next to the video, starting with the same name:

```
Frozen (2013).mp4
Frozen (2013).ro.srt
Frozen (2013).en.srt
```

- Text subtitles inside MKV files are found automatically.
- Romanian files in the old Windows encoding (ș/ț showing as garbage elsewhere) are handled.
- The player remembers each profile's subtitle language.

### Audio tracks (dubbing)

Files with several audio tracks (for example English + Romanian dub) get an **Audio** list in the player's *Audio & subtitles* menu. The choice is remembered per profile and applies to the next episodes. The Kids profile picks Romanian automatically when a file has a track tagged as Romanian. For files whose tracks have no language tag (common in old `.avi` files), pick one once and the same position is used for the following episodes.

### Posters from the internet

For movies without a poster image of their own, CineHome can download the film's poster from Wikipedia. With CineHome running:

```sh
cd webapp
DATA_DIR=../data node scripts/fetch-posters.js          # movies in the Movies rows
DATA_DIR=../data node scripts/fetch-posters.js --all    # every movie
```

- Posters are saved in `data/posters/`; your movie folders are not touched.
- `data/posters/titles.json` links each movie to its Wikipedia article. Fix a wrong poster there, or set a movie to `null` to keep its video frame, then run again with `--force`.
- A poster image placed next to the video still wins.

## Adding music

The **Music** profile shows `storage/music`. Each folder of songs is a playlist:

```
storage/music/
  Top 2024/                 playlist "Top 2024" (row "Playlists")
    01 - Smiley - Dead Tired.mp3
    cover.jpg
  Anii 80/                  playlist "Anii 80"
  Tops/                     a folder of folders is a row: "Tops"
    Top 2022/
    Top 2023/
  Some Album/CD1, CD2       disc folders are joined into one playlist
  Clipuri/                  music videos (mp4, mkv, avi…) play big, one after another
```

- Song names: `Artist - Title`, optionally with a track number (`03 - Artist - Title`). Without an artist in the name, the file's own tags are used.
- Cover: `cover.jpg`, `folder.jpg` (or any image in the folder), else the album art inside the songs, else a frame of a music video.
- MP3, M4A/AAC, FLAC, OGG/Opus and WAV play as they are. WMA, ALAC, APE and the like are converted to AAC the first time they play (a second or two) and cached in `data/cache/audio`.
- Music keeps playing while you browse; the bar at the bottom opens **Now playing**. Adults and Kids don't see music, and the kids tablets can't open it.

## Video formats

| File | What happens |
|---|---|
| MP4/M4V/MOV with H.264 + AAC, WebM | plays directly with no CPU cost and instant seeking |
| H.264 in MKV, or with AC3/DTS audio | the video is copied and the audio converted while you watch (light) |
| HEVC/x265, MPEG-4/XviD, 10-bit H.264… | converted to H.264 while you watch (uses CPU) |

Conversion is CPU-only: Docker on a Mac can't use the GPU. `MAX_TRANSCODES` (default 2) limits how many run at once. Seeking past the part that's already converted restarts the conversion at that point. That takes a few seconds; seeking inside the converted part is instant.

## Using it

- **Profiles:** choose one on first open; each device remembers it. Switch from the top-right corner.
- **Continue watching:** progress is saved every 10 seconds per profile. A title counts as watched at 92%; for series, the next episode then shows up.
- **Keyboard / TV remote:** arrow keys move between items and Enter opens them. In the player:

| Key | Action |
|---|---|
| Space | play / pause |
| ← → | −10 s / +10 s |
| ↑ ↓ | volume |
| F | fullscreen |
| A | next audio track |
| C | cycle subtitles |
| N | next episode |
| Esc | back |

## Development

```sh
cd webapp
npm install
npm test                 # parser, scanner, playback decision, subtitles
npm run dev              # needs ffmpeg/ffprobe on the host; uses ../storage and ../data
```

### API

The web app uses this API, and the Android app will use it too.

| Endpoint | |
|---|---|
| `GET /api/profiles` | the two profiles |
| `GET /api/catalog?profile=kids` | hero, continue watching, recently added, rows |
| `GET /api/items/:id?profile=` | movie or series details (seasons, episodes, progress) |
| `GET /api/play/:id?profile=&sid=&start=&client=web\|android` | how to play: `direct` file URL or HLS URL, subtitles, next episode |
| `GET /api/stream/:id` | the file itself (HTTP Range) |
| `GET /api/hls/:session/index.m3u8` | on-the-fly conversion |
| `GET /api/subtitles/:id/:key.vtt?offset=` | WebVTT |
| `POST /api/progress` | `{profile, id, position, duration}` |
| `GET /api/events` | server-sent `library-changed` events |
| `GET /api/art/:id/poster\|backdrop` | images |

The profile only decides what is listed. It is not a security boundary, so don't expose the port to the internet.

## Later

- Android TV / tablet app (`androidapp/`)

The LG TV app is ready: see [webosapp/README.md](webosapp/README.md).
- Fetching posters and descriptions from TMDB
- A small admin page (pick posters, fix titles)
- Optional PIN for the Adults profile
