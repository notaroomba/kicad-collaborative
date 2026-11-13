// Browser test of File ▸ Fabrication Outputs ▸ ODB++ Output File… in the real editor: the entry opens the Export
// ODB++ dialog (KiCad's DIALOG_EXPORT_ODBPP: output file, unit, precision, compression), and Export downloads an
// archive whose files are the ones web/fab/odb.ts writes for the same board in Node (static/tests/odb.test.js
// checks those against the board).  Setup as fab-ui.mjs.
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… [SHOTS=/some/dir] [BOARD=path.kicad_pcb] node odb-ui.mjs
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
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
const userId = (await db.query(`INSERT INTO users (github_id, login, name) VALUES ($1, $2, $3) ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [-9402, 'odb-alice', 'Alice'])).rows[0].id;
await db.query('DELETE FROM projects WHERE owner_id = $1', [userId]);
const jwt = mintJwt(userId, 'odb-alice');

// ---------------------------------------------------------------- the board
const boardText = fs.readFileSync(BOARD, 'utf8');
const pro = BOARD.replace(/\.kicad_pcb$/, '.kicad_pro');
const upload = makeZip([['board.kicad_pcb', boardText], ['board.kicad_pro', fs.existsSync(pro) ? fs.readFileSync(pro, 'utf8') : '{}']]);
const form = new FormData(); form.append('archive', new Blob([upload], { type: 'application/zip' }), 'project.zip'); form.append('name', 'odb-demo');
const created = await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: form });
const project = await created.json();
const doc = project.docs?.find((d) => d.docType === 'kicad_pcb');
check('board uploaded', created.status === 200 && !!doc, JSON.stringify(project).slice(0, 200));

// what the writers make of the same file in Node, to hold the browser's download against
const kdoc = K.parseDoc(boardText, 'kicad_pcb');
const when = new Date();
const expected = {};


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
const open = async () => {
  await page.click('#kmenus [data-menu="file"] > button');
  await page.locator('#kmenus [data-menu="file"] .dd >> text=Fabrication Outputs').first().hover();
  const entry = page.locator('#kmenus [data-menu="file"] .dd').locator('text=/^ODB\\+\\+/').first();
  const enabled = await entry.evaluate((el) => { const row = el.closest('[data-id], .mi, li, button, div'); return !(row && (row.classList.contains('off') || row.classList.contains('disabled') || row.getAttribute('aria-disabled') === 'true')); }).catch(() => false);
  await entry.click();
  await page.waitForSelector('.kd-dialog', { timeout: 20000 });
  return enabled;
};
const pick = (key, v) => page.$eval(`.kd-dialog [data-k="${key}"]`, (e, v) => { e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); }, v);
const strip = (t) => t.replace(/^(CREATION_DATE|SAVE_DATE)=.*$/gm, '').replace(/^# \d{4}-\d\d-\d\dT[\d:]+ *$/gm, '').replace(/<[^>]*[dD]ate[^>]*>/g, '');
const want = (o) => new Map(F.odb({ doc: kdoc, setup: boardText, projectName: 'board', date: when }, o).files.map((f) => [f.path, strip(f.text)]));

check('File ▸ Fabrication Outputs ▸ ODB++ Output File… is offered', await open());
await shot('01-dialog');
check('it opens Export ODB++', (await page.textContent('.kd-title span')) === 'Export ODB++');
const val = (key) => page.$eval(`.kd-dialog [data-k="${key}"]`, (e) => e.value).catch(() => null);
const labels = await page.$$eval('.kd-dialog .pd-lbl', (els) => els.map((e) => e.textContent));
check('with KiCad\'s fields', labels.join('|') === 'File:|Units:|Precision:|Version:|Compression format:|Product name:|Origin:', labels.join('|'));
check('defaults: board-odb.zip, Millimeters, 6, ZIP', (await val('outputFile')) === 'board-odb.zip' && (await val('units')) === '0' && Number(await val('precision')) === 6 && (await val('origin')) === '0' && (await val('compress')) === '1', [await val('outputFile'), await val('units'), await val('precision'), await val('compress')].join(' '));
const buttons = await page.$$eval('.kd-foot .btn', (els) => els.map((e) => e.textContent.trim()));
check('Export and Close', buttons.includes('Export') && buttons.includes('Close'), buttons.join('|'));

// ZIP, millimetres
{
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('.kd-foot .btn.primary')]);
  const file = path.join(os.tmpdir(), 'odb-ui-' + process.pid + '.zip'); await dl.saveAs(file);
  const got = new Map([...unzip(fs.readFileSync(file))].map(([n, d]) => [n, strip(d.toString('utf8'))])); fs.rmSync(file);
  const exp = want({});
  if (process.env.DIFF) for (const [n, x] of exp) if (got.get(n) !== x) { const a = x.split('\n'), b = (got.get(n) || '').split('\n'); const k = a.findIndex((l, i) => l !== b[i]); console.log(n, '\n  want', a[k], '\n  got ', b[k]); }
  check('Export downloads board-odb.zip', dl.suggestedFilename() === 'board-odb.zip', dl.suggestedFilename());
  check('holding the job the writer makes in Node', got.size === exp.size && [...exp].every(([n, t]) => got.get(n) === t), `${got.size} files, ${exp.size} expected, differing: ${[...exp].filter(([n, t]) => got.get(n) !== t).map(([n]) => n).slice(0, 4).join(' ')}`);
  check('with matrix, profile, netlist and layer features inside', ['matrix/matrix', 'steps/pcb/profile', 'steps/pcb/eda/data', 'steps/pcb/netlists/cadnet/netlist', 'misc/info'].every((n) => got.has(n)));
  await page.waitForSelector('.kd-dialog', { state: 'detached', timeout: 10000 }).catch(() => {});
  check('the dialog closes after the export', !(await page.$('.kd-dialog')));
}

// TGZ, inches, grid origin, a product name: the choice renames the file, and the choices are remembered
{
  await open();
  await pick('compress', '2');
  check('choosing TGZ renames the output file', (await val('outputFile')) === 'board-odb.tgz', await val('outputFile'));
  await pick('units', '1');
  check('inches raise the lowest precision to 4', await page.$eval('.kd-dialog [data-k="precision"]', (e) => { e.value = '2'; e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; }) === '4');
  await pick('origin', '2');
  await page.fill('.kd-dialog [data-k="productName"]', 'Demo board #1');
  await shot('02-tgz');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('.kd-foot .btn.primary')]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odb-ui-')); const file = path.join(dir, 'job.tgz'); await dl.saveAs(file);
  fs.mkdirSync(path.join(dir, 'out')); execFileSync('tar', ['xzf', file, '-C', path.join(dir, 'out')]);
  const exp = want({ inch: true, precision: 4, origin: 'grid', productName: 'Demo board #1' });
  const bad = [...exp].filter(([n, t]) => { try { return strip(fs.readFileSync(path.join(dir, 'out', n), 'utf8')) !== t; } catch (e) { return true; } }).map(([n]) => n);
  check('Export downloads board-odb.tgz', dl.suggestedFilename() === 'board-odb.tgz', dl.suggestedFilename());
  check('which tar unpacks to the inch job at 4 places from the grid origin, with the product name', bad.length === 0, bad.slice(0, 4).join(' '));
  fs.rmSync(dir, { recursive: true, force: true });
  await page.waitForSelector('.kd-dialog', { state: 'detached', timeout: 10000 }).catch(() => {});
  await open();
  check('the choices are remembered', (await val('units')) === '1' && Number(await val('precision')) === 4 && (await val('compress')) === '2' && (await val('origin')) === '2' && (await val('productName')) === 'Demo board #1' && (await val('outputFile')) === 'board-odb.tgz');
  await page.click('.kd-foot .btn:not(.primary)');
  await page.waitForSelector('.kd-dialog', { state: 'detached' });
}

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close(); await db.end();
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
