'use strict';
/*
 * serve.js — a dependency-free static server for local development.
 *
 *   node tools/serve.js [port] [--prefix /fair]
 *
 * `--prefix` mimics hosting under a subpath (as the Caddy config does), which is the quickest
 * way to catch an accidental absolute "/css/app.css" that would break on GitHub Pages too.
 *
 * Note: geolocation and service workers require a secure context. http://localhost counts as
 * one, so both work here; http://<lan-ip> does not, which is why the phone needs https.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const port = Number(args.find(a => /^\d+$/.test(a))) || 8080;
const pi = args.indexOf('--prefix');
const prefix = pi !== -1 ? (args[pi + 1] || '').replace(/\/+$/, '') : '';
const ROOT = path.join(__dirname, '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { res.writeHead(400).end('bad request'); return; }

  if (prefix) {
    if (urlPath === prefix) { res.writeHead(302, { Location: prefix + '/' }).end(); return; }
    if (!urlPath.startsWith(prefix + '/')) { res.writeHead(404).end('not found'); return; }
    urlPath = urlPath.slice(prefix.length);
  }
  if (urlPath.endsWith('/')) urlPath += 'index.html';

  // Resolve inside ROOT only — no path traversal.
  const file = path.join(ROOT, path.normalize(urlPath).replace(/^([/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found: ' + urlPath); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      // Service workers are only allowed to control the scope they're served from.
      'Service-Worker-Allowed': (prefix || '') + '/',
    });
    res.end(buf);
  });
}).listen(port, () => {
  console.log(`serving ${ROOT}`);
  console.log(`  http://localhost:${port}${prefix}/`);
});
