#!/usr/bin/env node
// github-bridge.mjs — a local stand-in for api.github.com that forwards to the real one
// with a token of your choosing, for github-real.mjs. The server under test is pointed
// at it (GITHUB_API_URL=http://127.0.0.1:8097); fake-github.mjs still does the OAuth
// hand-off, so no real OAuth app is needed.
//
// Reads go anywhere; writes (anything but GET) go ONLY to the repository in WRITE_REPO
// and are refused everywhere else, so a test can never touch another repository.
//
//   GH_TOKEN=$(gh auth token) WRITE_REPO=owner/throwaway node github-bridge.mjs
import http from 'node:http';

const PORT = Number(process.env.PORT || 8097);
const TOKEN = process.env.GH_TOKEN || '';
const WRITE = process.env.WRITE_REPO ? `/repos/${process.env.WRITE_REPO}` : null;
if (!WRITE) { console.error('WRITE_REPO=owner/name is required'); process.exit(2); }

let n = 0;
http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const p = req.url.split('?')[0];
  if (req.method !== 'GET' && !(p === WRITE || p.startsWith(WRITE + '/'))) {
    console.log(`REFUSED ${req.method} ${req.url}`);
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ message: `github-bridge: writes only go to ${WRITE}` }));
  }
  const t0 = Date.now();
  try {
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await fetch('https://api.github.com' + req.url, {
      method: req.method,
      headers: {
        Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'kicad-collab-test',
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
    });
    const out = Buffer.from(await r.arrayBuffer());
    console.log(`${++n} ${req.method} ${req.url} -> ${r.status} ${out.length}B ${Date.now() - t0}ms`);
    res.writeHead(r.status, { 'Content-Type': 'application/json' });
    res.end(out);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: String(e) }));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`github bridge on ${PORT}, writes only to ${WRITE}`));
