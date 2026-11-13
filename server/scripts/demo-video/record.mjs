// Records the footage of the demo video from the real application: a local server, real browsers,
// the real MCP endpoint.  Nothing is drawn by this script; it clicks, drags and calls tools, and keeps
// photographs of what the browser painted (lib.mjs record()).
//
//   node record.mjs [scene ...]        scenes: ai-schematic ai-board viewer3d together autoroute fab (default: all)
//
// Server as for the other browser tests (KC_DEV_LOGIN=1, a throwaway database, the library mirror);
// README.md beside this file has the commands.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { BASE, PG_URL, mintJwt, mcp, upload, share, record, sleep, POINTER } from './lib.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT || path.join(here, 'out');
const STATE = path.join(OUT, 'state.json');
fs.mkdirSync(OUT, { recursive: true });
const all = ['ai-schematic', 'ai-board', 'viewer3d', 'together', 'autoroute', 'fab'];
const want = process.argv.slice(2).length ? process.argv.slice(2) : all;
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1));

pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
const mkUser = async (ghId, login, name) => (await db.query(
  `INSERT INTO users (github_id, login, name) VALUES ($1, $2, $3) ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login, name = EXCLUDED.name RETURNING id`, [ghId, login, name])).rows[0].id;
const adaId = await mkUser(-7701, 'ada', 'Ada'), benId = await mkUser(-7702, 'ben', 'Ben');
const ada = mintJwt(adaId, 'ada'), ben = mintJwt(benId, 'ben');

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const FULL = { width: 1600, height: 900 }, HALF = { width: 944, height: 800 };
async function open(jwt, projectId, docId, viewport = FULL) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: 'dark', acceptDownloads: true });
  await ctx.addInitScript(POINTER);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  page error:', String(e).slice(0, 200)));
  await page.goto(`${BASE}/auth/dev?jwt=${jwt}&next=${encodeURIComponent(`/p/${projectId}/edit?doc=${docId}`)}`);
  await page.waitForFunction(() => window.CollabEditor && window.CollabEditor.kdoc && window.CollabEditor.ws && window.CollabEditor.ws.readyState === 1, null, { timeout: 60000 });
  await sleep(1200);
  return page;
}
const docs = async (jwt, projectId) => (await (await fetch(`${BASE}/api/projects/${projectId}`, { headers: { Authorization: `Bearer ${jwt}` } })).json()).docs;
const docOf = async (jwt, projectId, type) => (await docs(jwt, projectId)).find((d) => d.docType === type).docId;
// Wheel zoom the way a person does it: pointer on the spot, a few notches.
async function zoom(page, at, notches) {
  await page.mouse.move(at[0], at[1]);
  for (let i = 0; i < Math.abs(notches); i++) { await page.mouse.wheel(0, notches > 0 ? -120 : 120); await sleep(90); }
  await sleep(300);
}
// Where a design item is on the screen (the editor's own transform), to aim real mouse events at it.
const screenOf = (page, ref) => page.evaluate((ref) => {
  const E = window.CollabEditor, m0 = E.api.worldMm({ clientX: 0, clientY: 0 }), m1 = E.api.worldMm({ clientX: 1000, clientY: 1000 });
  for (const it of E.kdoc.items.values()) if (it.ref === ref && it.bbox) {
    const mx = typeof it.x === 'number' ? it.x : (it.bbox[0] + it.bbox[2]) / 2, my = typeof it.y === 'number' ? it.y : (it.bbox[1] + it.bbox[3]) / 2;   // a symbol's origin is on its body
    return [((mx - m0[0]) / (m1[0] - m0[0])) * 1000, ((my - m0[1]) / (m1[1] - m0[1])) * 1000];
  }
  return null;
}, ref);
const count = (page, kinds) => page.evaluate((kinds) => { let n = 0; for (const it of window.CollabEditor.kdoc.items.values()) if (kinds.includes(it.kind)) n++; return n; }, kinds);
async function run(jwt, project, file, title) {
  const t = Date.now();
  let r = await mcp(jwt, 'run_python', { project, code: fs.readFileSync(path.join(here, 'design', file), 'utf8'), title, live: true, timeout_s: 400 });
  while (r.data && r.data.running) r = await mcp(jwt, 'get_run', { run_id: r.data.run_id });
  if (r.isError || !r.data || !r.data.ok) throw new Error(`${file}: ${r.text.slice(0, 600)}`);
  return { seconds: +((Date.now() - t) / 1000).toFixed(1), calls: r.data.calls, output: r.data.output, notes: r.data.notes };
}
// Open a menu the way a person does: move to it, click, move to the entry.  Returns where the pointer ended.
async function menu(rec, page, from, name, entry, sub) {
  const btn = page.locator(`#kmenus [data-menu="${name}"] > button`); const bb = await btn.boundingBox(); let at = [bb.x + bb.width / 2, bb.y + bb.height / 2];
  await rec.glide(page, from, at, 600); await btn.click(); await rec.hold(500);
  for (const [text, last] of [[sub, false], [entry, true]]) {
    if (!text) continue;
    const it = page.locator(`#kmenus [data-menu="${name}"] .dd`).locator(`text=${text}`).first(); await it.waitFor({ timeout: 10000 }); const ib = await it.boundingBox(); const to = [ib.x + 40, ib.y + ib.height / 2];
    await rec.glide(page, at, to, 400); at = to; await rec.hold(300);
    if (last) await it.click(); else await it.hover();
  }
  return at;
}
const scene = async (name, fn) => { if (!want.includes(name)) return; console.log(`== ${name}`); const info = await fn(path.join(OUT, name)); state[name] = info; save(); console.log(JSON.stringify(info).slice(0, 900)); };

// ---------------------------------------------------------------- the AI draws the schematic through MCP
await scene('ai-schematic', async (dir) => {
  await db.query('DELETE FROM projects WHERE owner_id = $1', [adaId]);
  const p = await mcp(ada, 'create_project', { name: 'esp32-battery-devboard' });
  state.project = p.data.project_id; save();
  const page = await open(ada, state.project, await docOf(ada, state.project, 'kicad_sch'));
  // The script ends by sizing the page to the drawing, which starts at the page's top left corner: zoom out
  // around that corner so the drawing stays in view while it grows, and press Home (zoom to fit) at the end.
  const corner = await page.evaluate(() => { const E = window.CollabEditor, m0 = E.api.worldMm({ clientX: 0, clientY: 0 }), m1 = E.api.worldMm({ clientX: 1000, clientY: 1000 }); return [((0 - m0[0]) / (m1[0] - m0[0])) * 1000, ((0 - m0[1]) / (m1[1] - m0[1])) * 1000]; });
  await zoom(page, [corner[0] + 4, corner[1] + 4], -2);
  const rec = await record(page, dir);
  await rec.wait(800); rec.mark('call');
  const result = await rec.until(run(ada, state.project, 'design.py', 'ESP32-C3 battery devboard schematic'));
  rec.mark('done'); await rec.wait(1200);
  await page.mouse.move(950, 470); await page.keyboard.press('Home'); rec.mark('fit'); await rec.wait(3000);
  const r = await rec.stop(); await page.context().close();
  return { ...r, result };
});

// ---------------------------------------------------------------- then places and routes the board
await scene('ai-board', async (dir) => {
  const page = await open(ada, state.project, await docOf(ada, state.project, 'kicad_pcb'));
  await zoom(page, [698, 392], 8);
  const rec = await record(page, dir);
  await rec.wait(800); rec.mark('call');
  const result = await rec.until(run(ada, state.project, 'board.py', 'Place and route the board'));
  rec.mark('done'); await rec.wait(2500);
  const r = await rec.stop(); await page.context().close();
  return { ...r, result };
});

// ---------------------------------------------------------------- the board in the 3D viewer
await scene('viewer3d', async (dir) => {
  const page = await open(ada, state.project, await docOf(ada, state.project, 'kicad_pcb'));
  await zoom(page, [698, 392], 8);
  const rec = await record(page, dir);
  await rec.hold(500);
  const at = await menu(rec, page, [698, 392], 'view', '3D Viewer'); rec.mark('open');
  await rec.wait(14000); rec.mark('loaded');          // real STEP models are fetched and tessellated; real time
  const box = await page.evaluate(() => { const cs = [...document.querySelectorAll('canvas')].filter((c) => c.getBoundingClientRect().width > 200); const c = cs[cs.length - 1].getBoundingClientRect(); return [c.left, c.top, c.width, c.height]; });
  const cx = box[0] + box[2] / 2, cy = box[1] + box[3] / 2;
  await rec.glide(page, at, [cx - 160, cy], 500); await page.mouse.down();
  await rec.glide(page, [cx - 160, cy], [cx + 180, cy + 80], 2800); await page.mouse.up(); await rec.hold(400);
  await page.mouse.down(); await rec.glide(page, [cx + 180, cy + 80], [cx - 60, cy - 70], 2800); await page.mouse.up(); await rec.hold(1200);
  rec.mark('turned');
  const r = await rec.stop(); await page.context().close();
  return { ...r, canvas: box };
});

// ---------------------------------------------------------------- two people in one schematic
await scene('together', async (dir) => {
  await share(ada, state.project, ben);
  const sch = await docOf(ada, state.project, 'kicad_sch');
  const a = await open(ada, state.project, sch, HALF), b = await open(ben, state.project, sch, HALF);
  // each closes the side panels with their own close buttons, for a larger drawing in a half-width window
  for (const p of [a, b]) { for (let i = 0; i < 6; i++) { const x = p.locator('button.kx:visible').first(); if (!(await x.count())) break; await x.click(); await sleep(150); } await p.mouse.move(470, 420); await p.keyboard.press('Home'); await sleep(400); await zoom(p, [470, 420], 3); }
  const rec = await record([a, b], [path.join(dir, 'ada'), path.join(dir, 'ben')]);
  const info = { script: [] }; const pos = new Map([[a, [470, 420]], [b, [470, 420]]]);
  const to = async (page, at, ms) => { await rec.glide(page, pos.get(page), at, ms); pos.set(page, at); };
  const drag = async (page, ref, dx, dy, who) => {
    const at = await screenOf(page, ref); if (!at) { info.script.push(`${who}: ${ref} not found`); return; }
    await to(page, at, 700); await page.mouse.down(); await to(page, [at[0] + dx, at[1] + dy], 1300); await rec.hold(200); await page.mouse.up(); await rec.hold(500);
    info.script.push(`${who} moved ${ref}`);
  };
  await rec.hold(600);
  await drag(a, 'U3', 70, -50, 'Ada');
  await drag(b, 'U5', -40, 50, 'Ben');
  await drag(a, 'J4', 60, 30, 'Ada');
  await drag(b, 'U4', 50, 40, 'Ben');
  await rec.hold(1200);
  const r = await rec.stop();
  await a.context().close(); await b.context().close();
  return { ...r, ...info };
});

// ---------------------------------------------------------------- the autorouter on a board with its tracks taken off
await scene('autoroute', async (dir) => {
  require(path.join(here, '..', '..', 'static', 'kicad-canvas.js')); const K = globalThis.KiCadCanvas;
  const BOARD = path.join(here, '..', '..', '..', 'demos', 'pic_programmer', 'pic_programmer.kicad_pcb');
  const tree = K.parse(fs.readFileSync(BOARD, 'utf8'));
  const stripped = tree.filter((n) => !(Array.isArray(n) && (n[0] === 'segment' || n[0] === 'via' || n[0] === 'arc')));
  await db.query(`DELETE FROM projects WHERE owner_id = $1 AND name = 'pic-programmer'`, [adaId]);
  const project = await upload(ada, 'pic-programmer', [['pic_programmer.kicad_pcb', K.serialize(stripped)], ['pic_programmer.kicad_pro', fs.readFileSync(BOARD.replace(/\.kicad_pcb$/, '.kicad_pro'), 'utf8')]]);
  const page = await open(ada, project.projectId, project.docs.find((d) => d.docType === 'kicad_pcb').docId);
  await zoom(page, [780, 480], 1);
  const before = { connections: await page.evaluate(() => window.PcbTools.ratsnest(window.CollabEditor.kdoc).length), removed: tree.length - stripped.length };
  const rec = await record(page, dir);
  await rec.hold(500);
  const at = await menu(rec, page, [780, 460], 'route', '/^Autoroute/');
  await page.waitForSelector('.kd-dialog'); await rec.hold(1800); rec.mark('dialog');
  const ok = await page.locator('.kd-foot .btn.primary').boundingBox();
  await rec.glide(page, at, [ok.x + ok.width / 2, ok.y + ok.height / 2], 600); await rec.hold(200);
  await page.click('.kd-foot .btn.primary'); rec.mark('start');
  await rec.until(page.waitForFunction(() => { let n = 0; for (const it of window.CollabEditor.kdoc.items.values()) if (it.kind === 'segment') n++; const t = document.querySelector('.kd-title span'); return n > 0 && !(t && /Autorouting/.test(t.textContent)); }, null, { timeout: 400000 }));
  rec.mark('finished'); await rec.wait(2000);
  const report = await page.locator('.kd-body').first().textContent().catch(() => '');
  if (await page.locator('.kd-foot .btn.primary').count()) await page.click('.kd-foot .btn.primary');
  await rec.wait(2000);
  const r = await rec.stop();
  const after = { tracks: await count(page, ['segment']), vias: await count(page, ['via']), left: await page.evaluate(() => window.PcbTools.ratsnest(window.CollabEditor.kdoc).length) };
  await page.context().close();
  return { ...r, before, after, report: (report || '').replace(/\s+/g, ' ').slice(0, 400) };
});

// ---------------------------------------------------------------- fabrication outputs
await scene('fab', async (dir) => {
  const page = await open(ada, state.project, await docOf(ada, state.project, 'kicad_pcb'));
  await zoom(page, [698, 392], 8);
  const rec = await record(page, dir);
  await rec.hold(400);
  const at = await menu(rec, page, [698, 392], 'file', '/^Fabrication Package/', 'Fabrication Outputs');
  await page.waitForSelector('.kd-dialog'); await rec.wait(4000); rec.mark('dialog');
  const ok = await page.locator('.kd-foot .btn.primary').boundingBox();
  await rec.glide(page, at, [ok.x + ok.width / 2, ok.y + ok.height / 2], 700); await rec.hold(200);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('.kd-foot .btn.primary')]);
  rec.mark('downloaded'); await rec.wait(1500);
  const r = await rec.stop(); const name = dl.suggestedFilename();
  await page.context().close();
  return { ...r, download: name };
});

await browser.close(); await db.end();
