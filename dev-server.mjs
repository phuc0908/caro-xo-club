import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from './api/game.js';
const root = path.dirname(fileURLToPath(import.meta.url));
try {
  const env = await readFile(path.join(root, '.env'), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^([A-Z][A-Z_0-9]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch {}
const port = Number(process.env.PORT) || 3000;
const assets = {
  '/': ['index.html', 'text/html'],
  '/index.html': ['index.html', 'text/html'],
  '/styles.css': ['styles.css', 'text/css'],
  '/app.js': ['app.js', 'text/javascript'],
  '/polling.js': ['polling.js', 'text/javascript'],
};
createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname === '/api/game') {
    req.query = Object.fromEntries(url.searchParams);
    if (req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 10000) { res.writeHead(413); res.end('Payload too large'); return; }
      }
      try { req.body = JSON.parse(raw); } catch { req.body = null; }
    }
    return handler(req, res);
  }
  const asset = Object.hasOwn(assets, url.pathname) ? assets[url.pathname] : null;
  if (!asset || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const content = await readFile(path.join(root, 'public', asset[0]));
    res.setHeader('Content-Type', asset[1] + '; charset=utf-8');
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch { res.writeHead(500); res.end('Cannot read asset'); }
}).listen(port, () => console.log(`Caro XO Club: http://localhost:${port}`));
