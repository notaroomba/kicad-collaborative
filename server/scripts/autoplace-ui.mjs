// Browser test of Tools ▸ Auto Place Footprints… with two people in one board: Alice places an unrouted board,
// Bob (dark theme) sees every footprint land in the same spot, one undo takes it back for both, and the placed
// board then autoroutes cleanly.
// Setup as github-ui.mjs: local server with KC_DEV_LOGIN=1 and a throwaway database, plus Playwright.
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… [SHOTS=/some/dir] [BOARD=path.kicad_pcb] node autoplace-ui.mjs
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
const BOARD = process.env.BOARD || path.join(here, '..', '..', 'demos', 'ecc83', 'ecc83-pp.kicad_pcb');
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
const aliceId = await mkUser(-9311, 'place-alice', 'Alice'), bobId = await mkUser(-9312, 'place-bob', 'Bob');
await db.query('DELETE FROM projects WHERE owner_id = $1', [aliceId]);
const alice = mintJwt(aliceId, 'place-alice'), bob = mintJwt(bobId, 'place-bob');

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
  await page.waitForFunction(() => window.CollabEditor && window.CollabEditor.kdoc && window.CollabEditor.kdoc.items.size > 5 && window.CollabEditor.ws && window.CollabEditor.ws.readyState === 1, null, { timeout: 60000 });
  await page.waitForTimeout(800);
  return page;
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
const counts = (page) => page.evaluate(() => { const c = { segment: 0, via: 0 }; for (const it of window.CollabEditor.kdoc.items.values()) if (it.kind in c) c[it.kind]++; return c; });
const board = (page) => page.evaluate(() => {
  const P = window.PcbTools, doc = window.CollabEditor.kdoc, s = P.designSettings(window.CollabEditor.proSettings || null); const m = P.drc(doc, s);
  return { unconnected: P.ratsnest(doc).length, violations: m.filter((x) => ['clearance', 'copper_edge_clearance', 'shorting_items', 'track_width', 'via_diameter'].includes(x.code)).length };
});
const spots = (page) => page.evaluate(() => { const K = window.KiCadCanvas, out = {}; for (const it of window.CollabEditor.kdoc.items.values()) if (it.kind === 'footprint') out[it.id] = K.atOf(it.node).map((v) => +v.toFixed(4)).join(','); return out; });
const same = (x, y) => JSON.stringify(Object.entries(x).sort()) === JSON.stringify(Object.entries(y).sort());

const a = await open(alice, 'light'), b = await open(bob, 'dark');
const before = await spots(a); const rats0 = await a.evaluate(() => window.PcbAutoRouter.evaluate(window.KiCadCanvas, window.PcbTools, window.CollabEditor.kdoc, null).ratsnest);
check('the board starts with its footprints where people put them', Object.keys(before).length > 5 && same(before, await spots(b)));
await shot(a, '01-before');

// ---- the command and its dialog, light and dark
await a.click('#kmenus [data-menu="tools"] > button');
const entry = a.locator('#kmenus [data-menu="tools"] .dd >> text=Auto Place Footprints…');
check('Tools menu offers Auto Place Footprints…', await entry.count() === 1);
await shot(a, '02-tools-menu');
await entry.click(); await a.waitForSelector('.kd-dialog');
check('the Auto Place dialog opens', (await a.textContent('.kd-title span')) === 'Auto Place Footprints');
const text = await a.textContent('.kd-body'); check('the dialog says what it will do', /tight block/.test(text) && /board outline/.test(text), text.slice(0, 120));
await shot(a, '03-dialog');
await b.click('#kmenus [data-menu="tools"] > button'); await b.locator('#kmenus [data-menu="tools"] .dd >> text=Auto Place Footprints…').click(); await b.waitForSelector('.kd-dialog');
await shot(b, '04-dialog-dark'); await b.keyboard.press('Escape');
check('opening the dialog changes nothing', same(before, await spots(a)));
await a.click('.kd-foot .btn.primary');
await a.waitForFunction((was) => { const K = window.KiCadCanvas; let moved = 0; for (const it of window.CollabEditor.kdoc.items.values()) if (it.kind === 'footprint' && K.atOf(it.node).map((v) => +v.toFixed(4)).join(',') !== was[it.id]) moved++; return moved > 3; }, before, { timeout: 60000 });
await a.waitForTimeout(600);
const placed = await spots(a); const moved = Object.keys(placed).filter((k) => placed[k] !== before[k]).length;
check('footprints were moved', moved > 3 && Object.keys(placed).length === Object.keys(before).length, `${moved} of ${Object.keys(placed).length}`);
const q = await a.evaluate(() => { const K = window.KiCadCanvas, P = window.PcbTools, doc = window.CollabEditor.kdoc; const refs = []; for (const it of doc.items.values()) if (it.kind === 'footprint') { const p = K.kids(it.node, 'property').find((x) => K.str(x[1]) === 'Reference'); if (p) refs.push({ ref: K.str(p[2]), fixed: true }); } const r = window.PcbAutoRouter.place(K, P, doc, null, { footprints: refs }); return { score: r.score, rats: window.PcbAutoRouter.evaluate(K, P, doc, null).ratsnest, courtyard: P.drc(doc, null).filter((m) => /courtyard/.test(m.code)).length }; });
check('no footprint overlaps another or leaves the board', q.score.courtyardClashes === 0 && q.score.outside === 0 && q.courtyard === 0, JSON.stringify(q));
check('the connections left to route are no longer than in the hand layout (within 10%)', q.rats <= rats0 * 1.1, `${rats0.toFixed(0)} mm by hand, ${q.rats.toFixed(0)} mm placed`);
await shot(a, '05-placed');

// ---- the other person, undo and redo
await b.waitForFunction((want) => { const K = window.KiCadCanvas; for (const it of window.CollabEditor.kdoc.items.values()) if (it.kind === 'footprint' && K.atOf(it.node).map((v) => +v.toFixed(4)).join(',') !== want[it.id]) return false; return true; }, placed, { timeout: 30000 }).catch(() => {});
check('the other person sees every footprint in the same place', same(placed, await spots(b)));
await shot(b, '06-peer-dark');
await a.mouse.move(700, 450); await a.keyboard.press('Control+z'); await a.waitForTimeout(1500);
check('one undo puts every footprint back', same(before, await spots(a)));
await b.waitForTimeout(1000); check('…for the other person too', same(before, await spots(b)));
await a.keyboard.press('Control+Shift+z'); await a.waitForTimeout(1500);
check('redo places them again', same(placed, await spots(a)));

// ---- the placed board routes
const r = await a.evaluate(async () => { const E = window.CollabEditor; const ctx = window.CollabTools.pcb.lastCtx || null; const K = window.KiCadCanvas, P = window.PcbTools; const res = window.PcbAutoRouter.route(K, P, E.kdoc, null, { passes: 2 }); return { total: res.total, routed: res.routed, zone: res.zoneEnds + res.zoneCovered, why: res.connections.filter((c) => !c.routed).map((c) => c.net + ':' + c.reason) }; });
check('the placed board routes completely', r.total > 5 && r.routed === r.total, JSON.stringify(r));
await a.click('#kmenus [data-menu="route"] > button'); await a.locator('#kmenus [data-menu="route"] .dd >> text=Autoroute…').click(); await a.waitForSelector('.kd-dialog');
const sc = a.locator('.kd-body select[data-k="scope"]'); if (await sc.count()) await sc.selectOption('all');
await a.click('.kd-foot .btn.primary');
await a.waitForFunction(() => { let n = 0; for (const it of window.CollabEditor.kdoc.items.values()) if (it.kind === 'segment') n++; const t = document.querySelector('.kd-title span'); return n > 0 && !(t && /Autorouting/.test(t.textContent)); }, null, { timeout: 300000 });
await a.waitForTimeout(500); if (await a.locator('.kd-title span', { hasText: 'Autoroute finished' }).count()) await a.click('.kd-foot .btn.primary');
const end = await a.evaluate(() => { const P = window.PcbTools, doc = window.CollabEditor.kdoc; const m = P.drc(doc, P.designSettings(window.CollabEditor.proSettings || null)); return { unconnected: P.ratsnest(doc).length, violations: m.filter((x) => ['clearance', 'copper_edge_clearance', 'shorting_items', 'courtyards_overlap'].includes(x.code)).length }; });
check('placed and routed in the editor: nothing unconnected but what waits on a zone refill, no rule violations', end.unconnected <= r.zone && end.violations === 0, JSON.stringify({ end, zone: r.zone }));
await a.waitForTimeout(800); await shot(a, '07-placed-and-routed'); await b.waitForTimeout(1500); await shot(b, '08-placed-and-routed-peer-dark');
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
