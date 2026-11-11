// End-to-end test of version history and branches (server/src/versions.rs).
//
// Two people on real WebSockets: versions, the timeline, a document at any point of
// its history, restore (and taking a restore back), branches, merging both ways,
// conflicts, replacing, and what a reconnecting client is handed after a restore.
//
// Run against a LOCAL server and a THROWAWAY database (same set-up as e2e.mjs):
//
//   E2E_PG_URL=postgres://postgres:test@127.0.0.1:5432/collabtest \
//   E2E_JWT_SECRET=testsecret node versions-e2e.mjs
//
import crypto from 'node:crypto';
import pg from 'pg';

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const SECRET = process.env.E2E_JWT_SECRET;
const PG_URL = process.env.E2E_PG_URL;
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintJwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL });
await db.connect();
const mkUser = async (ghId, login) => (await db.query(
  `INSERT INTO users (github_id, login, name) VALUES ($1, $2, $2)
   ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [ghId, login])).rows[0].id;
const aliceId = await mkUser(-9101, 'ver-alice'), bobId = await mkUser(-9102, 'ver-bob'), eveId = await mkUser(-9103, 'ver-eve');
const alice = mintJwt(aliceId, 'ver-alice'), bob = mintJwt(bobId, 'ver-bob'), eve = mintJwt(eveId, 'ver-eve');

const call = async (token, method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch { /* no body */ }
  return { status: r.status, json };
};

function connect(token, clientId) {
  const ws = new WebSocket(WS);
  const inbox = [], waiters = [];
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', proto: 1, token, clientId, client: 'web' }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data); inbox.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].pred(m)) { waiters[i].resolve(m); waiters.splice(i, 1); }
  };
  let n = 0;
  const api = {
    inbox,
    send: (m) => ws.send(JSON.stringify(m)),
    wait: (pred, ms = 8000) => new Promise((resolve, reject) => {
      const hit = inbox.find(pred); if (hit) return resolve(hit);
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error(`${clientId}: timeout`)), ms);
    }),
    /** Send one op and wait for its ack; returns the seq. */
    op: async (docId, changes) => {
      const id = `${clientId}:${++n}`;
      ws.send(JSON.stringify({ type: 'op', docId, clientOpId: id, changes }));
      return (await api.wait((m) => m.type === 'ack' && m.clientOpId === id)).seq;
    },
    join: async (docId, sinceSeq) => {
      const mark = inbox.length;
      ws.send(JSON.stringify({ type: 'join_doc', docId, ...(sinceSeq === undefined ? {} : { sinceSeq }) }));
      return api.wait((m) => inbox.indexOf(m) >= mark && (m.type === 'snapshot' || m.type === 'ops') && m.docId === docId);
    },
    clear: () => { inbox.length = 0; },
    close: () => { try { ws.close(); } catch { /* closed */ } },
  };
  return api;
}

// A tiny model of what a client does with a document: the items by uuid.
const R1 = '11111111-1111-1111-1111-111111111111', R2 = '22222222-2222-2222-2222-222222222222', R3 = '33333333-3333-3333-3333-333333333333';
const move = (id, x) => ({ id, typeName: 'PCB_FOOTPRINT', kind: 'MODIFIED', properties: [{ name: 'Position X', after: { type: 'int', v: x } }] });
const add = (id, ref) => ({ id, typeName: 'PCB_FOOTPRINT', kind: 'ADDED', sexpr: `(footprint "R" (uuid "${id}") (property "Reference" "${ref}") (at 0 0))` });
const del = (id) => ({ id, typeName: 'PCB_FOOTPRINT', kind: 'REMOVED' });
function build(file, ops) {
  const items = new Map();
  for (const m of file.matchAll(/\(uuid "([0-9a-f-]+)"\)/g)) items.set(m[1], { x: 0 });
  for (const op of ops) for (const c of op.changes) {
    if (c.kind === 'ADDED') items.set(c.id, { x: 0 });
    else if (c.kind === 'REMOVED') items.delete(c.id);
    else if (items.has(c.id)) for (const p of c.properties || []) if (p.name === 'Position X') items.get(c.id).x = p.after.v;
  }
  return Object.fromEntries([...items].sort().map(([k, v]) => [k.slice(0, 1), v.x]));
}
const at = async (docId, seq = 'head') => {
  const r = await call(alice, 'GET', `/api/docs/${docId}/at/${seq}`);
  return r.status === 200 ? build(r.json.file, r.json.ops) : { status: r.status, code: r.json?.error };
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- a project ----------
const pcb = `(kicad_pcb (version 20260101) (generator "e2e")\n  (footprint "R" (uuid "${R1}") (property "Reference" "R1") (at 0 0))\n  (footprint "R" (uuid "${R2}") (property "Reference" "R2") (at 0 0))\n)\n`;
const form = new FormData();
form.append('file', new Blob([pcb]), 'ver.kicad_pcb');
form.append('file', new Blob(['{"meta":{"version":1}}']), 'ver.kicad_pro');
form.append('name', 'versions-e2e');
const up = await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { Authorization: `Bearer ${alice}` }, body: form });
const project = await up.json();
const pid = project.projectId;
const board = project.docs?.find((d) => d.docType === 'kicad_pcb');
const pro = project.docs?.find((d) => d.docType === 'kicad_pro');
check('project uploaded', up.status === 200 && !!board && !!pro, JSON.stringify(project).slice(0, 160));
await db.query(`INSERT INTO permissions (project_id, user_id, role) VALUES ($1, $2, 'editor')`, [pid, bobId]);

const A = connect(alice, 'a1'), B = connect(bob, 'b1');
await A.wait((m) => m.type === 'hello_ok'); await B.wait((m) => m.type === 'hello_ok');
await A.join(board.docId); await B.join(board.docId);

// ---------- versions ----------
await A.op(board.docId, [move(R1, 100)]);                       // seq 1
await B.op(board.docId, [move(R2, 200)]);                       // seq 2
B.clear();
const v1 = await call(alice, 'POST', `/api/projects/${pid}/versions`, { name: 'First layout', description: 'both resistors placed' });
check('a version is created', v1.status === 200 && !!v1.json.id, JSON.stringify(v1.json));
const note = await B.wait((m) => m.type === 'versions').catch(() => null);
check('everyone connected is told at once (no refresh)', note?.projectId === pid && note?.what === 'version', JSON.stringify(note));
const empty = await call(alice, 'POST', `/api/projects/${pid}/versions`, { name: '   ' });
check('a version needs a name', empty.status === 400);
const eveTry = await call(eve, 'POST', `/api/projects/${pid}/versions`, { name: 'nope' });
check('a stranger cannot create one', eveTry.status === 403, `got ${eveTry.status}`);

await A.op(board.docId, [move(R1, 111)]);                       // 3
await A.op(board.docId, [add(R3, 'R3')]);                       // 4
await A.op(board.docId, [move(R3, 300)]);                       // 5
const v2 = await call(bob, 'POST', `/api/projects/${pid}/versions`, { name: 'First layout' });
check('a second version may reuse a name', v2.status === 200 && v2.json.id !== v1.json.id);

const list = (await call(bob, 'GET', `/api/projects/${pid}/versions`)).json.versions;
const lv1 = list.find((v) => v.id === v1.json.id), lv2 = list.find((v) => v.id === v2.json.id);
check('versions are listed newest first with their author', list[0].id === v2.json.id && lv1.author.login === 'ver-alice' && lv2.author.login === 'ver-bob');
check('a version pins every file at its own point', lv1.docs.length === 2 && lv1.docs.find((d) => d.docId === board.docId).seq === 2 && lv2.docs.find((d) => d.docId === board.docId).seq === 5, JSON.stringify(lv1.docs));
check('a version carries its own date, not its file\'s', Math.abs(Date.now() - new Date(lv1.createdAt).getTime()) < 60000);
const legacy = (await call(alice, 'GET', `/api/projects/${pid}/checkpoints`)).json.checkpoints;
check('the old checkpoint list still answers', legacy.filter((c) => c.name === 'First layout').length === 4, `${legacy.length} rows`);

// ---------- a document at any point ----------
check('the document as it is now', same(await at(board.docId), { 1: 111, 2: 200, 3: 300 }), JSON.stringify(await at(board.docId)));
check('the document at an earlier edit', same(await at(board.docId, 2), { 1: 100, 2: 200 }), JSON.stringify(await at(board.docId, 2)));
check('the document as uploaded', same(await at(board.docId, 0), { 1: 0, 2: 0 }));
check('a point past the head does not exist', (await at(board.docId, 99)).status === 404);
const eveAt = await call(eve, 'GET', `/api/docs/${board.docId}/at/head`);
check('history of a private project is private', eveAt.status === 403, `got ${eveAt.status}`);

const hist = (await call(alice, 'GET', `/api/docs/${board.docId}/history`)).json;
check('the edit index lists every edit with its author', hist.seqs.join() === '1,2,3,4,5' && hist.floor === 0 && hist.people.length === 2 && hist.who[1] !== hist.who[0], JSON.stringify(hist).slice(0, 200));
const tl = (await call(alice, 'GET', `/api/projects/${pid}/timeline`)).json;
check('the timeline groups edits into runs per person', tl.runs.length === 3 && tl.runs[0].author.login === 'ver-alice' && tl.runs[0].from === 3 && tl.runs[0].to === 5 && tl.runs[0].count === 3, JSON.stringify(tl.runs.map((r) => [r.from, r.to, r.author.login])));
check('the timeline carries the versions and the files', tl.versions.length === 2 && tl.docs.length === 2 && tl.docs.find((d) => d.docId === board.docId).head === 5);

// ---------- rename, describe, delete ----------
const ren = await call(bob, 'PATCH', `/api/projects/${pid}/versions/${v2.json.id}`, { name: 'Three resistors', description: 'R3 added' });
const after = (await call(bob, 'GET', `/api/projects/${pid}/versions`)).json.versions.find((v) => v.id === v2.json.id);
check('a version can be renamed and described', ren.status === 200 && after.name === 'Three resistors' && after.description === 'R3 added');

// ---------- restore ----------
A.clear(); B.clear();
const rs = await call(bob, 'POST', `/api/projects/${pid}/versions/${v1.json.id}/restore`);
check('an editor can restore a version', rs.status === 200 && rs.json.docs.length === 1, JSON.stringify(rs.json));
const reset = await A.wait((m) => m.type === 'reset').catch(() => null);
check('everyone in the document is told to start over', !!reset && reset.docId === board.docId, JSON.stringify(reset));
check('the document now reads as the version did', same(await at(board.docId), { 1: 100, 2: 200 }), JSON.stringify(await at(board.docId)));
A.send({ type: 'resync', docId: board.docId });
const fresh = await A.wait((m) => m.type === 'snapshot' && A.inbox.indexOf(m) > A.inbox.indexOf(reset));
check('a resync hands out the restored state', same(build(fresh.file, fresh.thenOps), { 1: 100, 2: 200 }), `snapshot seq ${fresh.seq}, ${fresh.thenOps.length} ops`);
const afterRestore = (await call(alice, 'GET', `/api/projects/${pid}/versions`)).json.versions;
const beforeV = afterRestore.find((v) => v.kind === 'auto');
check('what was there before is kept by itself', !!beforeV && beforeV.name === 'Before restoring "First layout"', JSON.stringify(afterRestore.map((v) => [v.kind, v.name])));
check('nothing of the history is lost by a restore', same(await at(board.docId, 5), { 1: 111, 2: 200, 3: 300 }));

// a client that was away during the restore must not be caught up op by op
const C = connect(alice, 'a2'); await C.wait((m) => m.type === 'hello_ok');
const stale = await C.join(board.docId, 5);
check('a client that was away gets the whole document, not a tail of ops', stale.type === 'snapshot' && same(build(stale.file, stale.thenOps), { 1: 100, 2: 200 }), stale.type);
C.close();

// edits go on after a restore
const s = await A.op(board.docId, [move(R2, 222)]);
const got = await B.wait((m) => m.type === 'op' && m.seq === s).catch(() => null);
check('editing goes on after a restore', !!got && same(await at(board.docId), { 1: 100, 2: 222 }), `seq ${s}`);

// take the restore back
const undo = await call(alice, 'POST', `/api/projects/${pid}/restore`, { versionId: beforeV.id });
check('a restore can be taken back', undo.status === 200 && same(await at(board.docId), { 1: 111, 2: 200, 3: 300 }), JSON.stringify(await at(board.docId)));
const nowV = await call(alice, 'POST', `/api/projects/${pid}/versions`, { name: 'as it is' });
const again = await call(alice, 'POST', `/api/projects/${pid}/restore`, { versionId: nowV.json.id });
check('restoring what is already there does nothing', again.status === 200 && again.json.docs.length === 0);
await call(alice, 'DELETE', `/api/projects/${pid}/versions/${nowV.json.id}`);
const old = await call(alice, 'POST', `/api/projects/${pid}/restore`, { name: 'First layout' });
check('the old restore-by-name call still works', old.status === 200 && same(await at(board.docId), { 1: 100, 2: 200 }));

// restore to a point that is not a version (the scrubber)
const pt = await call(alice, 'POST', `/api/projects/${pid}/restore`, { at: { docId: board.docId, seq: 4 }, label: 'a point' });
check('any point of the timeline can be restored', pt.status === 200 && same(await at(board.docId), { 1: 111, 2: 200, 3: 0 }), JSON.stringify(await at(board.docId)));
const named = await call(alice, 'POST', `/api/projects/${pid}/versions`, { name: 'From the past', at: { docId: board.docId, seq: 1 } });
const fromPast = (await call(alice, 'GET', `/api/projects/${pid}/versions`)).json.versions.find((v) => v.id === named.json.id);
check('any point can be named as a version', named.status === 200 && fromPast.docs.find((d) => d.docId === board.docId).seq === 1);
const tl2 = (await call(alice, 'GET', `/api/projects/${pid}/timeline`)).json;
check('restores show in the timeline as restores', tl2.runs.some((r) => r.kind === 'restore'), JSON.stringify(tl2.runs.map((r) => r.kind)));

const rm = await call(alice, 'DELETE', `/api/projects/${pid}/versions/${named.json.id}`);
check('a version can be deleted', rm.status === 200 && !(await call(alice, 'GET', `/api/projects/${pid}/versions`)).json.versions.some((v) => v.id === named.json.id));

// viewers
await db.query(`INSERT INTO permissions (project_id, user_id, role) VALUES ($1, $2, 'viewer')`, [pid, eveId]);
check('a viewer can read the history', (await call(eve, 'GET', `/api/projects/${pid}/timeline`)).status === 200 && (await call(eve, 'GET', `/api/docs/${board.docId}/at/1`)).status === 200);
check('a viewer cannot restore', (await call(eve, 'POST', `/api/projects/${pid}/restore`, { versionId: v1.json.id })).status === 403);
check('a viewer cannot branch', (await call(eve, 'POST', `/api/projects/${pid}/branches`, { name: 'x' })).status === 403);

// ---------- branches ----------
// main is now { R1: 111, R2: 200, R3: 0 }
const main0 = await at(board.docId);
B.clear();
const br = await call(alice, 'POST', `/api/projects/${pid}/branches`, { name: 'try-tight-layout', description: 'pack the resistors' });
check('a branch is created', br.status === 200 && !!br.json.projectId, JSON.stringify(br.json));
check('everyone is told about the new branch', !!(await B.wait((m) => m.type === 'versions' && m.what === 'branch').catch(() => null)));
const bid = br.json.projectId;
const dup = await call(bob, 'POST', `/api/projects/${pid}/branches`, { name: 'Try-Tight-Layout' });
check('two branches cannot share a name', dup.status === 409, `got ${dup.status}`);
check('"main" is not a branch name', (await call(bob, 'POST', `/api/projects/${pid}/branches`, { name: 'main' })).status === 400);
let bl = (await call(bob, 'GET', `/api/projects/${pid}/branches`)).json;
const binfo = bl.branches[0];
const bboard = binfo.docs.find((d) => d.docType === 'kicad_pcb'), bpro = binfo.docs.find((d) => d.docType === 'kicad_pro');
check('the branch lists with its files and who made it', bl.branches.length === 1 && binfo.name === 'try-tight-layout' && binfo.createdBy.login === 'ver-alice' && binfo.docs.length === 2 && binfo.ahead === 0 && binfo.behind === 0, JSON.stringify(binfo).slice(0, 300));
check('the branch starts as the main line is', same(await at(bboard.docId), main0), JSON.stringify(await at(bboard.docId)));
check('members of the project can open the branch', (await call(bob, 'GET', `/api/projects/${bid}`)).json?.role === 'editor' && (await call(eve, 'GET', `/api/projects/${bid}`)).json?.role === 'viewer');
const stranger = mintJwt(await mkUser(-9104, 'ver-mallory'), 'ver-mallory');
check('a stranger cannot', (await call(stranger, 'GET', `/api/projects/${bid}`)).status === 403);
const mine = (await call(alice, 'GET', '/api/projects')).json;
check('a branch is not a project in the list', (mine.projects || mine).filter((p) => p.name === 'versions-e2e').length === 1, JSON.stringify((mine.projects || mine).map((p) => p.name)));
check('a branch cannot be branched', (await call(alice, 'POST', `/api/projects/${bid}/branches`, { name: 'deeper' })).status === 400);
check('asking from inside the branch gives the same family', (await call(bob, 'GET', `/api/projects/${bid}/branches`)).json.main.projectId === pid);

// work in the branch, with main untouched
const BA = connect(alice, 'a3'); await BA.wait((m) => m.type === 'hello_ok'); await BA.join(bboard.docId);
await BA.op(bboard.docId, [move(R1, 10)]);
await BA.op(bboard.docId, [move(R3, 30)]);
await BA.op(bboard.docId, [del(R2)]);
check('edits in the branch stay in the branch', same(await at(bboard.docId), { 1: 10, 3: 30 }) && same(await at(board.docId), main0));
// and main moves on too: R1 (both sides) and R2 (deleted in the branch)
await B.op(board.docId, [move(R1, 999)]);
bl = (await call(bob, 'GET', `/api/projects/${pid}/branches`)).json;
check('ahead and behind are counted', bl.branches[0].ahead === 3 && bl.branches[0].behind === 1, `${bl.branches[0].ahead}/${bl.branches[0].behind}`);

// preview
const dry = await call(bob, 'POST', `/api/projects/${bid}/merge`, { direction: 'into_main', dryRun: true });
const dboard = dry.json.docs.find((d) => d.path === 'ver.kicad_pcb');
check('a merge is previewed without changing anything', dry.status === 200 && dry.json.canMerge && dboard.ops === 3 && same(await at(board.docId), { 1: 999, 2: 200, 3: 0 }), JSON.stringify(dry.json).slice(0, 300));
check('items both sides changed are named', dry.json.conflicts === 1 && dboard.conflicts[0].label === 'footprint 11111111', JSON.stringify(dboard.conflicts));

// bring main's work into the branch first, keeping the branch's side of the conflict
const fm = await call(alice, 'POST', `/api/projects/${bid}/merge`, { direction: 'from_main', prefer: 'current' });
check('main\'s newer work comes into the branch, the branch keeping its own side', fm.status === 200 && fm.json.merged && same(await at(bboard.docId), { 1: 10, 3: 30 }), JSON.stringify(await at(bboard.docId)));
await B.op(board.docId, [move(R3, 333)]);
const fm2 = await call(alice, 'POST', `/api/projects/${bid}/merge`, { direction: 'from_main' });
const live = await BA.wait((m) => m.type === 'op' && m.changes?.[0]?.id === R3 && m.changes[0].properties?.[0]?.after?.v === 333).catch(() => null);
check('people in the branch see merged work arrive live', fm2.status === 200 && !!live && same(await at(bboard.docId), { 1: 10, 3: 333 }), JSON.stringify(await at(bboard.docId)));
bl = (await call(bob, 'GET', `/api/projects/${pid}/branches`)).json;
check('the branch is no longer behind', bl.branches[0].behind === 0 && bl.branches[0].ahead === 3, `${bl.branches[0].ahead}/${bl.branches[0].behind}`);

// merge into main
await BA.op(bboard.docId, [move(R3, 31)]);
A.clear();
const mg = await call(bob, 'POST', `/api/projects/${bid}/merge`, { direction: 'into_main' });
check('the branch merges into main', mg.status === 200 && mg.json.merged, JSON.stringify(mg.json).slice(0, 200));
const arrived = await A.wait((m) => m.type === 'op' && m.changes?.[0]?.kind === 'REMOVED').catch(() => null);
check('people on main see the merge arrive live', !!arrived);
check('main now has the branch\'s work', same(await at(board.docId), { 1: 10, 3: 31 }), JSON.stringify(await at(board.docId)));
const mv = (await call(alice, 'GET', `/api/projects/${pid}/versions`)).json.versions;
check('main as it was before the merge is kept', mv.some((v) => v.kind === 'auto' && v.name === 'Before merging "try-tight-layout"'));
bl = (await call(bob, 'GET', `/api/projects/${pid}/branches`)).json;
check('a merged branch is neither ahead nor behind', bl.branches[0].ahead === 0 && bl.branches[0].behind === 0 && !!bl.branches[0].mergedAt, `${bl.branches[0].ahead}/${bl.branches[0].behind}`);
const noop = await call(bob, 'POST', `/api/projects/${bid}/merge`, { direction: 'into_main' });
check('merging again does nothing', noop.status === 200 && noop.json.merged === false);
const back = await call(bob, 'POST', `/api/projects/${bid}/merge`, { direction: 'from_main', dryRun: true });
check('merged work does not bounce back', back.json.nothing === true, JSON.stringify(back.json).slice(0, 200));
const tl3 = (await call(alice, 'GET', `/api/projects/${pid}/timeline`)).json;
check('the merge shows in main\'s timeline as a merge', tl3.runs.some((r) => r.kind === 'merge'));

// the branch lives on: more work, merged again, only the new work travels
await BA.op(bboard.docId, [move(R1, 11)]);
const dry2 = await call(bob, 'POST', `/api/projects/${bid}/merge`, { direction: 'into_main', dryRun: true });
check('a later merge carries only the new work', dry2.json.docs.find((d) => d.path === 'ver.kicad_pcb').ops === 1 && dry2.json.conflicts === 0);
await call(bob, 'POST', `/api/projects/${bid}/merge`, { direction: 'into_main' });
check('and lands', same(await at(board.docId), { 1: 11, 3: 31 }));

// conflict with main keeping its own
await B.op(board.docId, [move(R1, 5000)]);
await BA.op(bboard.docId, [move(R1, 12)]);
await BA.op(bboard.docId, [move(R3, 32)]);
await call(bob, 'POST', `/api/projects/${bid}/merge`, { direction: 'into_main', prefer: 'current' });
check('main can keep its own side of a conflict and take the rest', same(await at(board.docId), { 1: 5000, 3: 32 }), JSON.stringify(await at(board.docId)));

// a file stored whole
const sendPro = async (docId, sock, text) => {
  const seq = await sock.op(docId, [{ id: 'project', kind: 'MODIFIED', typeName: 'PROJECT_FILE', properties: [] }]);
  const r = await fetch(`${BASE}/api/docs/${docId}/snapshots?seq=${seq}`, { method: 'POST', headers: { Authorization: `Bearer ${alice}`, 'content-type': 'application/octet-stream' }, body: text });
  return r.status;
};
await BA.join(bpro.docId);
check('the project file changes in the branch', await sendPro(bpro.docId, BA, '{"meta":{"version":1},"net_settings":{"branch":true}}') === 200);
const dry3 = await call(bob, 'POST', `/api/projects/${bid}/merge`, { direction: 'into_main', dryRun: true });
check('a changed project file is taken whole', dry3.json.docs.find((d) => d.path === 'ver.kicad_pro').action === 'take' && dry3.json.conflicts === 0, JSON.stringify(dry3.json.docs));
await call(bob, 'POST', `/api/projects/${bid}/merge`, { direction: 'into_main' });
const proNow = await (await fetch(`${BASE}/api/docs/${pro.docId}/content`, { headers: { Authorization: `Bearer ${alice}` } })).text();
check('main has the branch\'s project file', proNow.includes('"branch":true'), proNow);

// a restore inside the branch: replaying is refused, replacing works
const bver = await call(alice, 'POST', `/api/projects/${bid}/versions`, { name: 'branch point' });
await BA.op(bboard.docId, [move(R1, 77)]);
await call(alice, 'POST', `/api/projects/${bid}/restore`, { versionId: bver.json.id });
await BA.join(bboard.docId);
await BA.op(bboard.docId, [move(R3, 88)]);
const dry4 = await call(bob, 'POST', `/api/projects/${bid}/merge`, { direction: 'into_main', dryRun: true });
check('after a restore in the branch the preview says replaying is not possible', dry4.json.canMerge === false && typeof dry4.json.reason === 'string', JSON.stringify(dry4.json).slice(0, 200));
const refused = await call(bob, 'POST', `/api/projects/${bid}/merge`, { direction: 'into_main' });
check('and a replay is refused', refused.status === 409 && refused.json.error === 'not_linear', `got ${refused.status}`);
const rep = await call(bob, 'POST', `/api/projects/${bid}/merge`, { direction: 'into_main', mode: 'replace' });
check('main can be replaced by the branch', rep.status === 200 && same(await at(board.docId), await at(bboard.docId)) && same(await at(board.docId), { 1: 12, 3: 88 }), JSON.stringify([await at(board.docId), await at(bboard.docId)]));
await BA.op(bboard.docId, [move(R3, 89)]);
const dry5 = await call(bob, 'POST', `/api/projects/${bid}/merge`, { direction: 'into_main', dryRun: true });
check('after replacing, the two merge normally again', dry5.json.canMerge === true && dry5.json.docs.find((d) => d.path === 'ver.kicad_pcb').ops === 1, JSON.stringify(dry5.json).slice(0, 200));

// a branch from an earlier version
const br2 = await call(alice, 'POST', `/api/projects/${pid}/branches`, { name: 'from first layout', versionId: v1.json.id });
const b2 = (await call(alice, 'GET', `/api/projects/${pid}/branches`)).json.branches.find((b) => b.projectId === br2.json.projectId);
check('a branch can start from an earlier version', br2.status === 200 && same(await at(b2.docs.find((d) => d.docType === 'kicad_pcb').docId), { 1: 100, 2: 200 }));
const ren2 = await call(bob, 'PATCH', `/api/projects/${pid}/branches/${br2.json.projectId}`, { name: 'old layout' });
check('a branch can be renamed', ren2.status === 200 && (await call(alice, 'GET', `/api/projects/${pid}/branches`)).json.branches.some((b) => b.name === 'old layout'));
check('but not onto a name in use', (await call(bob, 'PATCH', `/api/projects/${pid}/branches/${br2.json.projectId}`, { name: 'try-tight-layout' })).status === 409);

// delete
const dl = await call(bob, 'DELETE', `/api/projects/${pid}/branches/${br2.json.projectId}`);
check('a branch can be deleted', dl.status === 200 && (await call(alice, 'GET', `/api/projects/${pid}/branches`)).json.branches.length === 1 && (await call(alice, 'GET', `/api/projects/${br2.json.projectId}`)).status !== 200);
check('its name is free again', (await call(alice, 'POST', `/api/projects/${pid}/branches`, { name: 'old layout' })).status === 200);

// pruning keeps what versions and branches need
await db.query(`UPDATE ops SET created_at = now() - interval '40 days' WHERE doc_id = ANY($1)`, [[board.docId, bboard.docId]]);
await db.query(`UPDATE snapshots SET created_at = now() - interval '40 days' WHERE doc_id = ANY($1)`, [[board.docId, bboard.docId]]);
const before = { v1: await at(board.docId, 2), head: await at(board.docId), bhead: await at(bboard.docId) };
// the same statements the server's hourly prune runs
const src = (await import('node:fs')).readFileSync(new URL('../src/persist.rs', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('pub async fn prune('));
const stmts = [...body.slice(0, body.indexOf('\n}\n')).matchAll(/"(DELETE FROM (?:ops|snapshots)[^"]*)"/g)].map((m) => m[1]);
let pruned = 0;
for (const q of stmts) pruned += (await db.query(q)).rowCount;
check('pruning ran', stmts.length === 2, `${stmts.length} statements, ${pruned} rows`);
check('kept versions, the head and the branch survive pruning', same(await at(board.docId, 2), before.v1) && same(await at(board.docId), before.head) && same(await at(bboard.docId), before.bhead));
const dry6 = await call(bob, 'POST', `/api/projects/${bid}/merge`, { direction: 'into_main', dryRun: true });
check('and the branch still merges', dry6.json.canMerge === true && dry6.json.docs.find((d) => d.path === 'ver.kicad_pcb').ops === 1);

// ---------- clean up ----------
A.close(); B.close(); BA.close();
await db.query(`DELETE FROM projects WHERE id = $1`, [pid]);
await db.query(`DELETE FROM users WHERE github_id IN (-9101, -9102, -9103, -9104)`);
await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
