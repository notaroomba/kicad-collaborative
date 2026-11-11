// Browser test of File ▸ Fabrication Outputs in the real editor: the dialog opens from each of its four menu
// entries, lists Gerbers, drill files, the placement file and the BOM for the chosen manufacturer, draws a layer,
// and "Download ZIP" hands over an archive whose files are what the writers produce for the same board in Node
// (scripts/fab-verify.mjs checks those against kicad-cli).
// Setup as autoroute-ui.mjs: local server with KC_DEV_LOGIN=1 and a throwaway database, plus Playwright.
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… [SHOTS=/some/dir] [BOARD=path.kicad_pcb] node fab-ui.mjs
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
require(path.join(here, '..', 'static', 'kicad-canvas.js'));
require(path.join(here, '..', 'static', 'dist', 'fab.js'));
const K = globalThis.KiCadCanvas, F = globalThis.KiCadFab;

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
const userId = (await db.query(`INSERT INTO users (github_id, login, name) VALUES ($1, $2, $3) ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [-9401, 'fab-alice', 'Alice'])).rows[0].id;
await db.query('DELETE FROM projects WHERE owner_id = $1', [userId]);
const jwt = mintJwt(userId, 'fab-alice');

// ---------------------------------------------------------------- the board
const boardText = fs.readFileSync(BOARD, 'utf8');
const pro = BOARD.replace(/\.kicad_pcb$/, '.kicad_pro');
const upload = makeZip([['board.kicad_pcb', boardText], ['board.kicad_pro', fs.existsSync(pro) ? fs.readFileSync(pro, 'utf8') : '{}']]);
const form = new FormData(); form.append('archive', new Blob([upload], { type: 'application/zip' }), 'project.zip'); form.append('name', 'fab-demo');
const created = await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: form });
const project = await created.json();
const doc = project.docs?.find((d) => d.docType === 'kicad_pcb');
check('board uploaded', created.status === 200 && !!doc, JSON.stringify(project).slice(0, 200));

// what the writers make of the same file in Node, to hold the browser's download against
const kdoc = K.parseDoc(boardText, 'kicad_pcb');
const when = new Date();
const expected = {};
for (const id of ['jlcpcb', 'pcbway', 'kicad']) expected[id] = await F.buildPackage({ doc: kdoc, setup: boardText, projectName: 'board', date: when }, { preset: id });

// ---------------------------------------------------------------- the browser
const browser = await chromium.launch(); const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, acceptDownloads: true, colorScheme: 'dark' });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|fonts\.g|ERR_|40[0-9]|status of 4/.test(m.text())) errors.push(m.text()); });
await page.goto(`${BASE}/auth/dev?jwt=${jwt}&next=${encodeURIComponent(`/p/${project.projectId}/edit?doc=${doc.docId}`)}`);
await page.waitForFunction(() => window.CollabEditor && window.CollabEditor.kdoc && window.CollabEditor.kdoc.items.size > 10 && window.CollabEditor.ws && window.CollabEditor.ws.readyState === 1, null, { timeout: 60000 });
await page.waitForTimeout(800);
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
const ready = () => page.waitForFunction(() => document.querySelectorAll('.fab-files .it').length > 0 && !document.querySelector('.fab-view .spinner'), null, { timeout: 120000 });
const fileNames = () => page.$$eval('.fab-files .it', (els) => els.map((e) => e.dataset.file));
const listIs = (names) => page.waitForFunction((w) => !document.querySelector('.fab-view .spinner') && [...document.querySelectorAll('.fab-files .it')].map((e) => e.dataset.file).join('|') === w, names.join('|'), { timeout: 120000 }).catch(() => {});
const closeDialog = async () => { await page.click('.kd-foot .btn:not(.primary)'); await page.waitForSelector('.kd-dialog', { state: 'detached' }); };

// ---- every entry of File ▸ Fabrication Outputs that this feature covers opens the dialog on its own kind of file
const ENTRIES = [['Gerbers', 'gerber', /\.(gtl|gbr)$/i], ['Drill Files', 'drill', /\.drl$/i], ['Component Placement', 'placement', /positions|centroid|pos/i], ['Bill of Materials', 'bom', /bom/i]];
let first = true;
for (const [label, kind, pattern] of ENTRIES) {
  await page.click('#kmenus [data-menu="file"] > button');
  const sub = page.locator('#kmenus [data-menu="file"] .dd >> text=Fabrication Outputs').first();
  await sub.hover();
  const entry = page.locator('#kmenus [data-menu="file"] .dd').locator(`text=/^${label}/`).first();
  const enabled = await entry.evaluate((el) => { const row = el.closest('[data-id], .mi, li, button, div'); return !(row && (row.classList.contains('off') || row.classList.contains('disabled') || row.getAttribute('aria-disabled') === 'true')); }).catch(() => false);
  if (first) { await shot('01-menu'); }
  check(`File ▸ Fabrication Outputs ▸ ${label} is offered`, enabled);
  await entry.click();
  await page.waitForSelector('.kd-dialog', { timeout: 20000 });
  await ready();
  const title = await page.textContent('.kd-title span');
  const sel = await page.$eval('.fab-files .it.sel', (e) => e.dataset.file).catch(() => '');
  check(`…and opens Fabrication Outputs on the ${kind} file`, title === 'Fabrication Outputs' && pattern.test(sel || ''), `${title}: ${sel}`);
  if (first) {
    first = false;
    await page.waitForTimeout(300); await shot('02-dialog-jlcpcb');
    const painted = await page.$eval('.fab-view canvas', (cv) => { const g = cv.getContext('2d'); const d = g.getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n / (cv.width * cv.height); });
    check('the selected layer is drawn', painted > 0.01, `${(painted * 100).toFixed(1)}% of the preview is ink`);
  }
  if (kind === 'drill') { const text = await page.textContent('.fab-view pre'); check('the drill file is shown as text', /^M48/.test(text || ''), (text || '').slice(0, 40)); await shot('03-drill'); }
  if (kind === 'bom') { const text = await page.textContent('.fab-view pre'); check('the BOM is shown as text', /Designator|Reference|Item/i.test((text || '').split('\n')[0]), (text || '').slice(0, 80)); await shot('04-bom'); }
  await closeDialog();
}

// ---- each manufacturer: the list, the checks, and the archive
await page.evaluate(() => { try { localStorage.removeItem('kicad.fab.preset'); } catch (e) { /* none */ } });
await page.click('#kmenus [data-menu="file"] > button');
await page.locator('#kmenus [data-menu="file"] .dd >> text=Fabrication Outputs').first().hover();
await page.locator('#kmenus [data-menu="file"] .dd').locator('text=/^Gerbers/').first().click();
await page.waitForSelector('.kd-dialog'); await ready();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fab-ui-'));
for (const id of ['jlcpcb', 'pcbway', 'kicad']) {
  await page.selectOption('.fab-side select', id);
  const want = expected[id].files.map((f) => f.name);
  await listIs(want);
  const names = await fileNames();
  check(`${id}: the list has the ${want.length} files of the package`, JSON.stringify(names) === JSON.stringify(want), names.join(' '));
  const summary = await page.textContent('.fab-sum');
  check(`${id}: the summary states the board`, /mm, \d+ copper layers?, \d+ holes?/.test(summary || ''), summary || '');
  await page.waitForTimeout(200); await shot(`05-${id}`);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('.kd-foot .btn.primary')]);
  const file = path.join(tmp, dl.suggestedFilename()); await dl.saveAs(file);
  check(`${id}: Download ZIP saves ${dl.suggestedFilename()}`, dl.suggestedFilename() === `board-${id === 'kicad' ? 'fabrication' : id}.zip` && fs.statSync(file).size > 1000, `${fs.statSync(file).size} bytes`);
  let got = unzip(fs.readFileSync(file));
  check(`${id}: the archive holds ${expected[id].bundle.length} entries`, JSON.stringify([...got.keys()]) === JSON.stringify(expected[id].bundle.map((f) => f.name)), [...got.keys()].join(' '));
  const inner = expected[id].preset.gerberArchive;
  if (inner && got.has(inner)) { const nested = unzip(got.get(inner)); got.delete(inner); for (const [n, d] of nested) got.set(n, d); }
  // the creation date is the only thing that may differ between the two runs
  const strip = (s) => s.replace(/^.*(CreationDate|Created on|date ).*$/gim, '');
  let same = 0; const differing = [];
  for (const f of expected[id].files) { const d = got.get(f.name); if (d && strip(d.toString('utf8')) === strip(String(f.data))) same++; else differing.push(f.name); }
  check(`${id}: every file is what the writers make of the stored board`, same === expected[id].files.length, differing.join(' ') || `${same} files`);
}

// ---- options
await page.selectOption('.fab-side select', 'jlcpcb'); await listIs(expected.jlcpcb.files.map((f) => f.name));
const before = (await fileNames()).length;
await page.uncheck('.fab-layers input[data-layer="F.Paste"]');
await page.waitForFunction((n) => document.querySelectorAll('.fab-files .it').length === n - 1, before, { timeout: 60000 }).catch(() => {});
check('unticking a layer takes its file out of the package', (await fileNames()).length === before - 1, `${before} before, ${(await fileNames()).length} after`);
await page.locator('.fab-side label', { hasText: 'Bill of materials' }).locator('input').uncheck();
await page.waitForFunction(() => ![...document.querySelectorAll('.fab-files .it')].some((e) => /bom/i.test(e.dataset.file)), null, { timeout: 60000 }).catch(() => {});
check('unticking Bill of materials leaves the BOM out', !(await fileNames()).some((n) => /bom/i.test(n)));
const [one] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.locator('.fab-files .it').first().locator('button').click()]);
check('Save downloads a single file', one.suggestedFilename() === (await fileNames())[0], one.suggestedFilename());
await closeDialog();

// ---- light theme, narrow window
await page.emulateMedia({ colorScheme: 'light' }); await page.setViewportSize({ width: 900, height: 700 });
await page.evaluate(() => window.CollabEditor && window.CollabEditor.runAction ? window.CollabEditor.runAction('generateGerbers') : null).catch(() => {});
if (!(await page.$('.kd-dialog'))) { await page.click('#kmenus [data-menu="file"] > button'); await page.locator('#kmenus [data-menu="file"] .dd >> text=Fabrication Outputs').first().hover(); await page.locator('#kmenus [data-menu="file"] .dd').locator('text=/^Gerbers/').first().click(); }
await page.waitForSelector('.kd-dialog'); await ready(); await page.waitForTimeout(300);
const box = await page.$eval('.kd-dialog', (d) => { const r = d.getBoundingClientRect(); return { w: r.width, h: r.height, vw: innerWidth, vh: innerHeight }; });
check('the dialog fits a narrow window', box.w <= box.vw && box.h <= box.vh, JSON.stringify(box));
await shot('06-light-narrow');
await closeDialog();

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close(); await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

/** The entries of a zip archive (stored or deflated), in order. */
function unzip(buf) {
  const out = new Map(); let end = buf.length - 22; while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) return out;
  const n = buf.readUInt16LE(end + 10); let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    const lnl = buf.readUInt16LE(off + 26), lel = buf.readUInt16LE(off + 28); const data = buf.subarray(off + 30 + lnl + lel, off + 30 + lnl + lel + csize);
    out.set(name, method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data));
    p += 46 + nl + el + cl;
  }
  return out;
}

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
