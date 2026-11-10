// TV mode: LG webOS (app or TV browser), or ?tv=1 to try it on a computer.

const params = new URLSearchParams(location.search);

export const isWebos = /Web0S|webOS/i.test(navigator.userAgent);
export const isTv = isWebos || params.has('tv');
// Inside the CineHome Android app (a WebView): the app exits and keeps the screen on through this bridge
export const android = window.CineHomeAndroid || null;
// Kids tablets open with ?lock=kids: one fixed profile, no switching
export const lockedProfile = params.get('lock');

// Remote keys arrive as key names on newer webOS and only as key codes on older ones
const CODES = { 461: 'Back', 415: 'Play', 19: 'Pause', 413: 'Stop', 417: 'FastForward', 412: 'Rewind', 10252: 'PlayPause' };
const NAMES = {
  GoBack: 'Back', BrowserBack: 'Back', MediaPlay: 'Play', MediaPause: 'Pause', MediaPlayPause: 'PlayPause',
  MediaStop: 'Stop', MediaFastForward: 'FastForward', MediaRewind: 'Rewind',
};

export function remoteKey(e) {
  return NAMES[e.key] || CODES[e.keyCode] || null;
}

// Leave the app (back to the TV's home screen); does nothing in a normal browser
export function exitApp() {
  if (android) android.exit();
  else if (window.PalmSystem && typeof window.PalmSystem.platformBack === 'function') window.PalmSystem.platformBack();
  else if (isWebos) window.close();
}
