// Records the footage of the Pico video from the real application, after build-pico.mjs and prepare.mjs:
//
//   schematic  Ada and Ben draw the schematic together, each in their own browser, each block by
//              the person it belongs to.  Every item goes in through the editor's own commit, one
//              at a time, with that person's mouse on it, so each sees the other's cursor and work
//              arrive live.  The crystal block is left for the next scene.
//   ai         Ben asks an AI app for the crystal; the app's run_python call (through an access key
//              named "Claude") adds it item by item, live, with its own cursor.
//   route      They route the board: each track goes in as the person's mouse runs along it.
//   finish     The planes go back in and are filled, and the 3D viewer opens.
//
// The design itself is the one build-pico.mjs drew; this script puts it back together in view.
//   node record-pico.mjs [scene ...]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { BASE, PG_URL, mintJwt, mcp, share, record, sleep, POINTER, FPS } from './lib.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT || path.join(here, 'out');
const STATE = path.join(OUT, 'state.json');
const all = ['schematic', 'ai', 'route', 'finish'];
const want = process.argv.slice(2).length ? process.argv.slice(2) : all;
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
const I = JSON.parse(fs.readFileSync(path.join(OUT, 'pico-items.json'), 'utf8'));
const project = I.project;

pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
const mkUser = async (ghId, login, name) => (await db.query(
  `INSERT INTO users (github_id, login, name) VALUES ($1, $2, $3) ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login, name = EXCLUDED.name RETURNING id`, [ghId, login, name])).rows[0].id;
const adaId = await mkUser(-7701, 'ada', 'Ada'), benId = await mkUser(-7702, 'ben', 'Ben');
const ada = mintJwt(adaId, 'ada'), ben = mintJwt(benId, 'ben');
const docs = (await (await fetch(`${BASE}/api/projects/${project}`, { headers: { Authorization: `Bearer ${ada}` } })).json()).docs;
const docOf = (type) => docs.find((d) => d.docType === type).docId;
await share(ada, project, ben);

// One browser for each person, as on two computers.  WebGL by software (for the 3D viewer), but not
// --ignore-gpu-blocklist: with it the 2D canvases are composited through the software GPU too, and a page
// taking a stream of remote edits then stops painting for many seconds.
const launch = () => chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const browsers = { [ada]: await launch(), [ben]: await launch() };
const HALF = { width: 944, height: 800 }, FULL = { width: 1600, height: 900 };
async function open(jwt, docId, viewport = HALF) {
  const ctx = await browsers[jwt].newContext({ viewport, deviceScaleFactor: 1, colorScheme: 'dark' });
  await ctx.addInitScript(POINTER);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  page error:', String(e).slice(0, 200)));
  await page.goto(`${BASE}/auth/dev?jwt=${jwt}&next=${encodeURIComponent(`/p/${project}/edit?doc=${docId}`)}`);
  await page.waitForFunction(() => window.CollabEditor && window.CollabEditor.kdoc && window.CollabEditor.ws && window.CollabEditor.ws.readyState === 1, null, { timeout: 60000 });
  // No project-card thumbnails from these windows: encoding one takes a software-rendered headless page many
  // seconds, during which it paints nothing (a normal browser does it in a moment).
  await page.evaluate(() => { window.KiCadCanvas.renderPng = () => new Promise(() => {}); });
  await sleep(1200);
  return page;
}
// side panels closed with their own close buttons, for a larger drawing in a half-width window
async function clearPanels(page) { for (let i = 0; i < 8; i++) { const x = page.locator('button.kx:visible').first(); if (!(await x.count())) break; await x.click(); await sleep(150); } }
// Zoom so that the box [x0, y0, x1, y1] (mm) fills the drawing: the editor's own fit, then wheel notches at the box's centre.
async function frame(page, box) {
  await page.mouse.move(470, 420); await page.keyboard.press('Home'); await sleep(500);
  for (let i = 0; i < 12; i++) {
    const m = await mapOf(page); const a = m.to([box[0], box[1]]), b = m.to([box[2], box[3]]);
    const vw = await page.evaluate(() => { const c = [...document.querySelectorAll('canvas')].sort((p, q) => q.width * q.height - p.width * p.height)[0].getBoundingClientRect(); return [c.left, c.top, c.right, c.bottom]; });
    if ((b[0] - a[0]) * 1.25 > vw[2] - vw[0] || (b[1] - a[1]) * 1.25 > vw[3] - vw[1]) break;
    await page.mouse.move((a[0] + b[0]) / 2, (a[1] + b[1]) / 2); await page.mouse.wheel(0, -120); await sleep(250);
  }
  await sleep(400);
}
// world (mm) to screen, from the editor's own inverse (worldMm); the view does not move while an actor works
async function mapOf(page) {
  const [m0, m1] = await page.evaluate(() => { const E = window.CollabEditor; return [E.api.worldMm({ clientX: 0, clientY: 0 }), E.api.worldMm({ clientX: 1000, clientY: 1000 })]; });
  const sx = 1000 / (m1[0] - m0[0]), sy = 1000 / (m1[1] - m0[1]);
  return { to: (p) => [(p[0] - m0[0]) * sx, (p[1] - m0[1]) * sy] };
}
const commit = (page, changes, label) => page.evaluate(([c, l]) => window.CollabEditor.api.commitChanges(c, l), [changes, label]);
const settled = (page) => page.waitForFunction(() => window.CollabEditor.pendingOps.size === 0, null, { timeout: 60000 });

// ---- an actor: one person's mouse working through a list of steps, one photograph per frame for everybody.
// A step is { path: [screen points], commit: [changes] }: the mouse goes to the first point, runs along the
// rest, and the change goes in when it gets there.
function actor(page, steps, start) {
  return { page, steps: steps.slice(), cur: null, pos: start, done: 0 };
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
async function advance(A) {
  if (!A.cur) {
    const s = A.steps.shift(); if (!s) return false;
    const pts = [A.pos, ...s.path]; const legs = []; let total = 0;
    for (let i = 1; i < pts.length; i++) { const l = dist(pts[i - 1], pts[i]); legs.push(l); total += l; }
    const approach = legs[0], along = total - approach;
    const frames = Math.max(3, Math.min(s.max || 14, Math.round(approach / (s.speed || 45)))) + (along > 1 ? Math.max(2, Math.min(s.alongMax || 12, Math.round(along / (s.alongPx || 30)))) : 0);
    A.cur = { s, pts, legs, total, frames, f: 0 };
  }
  const c = A.cur; c.f++;
  const k = c.f / c.frames, e = k * k * (3 - 2 * k); let d = e * c.total, i = 0;
  while (i < c.legs.length - 1 && d > c.legs[i]) { d -= c.legs[i]; i++; }
  const p0 = c.pts[i], p1 = c.pts[i + 1], t = c.legs[i] ? Math.min(1, d / c.legs[i]) : 1;
  const at = [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
  await A.page.mouse.move(at[0], at[1]); A.pos = at;
  if (c.f >= c.frames) { if (c.s.commit) await commit(A.page, c.s.commit, c.s.label || 'add'); A.cur = null; A.done++; }
  return true;
}
// Everybody works until all are done; the recorder photographs every frame.
async function together(rec, actors, onFrame) { for (;;) { let any = false; for (const A of actors) if (await advance(A)) any = true; await rec.tick(); if (onFrame) await onFrame(); if (!any) break; } }

// ---- turning the exported items into a person's steps
const ORDER = { rectangle: 0, text: 1, symbol: 2, wire: 3, label: 4, global_label: 4, hierarchical_label: 4, junction: 5, no_connect: 6 };
function schSteps(map, blockNames) {
  const steps = [];
  for (const name of blockNames) {
    const its = I.schematic.filter((i) => i.blockName === name);
    const parts = its.filter((i) => i.kind === 'symbol' && !/^power:/.test(i.lib || '')).sort((a, b) => a.pts[0][0] - b.pts[0][0] || a.pts[0][1] - b.pts[0][1]);
    const box = its.filter((i) => i.kind === 'rectangle' || i.kind === 'text');
    let rest = its.filter((i) => !parts.includes(i) && !box.includes(i));
    const ordered = [...box.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]), ...parts];
    // the rest nearest-first from where the hand is, the way a person works round a part
    let at = parts.length ? parts[parts.length - 1].pts[0] : (box[0] ? box[0].pts[0] : [0, 0]);
    while (rest.length) {
      rest.sort((a, b) => dist(at, a.pts[0]) - dist(at, b.pts[0]));
      const n = rest.shift(); ordered.push(n); at = n.pts[n.pts.length - 1];
    }
    for (const i of ordered) steps.push({ path: i.pts.map(map.to), commit: [i.add], label: 'add', max: i.kind === 'symbol' ? 16 : 12 });
  }
  return steps;
}

const scene = async (name, fn) => { if (!want.includes(name)) return; console.log(`== ${name}`); const info = await fn(path.join(OUT, name)); state[name] = info; save(); console.log(JSON.stringify(info).slice(0, 900)); };
const AI_BLOCK = '12 MHz crystal';
const content = (() => { const b = Object.values(I.blocks).map((x) => x.box); return [Math.min(...b.map((x) => x[0])) - 4, Math.min(...b.map((x) => x[1])) - 8, Math.max(...b.map((x) => x[2])) + 4, Math.max(...b.map((x) => x[3])) + 4]; })();

// Takes out whatever of the exported design a previous take put back, so a scene can be recorded again.
async function reset(page, kind) {
  const ids = new Set((kind === 'sch' ? I.schematic : I.board).map((i) => i.id));
  const n = await page.evaluate(([ids, kind]) => {
    const E = window.CollabEditor, d = E.kdoc, out = [];
    for (const it of d.items.values()) if (ids.includes(it.id)) out.push(kind === 'sch' ? { id: it.id, kind: 'REMOVED', typeName: window.CollabTools.sch._.typeNameFor(it), properties: [] } : window.PcbTools.removedChange(it));
    if (out.length) E.api.commitChanges(out, 'reset');
    return out.length;
  }, [[...ids], kind]);
  await settled(page); if (n) console.log('  reset: took out', n);
}

// ---------------------------------------------------------------- Ada and Ben draw the schematic
await scene('schematic', async (dir) => {
  const a = await open(ada, docOf('kicad_sch')), b = await open(ben, docOf('kicad_sch'));
  await reset(a, 'sch'); await sleep(800);
  for (const p of [a, b]) { await clearPanels(p); await frame(p, content); }
  const ma = await mapOf(a), mb = await mapOf(b);
  const names = Object.values(I.blocks).map((x) => x.name);
  const adaBlocks = names.filter((n) => /USB|buck|GPIO|Reset/.test(n)).concat(['outside']), benBlocks = names.filter((n) => !adaBlocks.includes(n) && n !== AI_BLOCK);
  const A = actor(a, schSteps(ma, adaBlocks), [470, 420]), B = actor(b, schSteps(mb, benBlocks), [470, 420]);
  const rec = await record([a, b], [path.join(dir, 'ada'), path.join(dir, 'ben')]);
  await rec.hold(600);
  let shown = false;
  await together(rec, [A, B], async () => { if (!shown && A.done + B.done > 40) { rec.mark('fast'); shown = true; } });
  await settled(a); await settled(b); await rec.hold(800);
  const r = await rec.stop();
  const counts = await b.evaluate(() => window.CollabEditor.kdoc.items.size);
  await a.context().close(); await b.context().close();
  return { ...r, ada: A.done, ben: B.done, itemsSeenByBen: counts, adaBlocks, benBlocks };
});

// ---------------------------------------------------------------- they ask an AI for the crystal block
await scene('ai', async (dir) => {
  const a = await open(ada, docOf('kicad_sch')), b = await open(ben, docOf('kicad_sch'));
  // the crystal out again if an earlier take put it in
  const crystal = new Set(I.schematic.filter((i) => i.blockName === AI_BLOCK).map((i) => i.id));
  await b.evaluate((ids) => { const E = window.CollabEditor, out = []; for (const it of E.kdoc.items.values()) if (ids.includes(it.id)) out.push({ id: it.id, kind: 'REMOVED', typeName: window.CollabTools.sch._.typeNameFor(it), properties: [] }); if (out.length) E.api.commitChanges(out, 'reset'); }, [...crystal]);
  await settled(b);
  // The AI app's access key (the Connect an AI assistant page), and one call before the take: the server starts its
  // MCP worker on the first call, and that start-up is not what the scene is about.
  // (the test user's keys from earlier takes are expired first: an account may hold 20)
  await db.query(`UPDATE mcp_tokens SET expires_at = now() WHERE grant_id IN (SELECT id FROM mcp_grants WHERE user_id = $1 AND client_id LIKE 'kcm\\_key\\_%')`, [benId]);
  const k = await (await fetch(`${BASE}/api/mcp/keys`, { method: 'POST', headers: { Authorization: `Bearer ${ben}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Claude', write: true }) })).json();
  // (in a scratch project, so that the AI app is not in this document before Ben asks)
  let scratch = (await db.query(`SELECT id FROM projects WHERE owner_id = $1 AND name = 'scratch'`, [benId]).catch(() => ({ rows: [] }))).rows[0];
  scratch = scratch ? scratch.id : (await mcp(k.key, 'create_project', { name: 'scratch' })).data.project_id;
  console.log('  warm-up:', (await mcp(k.key, 'run_python', { project: scratch, code: 'print(len(project.schematic().parts()))', timeout_s: 120 })).text.slice(0, 120));
  await sleep(1500);
  for (const p of [a, b]) { await clearPanels(p); await frame(p, content); }
  const box = I.blocks[Object.keys(I.blocks).find((k) => I.blocks[k].name === AI_BLOCK)].box;
  // Ben's mouse goes to the empty spot (no zoom: a zoomed-in headless page redraws too slowly to photograph live)
  const rec = await record([a, b], [path.join(dir, 'ada'), path.join(dir, 'ben')]);
  const mb = await mapOf(b); const c = mb.to([(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]);
  await rec.glide(b, [470, 420], c, 900); await rec.hold(500);
  await rec.glide(b, c, [c[0] - 40, c[1] + 20], 500); await rec.glide(b, [c[0] - 40, c[1] + 20], [c[0] + 30, c[1] - 10], 500); await rec.hold(400);
  rec.mark('ask');
  // Ben goes to his AI app
  await rec.glide(b, [c[0] + 30, c[1] - 10], [930, 790], 600); await a.mouse.move(930, 790);
  // the AI app's call: run_python, live
  const items = I.schematic.filter((i) => i.blockName === AI_BLOCK).sort((p, q) => (ORDER[p.kind] - ORDER[q.kind]) || p.pts[0][0] - q.pts[0][0]);
  const code = `# Adds the 12 MHz crystal circuit of the RP2040 hardware design guide: crystal, 1k drive resistor, two 15 pF loads.
# (It waits a moment after each item so that each one can be seen arriving; the video says how much faster it is.)
import time
ITEMS = ${JSON.stringify(items.map((i) => i.plain))}
sch = project.schematic()
for s in ITEMS:
    sch._edit({"op": "add_item", "sexpr": s})
    sch.flush()
    time.sleep(2.0)
print("added", len(ITEMS), "items")
`;
  await rec.hold(2500); rec.mark('call');
  const t0 = Date.now();
  const run = (async () => { let r = await mcp(k.key, 'run_python', { project, code, title: 'Add the 12 MHz crystal circuit', live: true, timeout_s: 200 }); while (r.data && r.data.running) r = await mcp(k.key, 'get_run', { run_id: r.data.run_id }); return r; })();
  const r = await rec.until(run); rec.mark('done'); console.log('  the call took', (Date.now() - t0) / 1000, 's');
  await rec.wait(2500);
  const out = await rec.stop();
  await a.context().close(); await b.context().close();
  return { ...out, ok: r.data && r.data.ok, output: r.data ? r.data.output : r.text, items: items.length, key: k.name };
});

// ---------------------------------------------------------------- they route the board
await scene('route', async (dir) => {
  const a = await open(ada, docOf('kicad_pcb')), b = await open(ben, docOf('kicad_pcb'));
  const outline = await a.evaluate(() => { for (const it of window.CollabEditor.kdoc.items.values()) if (it.kind === 'gr_rect') return it.bbox; return null; });
  for (const p of [a, b]) { await clearPanels(p); await frame(p, [outline[0] - 2, outline[1] - 2, outline[2] + 2, outline[3] + 2]); }
  const ma = await mapOf(a), mb = await mapOf(b);
  const tracks = I.board.filter((i) => i.kind !== 'zone');
  // one net at a time, its pieces in a chain from one end; vias where the chain reaches them
  const nets = [...new Set(tracks.map((t) => t.net))];
  const yOf = (n) => { const t = tracks.filter((x) => x.net === n); return t.reduce((s, x) => s + x.pts[0][1], 0) / t.length; };
  const mid = (outline[1] + outline[3]) / 2;
  const plan = (map, list) => {
    const steps = [];
    for (const n of list) {
      let rest = tracks.filter((t) => t.net === n); let at = rest.reduce((m, t) => (t.pts[0][1] < m[1] ? t.pts[0] : m), rest[0].pts[0]);
      let chain = []; let chainEnd = null;
      const flush = () => { if (chain.length) { const pts = [chain[0].pts[0], ...chain.flatMap((c) => c.pts.slice(1))]; steps.push({ path: pts.map(map.to), commit: chain.map((c) => c.add), label: 'route', max: 6, speed: 80, alongMax: 8, alongPx: 40 }); chain = []; } };
      while (rest.length) {
        rest.sort((p, q) => Math.min(...p.pts.map((x) => dist(x, at))) - Math.min(...q.pts.map((x) => dist(x, at))));
        let t = rest.shift();
        if (t.kind !== 'via' && dist(t.pts[t.pts.length - 1], at) < dist(t.pts[0], at)) t = { ...t, pts: t.pts.slice().reverse() };
        const joins = chainEnd && dist(t.pts[0], chainEnd) < 0.01 && t.kind !== 'via' && chain.length < 12;
        if (!joins) flush();
        if (t.kind === 'via') { steps.push({ path: [map.to(t.pts[0])], commit: [t.add], label: 'via', max: 5, speed: 80 }); at = t.pts[0]; chainEnd = null; continue; }
        chain.push(t); chainEnd = t.pts[t.pts.length - 1]; at = chainEnd;
      }
      flush();
    }
    return steps;
  };
  const top = nets.filter((n) => yOf(n) < mid), bottom = nets.filter((n) => yOf(n) >= mid);
  const A = actor(a, plan(ma, top), [470, 420]), B = actor(b, plan(mb, bottom), [470, 420]);
  const rec = await record([a, b], [path.join(dir, 'ada'), path.join(dir, 'ben')]);
  await rec.hold(800);
  await together(rec, [A, B]);
  await settled(a); await settled(b); await rec.hold(800);
  const r = await rec.stop();
  const left = await a.evaluate(() => window.PcbTools.ratsnest(window.CollabEditor.kdoc).length);
  await a.context().close(); await b.context().close();
  return { ...r, ada: A.done, ben: B.done, nets: nets.length, tracks: tracks.filter((t) => t.kind !== 'via').length, vias: tracks.filter((t) => t.kind === 'via').length, unrouted: left };
});

// ---------------------------------------------------------------- planes back in, filled; then 3D
await scene('finish', async (dir) => {
  const a = await open(ada, docOf('kicad_pcb'), FULL);
  const outline = await a.evaluate(() => { for (const it of window.CollabEditor.kdoc.items.values()) if (it.kind === 'gr_rect') return it.bbox; return null; });
  await frame(a, [outline[0] - 3, outline[1] - 3, outline[2] + 3, outline[3] + 3]);
  const rec = await record(a, dir);
  await rec.hold(500);
  await commit(a, I.board.filter((i) => i.kind === 'zone').map((z) => z.add), 'zones'); await rec.hold(600);
  rec.mark('fill');
  await a.mouse.move(800, 450); await a.keyboard.press('b');
  await rec.wait(4000);
  rec.mark('filled');
  const btn = a.locator('#kmenus [data-menu="view"] > button'); const bb = await btn.boundingBox();
  await rec.glide(a, [800, 450], [bb.x + bb.width / 2, bb.y + bb.height / 2], 600); await btn.click(); await rec.hold(400);
  const it = a.locator('#kmenus [data-menu="view"] .dd').locator('text=3D Viewer').first(); const ib = await it.boundingBox();
  await rec.glide(a, [bb.x + bb.width / 2, bb.y + bb.height / 2], [ib.x + 40, ib.y + ib.height / 2], 400); await it.click(); rec.mark('open3d');
  await rec.wait(14000); rec.mark('loaded');
  const box = await a.evaluate(() => { const cs = [...document.querySelectorAll('canvas')].filter((c) => c.getBoundingClientRect().width > 200); const c = cs[cs.length - 1].getBoundingClientRect(); return [c.left, c.top, c.width, c.height]; });
  const cx = box[0] + box[2] / 2, cy = box[1] + box[3] / 2;
  await rec.glide(a, [ib.x + 40, ib.y], [cx - 160, cy], 500); await a.mouse.down();
  await rec.glide(a, [cx - 160, cy], [cx + 170, cy + 70], 2800); await a.mouse.up(); await rec.hold(400);
  await a.mouse.down(); await rec.glide(a, [cx + 170, cy + 70], [cx - 50, cy - 80], 2800); await a.mouse.up(); await rec.hold(1200);
  const r = await rec.stop();
  const drc = await a.evaluate(() => { const P = window.PcbTools, d = window.CollabEditor.kdoc; return { unconnected: P.ratsnest(d).length }; });
  await a.context().close();
  return { ...r, ...drc };
});

for (const b of Object.values(browsers)) await b.close(); await db.end();
