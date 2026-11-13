// How the web editor copes with a burst of edits from somebody else (a script run through MCP, a paste, an
// autorouter): a second client sends OPS ops over the live session while a browser has the document open, and
// the browser reports how long its main thread was blocked and when the last edit was on screen.
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… [E2E_BASE=http://127.0.0.1:8099] [DEMO=stickhub] [OPS=400] [PER=1] [PACE=0] [BOARD=1] [PROFILE=1] [REOPEN=1] node burst-timing.mjs
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
const DEMO = process.env.DEMO || 'stickhub', OPS = Number(process.env.OPS) || 400, PER = Number(process.env.PER) || 1, BOARD = !!process.env.BOARD;
const DEMOS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../demos');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'burst-'));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'HS256', typ: 'JWT' }), b = b64({ sub, login, iat: now, exp: now + 36000 });
  return `${h}.${b}.${crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url')}`;
}
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
await db.query('DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE github_id = -9311)');
await db.query('DELETE FROM users WHERE github_id = -9311').catch(() => {});
const uid = (await db.query("INSERT INTO users (github_id, login, name, email) VALUES (-9311, 'burst', 'burst', 'burst@example.com') RETURNING id")).rows[0].id;
const token = jwt(uid, 'burst');
const zip = path.join(TMP, 'p.zip');
execSync(`cd "${path.join(DEMOS, DEMO)}" && zip -qr "${zip}" . -i '*.kicad_pro' '*.kicad_sch' '*.kicad_pcb'`);
const form = new FormData(); form.append('name', DEMO); form.append('archive', new Blob([fs.readFileSync(zip)]), 'p.zip');
const projectId = (await (await fetch(BASE + '/api/projects', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form })).json()).projectId;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const p0 = await ctx.newPage(); await p0.goto(`${BASE}/auth/dev?jwt=${token}&next=${encodeURIComponent('/api/me')}`); await p0.close();
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror: ' + e.message));
await page.goto(`${BASE}/p/${projectId}/edit`);
await page.waitForFunction(() => window.CollabEditor && window.CollabEditor.kdoc && window.CollabEditor.joinedDocId, null, { timeout: 20000 });
if (BOARD) {
  await page.evaluate(() => { const E = window.CollabEditor; E.api.openDoc(E.api.state.docs.find((d) => d.docType === 'kicad_pcb')); });
  await page.waitForFunction(() => document.body.dataset.editor === 'pcb' && window.CollabEditor.kdoc && window.CollabEditor.joinedDocId, null, { timeout: 20000 });
}
await page.waitForTimeout(1500);
const docId = await page.evaluate(() => window.CollabEditor.joinedDocId);
const before = await page.evaluate(() => {
  window.__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({ entryTypes: ['longtask'] });
  window.__frames = 0; const tick = () => { window.__frames++; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
  return window.CollabEditor.kdoc.items.size;
});

// the second client: the same person in another program
const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
const inbox = []; let acks = 0;
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.type === 'ack') acks++; else inbox.push(m); };
await new Promise((r) => { ws.onopen = r; });
ws.send(JSON.stringify({ type: 'hello', proto: 1, token, clientId: 'burst-script', client: 'script' }));
const until = async (f, ms = 60000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); } };
await until(() => inbox.some((m) => m.type === 'hello_ok'));
ws.send(JSON.stringify({ type: 'join_doc', docId }));
await until(() => inbox.some((m) => m.type === 'doc_info'));
const uuid = () => crypto.randomUUID();
const item = (i) => {
  const id = uuid(), x = 20 + (i % 100) * 1.27, y = 20 + Math.floor(i / 100) * 2.54;
  return BOARD
    ? { id, typeName: 'PCB_TRACK', kind: 'ADDED', sexpr: `(kicad_pcb (segment (start ${x} ${y}) (end ${x + 1} ${y}) (width 0.2) (layer "F.Cu") (net 0) (uuid "${id}")))` }
    : i % 3 === 2 ? { id, typeName: 'SCH_LABEL', kind: 'ADDED', sexpr: `(label "N${i}" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "${id}"))` }
    : { id, typeName: 'SCH_LINE', kind: 'ADDED', sexpr: `(wire (pts (xy ${x} ${y}) (xy ${x + 1.27} ${y})) (stroke (width 0) (type default)) (uuid "${id}"))` };
};
const cdp = process.env.PROFILE ? await ctx.newCDPSession(page) : null;
if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start'); }
const t0 = Date.now();
const PACE = Number(process.env.PACE) || 0;   // ms between ops: a script that keeps working for a while, not one burst
for (let i = 0; i < OPS; i++) { if (PACE) await new Promise((r) => setTimeout(r, PACE)); ws.send(JSON.stringify({ type: 'op', docId, clientOpId: `burst:${i}`, baseSeq: null, changes: Array.from({ length: PER }, (_, k) => item(i * PER + k)) })); }
await until(() => acks >= OPS);
const acked = Date.now() - t0;
await page.waitForFunction((n) => window.CollabEditor.kdoc.items.size >= n, before + OPS * PER, { timeout: 180000 });
const shown = Date.now() - t0;
await page.waitForTimeout(1200);
if (cdp) {
  // PROFILE=1: where the time went, by function (self time) and by what the editor called from its message handler
  const { profile } = await cdp.send('Profiler.stop');
  const dt = profile.timeDeltas, self = new Map(), byId = new Map(profile.nodes.map((n) => [n.id, n]));
  profile.samples.forEach((id, i) => { self.set(id, (self.get(id) || 0) + dt[i] / 1000); });
  const agg = new Map();
  for (const [id, ms] of self) { const n = byId.get(id), f = n.callFrame; const k = `${f.functionName || '(anon)'} ${f.url.split('/').pop().split('?')[0]}:${f.lineNumber + 1}:${f.columnNumber + 1}`; agg.set(k, (agg.get(k) || 0) + ms); }
  console.log('  self time, top 25:'); for (const [k, ms] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`    ${String(Math.round(ms)).padStart(6)} ms  ${k}`);
  const total = new Map(); const parent = new Map(); for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  for (const [id, ms] of self) { const seen = new Set(); for (let x = id; x !== undefined; x = parent.get(x)) { const f = byId.get(x).callFrame; const k = `${f.functionName || '(anon)'} ${f.url.split('/').pop().split('?')[0]}:${f.lineNumber + 1}:${f.columnNumber + 1}`; if (seen.has(k)) continue; seen.add(k); total.set(k, (total.get(k) || 0) + ms); } }
  console.log('  total time, top 40:'); for (const [k, ms] of [...total].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`    ${String(Math.round(ms)).padStart(6)} ms  ${k}`);
}
const r = await page.evaluate(() => ({ long: window.__long, frames: window.__frames, items: window.CollabEditor.kdoc.items.size }));
const blocked = r.long.reduce((s, d) => s + d, 0);
console.log(`${DEMO} ${BOARD ? 'board' : 'schematic'}: ${OPS} ops of ${PER} item(s) into ${before} items`);
console.log(`  server took them in        ${acked} ms`);
console.log(`  all on screen after        ${shown} ms`);
console.log(`  browser blocked            ${Math.round(blocked)} ms in ${r.long.length} long tasks (longest ${Math.round(Math.max(0, ...r.long))} ms)`);
console.log(`  frames drawn meanwhile     ${r.frames} (${Math.round(r.frames / ((shown + 1200) / 1000))} a second)`);
console.log(`  items                      ${before} -> ${r.items}`);
// REOPEN=1: somebody opens the document afterwards; the edits since the last stored snapshot come with the join
if (process.env.REOPEN) {
  const p2 = await ctx.newPage();
  await p2.addInitScript(() => { window.__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({ entryTypes: ['longtask'] }); });
  const t1 = Date.now();
  await p2.goto(`${BASE}/p/${projectId}/edit${BOARD ? `?doc=${docId}` : ''}`);
  await p2.waitForFunction(() => window.CollabEditor && window.CollabEditor.kdoc, null, { timeout: 60000 });
  const first = Date.now() - t1, had = await p2.evaluate(() => window.CollabEditor.kdoc.items.size);
  await p2.waitForFunction((n) => window.CollabEditor.kdoc && window.CollabEditor.kdoc.items.size >= n, r.items, { timeout: 180000 });
  const full = Date.now() - t1; await p2.waitForTimeout(500);
  if (process.env.PROFILE) {
    const c2 = await ctx.newCDPSession(p2); await c2.send('Profiler.enable'); await c2.send('Profiler.start');
    await p2.reload(); await p2.waitForFunction((n) => window.CollabEditor && window.CollabEditor.kdoc && window.CollabEditor.kdoc.items.size >= n, r.items, { timeout: 180000 }); await p2.waitForTimeout(500);
    const { profile } = await c2.send('Profiler.stop');
    const dt = profile.timeDeltas, self = new Map(), byId = new Map(profile.nodes.map((n) => [n.id, n])), parent = new Map();
    for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
    profile.samples.forEach((id, i) => { self.set(id, (self.get(id) || 0) + dt[i] / 1000); });
    const name = (x) => { const f = byId.get(x).callFrame; return `${f.functionName || '(anon)'} ${f.url.split('/').pop().split('?')[0]}:${f.lineNumber + 1}:${f.columnNumber + 1}`; };
    const total = new Map();
    for (const [id, ms] of self) { const seen = new Set(); for (let x = id; x !== undefined; x = parent.get(x)) { const k = name(x); if (seen.has(k)) continue; seen.add(k); total.set(k, (total.get(k) || 0) + ms); } }
    console.log('  reopen, total time, top 30:'); for (const [k, ms] of [...total].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`    ${String(Math.round(ms)).padStart(6)} ms  ${k}`);
  }
  const l2 = await p2.evaluate(() => window.__long);
  console.log(`  opened afterwards          first picture ${first} ms with ${had} items, all ${r.items} at ${full} ms, blocked ${Math.round(l2.reduce((s, d) => s + d, 0))} ms (longest ${Math.round(Math.max(0, ...l2))} ms)`);
}
ws.close(); await browser.close();
await db.query('DELETE FROM projects WHERE id = $1', [projectId]).catch(() => {});
await db.end();
