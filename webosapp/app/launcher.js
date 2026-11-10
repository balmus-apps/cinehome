/* CineHome launcher: finds the CineHome server on the home network, remembers it, then opens
   the server's own interface. Used by the LG webOS app and, bundled as assets, by the Android app
   (config.js sets CINEHOME_OPEN_PATH there). Plain ES5 so any webOS version runs it. */
(function () {
  var STORAGE_KEY = 'cinehome.server';
  var MIN_SPLASH_MS = 1200;
  var changeRequested = false;

  var $ = function (id) { return document.getElementById(id); };

  function normalize(address) {
    var a = String(address || '').replace(/\s+/g, '').replace(/\/+$/, '');
    if (!a) return null;
    if (!/^https?:\/\//i.test(a)) a = 'http://' + a;
    if (!/:\d+$/.test(a.replace(/^https?:\/\//i, ''))) a += ':8080';
    return a;
  }

  function saved() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  }

  function save(url) {
    try { localStorage.setItem(STORAGE_KEY, url); } catch (e) { /* ignore */ }
  }

  function check(url, done) {
    var xhr = new XMLHttpRequest();
    var finished = false;
    var finish = function (ok) {
      if (finished) return;
      finished = true;
      done(ok);
    };
    xhr.open('GET', url + '/healthz', true);
    xhr.timeout = 4000;
    xhr.onload = function () {
      try { finish(xhr.status === 200 && JSON.parse(xhr.responseText).ok === true); } catch (e) { finish(false); }
    };
    xhr.onerror = function () { finish(false); };
    xhr.ontimeout = function () { finish(false); };
    xhr.send();
  }

  // Try every address at once, so old IPs that no longer answer cost no waiting;
  // calls back with the first that answers, or null when none does
  function findServer(candidates, done) {
    var pending = candidates.length;
    var found = false;
    if (!pending) return done(null);
    $('connecting-text').textContent = 'Connecting to CineHome…';
    candidates.forEach(function (url) {
      check(url, function (ok) {
        pending -= 1;
        if (changeRequested || found) return;
        if (ok) {
          found = true;
          done(url);
        } else if (!pending) {
          done(null);
        }
      });
    });
  }

  function open(url) {
    save(url);
    window.location.href = url + (window.CINEHOME_OPEN_PATH || '/?tv=1');
  }

  function showSetup(message) {
    changeRequested = true;
    $('connecting').hidden = true;
    $('setup').hidden = false;
    $('setup-error').textContent = message || '';
    $('setup-error').hidden = !message;
    var input = $('address');
    if (!input.value) input.value = (saved() || normalize(window.CINEHOME_SERVERS && window.CINEHOME_SERVERS[0]) || '').replace(/^https?:\/\//, '');
    input.focus();
  }

  function connectTyped() {
    var url = normalize($('address').value);
    if (!url) return showSetup('Type the server address first.');
    $('connect').textContent = 'Connecting…';
    check(url, function (ok) {
      $('connect').textContent = 'Connect';
      if (ok) open(url);
      else showSetup('No CineHome server answered at ' + url.replace(/^https?:\/\//, '') + '. Is the computer on and CineHome running?');
    });
  }

  function exitApp() {
    if (window.CineHomeAndroid) window.CineHomeAndroid.exit();
    else if (window.PalmSystem && typeof window.PalmSystem.platformBack === 'function') window.PalmSystem.platformBack();
    else window.close();
  }

  $('change').addEventListener('click', function () { showSetup(); });
  $('connect').addEventListener('click', connectTyped);
  $('address').addEventListener('keydown', function (e) {
    if (e.keyCode === 13) connectTyped();
    if (e.keyCode === 40) { e.preventDefault(); $('connect').focus(); }
  });
  $('connect').addEventListener('keydown', function (e) {
    if (e.keyCode === 38) { e.preventDefault(); $('address').focus(); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.keyCode === 461 || e.key === 'GoBack') {
      e.preventDefault();
      if (!$('setup').hidden && saved()) window.location.reload();
      else exitApp();
    }
  });

  var candidates = [];
  var add = function (a) {
    var url = normalize(a);
    if (url && candidates.indexOf(url) === -1) candidates.push(url);
  };
  add(saved());
  (window.CINEHOME_SERVERS || []).forEach(add);

  $('change').focus();
  var started = Date.now();
  findServer(candidates, function (url) {
    if (changeRequested) return;
    if (!url) return showSetup('Could not find the CineHome server.');
    setTimeout(function () { if (!changeRequested) open(url); }, Math.max(0, MIN_SPLASH_MS - (Date.now() - started)));
  });
})();
