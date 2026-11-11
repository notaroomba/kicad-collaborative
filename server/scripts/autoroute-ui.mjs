// Browser test of the autorouter in the real editor with two people in one board: Alice runs Route ▸ Autoroute… on
// an unrouted board, Bob (dark theme) watches the tracks arrive, the result passes the editor's DRC, one undo takes
// the whole run back for both, redo brings it back, and a reload shows it was stored.
// Setup as github-ui.mjs: local server with KC_DEV_LOGIN=1 and a throwaway database, plus Playwright.
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… [SHOTS=/some/dir] [BOARD=path.kicad_pcb] node autoroute-ui.mjs
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
require(path.join(here, '..', 'static', 'kicad-canvas.js'));
const K = globalThis.KiCadCanvas;

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '';
const BOARD = process.env.BOARD || path.join(here, '..', '..', 'demos', 'pic_programmer', 'pic_programmer.kicad_pcb');
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintJwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
const mkUser = async (ghId, login, name) => (await db.query(
  `INSERT INTO users (github_id, login, name) VALUES ($1, $2, $3) ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [ghId, login, name])).rows[0].id;
const aliceId = await mkUser(-9301, 'route-alice', 'Alice'), bobId = await mkUser(-9302, 'route-bob', 'Bob');
await db.query('DELETE FROM projects WHERE owner_id = $1', [aliceId]);
const alice = mintJwt(aliceId, 'route-alice'), bob = mintJwt(bobId, 'route-bob');

// ---------------------------------------------------------------- the board: a routed demo with its tracks taken off
const tree = K.parse(fs.readFileSync(BOARD, 'utf8'));
const stripped = tree.filter((n) => !(Array.isArray(n) && (n[0] === 'segment' || n[0] === 'via' || n[0] === 'arc')));
const removed = tree.length - stripped.length;
const pro = BOARD.replace(/\.kicad_pcb$/, '.kicad_pro');
const zip = makeZip([['board.kicad_pcb', K.serialize(stripped)], ['board.kicad_pro', fs.existsSync(pro) ? fs.readFileSync(pro, 'utf8') : '{}']]);
const form = new FormData(); form.append('archive', new Blob([zip], { type: 'application/zip' }), 'project.zip'); form.append('name', 'autoroute-demo');
const created = await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { Authorization: `Bearer ${alice}` }, body: form });
const project = await created.json();
const doc = project.docs?.find((d) => d.docType === 'kicad_pcb');
check(`unrouted board uploaded (${removed} tracks and vias taken off)`, created.status === 200 && !!doc, JSON.stringify(project).slice(0, 200));
const link = await (await fetch(`${BASE}/api/projects/${project.projectId}/links`, { method: 'POST', headers: { Authorization: `Bearer ${alice}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'editor' }) })).json();
await fetch(`${BASE}/api/join/${link.token}`, { method: 'POST', headers: { Authorization: `Bearer ${bob}` } });

// ---------------------------------------------------------------- two browsers
const browser = await chromium.launch(); const errors = [];
async function open(jwt, colorScheme) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|fonts\.g|ERR_|40[0-9]|status of 4/.test(m.text())) errors.push(m.text()); });
  await page.goto(`${BASE}/auth/dev?jwt=${jwt}&next=${encodeURIComponent(`/p/${project.projectId}/edit?doc=${doc.docId}`)}`);
  await page.waitForFunction(() => window.CollabEditor && window.CollabEditor.kdoc && window.CollabEditor.kdoc.items.size > 10 && window.CollabEditor.ws && window.CollabEditor.ws.readyState === 1, null, { timeout: 60000 });
  await page.waitForTimeout(800);
  return page;
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
const counts = (page) => page.evaluate(() => { const c = { segment: 0, via: 0 }; for (const it of window.CollabEditor.kdoc.items.values()) if (it.kind in c) c[it.kind]++; return c; });
const board = (page) => page.evaluate(() => {
  const P = window.PcbTools, doc = window.CollabEditor.kdoc, s = P.designSettings(window.CollabEditor.proSettings || null); const m = P.drc(doc, s);
  return { unconnected: P.ratsnest(doc).length, violations: m.filter((x) => ['clearance', 'copper_edge_clearance', 'shorting_items', 'track_width', 'via_diameter'].includes(x.code)).length };
});

const a = await open(alice, 'light'), b = await open(bob, 'dark');
const before = await board(a); const c0 = await counts(a);
check('the board starts unrouted', c0.segment === 0 && c0.via === 0 && before.unconnected > 20, JSON.stringify({ c0, before }));
await shot(a, '01-unrouted');

// ---- the command and its dialog
await a.click('#kmenus [data-menu="route"] > button');
const entry = a.locator('#kmenus [data-menu="route"] .dd >> text=Autoroute…');
check('Route menu offers Autoroute…', await entry.count() === 1);
await shot(a, '02-route-menu');
await entry.click();
await a.waitForSelector('.kd-dialog');
const title = await a.textContent('.kd-title span');
check('the Autoroute dialog opens', title === 'Autoroute', title || '');
const dlgText = await a.textContent('.kd-body');
check('the dialog states the rules it routes by', /Board Setup/.test(dlgText) && new RegExp(`${before.unconnected} connections`).test(dlgText), dlgText.slice(0, 160));
await shot(a, '03-dialog');
const noChange = await counts(a); check('opening the dialog changes nothing', noChange.segment === 0);
await a.click('.kd-foot .btn.primary');

// ---- progress with a live preview; nothing is on the board (or at Bob's) until it finishes
await a.waitForFunction(() => { const t = document.querySelector('.kd-title span'); const n = document.querySelector('.kd-body .note'); return t && /Autorouting/.test(t.textContent) && n && /routed/.test(n.textContent); }, null, { timeout: 60000 });
await shot(a, '04-routing-preview');
const mid = await counts(b); check('nothing reaches the other person while the router is still working', mid.segment === 0, JSON.stringify(mid));
await a.waitForFunction(() => { let n = 0; for (const it of window.CollabEditor.kdoc.items.values()) if (it.kind === 'segment') n++; const t = document.querySelector('.kd-title span'); return n > 0 && !(t && /Autorouting/.test(t.textContent)); }, null, { timeout: 300000 });
await a.waitForTimeout(500);
if (await a.locator('.kd-title span', { hasText: 'Autoroute finished' }).count()) { await shot(a, '05-report'); await a.click('.kd-foot .btn.primary'); }
const c1 = await counts(a); const after = await board(a);
check('tracks were laid', c1.segment > 50, JSON.stringify(c1));
check('at least 95% of the connections are made', after.unconnected <= Math.ceil(before.unconnected * 0.05), `${before.unconnected} before, ${after.unconnected} left`);
check('no design rule violations', after.violations === before.violations, JSON.stringify({ before, after }));
await shot(a, '06-routed');

// ---- the other person
await b.waitForFunction((n) => { let k = 0; for (const it of window.CollabEditor.kdoc.items.values()) if (it.kind === 'segment') k++; return k === n; }, c1.segment, { timeout: 30000 }).catch(() => {});
const cb = await counts(b); const bobBoard = await board(b);
check('the other person receives every track and via', cb.segment === c1.segment && cb.via === c1.via, JSON.stringify({ alice: c1, bob: cb }));
check('…and their board is as connected and as clean', bobBoard.unconnected === after.unconnected && bobBoard.violations === after.violations, JSON.stringify(bobBoard));
await shot(b, '07-peer-dark');

// ---- one undo for the whole run, for both; redo brings it back
await a.mouse.move(700, 450); await a.keyboard.press('Control+z');
await a.waitForFunction(() => { for (const it of window.CollabEditor.kdoc.items.values()) if (it.kind === 'segment') return false; return true; }, null, { timeout: 15000 }).catch(() => {});
const cu = await counts(a); check('one undo takes the whole run back', cu.segment === 0 && cu.via === 0, JSON.stringify(cu));
await b.waitForFunction(() => { for (const it of window.CollabEditor.kdoc.items.values()) if (it.kind === 'segment') return false; return true; }, null, { timeout: 15000 }).catch(() => {});
const cbu = await counts(b); check('…for the other person too', cbu.segment === 0 && cbu.via === 0, JSON.stringify(cbu));
await a.keyboard.press('Control+Shift+z');
await a.waitForFunction((n) => { let k = 0; for (const it of window.CollabEditor.kdoc.items.values()) if (it.kind === 'segment') k++; return k === n; }, c1.segment, { timeout: 15000 }).catch(() => {});
const cr = await counts(a); check('redo lays it again', cr.segment === c1.segment && cr.via === c1.via, JSON.stringify(cr));

// ---- the dialog in the dark theme, and a view of nothing left to do
await b.click('#kmenus [data-menu="route"] > button'); await b.locator('#kmenus [data-menu="route"] .dd >> text=Autoroute…').click();
await b.waitForTimeout(400);
if (await b.locator('.kd-dialog').count()) { await shot(b, '08-dialog-dark'); await b.keyboard.press('Escape'); } else await shot(b, '08-nothing-left-dark');

// ---- stored: a fresh load has the tracks
await a.waitForTimeout(1500);
const c = await open(alice, 'light'); const cs = await counts(c);
check('a fresh load of the board has the routed tracks', cs.segment === c1.segment && cs.via === c1.via, JSON.stringify(cs));
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
await db.query('DELETE FROM projects WHERE owner_id = $1', [aliceId]);
await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

function makeZip(entries) {
  const table = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  const crc32 = (buf) => { let c = -1; for (const x of buf) c = table[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const locals = [], centrals = []; let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name), data = Buffer.from(content), crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, data); centrals.push(ch, nameBuf); offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
