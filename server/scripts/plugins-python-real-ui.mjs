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
  await page.click('#pluginManager [data-tab="catalog"]');
  await page.waitForSelector(`#pluginCatalog [data-source="kicad"][data-plugin="${id}"]`, { timeout: 30000 });
  await page.click(`#pluginCatalog [data-install="${id}"]`);
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
/** Where SpinRender's own painted controls are in its window (pixels from its top left). */
const SPIN = { format: [127, 463], gif: [52, 528], mp4: [127, 496], resolution: [422, 463], square: [285, 654], render: [335, 626] };
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

// ---- Pinout image generator: kicad-cli renders the board with the 3D viewer; pillow composes the picture
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

// ---- SpinRender: kicad-cli pcb render drawn by the editor's 3D viewer, an OpenGL preview on WebGL, ffmpeg's GIF by the browser
if (only('spinrender')) {
  const ID = 'com.alsoknownasfoo.spinrender';
  try {
    await page.goto(`${BASE}${ecc83}`); await editorReady();
    const actions = await install(ID);
    await runAction(ID, actions[0]);
    const f = await frameOf(ID);
    await f.waitForSelector('canvas', { timeout: 180000 });
    await page.waitForTimeout(Number(process.env.SPIN_WAIT || 15000));
    await shot('real-spinrender-window');
    const box = await (await page.locator(`#pluginFrames iframe[data-plugin="${ID}"]`).elementHandle()).boundingBox();
    if (process.env.VERBOSE) console.log('      frame at', JSON.stringify(box));
    // its controls are painted by the plugin itself, so they are worked by where they are in its window
    const click = async (x, y, wait = 1200) => { await page.mouse.click(box.x + x, box.y + y); await page.waitForTimeout(wait); };
    const preview = () => f.evaluate(() => { const c = document.querySelector('canvas.wx-gl'); if (!c) return null; const o = document.createElement('canvas'); o.width = c.width; o.height = c.height; const g = o.getContext('2d'); g.drawImage(c, 0, 0);
      const d = g.getImageData(0, 0, o.width, o.height).data; let lit = 0; for (let i = 0; i < d.length; i += 16) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++; return { w: c.width, h: c.height, lit, hash: Array.from(d.filter((_, i) => i % 4001 === 0)).join('') }; });
    const p1 = await preview(); await page.waitForTimeout(1500); const p2 = await preview();
    check('SpinRender: its OpenGL preview draws the board model', !!p1 && p1.lit > 500, JSON.stringify(p1 && { w: p1.w, h: p1.h, lit: p1.lit }));
    check('SpinRender: the preview turns', !!p1 && !!p2 && p1.hash !== p2.hash);
    const runs = [['GIF', 0, 0, 'gif'], ['MP4', 0, 0, 'mp4']].filter((r) => !process.env.SPIN_ONLY || r[3] === process.env.SPIN_ONLY);
    for (const [label, , , ext] of runs) {
      const n0 = downloads.length;
      await click(...SPIN.format); await click(...SPIN[ext]);
      await click(...SPIN.resolution); await click(...SPIN.square);
      if (label === runs[0][0]) await shot('real-spinrender-settings');
      await click(...SPIN.render, 6000);
      await shot('real-spinrender-rendering-' + ext);
      const got = await download(n0, 600000);
      check(`SpinRender: a ${label} is handed over`, !!got, await logTail(ID, 12));
      if (!got) continue;
      const files = /\.zip$/.test(got.name) ? unzip(got.bytes) : { [got.name]: got.bytes };
      const name = Object.keys(files).find((k) => k.endsWith('.' + ext));
      check(`SpinRender: the ${label} is among what it wrote`, !!name, Object.keys(files).join());
      if (!name) continue;
      if (SHOTS) fs.writeFileSync(path.join(SHOTS, 'real-spinrender-output.' + ext), files[name]);
      const m = await page.evaluate(async ([b, kind]) => {
        const bytes = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
        const lit = (src, w, h) => { const c = new OffscreenCanvas(w, h); const g = c.getContext('2d'); g.drawImage(src, 0, 0); const d = g.getImageData(0, 0, w, h).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 90) n++; return n / (w * h); };
        if (kind === 'gif') {
          const dec = new ImageDecoder({ data: bytes, type: 'image/gif' }); await dec.tracks.ready; await dec.completed; const t = dec.tracks.selectedTrack;
          const a = (await dec.decode({ frameIndex: 0 })).image, z = (await dec.decode({ frameIndex: Math.floor(t.frameCount / 4) })).image;
          return { frames: t.frameCount, w: a.displayWidth, h: a.displayHeight, first: lit(a, a.displayWidth, a.displayHeight), later: lit(z, z.displayWidth, z.displayHeight) };
        }
        const v = document.createElement('video'); v.muted = true; v.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
        await new Promise((ok, no) => { v.onloadeddata = ok; v.onerror = () => no(new Error('the browser could not play the MP4')); });
        const at = async (t) => { v.currentTime = t; await new Promise((ok) => { v.onseeked = ok; }); return lit(v, v.videoWidth, v.videoHeight); };
        return { seconds: v.duration, w: v.videoWidth, h: v.videoHeight, first: await at(0.05), later: await at(v.duration / 4) };
      }, [Buffer.from(files[name]).toString('base64'), ext]);
      check(`SpinRender: the ${label} is 800 x 800`, m.w === 800 && m.h === 800, JSON.stringify(m));
      if (ext === 'gif') check('SpinRender: the GIF holds every frame of the loop (10 s at 30 fps)', m.frames === 300, JSON.stringify(m));
      else check('SpinRender: the MP4 is 10 s long', Math.abs(m.seconds - 10) < 0.2, JSON.stringify(m));
      check(`SpinRender: the board is on the ${label}'s frames`, m.first > 0.05 && m.later > 0.05, JSON.stringify(m));
      console.log(`      (${name}: ${files[name].length} bytes, ${JSON.stringify(m)})`);
      await page.waitForTimeout(1500);
      await shot('real-spinrender-done-' + ext);
    }
  } catch (e) { check('SpinRender runs', false, String(e).slice(0, 300) + ' ' + await logTail('com.alsoknownasfoo.spinrender', 40)); await shot('real-spinrender-fail'); }
}

// ---- KiCad-Parasitics: the resistance between two pads, from its own network of the copper, solved by ngspice
// (the real simulator, as WebAssembly, behind the libngspice calls of its bundled ngspyce, in the child process it
// starts for it); then the loop inductance by bfieldtools.  The two pads are joined by 16.57 mm of 0.8 mm track.
if (only('Parasitics')) {
  const ID = 'com.github.Steffen-W.KiCad-Parasitics';
  try {
    await page.goto(`${BASE}${ecc83}`); await editorReady();
    const actions = await install(ID);
    // the two pads are picked as a person does: a click on R2's pad 1, then Shift and a click on U1's pad 3
    const picked = await page.evaluate(() => { const pcb = window.CollabTools.pcb, E = window.CollabEditor, ctx = E.api.toolCtx(); const ev = (shift) => ({ button: 0, shiftKey: shift, ctrlKey: false, metaKey: false }); pcb.selectPadAt(ev(false), [156.21, 95.885], ctx); pcb.selectPadAt(ev(true), [154.825, 111.885], ctx); return pcb.selectedPadKeys(); });
    check('Parasitics: Shift picks a second pad in the board editor', picked.length === 2, JSON.stringify(picked));
    if (process.env.SELDEBUG) console.log('      sel debug ' + JSON.stringify(await page.evaluate(() => { const k = window.KiCadCanvas, E = window.CollabEditor, doc = E.kdoc; return [typeof k.kids, E.api.state.document && E.api.state.document.editor, Object.keys(E.api.state.document || {}), window.CollabTools.pcb.selectedPadKeys().map((key) => { const i = key.lastIndexOf('#'); const fp = doc.items.get(key.slice(0, i)); const pad = fp && k.kids(fp.node, 'pad')[+key.slice(i + 1)]; return [key, !!fp, pad && JSON.stringify(k.kids(pad, 'uuid')).slice(0, 90)]; })]; })));
    await runAction(ID, actions[0]);
    const f = await frameOf(ID);
    const text = () => f.evaluate(() => Array.from(document.querySelectorAll('textarea, input, .wx-text, pre')).map((e) => e.value || e.textContent || '').join('\n'));
    let seen = ''; const t0 = Date.now();
    while (Date.now() - t0 < 240000) { seen = await text().catch(() => ''); if (/Shortest path resistance|No connection|ngspice|ERROR|Select exactly/i.test(seen)) break; await page.waitForTimeout(500); }
    await shot('real-parasitics');
    const dist = /Shortest distance ≈ ([\d.]+) mm/.exec(seen), res = /Shortest path resistance ≈ ([\d.]+) mΩ/.exec(seen);
    check('Parasitics: it finds the copper path between the two pads', !!dist && Math.abs(Number(dist[1]) - 16.57) < 1.5, seen.slice(0, 600) + ' ' + await logTail(ID, 12));
    // 16.57 mm x 0.8 mm x 35 um of copper is 10 mOhm
    check('Parasitics: the path resistance is the copper\'s', !!res && Number(res[1]) > 8 && Number(res[1]) < 12, seen.slice(0, 600));
    const dc = /^\s*DC\s+(\S+ ?\S*Ω)/m.exec(seen);
    check('Parasitics: ngspice solved the network (DC and AC rows)', !!dc && !/\[error\]/.test(seen) && /Hz/.test(seen) && !/could not be|unavailable/i.test(seen), seen.slice(0, 1200) + ' ' + await logTail(ID, 12));
    console.log('      ' + seen.split('\n').filter((l) => /≈|DC|Hz/.test(l)).slice(0, 9).join('\n      '));
    if (res) {
      await f.click('text=/^Inductance$/'); await page.waitForTimeout(300);
      await f.click('text=Calculate inductance');
      let ind = ''; const t1 = Date.now();
      while (Date.now() - t1 < 300000) { ind = await text().catch(() => ''); if (/Loop inductance|ERROR|could not/i.test(ind)) break; await page.waitForTimeout(1000); }
      const nh = /Loop inductance: ([\d.]+) nH/.exec(ind);
      // a 16.6 mm long, 0.8 mm wide strip closed by a straight return is of the order of 10 nH
      check('Parasitics: bfieldtools gives the loop inductance', !!nh && Number(nh[1]) > 3 && Number(nh[1]) < 30 && /Mesh: \d+ triangles/.test(ind), ind.slice(ind.indexOf('Loop'), ind.indexOf('Loop') + 500) + ' ' + await logTail(ID, 12));
      if (nh) console.log(`      (loop inductance ${nh[1]} nH)`);
      await shot('real-parasitics-inductance');
      await f.click('text=Debug plots');
      // matplotlib's own wx window: the field map is painted, so count the coloured pixels of the largest canvas
      const painted = () => f.evaluate(() => { let best = 0; for (const c of document.querySelectorAll('canvas')) { if (c.width < 300 || c.height < 300) continue; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 16) { if (d[i + 3] > 0 && Math.abs(d[i] - d[i + 2]) > 40) n++; } best = Math.max(best, n); } return best; }).catch(() => 0);
      let ink = 0; const t2 = Date.now();
      while (Date.now() - t2 < 120000) { ink = await painted(); if (ink > 2000) break; await page.waitForTimeout(1000); }
      await page.waitForTimeout(500); await shot('real-parasitics-plots');
      check('Parasitics: the debug plot (field and current map) is drawn by matplotlib', ink > 2000, `coloured samples ${ink} ` + await logTail(ID, 12));
    }
  } catch (e) { check('Parasitics runs', false, String(e).slice(0, 300) + ' ' + await logTail('com.github.Steffen-W.KiCad-Parasitics', 30)); await shot('real-parasitics-fail'); }
}

// ---- OrthoRoute: a PyQt6 window over KiCad's IPC interface; its own numpy router routes a six-layer board, and Apply to
// KiCad puts the tracks and blind vias on the board
if (only('orthoroute')) {
  const ID = 'com.github.bbenchoff.orthoroute';
  try {
    const six = await project('six-layer-unrouted', 'server/scripts/plugin-drives/boards', 'six-layer-unrouted');
    await page.goto(`${BASE}${six}`); await editorReady();
    const count = () => page.evaluate(() => { const its = Array.from(window.CollabEditor.kdoc.items.values()); return { tracks: its.filter((it) => it.kind === 'segment').length, vias: its.filter((it) => it.kind === 'via').length }; });
    const c0 = await count();
    check('OrthoRoute: the test board starts unrouted', c0.tracks === 0 && c0.vias === 0, JSON.stringify(c0));
    const actions = await install(ID);
    await runAction(ID, actions[0]);
    const f = await frameOf(ID);
    await f.waitForSelector('text=Begin Autorouting', { timeout: 240000 });
    await page.waitForTimeout(1500);
    await shot('real-orthoroute-window');
    await f.click('text=Begin Autorouting');
    await page.waitForSelector('#pluginPrompt', { timeout: 420000 });
    const routed = await page.locator('#pluginPrompt').innerText();
    check('OrthoRoute: its router converges with every net routed', /Converged/.test(routed) && /zero overuse/.test(routed), routed.slice(0, 300) + ' ' + await logTail(ID, 8));
    await page.click('#pluginPrompt .btn.primary');
    await page.waitForTimeout(1500);
    await shot('real-orthoroute-routed');
    const c1 = await count();
    check('OrthoRoute: the routes are a preview until they are applied', c1.tracks === 0, JSON.stringify(c1));
    await f.click('text=Apply to KiCad');
    await page.waitForSelector('#pluginPrompt', { timeout: 120000 });
    const applied = await page.locator('#pluginPrompt').innerText();
    await page.click('#pluginPrompt .btn.primary');
    const said = /(\d+) tracks[\s\S]*?(\d+) vias/.exec(applied) || [];
    const c2 = await count();
    check('OrthoRoute: Apply to KiCad puts the tracks and vias it reports on the board', /Successfully applied/.test(applied) && c2.tracks === +said[1] && c2.vias === +said[2] && c2.tracks >= 16, `${applied.slice(0, 200)} board: ${JSON.stringify(c2)}`);
    const inner = await page.evaluate(() => Array.from(window.CollabEditor.kdoc.items.values()).filter((it) => it.kind === 'segment' && /In\d+\.Cu/.test(JSON.stringify(it.node))).length);
    check('OrthoRoute: it routes on the inner layers', inner >= 4, `${inner} inner-layer tracks`);
    console.log(`      (${c2.tracks} tracks, ${c2.vias} vias, ${inner} on inner layers)`);
    await page.keyboard.press('Escape').catch(() => {});
    await shot('real-orthoroute-applied');
  } catch (e) { check('OrthoRoute runs', false, String(e).slice(0, 300) + ' ' + await logTail('com.github.bbenchoff.orthoroute', 30)); await shot('real-orthoroute-fail'); }
}

// ---- KiCad Routing Tools: a wx window; its Rust router (grid_router, built for the browser) routes the nets ticked on
// its Route tab and the tracks go on the board
if (only('kicadroutingtools')) {
  const ID = 'com.github.drandyhaas.kicadroutingtools';
  try {
    const six = await project('six-layer-unrouted', 'server/scripts/plugin-drives/boards', 'six-layer-unrouted');
    await page.goto(`${BASE}${six}`); await editorReady();
    const count = () => page.evaluate(() => { const its = Array.from(window.CollabEditor.kdoc.items.values()); return { tracks: its.filter((it) => it.kind === 'segment').length, vias: its.filter((it) => it.kind === 'via').length }; });
    const c0 = await count();
    check('Routing Tools: the test board starts unrouted', c0.tracks === 0 && c0.vias === 0, JSON.stringify(c0));
    const actions = await install(ID);
    await runAction(ID, actions[0]);
    const f = await frameOf(ID);
    await f.waitForSelector('text=/^Route$/', { timeout: 240000 });
    await page.waitForTimeout(1500);
    await shot('real-routingtools-window');
    if (process.env.KRT_DUMP) console.log('DUMP ' + JSON.stringify(await f.evaluate(() => Array.from(document.querySelectorAll('button, [role=tab]')).map((b) => { const r = b.getBoundingClientRect(); return [b.tagName, b.className, (b.textContent || '').trim().slice(0, 30), Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), b.disabled]; }))) + ' WIN ' + JSON.stringify(await f.evaluate(() => [innerWidth, innerHeight, document.documentElement.scrollHeight])));
    for (const net of ['SIG_A', 'SIG_B', 'SIG_C', 'SIG_D']) await f.locator('label, .wx-check-item, li', { hasText: new RegExp(`^\\s*${net}\\s*$`) }).first().locator('input[type=checkbox]').check();
    await shot('real-routingtools-picked');
    await f.locator('button', { hasText: /^Route$/ }).nth(1).click();          // the first is the tab of that name
    await page.waitForSelector('#pluginPrompt', { timeout: +(process.env.KRT_WAIT || 420000) });
    const said = await page.locator('#pluginPrompt').innerText();
    check('Routing Tools: its router reports all four nets routed', /Successfully routed: 4 nets/.test(said) && /Failed: 0/.test(said), said.slice(0, 300) + ' ' + await logTail(ID, 8));
    await shot('real-routingtools-routed');
    await page.click('#pluginPrompt .btn.primary');
    await page.waitForTimeout(1500);
    const c1 = await count();
    const added = /Added to board:\s*(\d+) segments,?\s*(\d+) vias/.exec(said) || [];
    check('Routing Tools: the tracks it reports are on the board', c1.tracks === +added[1] && c1.vias === +added[2] && c1.tracks >= 8, `${said.slice(0, 200)} board: ${JSON.stringify(c1)}`);
    console.log(`      (${c1.tracks} tracks, ${c1.vias} vias)`);
    await page.keyboard.press('Escape').catch(() => {});
    await shot('real-routingtools-applied');
  } catch (e) { check('Routing Tools runs', false, String(e).slice(0, 300) + ' ' + await logTail('com.github.drandyhaas.kicadroutingtools', 30)); await shot('real-routingtools-fail'); }
}

// ---- Board2Pdf: PLOT_CONTROLLER plots each layer of each template to a PDF with the editor's File → Plot writer; the plugin's
// own PyPDF4 recolours and merges them into one assembly document
if (only('Board2Pdf')) {
  const ID = 'com.gitlab.dennevi.Board2Pdf';
  try {
    await page.goto(`${BASE}${ecc83}`); await editorReady();
    const actions = await install(ID);
    const n0 = downloads.length;
    await runAction(ID, actions[0]);
    const f = await frameOf(ID);
    await f.waitForSelector('text=Perform', { timeout: 120000 });
    await shot('real-board2pdf-window');
    await f.click('text=/^Perform$/');
    // its message boxes are the editor's own dialog: "will now begin", then "All done!" (or what failed)
    let last = '';
    for (let i = 0; i < 12 && !/All done|failed/.test(last); i++) {
      if (i > 0 && /Traceback/.test(await logTail(ID, 40))) throw new Error("the plugin raised");
      await page.waitForSelector('#pluginPrompt', { timeout: 300000 });
      last = await page.locator('#pluginPrompt').innerText();
      if (i === 0) await shot('real-board2pdf-message');
      await page.click('#pluginPrompt .btn.primary');
      await page.waitForSelector('#pluginPrompt', { state: 'detached', timeout: 5000 }).catch(() => {});
    }
    check('Board2Pdf: it plots, recolours and merges without an error', /All done/.test(last) && /Assembly\.pdf/.test(last), last.slice(0, 400) + ' ' + await logTail(ID, 12));
    await f.click('text=/^Exit$/').catch(() => {});
    const got = await download(n0);
    check('Board2Pdf: a file is handed over', !!got, await logTail(ID));
    if (got) {
      const files = /\.zip$/.test(got.name) ? unzip(got.bytes) : { [got.name]: got.bytes };
      const name = Object.keys(files).find((k) => /-Assembly\.pdf$/.test(k));
      check('Board2Pdf: the assembly PDF is among what it wrote', !!name, Object.keys(files).join());
      if (name) {
        const pdf = files[name]; const text = pdf.toString('latin1');
        if (SHOTS) fs.writeFileSync(path.join(SHOTS, 'real-board2pdf-assembly.pdf'), pdf);
        const box = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(text);
        const W = box ? +box[3] : 0, H = box ? +box[4] : 0, PT = 72 / 25.4;
        check('Board2Pdf: two pages (top and bottom) of the board\'s A4 sheet', /\/Count 2\b/.test(text) && Math.abs(W - 297 * PT) < 0.1 && Math.abs(H - 210 * PT) < 0.1, `${W} x ${H}`);
        const pages = [];
        for (const m of text.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
          let t = ''; try { t = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { t = m[1]; }
          if (/\d [ml]\b/.test(t)) pages.push(t);
        }
        // the board's own outline, from its file: on page 1 where it is, on page 2 mirrored, in the template's grey
        const boardText = fs.readFileSync(path.join(repo, 'demos', 'ecc83', 'ecc83-pp.kicad_pcb'), 'utf8');
        const edges = [];
        for (const m of boardText.matchAll(/\(gr_line\s+\(start ([-\d.]+) ([-\d.]+)\)\s+\(end ([-\d.]+) ([-\d.]+)\)[\s\S]*?\(layer "([^"]+)"\)/g)) if (m[5] === 'Edge.Cuts') edges.push([[+m[1], +m[2]], [+m[3], +m[4]]]);
        const lines = (t) => { const out = []; let colour = '';
          for (const m of t.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) RG|([\d.]+) ([\d.]+) m\s+([\d.]+) ([\d.]+) l\s+S/g)) {
            if (m[1]) colour = [m[1], m[2], m[3]].map((v) => (+v).toFixed(2)).join(' '); else out.push({ a: [+m[4], +m[5]], b: [+m[6], +m[7]], colour });
          } return out; };
        const has = (ls, p, q, colour) => ls.some((l) => (colour === undefined || l.colour === colour)
          && [[l.a, l.b], [l.b, l.a]].some(([a, b]) => Math.abs(a[0] - p[0]) < 0.02 && Math.abs(a[1] - p[1]) < 0.02 && Math.abs(b[0] - q[0]) < 0.02 && Math.abs(b[1] - q[1]) < 0.02));
        const at = (p, mirrored) => [(mirrored ? 297 - p[0] : p[0]) * PT, H - p[1] * PT];
        const top = lines(pages[0] || ''), bottom = lines(pages[1] || ''); const grey = '0.34 0.34 0.34';
        check('Board2Pdf: page 1 holds the board outline where the board has it, in the template\'s grey', edges.length >= 4 && edges.every(([p, q]) => has(top, at(p, false), at(q, false), grey)), `${edges.length} outline lines, ${top.length} lines on the page`);
        check('Board2Pdf: page 2 holds the outline mirrored', edges.length >= 4 && edges.every(([p, q]) => has(bottom, at(p, true), at(q, true), grey) && !has(bottom, at(p, false), at(q, false))), `${bottom.length} lines on the page`);
        check('Board2Pdf: the copper is recoloured to the template\'s light grey', (pages[0] || '').split('0.94118 0.94118 0.94118 rg').length > 20, `${(pages[0] || '').length} bytes`);
        console.log(`      (${name}: ${pdf.length} bytes, ${pages.length} pages, ${top.length}+${bottom.length} stroked lines)`);
      }
    }
  } catch (e) { check('Board2Pdf runs', false, String(e).slice(0, 300) + ' ' + await logTail('com.gitlab.dennevi.Board2Pdf', 30)); await shot('real-board2pdf-fail'); }
}

// ---- kicad-git: its button is the commit window; here that is the project's Save Version dialog, and a version is saved
if (only('kicad-git')) {
  const ID = 'com.github.adamws.kicad-git';
  try {
    await page.goto(`${BASE}${ecc83}`); await editorReady();
    const pid = ecc83.split('/')[2];
    const timeline = async () => page.evaluate(async (p) => (await (await fetch(`/api/projects/${p}/timeline`)).json()).versions || [], pid);
    const before = await timeline();
    const actions = await install(ID);
    check('kicad-git: it adds its one toolbar command', actions.length === 1 && actions[0].name === 'Git Plugin', JSON.stringify(actions));
    await runAction(ID, actions[0]);
    await page.waitForSelector('[data-version-dialog] #versionName', { timeout: 60000 });
    check('kicad-git: its button opens the Save Version dialog', true);
    await shot('real-kicad-git-dialog');
    const name = `From the git plugin ${Date.now() % 100000}`;
    await page.fill('#versionName', name); await page.fill('#versionNote', 'Saved through the plugin\'s button');
    await page.click('[data-version-dialog] button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('[data-version-dialog]'), null, { timeout: 30000 });
    let after = []; for (let i = 0; i < 40 && !(after = await timeline()).some((v) => v.name === name); i++) await page.waitForTimeout(250);
    const saved = after.find((v) => v.name === name);
    check('kicad-git: the version is in the project\'s history, with its note', !!saved && saved.description === 'Saved through the plugin\'s button' && after.length === before.length + 1, `${before.length} before, ${after.length} after`);
    check('kicad-git: no error window from the plugin', !(await state()).prompt && !/Could not|Traceback/.test(await logTail(ID, 12)), await logTail(ID, 12));
  } catch (e) { check('kicad-git runs', false, String(e).slice(0, 300) + ' ' + await logTail('com.github.adamws.kicad-git', 12)); await shot('real-kicad-git-fail'); }
}

// ---- Localize Dependencies: KiCad's own symbol libraries and footprints copied into the project, the sheets and the
// board pointed at the copies.  The server must serve the libraries (KC_LIBS_SYMBOLS_URL / KC_LIBS_FOOTPRINTS_URL may
// name local folders laid out like the official repositories, for a machine that cannot download them).
if (only('localize')) {
  const ID = 'com.github.jOaSbA.localize-dependencies';
  try {
    const dir = path.join(repo, 'demos/openair-max');
    const pid = (await db.query(`INSERT INTO projects (owner_id, name) VALUES ($1, $2) RETURNING id`, [dana, 'openair-localize'])).rows[0].id; const docs = {};
    for (const [file, type] of [['One-Air-Max.kicad_pcb', 'kicad_pcb'], ['One-Air-Max.kicad_sch', 'kicad_sch'], ['Battery-Holder.kicad_sch', 'kicad_sch'], ['Solar-Module.kicad_sch', 'kicad_sch'], ['One-Air-Max.kicad_pro', 'kicad_pro']]) {
      const doc = (await db.query(`INSERT INTO documents (project_id, path, doc_type) VALUES ($1, $2, $3) RETURNING id`, [pid, file, type])).rows[0].id;
      await db.query('INSERT INTO snapshots (doc_id, seq, content) VALUES ($1, 0, $2)', [doc, fs.readFileSync(path.join(dir, file))]); docs[file] = doc;
    }
    const sheetsBefore = Object.fromEntries(['One-Air-Max.kicad_sch', 'Battery-Holder.kicad_sch', 'Solar-Module.kicad_sch'].map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
    const STD = ['Connector', 'Device', 'Jumper', 'Transistor_FET', 'power'];
    const ids = (t) => [...t.matchAll(/\(lib_id "([^":]+):([^"]+)"\)/g)].map((m) => `${m[1]}:${m[2]}`);
    await page.goto(`${BASE}/p/${pid}/edit?doc=${docs['One-Air-Max.kicad_pcb']}`); await editorReady();
    const fpids = () => page.evaluate(() => { const out = {}; for (const [id, it] of window.CollabEditor.kdoc.items) { if (it.kind === 'footprint' || (it.node && String(it.node[0]) === 'footprint')) out[id] = String((it.node || [])[1]); } return out; });
    const fpBefore = await fpids();
    const actions = await install(ID);
    await runAction(ID, actions[0]);
    const f = await frameOf(ID);
    await f.waitForSelector('text=Also include standard KiCad libraries', { timeout: 180000 });
    const rowsShown = await f.locator('text=standard').count();
    check('Localize Dependencies: its window lists the project\'s parts, with those from KiCad\'s libraries marked standard', rowsShown > 20, `${rowsShown} rows say standard`);
    const boxes = await f.locator('.wx-table td input[type=checkbox]').count();
    const fits = await f.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Localize'); const t = document.querySelector('.wx-table'); const r = b && b.getBoundingClientRect(); return !!r && r.bottom <= window.innerHeight && r.top >= 0 && !!t && t.scrollHeight > t.clientHeight; });
    check('Localize Dependencies: each row has its tick box, and the long list scrolls inside the window with the buttons in view', boxes > 100 && fits, `${boxes} boxes, fits ${fits}`);
    await shot('real-localize-window');
    await f.click('text=Also include standard KiCad libraries');
    await f.getByRole('button', { name: 'Localize', exact: true }).click();
    // the plugin's own questions and the editor's (add the libraries, change each sheet) are answered yes, in the order they come
    const asked = []; let done = '';
    for (let i = 0; i < 12; i++) {
      const up = await page.waitForSelector('#pluginPrompt', { timeout: i < 2 ? 240000 : 25000 }).catch(() => null); if (!up) break;
      const text = await page.locator('#pluginPrompt').innerText(); asked.push(text.split('\n')[0].slice(0, 60));
      if (/Localized:/.test(text)) done = text;
      await shot(`real-localize-ask-${i}`);
      await page.click('#pluginPrompt .btn.primary');
      await page.waitForFunction((t) => { const e = document.querySelector('#pluginPrompt'); return !e || e.innerText !== t; }, text, { timeout: 60000 }).catch(() => {});
      if (/Localized:/.test(text)) { const g = await frameOf(ID); await g.getByRole('button', { name: 'Close', exact: true }).click().catch(() => {}); }
    }
    check('Localize Dependencies: it reports what it localized', /Symbols: 5 libraries, 193 references/.test(done) && /Footprints: 2 libraries, 2 files, 7 references/.test(done), done.replace(/\n/g, ' ').slice(0, 300) + ' || asked: ' + asked.join(' | '));
    check('Localize Dependencies: the editor asks before adding the libraries and before changing each sheet', asked.some((a) => /Add to the project's libraries/.test(a)) && asked.filter((a) => /Change the schematic/.test(a)).length === 3, asked.join(' | '));
    await page.waitForTimeout(2500);
    const proj = await page.evaluate(async (p) => (await (await fetch(`/api/projects/${p}`)).json()), pid);
    const docList = (proj.docs || proj.documents || []); const byPath = Object.fromEntries(docList.map((d) => [d.path, d.docId || d.id]));
    const text = async (p) => (byPath[p] ? page.evaluate(async (d) => (await fetch(`/api/docs/${d}/content`)).text(), byPath[p]) : '');
    const missing = STD.map((l) => `libs/${l}_local.kicad_sym`).concat(['libs/Jumper_local.pretty/SolderJumper-3_P1.3mm_Bridged12_RoundedPad1.0x1.5mm.kicad_mod', 'libs/TestPoint_local.pretty/TestPoint_Pad_D1.5mm.kicad_mod']).filter((p) => !byPath[p]);
    check('Localize Dependencies: the copied libraries are documents of the project', missing.length === 0, `missing ${missing.join(', ')}; have ${Object.keys(byPath).join(', ')}`);
    const power = await text('libs/power_local.kicad_sym');
    check('Localize Dependencies: the copy of the power library is the whole library', power.startsWith('(kicad_symbol_lib') && (power.match(/^\t\(symbol "/gm) || []).length > 100 && power.includes('(symbol "GND"'), `${power.length} bytes, ${(power.match(/^\t\(symbol "/gm) || []).length} symbols`);
    let sheetsOk = true, detail = '';
    for (const [name, was] of Object.entries(sheetsBefore)) {
      const now = await text(name); const want = ids(was).map((x) => { const [l, n] = [x.slice(0, x.indexOf(':')), x.slice(x.indexOf(':') + 1)]; return STD.includes(l) ? `${l}_local:${n}` : x; });
      const have = ids(now);
      if (JSON.stringify(want) !== JSON.stringify(have)) { sheetsOk = false; detail += `${name}: ${have.filter((x) => /_local:/.test(x)).length} of ${want.filter((x) => /_local:/.test(x)).length} repointed; `; }
    }
    check('Localize Dependencies: every symbol of the three sheets that came from those libraries now names the copy', sheetsOk, detail);
    const symTable = await text('sym-lib-table'), fpTable = await text('fp-lib-table');
    check('Localize Dependencies: the project\'s library tables list the copies', STD.every((l) => symTable.includes(`${l}_local`)) && fpTable.includes('Jumper_local') && fpTable.includes('TestPoint_local'), `${symTable.slice(0, 200)} || ${fpTable.slice(0, 200)}`);
    const fpAfter = await fpids(); const changed = Object.keys(fpBefore).filter((k) => fpBefore[k] !== fpAfter[k]);
    check('Localize Dependencies: the seven footprints of the open board name the copies, and no other footprint changed', changed.length === 7 && changed.every((k) => fpAfter[k] === fpBefore[k].replace(':', '_local:')), `${changed.length} changed: ${changed.slice(0, 3).map((k) => `${fpBefore[k]} -> ${fpAfter[k]}`).join(', ')}`);
    check('Localize Dependencies: nothing was handed over as a download instead', downloads.length === 0 || !downloads.some((d) => /lib-table|kicad_sym|kicad_sch/.test(d.suggestedFilename())), downloads.map((d) => d.suggestedFilename()).join());
    await shot('real-localize-done');
  } catch (e) { check('Localize Dependencies runs', false, String(e).slice(0, 400) + ' ' + await logTail('com.github.jOaSbA.localize-dependencies', 12)); await shot('real-localize-fail'); }
}

if (only('traces')) {
  // traces talks to its own server on the user's computer (127.0.0.1:8000).  It is the one plugin allowed to, after
  // the user agrees; the request goes from this page straight to that port, never through Junction's server.
  const ID = 'com.github.usetraces.traces';
  const seen = [];
  const http = await import('node:http');
  const standIn = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      seen.push(`${req.method} ${req.url}${body ? ' ' + body : ''}`);
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
      const json = (o) => { res.writeHead(200, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/health') return json({ status: 'ok' });
      if (req.url === '/jobs/jlcpcb/search' || req.url === '/jobs/jlcpcb/source') return json({ job_id: 'job-7' });
      if (req.url === '/jobs/job-7') return json({ status: 'complete', result: { candidates: [{ part_number: 'C25744', name: 'Stand-in 10k 0402 resistor', manufacturer: 'UNI-ROYAL', price: 0.0011, qty: 4200 }] } });
      res.writeHead(404, cors); res.end('{}');
    });
  });
  await new Promise((ok) => standIn.listen(8000, '127.0.0.1', ok));
  try {
    await page.goto(`${BASE}${ecc83}`); await editorReady();
    const actions = await install(ID);
    await runAction(ID, actions[0]);
    const up = await page.waitForSelector('#pluginPrompt', { timeout: 120000 });
    const ask = await page.locator('#pluginPrompt').innerText();
    check('traces: the user is asked before it reaches its server on this computer', /Reach a server on this computer\?/.test(ask) && /127\.0\.0\.1:8000/.test(ask) && seen.length === 0, ask.slice(0, 200) + ' seen ' + seen.join(','));
    await shot('real-traces-ask');
    await page.click('#pluginPrompt .btn.primary');
    const f = await frameOf(ID);
    await f.waitForSelector('text=Select a component', { timeout: 120000 });
    await page.waitForTimeout(1500);
    check('traces: after Allow it reaches the stand-in server from the page, and its window opens without the "could not reach" message', seen.some((x) => x.startsWith('GET /health')) && !(await page.locator('#pluginPrompt').count()), seen.join(' | ') + ' ' + await logTail(ID));
    await shot('real-traces-window');
    await f.locator('text=680nF').first().click();
    await page.waitForTimeout(800);
    const sup = f.locator('select').filter({ has: f.locator('option', { hasText: 'LCSC' }) }).last();
    await sup.selectOption({ label: 'LCSC' }); await page.waitForTimeout(400);
    await f.getByRole('button', { name: 'Source', exact: true }).click();
    const t0 = Date.now(); while (!seen.some((x) => x.startsWith('GET /jobs/job-7')) && Date.now() - t0 < 30000) await page.waitForTimeout(300);
    await page.waitForTimeout(1500);
    const post = seen.find((x) => x.startsWith('POST /jobs/jlcpcb/')) || '';
    const shown = await f.locator('text=Stand-in 10k 0402 resistor').count();
    check('traces: Source sends the part to its server as JSON, follows the job, and shows the part it found', /"description":\s*"680nF"/.test(post) && /"footprint":\s*"[^"]*C_Disc_D4\.7mm/.test(post) && seen.some((x) => x.startsWith('GET /jobs/job-7')) && shown > 0, `shown ${shown}; ` + seen.join(' | ').slice(0, 600) + ' ' + await logTail(ID, 8));
    await shot('real-traces-sourced');
    const g = await frameOf(ID);
    await g.getByRole('button', { name: 'Apply to selected', exact: true }).click();
    await page.waitForTimeout(1500);
    await shot('real-traces-after-apply');
    // the plugin saves the sheet as it goes; the editor takes the rewritten sheet when its window closes
    await (await frameOf(ID)).getByRole('button', { name: 'Close', exact: true }).last().click();
    const asked = [];
    for (let i = 0; i < 4; i++) {
      const up = await page.waitForSelector('#pluginPrompt', { timeout: 20000 }).catch(() => null); if (!up) break;
      const text = await page.locator('#pluginPrompt').innerText(); asked.push(text.split('\n').slice(0, 2).join(' ').slice(0, 120));
      await page.click('#pluginPrompt .btn.primary');
      await page.waitForFunction((t) => { const e = document.querySelector('#pluginPrompt'); return !e || e.innerText !== t; }, text, { timeout: 30000 }).catch(() => {});
    }
    await page.waitForTimeout(3000);
    const pid = ecc83.split('/')[2];
    const proj = await page.evaluate(async (p) => (await (await fetch(`/api/projects/${p}`)).json()), pid);
    const sch = (proj.docs || proj.documents || []).find((d) => /\.kicad_sch$/.test(d.path));
    const text = sch ? await page.evaluate(async (d) => (await fetch(`/api/docs/${d}/content`)).text(), sch.docId || sch.id) : '';
    const c2 = text.slice(text.indexOf('"C2"') - 3000, text.indexOf('"C2"') + 3000);
    check('traces: Apply to selected writes the found part into C2 of the schematic', /C25744/.test(text) && /C25744/.test(c2), `asked: ${asked.join(' | ')}; C25744 in schematic: ${/C25744/.test(text)} ` + await logTail(ID, 6));
    await shot('real-traces-applied');
  } catch (e) { check('traces runs', false, String(e).slice(0, 400) + ' ' + await logTail(ID, 12)); await shot('real-traces-fail'); }
  standIn.close();
}

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);

await browser.close(); await db.end(); fixture.server.close();
process.exit(fail ? 1 : 0);
