// Takes the finished Pico design (build-pico.mjs) apart so the video can show it being put together:
// every schematic item, and every track, via and zone of the board, is written to out/pico-items.json
// as the change that adds it back (the editor's own change format), with where it sits, and is then
// removed from the project by Ada's editor.  The footprints stay where the layout put them.
//
//   node prepare.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { BASE, PG_URL, mintJwt, sleep } from './lib.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT || path.join(here, 'out');
const { project } = JSON.parse(fs.readFileSync(path.join(OUT, 'pico.json'), 'utf8'));
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false }); await db.connect();
const adaId = (await db.query(`SELECT id FROM users WHERE github_id = -7701`)).rows[0].id;
const ada = mintJwt(adaId, 'ada');
const docs = (await (await fetch(`${BASE}/api/projects/${project}`, { headers: { Authorization: `Bearer ${ada}` } })).json()).docs;
const browser = await chromium.launch();

async function open(type) {
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
  page.on('pageerror', (e) => console.log('page error', String(e).slice(0, 300)));
  await page.goto(`${BASE}/auth/dev?jwt=${ada}&next=${encodeURIComponent(`/p/${project}/edit?doc=${docs.find((d) => d.docType === type).docId}`)}`);
  await page.waitForFunction(() => window.CollabEditor && window.CollabEditor.kdoc && window.CollabEditor.kdoc.items.size > 10 && window.CollabEditor.ws && window.CollabEditor.ws.readyState === 1, null, { timeout: 60000 });
  await sleep(1500);
  return page;
}
// remove in batches through the editor's commit, then wait until the server has every op
async function removeAll(page, removes) {
  for (let i = 0; i < removes.length; i += 200) await page.evaluate((c) => window.CollabEditor.api.commitChanges(c, 'clear'), removes.slice(i, i + 200));
  await page.waitForFunction(() => window.CollabEditor.pendingOps.size === 0, null, { timeout: 60000 });
}

// ---------------------------------------------------------------- schematic
const sch = await open('kicad_sch');
const s = await sch.evaluate(() => {
  const E = window.CollabEditor, T = window.CollabTools.sch._, K = window.KiCadCanvas, d = E.kdoc;
  const kid = (n, k) => n.find((c) => Array.isArray(c) && c[0] === k);
  const rects = [], items = [];
  for (const it of d.items.values()) if (it.kind === 'rectangle') { const a = kid(it.node, 'start'), b = kid(it.node, 'end'); rects.push({ id: it.id, box: [Math.min(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[1], b[1]), Math.max(a[2], b[2])] }); }
  for (const it of d.items.values()) {
    const typeName = T.typeNameFor(it);
    const add = { id: it.id, kind: 'ADDED', typeName, sexpr: T.itemSexpr(d, it.kind, it.node) };
    let pts;
    if (it.kind === 'wire') pts = kid(it.node, 'pts').slice(1).map((p) => [p[1], p[2]]);
    else if (it.kind === 'rectangle') { const r = rects.find((x) => x.id === it.id).box; pts = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]], [r[0], r[1]]]; }
    else if (it.kind === 'symbol') pts = [[it.x, it.y]];
    else { const at = kid(it.node, 'at'); pts = at ? [[at[1], at[2]]] : [[(it.bbox[0] + it.bbox[2]) / 2, (it.bbox[1] + it.bbox[3]) / 2]]; }
    const c = it.kind === 'rectangle' ? null : [(it.bbox[0] + it.bbox[2]) / 2, (it.bbox[1] + it.bbox[3]) / 2];
    const block = it.kind === 'rectangle' ? it.id : (rects.find((r) => c[0] >= r.box[0] && c[0] <= r.box[2] && c[1] >= r.box[1] && c[1] <= r.box[3]) || {}).id || null;
    items.push({ id: it.id, kind: it.kind, lib: it.lib || null, ref: it.ref || null, text: it.kind === 'text' || /label/.test(it.kind) ? String(it.node[1]) : null, pts, block, add, plain: K.serialize(it.node),
      remove: { id: it.id, kind: 'REMOVED', typeName, properties: [] } });
  }
  return { items, rects };
});
// name each block after its title text
const blocks = {};
for (const r of s.rects) {
  const title = s.items.filter((i) => i.kind === 'text' && i.block === r.id).sort((a, b) => a.pts[0][1] - b.pts[0][1])[0];
  blocks[r.id] = { name: title ? title.text : r.id, box: r.box };
}
for (const it of s.items) it.blockName = it.block ? blocks[it.block].name : 'outside';
console.log('schematic', s.items.length, 'items in', Object.values(blocks).map((b) => `${b.name} (${s.items.filter((i) => i.blockName === b.name).length})`).join(', '), '; outside', s.items.filter((i) => !i.block).length);
await removeAll(sch, s.items.map((i) => i.remove));
console.log('schematic cleared:', await sch.evaluate(() => window.CollabEditor.kdoc.items.size), 'items left');

// ---------------------------------------------------------------- board
const pcb = await open('kicad_pcb');
const b = await pcb.evaluate(() => {
  const E = window.CollabEditor, P = window.PcbTools, K = window.KiCadCanvas, d = E.kdoc;
  const kid = (n, k) => n.find((c) => Array.isArray(c) && c[0] === k);
  const out = [];
  for (const it of d.items.values()) {
    if (!['segment', 'arc', 'via', 'zone'].includes(it.kind)) continue;
    const add = K.boardChangeExtras(d, it, { id: it.id, kind: 'ADDED', typeName: P.typeNameOf(it), sexpr: P.wrapBoard(it.node) });
    let pts, layer = null;
    if (it.kind === 'segment') pts = [kid(it.node, 'start').slice(1, 3), kid(it.node, 'end').slice(1, 3)];
    else if (it.kind === 'arc') pts = [kid(it.node, 'start').slice(1, 3), kid(it.node, 'mid').slice(1, 3), kid(it.node, 'end').slice(1, 3)];
    else if (it.kind === 'via') pts = [kid(it.node, 'at').slice(1, 3)];
    else pts = [[(it.bbox[0] + it.bbox[2]) / 2, (it.bbox[1] + it.bbox[3]) / 2]];
    const l = kid(it.node, 'layer'); if (l) layer = l[1];
    const n = kid(it.node, 'net'); const net = n ? String(n[n.length - 1]) : null;
    out.push({ id: it.id, kind: it.kind, pts, layer, net: K.netNameOf ? (K.netNameOf(d, it) || net) : net, add, remove: P.removedChange(it) });
  }
  return out;
});
const by = {}; for (const i of b) by[i.kind] = (by[i.kind] || 0) + 1;
console.log('board', JSON.stringify(by), 'nets', new Set(b.map((i) => i.net)).size);
await removeAll(pcb, b.map((i) => i.remove));
console.log('board cleared:', await pcb.evaluate(() => { const c = {}; for (const it of window.CollabEditor.kdoc.items.values()) c[it.kind] = (c[it.kind] || 0) + 1; return JSON.stringify(c); }));

fs.writeFileSync(path.join(OUT, 'pico-items.json'), JSON.stringify({ project, blocks, schematic: s.items, board: b }));
await browser.close(); await db.end();
