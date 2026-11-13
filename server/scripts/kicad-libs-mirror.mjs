// A caching mirror of KiCad's library host for tests and offline work: answers the two URL
// shapes the server's /api/kicad-lib endpoints request (GitLab's tree API and raw files),
// from a directory on disk, filling it from upstream with curl on a miss (curl, so that the
// machine's proxy settings apply).  Point the server at it with KICAD_LIBS_URL.
//
//   PORT=8096 CACHE=/some/dir [UPSTREAM=https://gitlab.com] [OFFLINE=1] node kicad-libs-mirror.mjs
//
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const PORT = +(process.env.PORT || 8096), CACHE = process.env.CACHE || '/tmp/kicad-libs-mirror';
const UPSTREAM = (process.env.UPSTREAM || 'https://gitlab.com').replace(/\/$/, ''), OFFLINE = process.env.OFFLINE === '1';
fs.mkdirSync(CACHE, { recursive: true });

const fetchUp = (url) => new Promise((ok) => execFile('curl', ['-sS', '-m', '40', '-w', '\n%{http_code}', url], { maxBuffer: 64 << 20 }, (err, out) => {
  if (err) return ok({ status: 502, body: '' });
  const cut = out.lastIndexOf('\n'); ok({ status: +out.slice(cut + 1) || 502, body: out.slice(0, cut) });
}));

http.createServer(async (req, res) => {
  if (!/^\/(api\/v4\/projects\/kicad%2Flibraries%2Fkicad-(symbols|footprints|packages3D)\/repository\/tree\?|kicad\/libraries\/kicad-(symbols|footprints|packages3D)\/-\/raw\/)/.test(req.url)) { res.writeHead(404); return res.end('not mirrored'); }
  const file = path.join(CACHE, crypto.createHash('sha1').update(req.url).digest('hex'));
  let hit = null;
  try { hit = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* miss */ }
  if (!hit) {
    if (OFFLINE) { res.writeHead(502); return res.end('offline and not cached'); }
    hit = await fetchUp(UPSTREAM + req.url);
    if (hit.status === 200 || hit.status === 404) fs.writeFileSync(file, JSON.stringify({ url: req.url, ...hit }));
  }
  res.writeHead(hit.status, { 'Content-Type': req.url.startsWith('/api/') ? 'application/json' : 'text/plain; charset=utf-8' });
  res.end(hit.body);
}).listen(PORT, '127.0.0.1', () => console.log(`kicad libs mirror on :${PORT}, cache ${CACHE}`));
