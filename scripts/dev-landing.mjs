#!/usr/bin/env node
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const PORT = 3000;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.join(projectRoot, 'docs');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const RELOAD_SNIPPET = `<script>new EventSource('/__lr').onmessage=()=>location.reload()</script>`;

const clients = new Set();

http.createServer((req, res) => {
  if (req.url === '/__lr') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('data: ok\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.join(ROOT, urlPath);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    if (ext === '.html') {
      res.end(data.toString().replace('</body>', RELOAD_SNIPPET + '</body>'));
    } else {
      res.end(data);
    }
  });
}).listen(PORT, () => console.log(`Landing dev → http://localhost:${PORT}  (watching for changes…)`));

let reloadTimer;
fs.watch(ROOT, { recursive: true }, (event, filename) => {
  if (!filename || !/\.(js|css)$/.test(filename)) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    for (const c of clients) c.write('data: reload\n\n');
  }, 150);
});

const vite = spawn(
  path.join(projectRoot, 'node_modules', '.bin', 'vite'),
  ['build', '--config', 'vite.landing.config.js', '--watch'],
  { cwd: projectRoot, stdio: 'inherit' },
);

process.on('SIGINT', () => { vite.kill(); process.exit(0); });
process.on('SIGTERM', () => { vite.kill(); process.exit(0); });
