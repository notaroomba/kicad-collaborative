// Test of the server folding a document's edits into a new stored file when no desktop editor is there to save
// it (src/compact.rs, web/mcp/compact.ts).  A project is edited from the browser only; then an archive download,
// a new branch and everyone leaving must each leave a stored file that is the design as edited: the same document
// the editing browser shows, the stored file's own text wherever nothing was edited, the format version untouched,
// and the live session carrying on.  Needs a local server with KC_DEV_LOGIN=1.
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… [E2E_BASE=http://127.0.0.1:8099] [FRESH=1] [REAP=1] node fold-check.mjs
//
import crypto from 'node:crypto'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import { execSync } from 'node:child_process'; import { createRequire } from 'node:module'; import pg from 'pg';
const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, ''), SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (sub, login) => { const now = Math.floor(Date.now() / 1000); const h = b64({ alg: 'HS256', typ: 'JWT' }), b = b64({ sub, login, iat: now, exp: now + 36000 }); return `${h}.${b}.${crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url')}`; };
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false }); await db.connect();
await db.query('DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE github_id = -9306)'); await db.query('DELETE FROM users WHERE github_id = -9306');
const uid = (await db.query("INSERT INTO users (github_id, login, name, email) VALUES (-9306,'fold','fold','fold@example.com') RETURNING id")).rows[0].id; const token = jwt(uid, 'fold');
const auth = { authorization: `Bearer ${token}` };
const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../demos/stickhub');
const ZIP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fold-')), 'p.zip');
execSync(`cd "${DEMO}" && zip -qr "${ZIP}" . -i '*.kicad_pro' '*.kicad_sch' '*.kicad_pcb'`);
const form = new FormData(); form.append('name', 'fold'); form.append('archive', new Blob([fs.readFileSync(ZIP)]), 'p.zip');
const pid = (await (await fetch(BASE + '/api/projects', { method: 'POST', headers: auth, body: form })).json()).projectId;
const info = await (await fetch(`${BASE}/api/projects/${pid}/info`, { headers: auth })).json();
const schDoc = info.docs.find((d) => d.docType === 'kicad_sch'), pcbDoc = info.docs.find((d) => d.docType === 'kicad_pcb');

let pass = 0, fail = 0; const errs = [];
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n} ${d}`); ok ? pass++ : fail++; };
const stored = async (docId) => { const r = await fetch(`${BASE}/api/docs/${docId}/content`, { headers: auth }); return { text: await r.text(), seq: Number(r.headers.get('x-snapshot-seq')), head: Number(r.headers.get('x-head-seq')) }; };
const snapshots = async (docId) => (await db.query('SELECT seq FROM snapshots WHERE doc_id = $1 ORDER BY seq', [docId])).rows.map((r) => r.seq);
const opCount = async (docId) => (await db.query('SELECT count(*)::int AS n FROM ops WHERE doc_id = $1', [docId])).rows[0].n;
const linesLost = (a, b) => { const have = new Map(); for (const l of b.split('\n')) have.set(l, (have.get(l) || 0) + 1); let lost = 0; for (const l of a.split('\n')) { const n = have.get(l) || 0; if (n) have.set(l, n - 1); else lost++; } return lost; };
const versionLine = (t) => (t.match(/\(version [^)]*\)/) || [''])[0] + (t.match(/\(generator [^)]*\)/) || [''])[0] + (t.match(/\(generator_version [^)]*\)/) || [''])[0];

const browser = await chromium.launch(); const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const p0 = await ctx.newPage(); await p0.goto(`${BASE}/auth/dev?jwt=${token}&next=/api/me`); await p0.close();
const open = async (project, docId) => { const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); await p.goto(`${BASE}/p/${project}/edit${docId ? '?doc=' + docId : ''}`); await p.waitForFunction(() => window.CollabEditor && window.CollabEditor.kdoc && window.CollabEditor.joinedDocId && window.CollabEditor.lastSeq !== undefined && window.CollabEditor.items.length, null, { timeout: 30000 }); await p.waitForTimeout(400); return p; };
/** The document a page holds, as one digest per item (and library symbol): what "the same document" means here. */
const digest = (p) => p.evaluate(() => { const E = window.CollabEditor, K = window.KiCadCanvas; const rows = []; for (const [id, it] of E.kdoc.items) if (!id.startsWith('anon-')) rows.push(id + ' ' + K.serialize(it.node)); if (E.kdoc.lib) for (const [n, s] of E.kdoc.lib) rows.push('lib ' + n + ' ' + K.serialize(s)); rows.sort(); let h = 0; for (const r of rows) for (let i = 0; i < r.length; i++) h = (h * 31 + r.charCodeAt(i)) | 0; return { n: rows.length, h, seq: E.lastSeq, pend: E.pendingOps.size }; });
const edit = (p, kinds) => p.evaluate((kinds) => {
  const E = window.CollabEditor, IU = E.IU; const of = (k) => [...E.kdoc.items.values()].filter((i) => i.kind === k && !i.id.startsWith('anon-'));
  const movers = of(kinds[0]).slice(0, 3), gone = of(kinds[1]).slice(0, 5), turned = of(kinds[0]).slice(3, 5);
  for (const m of movers) E.api.commitChanges([{ id: m.id, kind: 'MODIFIED', typeName: E.ITEM_TYPE, properties: [{ name: 'Position X', after: { type: 'int', v: Math.round((m.x + 2.54) * IU) } }, { name: 'Position Y', after: { type: 'int', v: Math.round((m.y + 2.54) * IU) } }] }], 'move');
  for (const g of gone) E.api.commitChanges([{ id: g.id, kind: 'REMOVED', typeName: E.ITEM_TYPE, properties: [] }], 'delete');
  for (const t of turned) { const it = E.kdoc.items.get(t.id); window.KiCadCanvas.moveItem(E.kdoc, it, 1.27, 0); E.api.commitChanges([window.KiCadCanvas.replaceChange(E.kdoc, it)], 'nudge'); }
  return { moved: movers.map((m) => m.id), gone: gone.map((g) => g.id), turned: turned.map((t) => t.id) };
}, kinds);

for (const [doc, kinds, label] of [[schDoc, ['symbol', 'wire'], 'schematic'], [pcbDoc, ['footprint', 'segment'], 'board']]) {
  const before = await stored(doc.docId);
  const A = await open(pid, doc.docId);
  const did = await edit(A, kinds); await A.waitForTimeout(1200);
  const a = await digest(A);
  check(`${label}: edits sent`, a.pend === 0 && a.seq > before.seq, JSON.stringify({ a, did: [did.moved.length, did.gone.length, did.turned.length] }));
  const mid = await stored(doc.docId);
  if (!process.env.FRESH) check(`${label}: the stored file is still the old one while only a browser edits`, mid.seq === before.seq && mid.head === a.seq, JSON.stringify({ seq: mid.seq, head: mid.head }));   // (a short SNAPSHOT_FRESH_SECS folds sooner)
  const ops0 = await opCount(doc.docId);

  // an archive download reads the files as the design is now
  const zip = await fetch(`${BASE}/api/projects/${pid}/archive`, { headers: auth }); await zip.arrayBuffer();
  const after = await stored(doc.docId);
  check(`${label}: a download folds the edits into the stored file`, zip.ok && after.seq === a.seq && after.head === a.seq, JSON.stringify({ status: zip.status, seq: after.seq, head: after.head }));
  check(`${label}: no edit is removed from the history`, (await opCount(doc.docId)) === ops0 && (await snapshots(doc.docId)).includes(before.seq));
  check(`${label}: format version and generator untouched`, versionLine(after.text) === versionLine(before.text) && versionLine(before.text).length > 10, versionLine(after.text));
  check(`${label}: removed items are gone, the others are there`, did.gone.every((id) => !after.text.includes(id)) && did.moved.concat(did.turned).every((id) => after.text.includes(id)));
  const lost = linesLost(before.text, after.text), total = before.text.split('\n').length;
  check(`${label}: text nobody edited is the stored text`, lost > 0 && lost < total * 0.2, `${lost} of ${total} lines changed`);

  // a fresh open reads the folded file and is the same document as the browser that made the edits
  const B = await open(pid, doc.docId); const b = await digest(B);
  check(`${label}: a fresh open of the folded file is the editing browser's document`, b.n === a.n && b.h === a.h && b.seq === a.seq, JSON.stringify([a, b]));
  // the live session carries on across the fold
  const more = await A.evaluate((k) => { const E = window.CollabEditor; const it = [...E.kdoc.items.values()].filter((i) => i.kind === k && !i.id.startsWith('anon-'))[7]; E.api.commitChanges([{ id: it.id, kind: 'REMOVED', typeName: E.ITEM_TYPE, properties: [] }], 'delete'); return it.id; }, kinds[1]);
  await A.waitForTimeout(900); const a2 = await digest(A), b2 = await digest(B);
  check(`${label}: live editing carries on after the fold`, a2.seq === a.seq + 1 && b2.h === a2.h && b2.n === a.n - 1 && a2.pend === 0, JSON.stringify([a2, b2, more]));

  // a branch starts from whole files
  const br = await (await fetch(`${BASE}/api/projects/${pid}/branches`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'fold-' + label }) })).json();
  const bid = br.projectId || br.id || (br.branch && (br.branch.projectId || br.branch.id));
  const binfo = bid ? await (await fetch(`${BASE}/api/projects/${bid}/info`, { headers: auth })).json() : { docs: [] };
  const bdoc = (binfo.docs || []).find((d) => d.path === doc.path);
  const bs = bdoc ? await stored(bdoc.docId) : { seq: -1, head: -2, text: '' };
  check(`${label}: a new branch has the design in its file, with nothing to replay`, bs.seq === bs.head && bs.seq === a2.seq && !bs.text.includes(more), JSON.stringify({ bid, seq: bs.seq, head: bs.head }));
  if (bdoc) { const C = await open(bid, bdoc.docId); const c = await digest(C); check(`${label}: the branch opens as the same document`, c.h === a2.h && c.n === a2.n, JSON.stringify(c)); await C.close(); }
  await A.close(); await B.close();
}

if (process.env.FRESH) {
  // a browser stays in the document: the server folds on its own schedule (run the server with SNAPSHOT_FRESH_SECS=5)
  const A = await open(pid, schDoc.docId);
  await A.evaluate(() => { const E = window.CollabEditor; const it = [...E.kdoc.items.values()].filter((i) => i.kind === 'wire')[11]; E.api.commitChanges([{ id: it.id, kind: 'REMOVED', typeName: E.ITEM_TYPE, properties: [] }], 'delete'); });
  await A.waitForTimeout(800); const a = await digest(A); const t0 = Date.now(); let s;
  do { await A.waitForTimeout(2000); s = await stored(schDoc.docId); } while (s.seq < a.seq && Date.now() - t0 < 30000);
  check('with a browser still in the document, the file catches up on the server\'s schedule', s.seq === a.seq, `${Math.round((Date.now() - t0) / 1000)} s, seq ${s.seq} of ${a.seq}`);
  const a2 = await digest(A); check('and that browser is undisturbed', a2.h === a.h && a2.seq === a.seq && a2.pend === 0);
  await A.close();
}
if (process.env.REAP) {
  // everyone has left: within the reap time (60 s) the last edit is folded too
  const A = await open(pid, schDoc.docId);
  await A.evaluate(() => { const E = window.CollabEditor; const it = [...E.kdoc.items.values()].filter((i) => i.kind === 'wire')[13]; E.api.commitChanges([{ id: it.id, kind: 'REMOVED', typeName: E.ITEM_TYPE, properties: [] }], 'delete'); });
  await A.waitForTimeout(800); const want = (await digest(A)).seq; await A.close();
  const left = await stored(schDoc.docId); check('an edit is made and the browser leaves', left.head === want && left.seq < want, JSON.stringify({ seq: left.seq, head: left.head }));
  const t0 = Date.now(); let s;
  do { await new Promise((r) => setTimeout(r, 5000)); s = await stored(schDoc.docId); } while (s.seq < want && Date.now() - t0 < 100000);
  check('after everyone leaves, the file catches up by itself', s.seq === want && s.head === want, `${Math.round((Date.now() - t0) / 1000)} s, seq ${s.seq} of ${want}`);
}
console.log(`${pass} passed, ${fail} failed; errors ${JSON.stringify(errs)}`);
await browser.close(); await db.query('DELETE FROM projects WHERE id=$1 OR parent_id=$1', [pid]); await db.end();
process.exit(fail || errs.length ? 1 : 0);
