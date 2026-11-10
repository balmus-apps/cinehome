# CineHome for LG TVs (webOS)

A small launcher app for LG TVs with webOS 5 or newer (2020+). It finds the CineHome server on your network, remembers it, and opens CineHome's TV interface:

- bigger text, and a highlight that follows the remote
- **Back** goes back a page; on the home screen it leaves the app
- **play/pause/stop/⏩/⏪** work in the player
- in the player, **▼** reaches the control bar (audio & subtitles, next episode); **◀ ▶** seek ±10 s

The TV plays MKV, HEVC and AC3/E-AC3 itself, so most files need no conversion on the computer. DTS or TrueHD audio, old XviD `.avi` files, and a non-default audio track (such as the Romanian dub) still get the light conversion.

Because the interface comes from the server, improvements to CineHome show up on the TV without reinstalling. Reinstall only when this launcher changes.

## One-time setup

### 1. Developer Mode on the TV

1. Create a free account at <https://webostv.developer.lge.com> (top right, **Sign in** → create account).
2. On the TV: **LG Content Store** → search **Developer Mode** → install → open it and sign in with that account.
3. Turn **Dev Mode Status** on. The TV restarts.
4. Open **Developer Mode** again and turn **Key Server** on. Note the **IP address** it shows.

The session lasts about 50 hours. Open the Developer Mode app now and then and press **Extend** (up to 1000 hours). If it runs out, the app disappears from the TV until you reinstall it.

### 2. Connect the Mac to the TV

```sh
cd cinehome/webosapp
npm install
npx ares-setup-device -a lgtv -i "host=<TV IP>" -i "port=9922" -i "username=prisoner"
npx ares-novacom --device lgtv --getkey     # asks for the passphrase shown in the Developer Mode app
```

### 3. Install and start

```sh
npm run deploy            # package + install + launch
```

CineHome now sits in the TV's app list.

## Server address

The launcher tries the saved address first, then the ones in [app/config.js](app/config.js) (the Mac's IP, then `cinehome.local:8080`). If none answers, it shows a screen where you type the address with the remote. Press **Change server** on the start screen to switch.

Give the Mac a fixed IP (a DHCP reservation in the router) so the address doesn't change.

## Commands

| | |
|---|---|
| `npm run package` | build `dist/com.cinehome.tv_1.0.0_all.ipk` |
| `npm run install-tv` | install it on the TV |
| `npm run launch` | start it on the TV |
| `npm run deploy` | all three |
| `npm run inspect` | open Chrome DevTools for the app running on the TV |
