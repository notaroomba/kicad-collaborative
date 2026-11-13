// node server/scripts/landing-ai/record.mjs
//
// Runs the AI's two scripts for the ESP32-C3 devboard (../demo-video/design: the schematic, then
// the board) through the real MCP endpoint of a local server, exactly as the AI did, and keeps
// what came out for the home page's AI chapter: the finished schematic and board, and the order
// in which every item was added (the documents' op logs).  Server and library mirror as in
// ../demo-video/README.md.  Writes server/web/landing/ai/{esp32.kicad_sch,esp32.kicad_pcb,order.json}.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createRequire } from 'node:module';
import { BASE, PG_URL, mintJwt, mcp } from '../demo-video/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', '..', 'web', 'landing', 'ai');
fs.mkdirSync(OUT, { recursive: true });
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
const id = (await db.query(`INSERT INTO users (github_id, login, name) VALUES (-7731, 'ai-demo', 'AI demo') ON CONFLICT (github_id) DO UPDATE SET name = EXCLUDED.name RETURNING id`)).rows[0].id * 1;   // bigint arrives as a string; the token wants a number
const jwt = mintJwt(id, 'ai-demo');
const api = async (p) => { const r = await fetch(BASE + p, { headers: { Authorization: `Bearer ${jwt}` } }); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r; };

const require = createRequire(import.meta.url);
require(path.join(here, '..', '..', 'static', 'kicad-canvas.js'));
const K = globalThis.KiCadCanvas;

// --extract: skip the runs and only rebuild the outputs from the project already in the database.
let project;
if (process.argv.includes('--extract')) project = (await db.query('SELECT id FROM projects WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 1', [id])).rows[0].id;
else {
  await db.query('DELETE FROM projects WHERE owner_id = $1', [id]);
  project = (await mcp(jwt, 'create_project', { name: 'esp32-battery-devboard' })).data.project_id;
  const runs = {};
  for (const [file, title] of [['design.py', 'ESP32-C3 battery devboard schematic'], ['board.py', 'Place and route the board']]) {
    const t = Date.now();
    let r = await mcp(jwt, 'run_python', { project, code: fs.readFileSync(path.join(here, '..', 'demo-video', 'design', file), 'utf8'), title, live: true, timeout_s: 400 });
    while (r.data && r.data.running) { await new Promise((ok) => setTimeout(ok, 1000)); r = await mcp(jwt, 'get_run', { run_id: r.data.run_id }); }
    if (r.isError || !r.data || !r.data.ok) throw new Error(`${file}: ${r.text.slice(0, 900)}`);
    runs[file] = { seconds: +((Date.now() - t) / 1000).toFixed(1), calls: r.data.calls, output: String(r.data.output) };
    console.log(file, runs[file].seconds, 's\n' + runs[file].output.slice(0, 1500));
  }
  fs.writeFileSync(path.join(here, 'runs.json'), JSON.stringify(runs, null, 1));
}

// Each document: its first snapshot with every op replayed onto it, in order, the way an editor
// that watched the whole run would have it.  On the way, note when each item first appeared and
// (for footprints) where the AI first put it, before placement moved it.
const runs = JSON.parse(fs.readFileSync(path.join(here, 'runs.json'), 'utf8'));
// The numbers the page quotes, read from what the two runs printed (never typed in by hand).
const num = (text, re) => { const m = re.exec(text); if (!m) throw new Error('missing in the run output: ' + re); return m.slice(1).map(Number); };
const so = runs['design.py'].output, bo = runs['board.py'].output;
const [parts, nets] = num(so, /'placed': (\d+), 'nets': (\d+)/), [ercErrors] = num(so, /'check': 'ERC', 'errors': (\d+)/);
const [routed, connections, vias, length] = num(bo, /'routed': (\d+), 'connections': (\d+), 'vias': (\d+), 'length_mm': ([\d.]+)/);
const [width, height] = num(bo, /'width': ([\d.]+), 'height': ([\d.]+)/), [drcErrors] = num(bo, /\ndrc (\d+) /);
const layers = /'copper_layers': \[([^\]]*)\]/.exec(bo)[1].split(',').length;
const unrouted = [...(/'unrouted': \[([^\]]*)\]/.exec(bo) || ['', ''])[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
const stats = { parts, nets, ercErrors, routed, connections, vias, length: Math.round(length), width, height, layers, drcErrors, unrouted };
console.log(stats);
const out = { stats, runs: Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, { seconds: v.seconds, calls: v.calls }])) };
const r6 = (v) => Math.round(v * 1e6) / 1e6;
await (await api(`/api/projects/${project}/archive`)).arrayBuffer();
for (const type of ['kicad_sch', 'kicad_pcb']) {
  const d = (await db.query('SELECT id FROM documents WHERE project_id = $1 AND doc_type = $2', [project, type])).rows[0].id;
  const base = (await db.query('SELECT seq, content FROM snapshots WHERE doc_id = $1 ORDER BY seq LIMIT 1', [d])).rows[0];
  const doc = K.parseDoc(base.content.toString('utf8'));
  const ops = (await db.query('SELECT seq, changes FROM ops WHERE doc_id = $1 AND seq > $2 ORDER BY seq', [d, base.seq])).rows;
  const first = new Map(), from = new Map();
  ops.forEach((o, i) => {
    for (const c of o.changes || []) {
      K.applyChange(doc, c, type === 'kicad_pcb' ? 1e6 : 1e4);
      if (String(c.kind).toUpperCase() === 'ADDED' && !first.has(c.id)) {
        first.set(c.id, i);
        const it = doc.items.get(c.id);
        if (it && it.kind === 'footprint') { const at = K.atOf(it.node); from.set(c.id, [r6(at[0]), r6(at[1]), at[2]]); }
      }
    }
  });
  // The file itself: the server's own fold of the journal (the archive download makes it fold first).
  const text = await (await api(`/api/docs/${d}/content`)).text();
  if (K.parseDoc(text).items.size !== doc.items.size) throw new Error(`${type}: the folded file and the replayed ops differ`);
  fs.writeFileSync(path.join(OUT, 'esp32.' + type), text);
  // Items of the final document in the order they first appeared (anything already in the base first).
  const ids = [...doc.items.keys()].sort((a, b) => (first.has(a) ? first.get(a) : -1) - (first.has(b) ? first.get(b) : -1));
  out[type] = { ops: ops.length, order: ids.map((x) => [x, first.has(x) ? first.get(x) : -1]), from: Object.fromEntries([...from].filter(([k]) => doc.items.has(k))) };
  console.log(type, 'ops', ops.length, 'items', doc.items.size, 'bytes', text.length);
}
fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify(out));
try { fs.unlinkSync(path.join(OUT, 'order.json')); } catch { /* first run */ }
console.log('wrote', fs.readdirSync(OUT));
await db.end();
