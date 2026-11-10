'use strict';

const path = require('node:path');
const express = require('express');
const config = require('./config');
const library = require('./library');
const events = require('./events');
const state = require('./state');
const probe = require('./media/probe');
const hls = require('./media/hls');
const api = require('./routes/api');
const { remoteAuth } = require('./remote');

const app = express();
app.disable('x-powered-by');
app.set('etag', 'strong');
app.use(remoteAuth);

// The TV launcher (a local file on the TV) checks the server address here, so allow any origin
app.get('/healthz', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json({ ok: true, app: 'cinehome', version: library.version() });
});

// Beacons from the player arrive as text/plain
app.use('/api', express.json({ type: ['application/json', 'text/plain'], limit: '16kb' }), api);

app.get('/vendor/hls.min.js', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(require.resolve('hls.js/dist/hls.min.js'));
});
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: 0 }));

library.on('changed', version => events.broadcast('library-changed', { version }));

const server = app.listen(config.port, () => {
  console.log(`[cinehome] listening on :${config.port}, media at ${config.mediaRoot}`);
});

library.rescan('startup').catch(err => console.error(`[cinehome] scan failed: ${err.message}`));
library.watch();

function shutdown() {
  hls.stopAll();
  state.flush();
  probe.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
