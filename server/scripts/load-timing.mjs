// How long a schematic takes to appear in the web editor, and where the time goes.
//
// Uploads a demo project to a local server (KC_DEV_LOGIN=1, throwaway database), then opens its
// schematic in Chromium several times over a throttled connection (the round trip and bandwidth
// of a hosted server, not of 127.0.0.1) and reports, per stage, the median time since navigation:
// scripts loaded, project info, document text, first picture of the sheet, live session joined.
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… [E2E_BASE=http://127.0.0.1:8099] [DEMO=stickhub] [RUNS=5]
//   [LATENCY=60] [MBPS=20] [OUT=timing.json] node load-timing.mjs
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
const DEMO = process.env.DEMO || 'stickhub', RUNS = Number(process.env.RUNS) || 5;
const LATENCY = process.env.LATENCY === undefined ? 60 : Number(process.env.LATENCY), MBPS = Number(process.env.MBPS) || 20;
const DEMOS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../demos');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'load-timing-'));

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'HS256', typ: 'JWT' }), b = b64({ sub, login, iat: now, exp: now + 36000 });
  return `${h}.${b}.${crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url')}`;
}

pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
await db.query('DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE github_id = -9301)');
await db.query('DELETE FROM users WHERE github_id = -9301').catch(() => {});
const uid = (await db.query("INSERT INTO users (github_id, login, name, email) VALUES (-9301, 'timing', 'timing', 'timing@example.com') RETURNING id")).rows[0].id;
const token = jwt(uid, 'timing');
const zip = path.join(TMP, 'p.zip');
execSync(`cd "${path.join(DEMOS, DEMO)}" && zip -qr "${zip}" . -i '*.kicad_pro' '*.kicad_sch' '*.kicad_pcb'`);
const form = new FormData(); form.append('name', DEMO); form.append('archive', new Blob([fs.readFileSync(zip)]), 'p.zip');
const made = await (await fetch(BASE + '/api/projects', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form })).json();
const projectId = made.projectId;
if (!projectId) { console.error('upload failed', made); process.exit(1); }

const browser = await chromium.launch();
const median = (a) => { const s = a.filter((v) => v != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

/** One page load in an existing browser profile; returns the stage times in ms since navigation start. */
async function load(ctx) {
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: LATENCY, downloadThroughput: MBPS * 125000, uploadThroughput: MBPS * 125000 });
  // The first picture of the sheet: the canvas is shown and a frame after that has been painted.
  await page.addInitScript(() => {
    const w = window;
    w.__t = {};
    const seen = () => {
      const cv = document.getElementById('canvas');
      if (cv && cv.style.display === 'block' && !w.__t.shown) {
        w.__t.shown = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => { w.__t.painted = performance.now(); }));
      }
      if (!w.__t.live && /^live/.test((document.getElementById('connLabel') || {}).textContent || '')) w.__t.live = performance.now();
    };
    new MutationObserver(seen).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  const sockets = [];
  page.on('websocket', (ws) => ws.on('framereceived', (f) => { try { const m = JSON.parse(f.payload); if (m.type === 'doc_info' || m.type === 'snapshot') sockets.push([m.type, Date.now()]); } catch { /* binary */ } }));
  const started = Date.now();
  await page.goto(`${BASE}/p/${projectId}/edit`);
  await page.waitForFunction(() => window.__t && window.__t.painted, null, { timeout: 30000 });
  await page.waitForTimeout(1500);   // let the live session join
  const r = await page.evaluate(() => {
    const res = performance.getEntriesByType('resource').map((e) => ({ name: e.name.replace(location.origin, ''), start: e.startTime, end: e.responseEnd, size: e.transferSize, decoded: e.decodedBodySize }));
    const nav = performance.getEntriesByType('navigation')[0];
    const marks = Object.fromEntries(performance.getEntriesByType('mark').filter((m) => m.name.startsWith('kc:')).map((m) => [m.name, m.startTime]));
    return { res, html: nav.responseEnd, dcl: nav.domContentLoadedEventEnd, t: window.__t, marks };
  });
  const end = (re) => { const e = r.res.filter((x) => re.test(x.name)); return e.length ? Math.max(...e.map((x) => x.end)) : null; };
  const js = r.res.filter((x) => /\.js(\?|$)/.test(x.name));
  const out = {
    html: r.html,
    scripts: end(/\/static\/.*\.js(\?|$)/), scriptsRun: r.dcl,
    jsKb: Math.round(js.reduce((s, x) => s + x.size, 0) / 1024), jsRequests: js.filter((x) => x.size > 0).length,
    me: end(/\/api\/me$/), info: end(/\/api\/projects\/[^/]+\/info/), content: end(/\/api\/(docs\/[^/]+\/content|projects\/[^/]+\/first-doc)/),
    shown: r.t.shown, painted: r.t.painted,
    live: sockets.find((s) => s[0] === 'doc_info') ? sockets.find((s) => s[0] === 'doc_info')[1] - started : null,
    requests: r.res.length, marks: r.marks,
  };
  await page.close();
  return out;
}

const report = { demo: DEMO, latencyMs: LATENCY, mbps: MBPS, runs: RUNS };
for (const mode of ['first visit', 'return visit']) {
  const rows = [];
  for (let i = 0; i < RUNS; i++) {
    // a profile of its own per run: nothing cached on a first visit, one earlier visit behind a return one
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p0 = await ctx.newPage(); await p0.goto(`${BASE}/auth/dev?jwt=${token}&next=${encodeURIComponent('/api/me')}`); await p0.close();
    if (mode === 'return visit') await load(ctx);
    rows.push(await load(ctx));
    await ctx.close();
  }
  const keys = ['html', 'scripts', 'scriptsRun', 'me', 'info', 'content', 'shown', 'painted', 'live', 'jsKb', 'jsRequests', 'requests'];
  report[mode] = Object.fromEntries(keys.map((k) => [k, Math.round(median(rows.map((r) => r[k])))]));
  report[mode].marks = rows[rows.length - 1].marks;
}
await browser.close();
await db.query('DELETE FROM projects WHERE id = $1', [projectId]).catch(() => {});
await db.end();

const label = { html: 'page', scripts: 'scripts downloaded', scriptsRun: 'scripts run', me: 'who am I', info: 'project info', content: 'schematic text', shown: 'sheet parsed', painted: 'sheet on screen', live: 'live session joined', jsKb: 'script kB over the wire', jsRequests: 'script downloads', requests: 'requests' };
console.log(`\n${DEMO}, ${LATENCY} ms round trip, ${MBPS} Mbit/s, median of ${RUNS} (ms since navigation)\n`);
console.log('stage'.padEnd(26) + 'first visit'.padStart(13) + 'return visit'.padStart(14));
for (const k of Object.keys(label)) console.log(label[k].padEnd(26) + String(report['first visit'][k]).padStart(13) + String(report['return visit'][k]).padStart(14));
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(report, null, 2));
