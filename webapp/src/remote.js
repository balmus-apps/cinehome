'use strict';

// Visits from outside the home arrive through a Cloudflare tunnel and carry Cloudflare's headers.
// They need the password in CINEHOME_PASSWORD (any user name); without one set, they are refused.
// The TV, tablets and browsers at home never see a password prompt.

const crypto = require('node:crypto');
const config = require('./config');

const MAX_FAILURES = 10;
const BLOCK_MS = 15 * 60_000;
const failures = new Map(); // ip -> { count, until }

const fromTunnel = req => Boolean(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);

function same(a, b) {
  const hash = s => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
}

function passwordOf(req) {
  const [scheme, value] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !value) return null;
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  return decoded.slice(decoded.indexOf(':') + 1);
}

function remoteAuth(req, res, next) {
  if (!fromTunnel(req)) return next();
  if (!config.password) {
    return res.status(403).type('text').send('CineHome is not open to the internet: set CINEHOME_PASSWORD first.');
  }
  const ip = req.headers['cf-connecting-ip'] || req.ip;
  const f = failures.get(ip);
  if (f && f.until > Date.now()) return res.status(429).type('text').send('Too many wrong passwords. Try again later.');

  const given = passwordOf(req);
  if (given !== null && same(given, config.password)) {
    failures.delete(ip);
    return next();
  }
  if (given !== null) {
    const count = (f ? f.count : 0) + 1;
    failures.set(ip, { count, until: count >= MAX_FAILURES ? Date.now() + BLOCK_MS : 0 });
  }
  res.set('WWW-Authenticate', 'Basic realm="CineHome", charset="UTF-8"');
  res.status(401).type('text').send('Password needed');
}

module.exports = { remoteAuth };
