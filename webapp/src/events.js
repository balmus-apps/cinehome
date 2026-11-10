'use strict';

// Server-sent events: tells open pages when the library changed.

const clients = new Set();

function handler(req, res) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

// Keeps proxies and browsers from closing idle connections
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25 * 1000).unref();

module.exports = { handler, broadcast };
