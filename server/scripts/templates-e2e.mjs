// API test of the starter templates (server/src/templates.rs): the list, the pictures, a project from each
// template under a new name, the guided board, a board handed over from the home page, and what is refused.
// With E2E_KICAD=1 (Docker and the kicad/kicad:10.0 image) every project is downloaded as its archive and
// checked by KiCad itself: ERC, and DRC with schematic parity, must report nothing under the new file names.
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… [E2E_BASE=http://127.0.0.1:8099] [E2E_KICAD=1] node templates-e2e.mjs
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import pg from 'pg';

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
const KICAD = process.env.E2E_KICAD === '1', IMAGE = process.env.KICAD_IMAGE || 'kicad/kicad:10.0';

let pass = 0, fail = 0; const fails = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (ok) pass++; else { fail++; fails.push(name); } };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'HS256', typ: 'JWT' }), b = b64({ sub, login, iat: now, exp: now + 36000 });
  return `${h}.${b}.${crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url')}`;
}
async function api(token, p, opts = {}) {
  const r = await fetch(BASE + p, { ...opts, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.json ? { 'content-type': 'application/json' } : {}) }, body: opts.json ? JSON.stringify(opts.json) : undefined });
  const buf = Buffer.from(await r.arrayBuffer()); let j; try { j = JSON.parse(buf.toString('utf8')); } catch { j = null; }
  return { status: r.status, body: j, buf, type: r.headers.get('content-type') || '' };
}

pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
await db.query('DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE github_id = -9301)');
await db.query('DELETE FROM users WHERE github_id = -9301').catch(() => {});
const uid = (await db.query("INSERT INTO users (github_id, login, name, email) VALUES (-9301, 'tess', 'Tess', 'tess@example.com') RETURNING id")).rows[0].id;
const token = jwt(uid, 'tess');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'templates-e2e-'));

/** KiCad's verdict on a downloaded project. */
function kicadCheck(dir, stem) {
  fs.chmodSync(dir, 0o777); for (const f of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, f), 0o666);
  const run = (args) => { try { return execFileSync('docker', ['run', '--rm', '-v', `${dir}:/w`, '-w', '/w', IMAGE, 'kicad-cli', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return String(e.stdout || '') + String(e.stderr || ''); } };
  const erc = run(['sch', 'erc', '--severity-all', '--exit-code-violations', '-o', 'erc.rpt', `${stem}.kicad_sch`]);
  const drc = run(['pcb', 'drc', '--severity-all', '--schematic-parity', '--exit-code-violations', '-o', 'drc.rpt', `${stem}.kicad_pcb`]);
  const n = (out, what) => { const m = new RegExp(`Found (\\d+) ${what}`).exec(out); return m ? +m[1] : -1; };
  const kinds = [...new Set((fs.readFileSync(path.join(dir, 'drc.rpt'), 'utf8').match(/^\[[a-z_]+\]/gm) || []))].join(' ');
  return { erc: n(erc, 'violations'), drc: n(drc, 'violations'), unconnected: n(drc, 'unconnected items'), parity: n(drc, 'schematic parity issues'), kinds };
}
async function download(projectId, name) {
  const r = await api(token, `/api/projects/${projectId}/archive`);
  const dir = path.join(TMP, name); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'p.zip'), r.buf); execSync(`cd "${dir}" && unzip -qo p.zip && rm p.zip`);
  // an archive may hold the files in a folder named after the project
  let at = dir; const inner = fs.readdirSync(dir); if (inner.length === 1 && fs.statSync(path.join(dir, inner[0])).isDirectory()) at = path.join(dir, inner[0]);
  return at;
}

// ---------------------------------------------------------------- the list and the pictures
const list = await api(null, '/api/templates');
const templates = list.body?.templates || [];
check('the list is open to everyone and has the four templates', list.status === 200 && templates.length === 4, templates.map((t) => t.id).join(', '));
check('the 555 blinker is first and is the guided one', templates[0]?.id === 'blinker' && templates[0].guided === true && templates.slice(1).every((t) => t.guided === false));
for (const t of templates) {
  check(`${t.id}: says what it is`, !!(t.title && t.summary && t.detail && t.level && t.parts > 0 && t.nets > 0 && t.size?.length === 2));
  for (const pic of [t.board, t.schematic]) { const r = await api(null, pic); check(`${t.id}: ${pic.split('/').pop()} is a PNG`, r.status === 200 && r.type === 'image/png' && r.buf.subarray(1, 4).toString() === 'PNG', `${r.buf.length} bytes`); }
}
check('an unknown picture is not found', (await api(null, '/api/templates/blinker/secret.png')).status === 404 && (await api(null, '/api/templates/nope/board.png')).status === 404);

// ---------------------------------------------------------------- a project from each template
check('creating needs a session', (await api(null, '/api/projects/from-template', { method: 'POST', json: { template: 'blinker' } })).status === 401);
for (const t of templates) {
  const name = `My ${t.title}`;
  const r = await api(token, '/api/projects/from-template', { method: 'POST', json: { template: t.id, name } });
  const stem = name.replace(/ /g, '_');
  const paths = (r.body?.docs || []).map((d) => d.path).sort();
  check(`${t.id}: a project is made with the three files under its own name`, r.status === 200 && r.body.name === name && JSON.stringify(paths) === JSON.stringify([`${stem}.kicad_pcb`, `${stem}.kicad_pro`, `${stem}.kicad_sch`]), paths.join(', '));
  if (r.status !== 200) continue;
  const dir = await download(r.body.projectId, t.id);
  const read = (ext) => fs.readFileSync(path.join(dir, `${stem}.${ext}`), 'utf8');
  check(`${t.id}: the files name the new project inside`, JSON.parse(read('kicad_pro')).meta.filename === `${stem}.kicad_pro` && read('kicad_sch').includes(`(project "${stem}"`) && !read('kicad_sch').includes(`(project "${t.stem}"`) && read('kicad_pcb').includes(`(sheetfile "${stem}.kicad_sch")`));
  if (KICAD) { const v = kicadCheck(dir, stem); check(`${t.id}: KiCad's ERC and DRC report nothing on the renamed project`, v.erc === 0 && v.drc === 0 && v.unconnected === 0 && v.parity === 0, JSON.stringify(v)); }
}

// ---------------------------------------------------------------- names
const untitled = await api(token, '/api/projects/from-template', { method: 'POST', json: { template: 'i2c-sensor-breakout' } });
check('without a name the project takes the template title', untitled.status === 200 && untitled.body.name === 'I2C temperature sensor breakout');
check('a name of dots is refused', (await api(token, '/api/projects/from-template', { method: 'POST', json: { template: 'blinker', name: '..' } })).status === 400);
check('an unknown template is refused', (await api(token, '/api/projects/from-template', { method: 'POST', json: { template: 'nope' } })).status === 400);

// ---------------------------------------------------------------- the guided board
const guided = await api(token, '/api/projects/from-template', { method: 'POST', json: { template: 'blinker', name: 'First board', guided: true } });
const full = await api(token, '/api/projects/from-template', { method: 'POST', json: { template: 'blinker', name: 'Whole board' } });
const pcbOf = async (r) => { const d = r.body.docs.find((x) => x.docType === 'kicad_pcb'); return (await api(token, `/api/docs/${d.docId}/content`)).buf.toString('utf8'); };
const gText = await pcbOf(guided), fText = await pcbOf(full);
const segs = (t) => (t.match(/\(segment/g) || []).length, vias = (t) => (t.match(/\(via/g) || []).length;
check('the guided board is the blinker with tracks taken out', guided.status === 200 && segs(gText) < segs(fText) && vias(gText) < vias(fText), `${segs(fText) - segs(gText)} segments, ${vias(fText) - vias(gText)} vias fewer`);
check('guided on a template without a guided board gives the whole board', await (async () => {
  const r = await api(token, '/api/projects/from-template', { method: 'POST', json: { template: 'attiny85-dev-board', name: 'Tiny', guided: true } });
  return r.status === 200 && segs(await pcbOf(r)) > 50;
})());
if (KICAD) {
  const dir = await download(guided.body.projectId, 'guided'); const v = kicadCheck(dir, 'First_board');
  // the via the missing back-layer jumper started from is left hanging until the jumper is routed
  check('KiCad finds the four open connections on the guided board, and nothing else', v.erc === 0 && v.parity === 0 && v.unconnected === 4 && v.kinds === '[via_dangling] [unconnected_items]', JSON.stringify(v));
}

// ---------------------------------------------------------------- a board handed over from the home page
// the home page's editor works on the demo board, which names its schematic blinker.kicad_sch
const handed = fText.replace('(gr_text "555 BLINKER"', '(gr_text "MY BLINKER"').replaceAll('"Whole_board.kicad_sch"', '"blinker.kicad_sch"');
const h = await api(token, '/api/projects/from-template', { method: 'POST', json: { template: 'blinker', name: 'From the home page', board: handed } });
check('a handed-over board becomes the project board', h.status === 200 && (await pcbOf(h)).includes('MY BLINKER') && (await pcbOf(h)).includes('(sheetfile "From_the_home_page.kicad_sch")'), `${h.status} ${JSON.stringify(h.body).slice(0, 120)}`);
for (const [what, board] of [['a schematic', '(kicad_sch (version 1))'], ['an unbalanced list', '(kicad_pcb (version 1)'], ['two lists', '(kicad_pcb) (kicad_pcb)'], ['plain text', 'hello'], ['a huge board', '(kicad_pcb ' + '(gr_text "x") '.repeat(90000) + ')']]) {
  const r = await api(token, '/api/projects/from-template', { method: 'POST', json: { template: 'blinker', name: 'Bad', board } });
  check(`${what} is refused as a board`, r.status === 400 || r.status === 413, String(r.status));
}
const mine = await api(token, '/api/projects');
check('nothing was created by the refused requests', !(mine.body?.projects || []).some((p) => p.name === 'Bad'));

await db.query('DELETE FROM projects WHERE owner_id = $1', [uid]);
await db.query('DELETE FROM users WHERE id = $1', [uid]).catch(() => {});
await db.end();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed${fail ? ': ' + fails.join('; ') : ''}`);
process.exit(fail ? 1 : 0);
