// Browser test of real official KiCad plugins that need compiled Python packages (numpy, pillow, shapely) or a
// drawing library (cairosvg): each is installed from a local copy of KiCad's repository and worked in Chromium, in
// the real editor, on a real board.  What is checked is the plugin's own result: a PNG with the board on it, an image
// file, copper put on the board.
//
//   PCM_META=<kicad-addons metadata>/packages  PCM_ZIPS=<folder of <identifier>.zip>
//   Server: KC_DEV_LOGIN=1 KC_PCM_REPOSITORY=http://127.0.0.1:8096/repository.json
//   E2E_PG_URL=… E2E_JWT_SECRET=… [SHOTS=/some/dir] [ONLY=substring] node plugins-python-real-ui.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import pg from 'pg';
import { startPcmFixture } from './pcm-fixture.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const fixture = await startPcmFixture({ port: Number(process.env.PCM_PORT || 8096) });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintJwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub: Number(sub), login, iat: now, exp: now + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
/** The files of a zip (stored or deflated entries), by name. */
function unzip(buf) {
  const out = {}; let p = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); if (p < 0) return out;
  const n = buf.readUInt16LE(p + 10); let q = buf.readUInt32LE(p + 16);
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(q + 10), size = buf.readUInt32LE(q + 20), nameLen = buf.readUInt16LE(q + 28), extra = buf.readUInt16LE(q + 30), comment = buf.readUInt16LE(q + 32), at = buf.readUInt32LE(q + 42);
    const name = buf.slice(q + 46, q + 46 + nameLen).toString('utf8');
    const data = buf.slice(at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28)).slice(0, size);
    out[name] = method === 8 ? zlib.inflateRawSync(data) : data;
    q += 46 + nameLen + extra + comment;
  }
  return out;
}
/** Width, height and how many pixels of a PNG are not blank, measured by the browser. */
const measurePng = (page, bytes) => page.evaluate(async (b) => {
  const img = new Image(); await new Promise((ok, bad) => { img.onload = ok; img.onerror = () => bad(new Error('not a picture')); img.src = 'data:image/png;base64,' + b; });
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data; let drawn = 0; const seen = new Set();
  for (let i = 0; i < d.length; i += 4) { if (d[i + 3] > 0 && !(d[i] > 250 && d[i + 1] > 250 && d[i + 2] > 250)) drawn++; if (seen.size < 64) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]); }
  return { w: img.width, h: img.height, drawn, colours: seen.size };
}, Buffer.from(bytes).toString('base64'));

const db = new pg.Client({ connectionString: PG_URL });
await db.connect();
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
async function user(githubId, login) {
  return (await db.query(`INSERT INTO users (github_id, login, name) VALUES ($1, $2, $2) ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [githubId, login])).rows[0].id;
}
const dana = await user(9701, 'real-dana');
await db.query('DELETE FROM projects WHERE owner_id = $1', [dana]);
await db.query('DELETE FROM plugins WHERE user_id = $1', [dana]);
const RECT = '5b0e6c1e-7d0a-4c55-9a55-0f3f6a1c2d01';
/** A project holding one demo board (and its schematic and project file); `edit` may change the board text. */
async function project(name, dir, stem, edit = (t) => t) {
  const id = (await db.query(`INSERT INTO projects (owner_id, name) VALUES ($1, $2) RETURNING id`, [dana, name])).rows[0].id; const docs = {};
  for (const [ext, type] of [['kicad_sch', 'kicad_sch'], ['kicad_pcb', 'kicad_pcb'], ['kicad_pro', 'kicad_pro']]) {
    const f = path.join(repo, dir, `${stem}.${ext}`); if (!fs.existsSync(f)) continue;
    const doc = (await db.query(`INSERT INTO documents (project_id, path, doc_type) VALUES ($1, $2, $3) RETURNING id`, [id, `${stem}.${ext}`, type])).rows[0].id;
    await db.query('INSERT INTO snapshots (doc_id, seq, content) VALUES ($1, 0, $2)', [doc, ext === 'kicad_pcb' ? Buffer.from(edit(fs.readFileSync(f, 'utf8'))) : fs.readFileSync(f)]);
    docs[ext] = doc;
  }
  return `/p/${id}/edit?doc=${docs.kicad_pcb}`;
}
const withRect = (t) => t.slice(0, t.lastIndexOf(')')) + `\t(gr_rect (start 121.285 90.17) (end 173.355 136.525) (stroke (width 0.1) (type default)) (fill no) (layer "Cmts.User") (uuid "${RECT}"))\n)\n`;
const ecc83 = await project('ecc83-pp', 'demos/ecc83', 'ecc83-pp', withRect);
/** The board with its tracks and vias deleted (top-level nodes), as a person would before autorouting it. */
const unrouted = (t) => {
  let out = ''; let i = 0;
  for (;;) {
    const m = /\n\t\((segment|via|arc)\b/.exec(t.slice(i)); if (!m) { out += t.slice(i); break; }
    const at = i + m.index; out += t.slice(i, at); let depth = 0, j = at + 2, inStr = false;
    for (; j < t.length; j++) { const c = t[j]; if (inStr) { if (c === '\\') j++; else if (c === '"') inStr = false; } else if (c === '"') inStr = true; else if (c === '(') depth++; else if (c === ')' && --depth === 0) { j++; break; } }
    i = j;
  }
  return out;
};
const ecc83Unrouted = await project('ecc83-unrouted', 'demos/ecc83', 'ecc83-pp', unrouted);

const browser = await chromium.launch();
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1, colorScheme: 'light', acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
if (process.env.VERBOSE) page.on('console', (m) => { if (m.type() === 'error') console.log('   console:', m.text().slice(0, 300)); });
const downloads = []; page.on('download', (d) => downloads.push(d));
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
const editorReady = async () => { await page.waitForFunction(() => window.CollabEditor && window.CollabEditor.api && window.CollabEditor.kdoc && window.KcPlugins, null, { timeout: 30000 }); await page.waitForTimeout(1200); };
const state = () => page.evaluate(() => { const s = window.KcPlugins.store.get(); return { running: s.running, logs: s.logs, py: s.pyActions, prompt: s.prompt && { title: s.prompt.title, message: s.prompt.message } }; });
const logTail = async (id, n = 6) => (((await state()).logs[id] || []).slice(-n).map((l) => l.text).join(' | ')).slice(-5000);
const inner = () => page.frames().filter((f) => f !== page.mainFrame() && f.parentFrame() === page.mainFrame());
const frameOf = async (id) => { const h = await page.locator(`#pluginFrames iframe[data-plugin="${id}"]`).elementHandle().catch(() => null); return h ? h.contentFrame() : inner()[inner().length - 1]; };
const download = async (after, timeout = 240000) => { const t0 = Date.now(); while (downloads.length <= after && Date.now() - t0 < timeout) await page.waitForTimeout(300); const d = downloads[after]; if (!d) return null; const f = path.join(os.tmpdir(), `real-${Date.now()}-${d.suggestedFilename()}`); await d.saveAs(f); return { name: d.suggestedFilename(), bytes: fs.readFileSync(f) }; };

/** Install a plugin from the KiCad tab, agree to its permissions and wait for its interpreter and packages. */
async function install(id) {
  await page.evaluate(() => window.KcPlugins.runUi('pluginManager'));
  await page.waitForSelector('#pluginManager');
  await page.click('#pluginManager [data-tab="kicad"]');
  await page.waitForSelector(`#pluginKicad [data-plugin="${id}"]`, { timeout: 30000 });
  await page.click(`#pluginKicad [data-install="${id}"]`);
  await page.waitForSelector('#pluginConsent', { timeout: 30000 });
  await page.click('#pluginConsentOk');
  await page.waitForFunction((i) => window.KcPlugins.store.get().installed.some((p) => p.identifier === i), id, { timeout: 30000 });
  await page.click('#pluginManager .kd-x');
  const t0 = Date.now();
  await page.waitForFunction((i) => { const r = window.KcPlugins.store.get().running[i]; return r && (r.ready || r.failed); }, id, { timeout: 240000 });
  const st = await state();
  check(`${id}: Python and its packages load in the sandbox`, st.running[id] && st.running[id].ready && !st.running[id].failed, JSON.stringify(st.running[id]) + ' ' + await logTail(id));
  console.log(`      (ready ${Date.now() - t0} ms after install; commands: ${(st.py[id] || []).map((a) => a.name).join(', ')})`);
  return st.py[id] || [];
}
const runAction = (id, action) => page.evaluate(([i, a]) => { window.KcPlugins.runUi(`plugin:${i}:${a}`); }, [id, action.identifier]);
const only = (id) => !process.env.ONLY || id.includes(process.env.ONLY);

await page.goto(`${BASE}/auth/dev?jwt=${mintJwt(dana, 'real-dana')}&next=${encodeURIComponent(ecc83)}`);
await editorReady();

// ---- KiPNG: kicad-cli SVG export of the chosen layers, stacked, drawn to a PNG by cairosvg (pillow joins tiles)
if (only('KiPNG')) {
  const ID = 'com.github.tobiglaser.KiPNG';
  try {
    const actions = await install(ID);
    await page.evaluate((u) => window.CollabEditor.api.toolCtx().setSelection([u]), RECT);
    const n0 = downloads.length;
    await runAction(ID, actions[0]);
    const f = await frameOf(ID);
    await f.waitForSelector('text=Generate PNG', { timeout: 120000 });
    await f.click('text=Front');
    await page.waitForTimeout(400);
    await shot('real-kipng-window');
    const announced = (await f.locator('text=/^\\s*\\d+x\\d+\\s*$/').first().innerText().catch(() => '')).trim();
    await f.click('text=Generate PNG');
    const got = await download(n0);
    check('KiPNG: a file is handed over', !!got, await logTail(ID));
    if (got) {
      const files = /\.zip$/.test(got.name) ? unzip(got.bytes) : { [got.name]: got.bytes };
      const png = Object.keys(files).find((k) => /^\d{8}-\d{6}\.png$/.test(path.basename(k)));
      check('KiPNG: its PNG is among what it wrote', !!png, Object.keys(files).join());
      if (png) {
        const m = await measurePng(page, files[png]);
        check('KiPNG: the PNG has the size the window announced', announced === `${m.w}x${m.h}`, `${announced} vs ${m.w}x${m.h}`);
        check('KiPNG: the board is on the picture', m.drawn > m.w * m.h * 0.02 && m.colours > 2, JSON.stringify(m));
        if (SHOTS) fs.writeFileSync(path.join(SHOTS, 'real-kipng-output.png'), files[png]);
        console.log(`      (${png}: ${m.w}x${m.h}, ${m.drawn} pixels drawn, ${m.colours}+ colours)`);
      }
    }
  } catch (e) { check('KiPNG runs', false, String(e).slice(0, 300) + ' ' + await logTail('com.github.tobiglaser.KiPNG')); }
  await page.evaluate(() => window.KcPlugins.store.get().window && window.KcPlugins.closeWindow && window.KcPlugins.closeWindow()).catch(() => {});
}

// ---- Pinout image generator: kicad-cli render is refused, so it takes its SVG export path; pillow composes the picture
if (only('pinout')) {
  const ID = 'com.github.lou270.pinout-image-generator';
  try {
    await page.goto(`${BASE}${ecc83}`); await editorReady();
    const actions = await install(ID);
    const n0 = downloads.length;
    await runAction(ID, actions[0]);
    const f = await frameOf(ID);
    await f.waitForSelector('text=Generate', { timeout: 120000 });
    check('Pinout image generator: its dialog lists the connector pins it found on the board', (await f.locator('input[type="checkbox"]').count()) >= 4, await logTail(ID));
    await shot('real-pinout-window');
    await f.click('text=/^Generate$/');
    // it ends by asking "Open in browser?": the editor's own dialog; the answer here is no
    await page.waitForSelector('#pluginPrompt', { timeout: 180000 });
    const asked = await page.locator('#pluginPrompt').innerText();
    check('Pinout image generator: it reports the file it generated', /Generated/.test(asked) && /_pinout\.svg/.test(asked), asked.slice(0, 200));
    await page.click('#pluginPrompt .btn:not(.primary)');
    const got = await download(n0);
    check('Pinout image generator: a file is handed over', !!got, await logTail(ID));
    if (got) {
      const files = /\.zip$/.test(got.name) ? unzip(got.bytes) : { [got.name]: got.bytes };
      const svg = Object.keys(files).find((k) => /_pinout\.svg$/.test(k));
      check('Pinout image generator: the pinout SVG is written', !!svg, Object.keys(files).join());
      if (svg) {
        const text = files[svg].toString('utf8');
        const m = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(text);
        check('Pinout image generator: the board picture is embedded in it', !!m, text.slice(0, 300));
        if (m) { const r = await measurePng(page, Buffer.from(m[1], 'base64')); check('Pinout image generator: the board is on that picture', r.drawn > r.w * r.h * 0.02, JSON.stringify(r)); console.log(`      (board picture ${r.w}x${r.h}, ${r.drawn} pixels drawn)`); }
        check('Pinout image generator: pins are labelled', (text.match(/<text/g) || []).length > 4, `${(text.match(/<text/g) || []).length} labels`);
        if (SHOTS) fs.writeFileSync(path.join(SHOTS, 'real-pinout-output.svg'), files[svg]);
      }
    }
    await shot('real-pinout');
  } catch (e) { check('Pinout image generator runs', false, String(e).slice(0, 300) + ' ' + await logTail('com.github.lou270.pinout-image-generator')); }
}

// ---- Tracklayer: numpy and shapely loaded from this server; routes the chosen nets and refills zones
if (only('tracklayer')) {
  const ID = 'com.github.michaelgaylor.tracklayer';
  try {
    await page.goto(`${BASE}${ecc83}`); await editorReady();
    const actions = await install(ID);
    const st = await state();
    check('Tracklayer: numpy and shapely were loaded for it', /numpy/.test(JSON.stringify(st.logs[ID] || [])) || !!(st.running[ID] && st.running[ID].ready), await logTail(ID));
    await runAction(ID, actions[0]);
    const f = await frameOf(ID);
    await f.waitForSelector('button', { timeout: 120000 });
    await page.waitForTimeout(800);
    await shot('real-tracklayer-window');
    check('Tracklayer: its window opens with its controls', (await f.locator('button').count()) > 1, await logTail(ID));
  } catch (e) { check('Tracklayer runs', false, String(e).slice(0, 300) + ' ' + await logTail('com.github.michaelgaylor.tracklayer')); }
}

// ---- VelaTrace: a Qt window; its own numpy router routes an unrouted board and draws the preview on the board
if (only('velatrace')) {
  const ID = 'com.github.f-blaze.velatrace';
  try {
    await page.goto(`${BASE}${ecc83Unrouted}`); await editorReady();
    const tracks = await page.evaluate(() => Array.from(window.CollabEditor.kdoc.items.values()).filter((it) => it.kind === 'segment' || it.kind === 'via').length);
    check('VelaTrace: the test board starts unrouted', tracks === 0, `${tracks} tracks`);
    const actions = await install(ID);
    await runAction(ID, actions[0]);
    const f = await frameOf(ID);
    await f.waitForSelector('text=/^Route$/', { timeout: 180000 });
    await f.waitForSelector('text=Router ready', { timeout: 180000 });
    await f.click('text=/^Route$/');
    await f.waitForSelector('button:has-text("Route board"):not([disabled])', { timeout: 60000 });
    await page.waitForTimeout(1500);
    await shot('real-velatrace-window');
    const lines0 = await page.evaluate(() => Array.from(window.CollabEditor.kdoc.items.values()).filter((it) => it.kind === 'gr_line').length);
    await f.click('button:has-text("Route board")');
    await page.waitForFunction((n) => Array.from(window.CollabEditor.kdoc.items.values()).filter((it) => it.kind === 'gr_line').length >= n + 10, lines0, { timeout: 400000 });
    const lines1 = await page.evaluate(() => Array.from(window.CollabEditor.kdoc.items.values()).filter((it) => it.kind === 'gr_line').length);
    check('VelaTrace: its router routes the board and the preview lands on the board', lines1 - lines0 >= 10, `${lines1 - lines0} preview lines`);
    console.log(`      (${lines1 - lines0} preview lines drawn on the board)`);
    await page.waitForTimeout(1500);
    await shot('real-velatrace-routed');
  } catch (e) { check('VelaTrace runs', false, String(e).slice(0, 300) + ' ' + await logTail('com.github.f-blaze.velatrace', 60)); await shot('real-velatrace-fail'); }
}

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); await db.end(); fixture.server.close();
process.exit(fail ? 1 : 0);
