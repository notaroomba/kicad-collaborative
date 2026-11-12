// End-to-end test of run_python (web/mcp/host.ts, web/harness/sandbox.ts, harness/kicad_harness):
// a Python script sent to the MCP endpoint builds a small design in a live project, while a
// second collaboration client watches, so that "edits appear step by step with a cursor on
// them" is checked and not assumed.  Also: a failing script leaves nothing behind, the sandbox
// keeps a script away from files, the network and JavaScript, and the edits can be undone.
//
// Server as for mcp-e2e.mjs (node on its PATH, the Python runtime built with `npm run build`):
//   E2E_PG_URL=… E2E_JWT_SECRET=testsecret node harness-e2e.mjs
//
import crypto from 'node:crypto';
import pg from 'pg';

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required (see the header comment).'); process.exit(2); }

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + String(detail).slice(0, 600) : ''}`); ok ? pass++ : fail++; return ok; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(100); } return false; };
function mintJwt(sub, login) {
  const now = Math.floor(Date.now() / 1000); const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 7200 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}

pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
const uid = (await db.query(`INSERT INTO users (github_id, login, name) VALUES (9431, 'harness-ada', 'harness-ada')
  ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`)).rows[0].id;
await db.query(`DELETE FROM projects WHERE owner_id = $1`, [uid]);
const jwt = mintJwt(uid, 'harness-ada');

let rpcId = 0;
async function call(name, args) {
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${jwt}`, 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
  let j; const text0 = await r.text();
  if (text0.trimStart().startsWith('{')) j = JSON.parse(text0);
  else j = text0.split(/\n\n/).map((f) => f.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')).filter(Boolean).map((d) => JSON.parse(d)).find((e) => e.id !== undefined);
  if (!j || !j.result) return { isError: true, text: JSON.stringify(j && j.error) };
  const text = (j.result.content.find((c) => c.type === 'text') || {}).text || ''; let data = null; try { data = JSON.parse(text); } catch { /* prose */ }
  return { isError: !!j.result.isError, text, data };
}

function watch(docId) {
  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws'); const w = { ops: [], cursors: [], ws };
  return new Promise((resolve, reject) => {
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', proto: 1, token: jwt, clientId: 'watch-' + crypto.randomBytes(4).toString('hex'), linkToken: null, client: 'web' }));
    ws.onerror = () => reject(new Error('watcher socket failed'));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'hello_ok') ws.send(JSON.stringify({ type: 'join_doc', docId }));
      else if (m.type === 'snapshot') resolve(w);
      else if (m.type === 'op') w.ops.push(m);
      else if (m.type === 'ops') w.ops.push(...m.ops);
      else if (m.type === 'presence') for (const p of Object.values(m.peers || {})) if (p && p.state && p.state.cursor) w.cursors.push(p.state.cursor.join(','));
    };
  });
}

// ------------------------------------------------------------------ the tool is offered

{
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${jwt}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' }) });
  const tools = (await r.json()).result.tools; const py = tools.find((t) => t.name === 'run_python');
  check('run_python and get_geometry are in the catalog', !!py && tools.some((t) => t.name === 'get_geometry') && py.inputSchema.required.join() === 'project,code' && /kicad_harness/.test(py.description));
  const guide = await call('get_design_guide', { topic: 'python' });
  check('the guide has the Python API', !guide.isError && /sch\.connect/.test(guide.text) && /parts\.from_datasheet/.test(guide.text), guide.text.slice(0, 200));
}

// ------------------------------------------------------------------ a design from one script

const NAME = 'harness-e2e-blinky';
const made = await call('create_project', { name: NAME });
check('create_project', !made.isError, made.text);
const rows = (await db.query(`SELECT id, doc_type FROM documents WHERE project_id = $1`, [made.data.project_id])).rows;
const schWatch = await watch(rows.find((r) => r.doc_type === 'kicad_sch').id), pcbWatch = await watch(rows.find((r) => r.doc_type === 'kicad_pcb').id);

const SCHEMATIC = `
sch = project.schematic()
sch.place("Timer:NE555D", ref="U1", footprint="Package_SO:SOIC-8_3.9x4.9mm_P1.27mm")
sch.net("GND", "U1.GND"); sch.net("+5V", "U1.VCC", "U1.RST")
r1 = sch.attach("U1.DISCH", "Device:R", value="10k", footprint="Resistor_SMD:R_0402_1005Metric", to="+5V")
r2 = sch.place("Device:R", value="47k", footprint="Resistor_SMD:R_0402_1005Metric")
c1 = sch.place("Device:C", value="10uF", footprint="Capacitor_SMD:C_0603_1608Metric")
sch.connect("U1.DISCH", f"{r2}.1"); sch.connect(f"{r2}.2", "U1.THRES"); sch.connect("U1.THRES", "U1.TRIG"); sch.connect("U1.THRES", f"{c1}.1")
sch.net("GND", f"{c1}.2")
d1 = sch.attach("U1.OUT", "Device:LED", footprint="LED_SMD:LED_0603_1608Metric", part_pin="2")
sch.attach(f"{d1}.1", "Device:R", value="330", footprint="Resistor_SMD:R_0402_1005Metric", to="GND")
sch.no_connect("U1.CONT")
erc = sch.check()
print("parts", sorted(sch.refs()))
print("erc", erc)
result = {"parts": len(sch.refs()), "unconnected": sch.unconnected()}
`;
{
  const t = Date.now();
  const r = await call('run_python', { project: NAME, title: 'Draw the 555 blinker', code: SCHEMATIC });
  check('a script draws a schematic', !r.isError && r.data.ok === true && r.data.result && r.data.result.parts === 6, r.text);
  check('it returns what it printed and nothing of the file', !r.isError && /parts \['C1', 'D1', 'R1', 'R2', 'R3', 'U1'\]/.test(r.data.output || '') && r.text.length < 2500 && !/\(symbol/.test(r.text), `${r.text.length} chars`);
  check('the change is recorded for undo', !r.isError && Array.isArray(r.data.change_ids) && r.data.change_ids.length === 1 && r.data.changed[0].items > 20, JSON.stringify(r.data && r.data.changed));
  await until(() => schWatch.ops.length > 5, 3000);
  const cursors = new Set(schWatch.cursors);
  check('the watcher saw the sheet drawn in steps, with the cursor moving', schWatch.ops.length >= 8 && cursors.size >= 6, `${schWatch.ops.length} ops, ${cursors.size} cursor positions, ${Date.now() - t} ms`);
  const comps = await call('list_components', { project: NAME, document: 'schematic' });
  check('the parts are in the live document', !comps.isError && comps.data.components.length === 6, comps.text.slice(0, 200));
  const erc = await call('run_checks', { project: NAME, document: 'schematic' });
  check('the ERC has no errors', !erc.isError && (erc.data.errors || 0) === 0, erc.text.slice(0, 400));
}

const BOARD = `
board = project.board()
print(board.sync())
board.outline(100, 100, 125, 120)
print(board.autoplace(outline=(100, 100, 125, 120)))
routed = board.route(time_s=15)
print(routed)
print(board.check())
result = {"unrouted": board.unrouted()}
`;
{
  const r = await call('run_python', { project: NAME, title: 'Lay out the board', code: BOARD });
  check('a script syncs, places and routes the board', !r.isError && r.data.ok === true && r.data.result.unrouted && Object.keys(r.data.result.unrouted).length === 0, r.text);
  await until(() => pcbWatch.ops.length > 3, 3000);
  check('the watcher saw the board drawn in steps', pcbWatch.ops.length >= 4 && new Set(pcbWatch.cursors).size >= 3, `${pcbWatch.ops.length} ops, ${new Set(pcbWatch.cursors).size} cursor positions`);
  const drc = await call('run_checks', { project: NAME, document: 'board' });
  check('the DRC has no errors', !drc.isError && (drc.data.errors || 0) === 0, drc.text.slice(0, 400));
}

// ------------------------------------------------------------------ live off, failure, undo

{
  const before = schWatch.ops.length;
  const r = await call('run_python', { project: NAME, live: false, code: 'sch = project.schematic()\nfor i in range(4):\n    sch.place("Device:C", at=(150 + 10 * i, 150), ref=f"C{i + 10}", value="100n")\nprint(len(sch.refs()))' });
  await sleep(400);
  check('live off applies a batch as one op', !r.isError && r.data.ok && /^10$/m.test(r.data.output) && schWatch.ops.length - before === 1, `${schWatch.ops.length - before} ops; ${r.text.slice(0, 200)}`);

  const bad = await call('run_python', { project: NAME, code: 'sch = project.schematic()\nsch.place("Device:R", ref="R77", value="1k")\nsch.commit() if hasattr(sch, "commit") else project.commit()\nsch.connect("R77.1", "U9.1")\n' });
  check('a failing script reports the line and the reason', !bad.isError && bad.data.ok === false && /U9/.test(bad.data.error) && /line 4/.test(bad.data.error), bad.text);
  const comps = await call('list_components', { project: NAME, document: 'schematic' });
  check('and leaves nothing behind', /taken back/.test(bad.data.design || '') && !comps.data.components.some((c) => c.reference === 'R77') && comps.data.components.length === 10, `${comps.data.components.length} parts; ${bad.data.design}`);

  const syntax = await call('run_python', { project: NAME, code: 'x = (1,\nprint(x' });
  check('a syntax error is reported, not a crash', !syntax.isError && syntax.data.ok === false && /SyntaxError/.test(syntax.data.error), syntax.text);

  const undo = await call('undo_changes', { project: NAME });
  const after = await call('list_components', { project: NAME, document: 'schematic' });
  check('undo_changes takes a script\'s edits back', !undo.isError && after.data.components.length === 6, undo.text.slice(0, 300));
}

// ------------------------------------------------------------------ the sandbox

{
  const probes = [
    ['read a server file', 'print(open("/etc/passwd").read()[:20])'],
    ['see the server environment', 'import os\nassert "DATABASE_URL" not in os.environ and "JWT_SECRET" not in os.environ and "PATH" not in os.environ\nraise RuntimeError("env is empty")'],
    ['open a network connection', 'import urllib.request\nurllib.request.urlopen("' + BASE + '/").read()'],
    ['reach JavaScript', 'import _kc_host\nprint(_kc_host.call.constructor("return typeof process")())'],
    ['run JavaScript', 'from pyodide.code import run_js\nprint(run_js("typeof process"))'],
    ['start a process', 'import subprocess\nprint(subprocess.run(["id"], capture_output=True).stdout)'],
  ];
  for (const [what, code] of probes) {
    const r = await call('run_python', { project: NAME, code });
    check(`a script cannot ${what}`, !r.isError && r.data.ok === false && !/root:|function|object/.test(r.data.output || ''), (r.data && r.data.error) || r.text);
  }
  const slow = await call('run_python', { project: NAME, timeout_s: 5, code: 'while True:\n    pass' });
  check('a script that never ends is stopped', !slow.isError && slow.data.ok === false && /time limit/.test(slow.data.error), slow.text);
  const ok = await call('run_python', { project: NAME, code: 'print(sum(range(10)))' });
  check('and the next call works', !ok.isError && ok.data.ok && ok.data.output === '45', ok.text);
}

// ------------------------------------------------------------------ parts from the harness

{
  const r = await call('run_python', { project: NAME, live: false, code: `
part = parts.make("MYREG", package="SOT-23-5", pins=[(1, "VIN"), (2, "GND"), (3, "EN"), (4, "NC"), (5, "VOUT")])
sch = project.schematic()
ref = sch.place(part, ref="U7")
print(ref, sorted(p["name"] for p in sch.pins("U7")))
board = project.board(); print(board.sync())
print([p for p in board.refs() if p == "U7"], len(board.pads("U7")))
` });
  check('a generated part is placed on the sheet and reaches the board with its footprint', !r.isError && r.data.ok && /U7 \['EN', 'GND', 'NC', 'VIN', 'VOUT'\]/.test(r.data.output) && /\['U7'\] 5/.test(r.data.output), r.text);
}

schWatch.ws.close(); pcbWatch.ws.close();
await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
