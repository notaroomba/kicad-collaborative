// End-to-end test of the collaboration op pipeline.
//
// Drives two WebSocket clients through the real join -> op -> ack -> broadcast
// flow, plus sharing, roles, presence and version history. It mints tokens
// directly (bypassing the browser OAuth leg) for test users it creates in the
// database, and deletes them afterwards.
//
// Run it against a LOCAL server and a THROWAWAY database — it writes to both:
//
//   docker run -d --name collabtest -e POSTGRES_PASSWORD=test \
//     -e POSTGRES_DB=collabtest -p 55432:5432 postgres:16-alpine
//
//   DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/collabtest \
//   JWT_SECRET=testsecret PUBLIC_URL=http://127.0.0.1:8099 PORT=8099 \
//     cargo run --manifest-path server/Cargo.toml
//
//   cd server/scripts && npm install pg && \
//   E2E_PG_URL=postgres://postgres:test@127.0.0.1:55432/collabtest \
//   E2E_JWT_SECRET=testsecret node e2e.mjs
//
import crypto from 'node:crypto';
import pg from 'pg';

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const WS = BASE.replace(/^http/, 'ws') + '/ws';
// With E2E_BASE_B set, everything Bob does over the socket goes through a second replica
// of the server (same database), so every exchange below also crosses replicas.
const BASE_B = (process.env.E2E_BASE_B || BASE).replace(/\/$/, '');
const WS_B = BASE_B.replace(/^http/, 'ws') + '/ws';
const SECRET = process.env.E2E_JWT_SECRET;
const PG_URL = process.env.E2E_PG_URL;

if (!SECRET || !PG_URL) {
  console.error('E2E_JWT_SECRET and E2E_PG_URL are required (see the header comment).');
  process.exit(2);
}

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintJwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub, login, iat: now, exp: now + 3600 });
  const sig = crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

// --- test users (cleaned up at the end) ---
const local = PG_URL.includes('127.0.0.1') || PG_URL.includes('localhost');
// node-postgres returns int8 as a string to avoid precision loss, but user ids
// here are small and the server's JWT claim is a number, so parse them back.
pg.types.setTypeParser(20, (v) => parseInt(v, 10));

const client = new pg.Client({
  connectionString: PG_URL,
  ssl: local ? false : { rejectUnauthorized: false },
});
await client.connect();
const mkUser = async (ghId, login) => {
  const r = await client.query(
    `INSERT INTO users (github_id, login, name) VALUES ($1, $2, $3)
     ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`,
    [ghId, login, login]);
  return r.rows[0].id;
};
const aliceId = await mkUser(-9001, 'e2e-alice');
const bobId = await mkUser(-9002, 'e2e-bob');
const alice = mintJwt(aliceId, 'e2e-alice');
const bob = mintJwt(bobId, 'e2e-bob');

const me = await fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${alice}` } });
check('minted token authenticates', me.status === 200, `got ${me.status}`);

// --- upload a project (a real minimal schematic) ---
const sch = `(kicad_sch (version 20260101) (generator "e2e")
  (symbol (lib_id "Device:R") (at 100 100 0) (uuid "11111111-1111-1111-1111-111111111111")))`;
const zip = await makeZip([['test.kicad_sch', sch], ['test.kicad_pro', '{}']]);
const form = new FormData();
form.append('archive', new Blob([zip], { type: 'application/zip' }), 'project.zip');
form.append('name', 'e2e-project');
const created = await fetch(`${BASE}/api/projects`, {
  method: 'POST', headers: { Authorization: `Bearer ${alice}` }, body: form });
const project = await created.json();
check('project upload accepted', created.status === 200 && !!project.projectId, JSON.stringify(project).slice(0, 200));
const doc = project.docs?.find(d => d.docType === 'kicad_sch');
check('schematic document registered', !!doc, JSON.stringify(project.docs));

// --- share link + claim by a second user ---
const linkRes = await fetch(`${BASE}/api/projects/${project.projectId}/links`, {
  method: 'POST', headers: { Authorization: `Bearer ${alice}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ role: 'editor' }) });
const link = await linkRes.json();
check('share link created', linkRes.status === 200 && link.url?.includes('/j/'), link.url);

const bobNoAccess = await fetch(`${BASE}/api/projects/${project.projectId}`, {
  headers: { Authorization: `Bearer ${bob}` } });
check('non-member is denied before claiming the link', bobNoAccess.status === 403, `got ${bobNoAccess.status}`);

const claim = await fetch(`${BASE}/api/join/${link.token}`, {
  method: 'POST', headers: { Authorization: `Bearer ${bob}` } });
check('link claim grants access', claim.status === 200, `got ${claim.status}`);

// --- websocket helper ---
// Sends `hello` from the open handler rather than awaiting open separately, so
// the socket is never left idle against the server's handshake timeout.
function connect(token, clientId, label) {
  const ws = new WebSocket(label === 'alice' ? WS : WS_B);
  const inbox = [];
  const waiters = [];
  let closed = null;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', proto: 1, token, clientId }));
  ws.onclose = (e) => {
    closed = `closed (code ${e.code}${e.reason ? ', ' + e.reason : ''})`;
    for (const w of waiters.splice(0)) w.reject(new Error(`${label}: ${closed}`));
  };
  ws.onerror = () => { closed = closed || 'socket error'; };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    inbox.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(m)) { waiters[i].resolve(m); waiters.splice(i, 1); }
    }
  };
  const api = {
    ws, inbox,
    send: (m) => ws.send(JSON.stringify(m)),
    wait: (pred, ms = 15000) => new Promise((resolve, reject) => {
      const hit = inbox.find(pred);
      if (hit) return resolve(hit);
      if (closed) return reject(new Error(`${label}: ${closed}`));
      const w = { pred, resolve, reject };
      waiters.push(w);
      setTimeout(() => reject(new Error(`${label}: timeout waiting for a message`)), ms);
    }),
    close: () => { try { ws.close(); } catch {} },
  };
  return api;
}

const A = connect(alice, 'alice-1', 'alice');
const B = connect(bob, 'bob-1', 'bob');
const aHello = await A.wait(m => m.type === 'hello_ok');
const bHello = await B.wait(m => m.type === 'hello_ok');
check('both clients complete the handshake', !!aHello && !!bHello);
check('server namespaces clientId by user id (impersonation fix)',
  aHello.clientId === `${aliceId}:alice-1`, aHello.clientId);
check('peers get distinct colors', aHello.color !== bHello.color, `${aHello.color} vs ${bHello.color}`);

A.send({ type: 'join_doc', docId: doc.docId });
const aInfo = await A.wait(m => m.type === 'doc_info');
check('join returns doc_info with role', aInfo.role === 'editor', JSON.stringify(aInfo).slice(0, 160));
const aSnap = await A.wait(m => m.type === 'snapshot');
check('cold join receives the uploaded file as a snapshot',
  aSnap.file?.includes('kicad_sch') && aSnap.seq === 0, `seq=${aSnap.seq}`);

B.send({ type: 'join_doc', docId: doc.docId });
await B.wait(m => m.type === 'snapshot');
const peerJoined = await A.wait(m => m.type === 'peer_joined');
check('existing peer is told about the new joiner', peerJoined.peer?.login === 'e2e-bob',
  JSON.stringify(peerJoined.peer));

// --- the actual op round trip ---
const changes = [{
  id: '11111111-1111-1111-1111-111111111111',
  typeName: 'SCH_SYMBOL', kind: 'MODIFIED', screen: 'test.kicad_sch',
  properties: [{ name: 'Position X', before: { type: 'int', v: 1016000 }, after: { type: 'int', v: 1027430 } }],
}];
A.send({ type: 'op', docId: doc.docId, clientOpId: 'alice-1:1', changes });
const ack = await A.wait(m => m.type === 'ack');
check('author receives an ack with a sequence number', ack.seq === 1 && ack.clientOpId === 'alice-1:1',
  JSON.stringify(ack));
const bcast = await B.wait(m => m.type === 'op');
check('peer receives the op with the same seq', bcast.seq === 1, JSON.stringify(bcast).slice(0, 120));
check('broadcast preserves the property delta',
  bcast.changes?.[0]?.properties?.[0]?.after?.v === 1027430);
check('broadcast attributes the author', bcast.author?.login === 'e2e-alice', JSON.stringify(bcast.author));
check('author does not receive its own op back', !A.inbox.some(m => m.type === 'op' && m.seq === 1));

// --- idempotent resubmit (the reconnect-replay path) ---
A.send({ type: 'op', docId: doc.docId, clientOpId: 'alice-1:1', changes });
const reack = await A.wait(m => m.type === 'ack' && m !== ack);
check('resubmitting the same clientOpId re-acks the original seq', reack.seq === 1, JSON.stringify(reack));
const secondOp = B.inbox.filter(m => m.type === 'op' && m.seq === 1).length;
check('resubmit is not re-broadcast', secondOp === 1, `${secondOp} broadcasts`);

// --- sequencing from the second client ---
B.send({ type: 'op', docId: doc.docId, clientOpId: 'bob-1:1', changes });
const bAck = await B.wait(m => m.type === 'ack');
check('second client gets the next sequence number', bAck.seq === 2, JSON.stringify(bAck));

// --- presence ---
B.send({ type: 'presence', docId: doc.docId,
         state: { cursor: [1016000, 508000], selection: ['11111111-1111-1111-1111-111111111111'],
                  sheetFile: 'test.kicad_sch' } });
const pres = await A.wait(m => m.type === 'presence' && m.peers && Object.values(m.peers).some(p => p?.state));
const entry = Object.values(pres.peers).find(p => p?.state);
check('presence relays cursor + selection to peers',
  entry.state.cursor[0] === 1016000 && entry.user.login === 'e2e-bob', JSON.stringify(entry).slice(0, 160));

const bigPresence = { cursor: [0, 0], pad: 'x'.repeat(9000) };
B.send({ type: 'presence', docId: doc.docId, state: bigPresence });
const presErr = await B.wait(m => m.type === 'error' && m.code === 'bad_message');
check('oversized presence is rejected (amplification fix)', !!presErr);

// --- viewer cannot write ---
await client.query(`UPDATE permissions SET role='viewer' WHERE project_id=$1 AND user_id=$2`,
  [project.projectId, bobId]);
const V = connect(bob, 'bob-viewer', 'viewer');
await V.wait(m => m.type === 'hello_ok');
V.send({ type: 'join_doc', docId: doc.docId });
const vInfo = await V.wait(m => m.type === 'doc_info');
check('downgraded user joins as viewer', vInfo.role === 'viewer', vInfo.role);
V.send({ type: 'op', docId: doc.docId, clientOpId: 'bob-viewer:1', changes });
const vErr = await V.wait(m => m.type === 'error' && m.code === 'permission_denied');
check('viewer edits are rejected', !!vErr);

// --- leave ---
B.close();
const left = await A.wait(m => m.type === 'peer_left', 20000).catch(() => null);
check('disconnect produces peer_left', !!left, left ? left.clientId : 'no peer_left');

// --- version history ---
const cp = await fetch(`${BASE}/api/projects/${project.projectId}/checkpoints`, {
  method: 'POST', headers: { Authorization: `Bearer ${alice}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'e2e-checkpoint' }) });
check('named checkpoint created', cp.status === 200, `got ${cp.status} ${(await cp.text()).slice(0, 120)}`);
const cps = await (await fetch(`${BASE}/api/projects/${project.projectId}/checkpoints`,
  { headers: { Authorization: `Bearer ${alice}` } })).json();
check('checkpoint is listed', cps.checkpoints?.some(c => c.name === 'e2e-checkpoint'));

// --- managing access: the stored-projects UI's endpoints ---
const authA = { Authorization: `Bearer ${alice}` }, authB = { Authorization: `Bearer ${bob}` };
const jsonA = { ...authA, 'Content-Type': 'application/json' }, jsonB = { ...authB, 'Content-Type': 'application/json' };
const listing = await (await fetch(`${BASE}/api/projects`, { headers: authA })).json();
const row = listing.projects?.find(p => p.projectId === project.projectId);
check('listing carries description, member count and owner avatar', !!row && 'description' in row && row.memberCount >= 1 && 'ownerAvatarUrl' in row, JSON.stringify(row));

const asMember = await fetch(`${BASE}/api/projects/${project.projectId}/members`, { headers: authB });
const memberView = await asMember.json();
check('a member can see who has access, read-only', asMember.status === 200 && memberView.canManage === false
  && memberView.owner?.login === 'e2e-alice' && memberView.pending.length === 0, JSON.stringify(memberView).slice(0, 200));

const demote = await fetch(`${BASE}/api/projects/${project.projectId}/members/${bobId}`, {
  method: 'PATCH', headers: jsonA, body: JSON.stringify({ role: 'viewer' }) });
const afterDemote = await (await fetch(`${BASE}/api/projects/${project.projectId}/members`, { headers: authA })).json();
check('owner can change a member\'s role', demote.status === 200 && afterDemote.members.find(m => m.userId === bobId)?.role === 'viewer'
  && afterDemote.canManage === true, `got ${demote.status}`);
const selfPromote = await fetch(`${BASE}/api/projects/${project.projectId}/members/${bobId}`, {
  method: 'PATCH', headers: jsonB, body: JSON.stringify({ role: 'editor' }) });
check('a member cannot change roles', selfPromote.status === 403, `got ${selfPromote.status}`);
const badRole = await fetch(`${BASE}/api/projects/${project.projectId}/members/${bobId}`, {
  method: 'PATCH', headers: jsonA, body: JSON.stringify({ role: 'owner' }) });
check('unknown roles are rejected', badRole.status === 400, `got ${badRole.status}`);
await fetch(`${BASE}/api/projects/${project.projectId}/members/${bobId}`, {
  method: 'PATCH', headers: jsonA, body: JSON.stringify({ role: 'editor' }) });

const inv = await fetch(`${BASE}/api/projects/${project.projectId}/invites`, {
  method: 'POST', headers: jsonA, body: JSON.stringify({ email: 'e2e-nobody@example.invalid', role: 'editor' }) });
const pendingList = (await (await fetch(`${BASE}/api/projects/${project.projectId}/members`, { headers: authA })).json()).pending;
const pendingId = pendingList.find(p => p.email === 'e2e-nobody@example.invalid')?.inviteId;
const invRole = await fetch(`${BASE}/api/projects/${project.projectId}/invites/${pendingId}`, {
  method: 'PATCH', headers: jsonA, body: JSON.stringify({ role: 'viewer' }) });
const pendingAfter = (await (await fetch(`${BASE}/api/projects/${project.projectId}/members`, { headers: authA })).json()).pending;
check('a pending invite\'s role can be changed', inv.status === 200 && invRole.status === 200
  && pendingAfter.find(p => p.inviteId === pendingId)?.role === 'viewer', `invite ${inv.status}, patch ${invRole.status}`);
await fetch(`${BASE}/api/projects/${project.projectId}/invites/${pendingId}`, { method: 'DELETE', headers: authA });

const links = await (await fetch(`${BASE}/api/projects/${project.projectId}/links`, { headers: authA })).json();
check('owner can list the active share links', links.links?.some(l => l.token === link.token && l.role === 'editor'), JSON.stringify(links).slice(0, 160));
const linksAsMember = await fetch(`${BASE}/api/projects/${project.projectId}/links`, { headers: authB });
check('members cannot list share links', linksAsMember.status === 403, `got ${linksAsMember.status}`);
await fetch(`${BASE}/api/links/${link.token}`, { method: 'DELETE', headers: authA });
const linksAfter = await (await fetch(`${BASE}/api/projects/${project.projectId}/links`, { headers: authA })).json();
check('a revoked link drops out of the list', !linksAfter.links?.some(l => l.token === link.token));

// --- upload as loose files (the web's folder upload): a wrapping folder is stripped, stray files are left out ---
const loose = new FormData();
loose.append('name', 'e2e-loose');
loose.append('file', new Blob([sch]), 'board/board.kicad_sch');
loose.append('file', new Blob(['{}']), 'board/board.kicad_pro');
loose.append('file', new Blob([sch]), 'board/sheets/sub.kicad_sch');
loose.append('file', new Blob(['hello']), 'board/README.md');
loose.append('file', new Blob([sch]), 'board/board.collab/base/board.kicad_sch');
const looseRes = await fetch(`${BASE}/api/projects`, { method: 'POST', headers: authA, body: loose });
const looseProject = await looseRes.json();
const loosePaths = (looseProject.docs || []).map(d => d.path).sort().join(',');
check('loose-file upload: folder stripped, non-KiCad and sync-state files left out',
  looseRes.status === 200 && loosePaths === 'board.kicad_pro,board.kicad_sch,sheets/sub.kicad_sch'
  && looseProject.skipped?.join() === 'board/README.md', `${looseRes.status} ${loosePaths} skipped=${looseProject.skipped}`);
const junk = new FormData();
junk.append('file', new Blob(['hello']), 'notes.txt');
const junkRes = await fetch(`${BASE}/api/projects`, { method: 'POST', headers: authA, body: junk });
check('an upload with no KiCad files is refused', junkRes.status === 400, `got ${junkRes.status}`);
const evil = new FormData();
evil.append('file', new Blob([sch]), '../escape.kicad_sch');
const evilRes = await fetch(`${BASE}/api/projects`, { method: 'POST', headers: authA, body: evil });
check('path traversal in a file name is refused', evilRes.status === 400, `got ${evilRes.status}`);

// --- a role change reaches a socket that is already connected ---
// V joined as a viewer; the block above left bob as an editor again.
const mk = (n) => [{ ...changes[0], properties: [{ name: 'Position X', before: { type: 'int', v: 1027430 + n }, after: { type: 'int', v: 1027431 + n } }] }];
V.send({ type: 'op', docId: doc.docId, clientOpId: 'bob-viewer:2', changes: mk(0) });
const upAck = await V.wait(m => m.type === 'ack' && m.clientOpId === 'bob-viewer:2').catch(() => null);
check('a promotion reaches the live session: its next edit is accepted', !!upAck);
await fetch(`${BASE}/api/projects/${project.projectId}/members/${bobId}`, {
  method: 'PATCH', headers: jsonA, body: JSON.stringify({ role: 'viewer' }) });
V.send({ type: 'op', docId: doc.docId, clientOpId: 'bob-viewer:3', changes: mk(1) });
const downErr = await V.wait(m => m.type === 'error' && m.code === 'permission_denied' && m.clientOpId === 'bob-viewer:3').catch(() => null);
check('a demotion reaches the live session: its next edit is refused', !!downErr);

// --- a role the owner picked is not raised again by a share link ---
const edLink = await (await fetch(`${BASE}/api/projects/${project.projectId}/links`, {
  method: 'POST', headers: jsonA, body: JSON.stringify({ role: 'editor' }) })).json();
const reclaim = await (await fetch(`${BASE}/api/join/${edLink.token}`, { method: 'POST', headers: authB })).json();
check('an editor link does not undo the owner\'s demotion', reclaim.role === 'viewer', JSON.stringify(reclaim));
const ownClaim = await fetch(`${BASE}/api/join/${edLink.token}`, { method: 'POST', headers: authA });
const membersNow = await (await fetch(`${BASE}/api/projects/${project.projectId}/members`, { headers: authA })).json();
check('the owner claiming their own link is not listed as a member', ownClaim.status === 200
  && !membersNow.members.some(m => m.userId === membersNow.ownerId));
const visit = await fetch(`${BASE}/j/${edLink.token}`, { headers: { Cookie: `kc_session=${bob}` } });
check('visiting the link page changes nothing by itself', visit.status === 200 && /id="openweb"/.test(await visit.text()));

// --- stars, Trash, blank projects, ownership transfer ---
const star = await fetch(`${BASE}/api/projects/${project.projectId}/star`, { method: 'PUT', headers: authB });
const starredB = (await (await fetch(`${BASE}/api/projects`, { headers: authB })).json()).projects.find(p => p.projectId === project.projectId);
const starredA = (await (await fetch(`${BASE}/api/projects`, { headers: authA })).json()).projects.find(p => p.projectId === project.projectId);
check('a star is per person', star.status === 200 && starredB?.starred === true && starredA?.starred === false);
await fetch(`${BASE}/api/projects/${project.projectId}/star`, { method: 'DELETE', headers: authB });

const blankRes = await fetch(`${BASE}/api/projects/blank`, { method: 'POST', headers: jsonA, body: JSON.stringify({ name: 'E2E blank: one/two' }) });
const blank = await blankRes.json();
check('blank project: a project file, a schematic and a board with a safe file name', blankRes.status === 200 && blank.docs?.length === 3
  && blank.docs.every(d => !/[\/:]/.test(d.path.replace(/\.kicad_\w+$/, ''))), JSON.stringify(blank.docs?.map(d => d.path)));
for (const bad of ['', '   ', '..', 'x'.repeat(121)]) {
  const r = await fetch(`${BASE}/api/projects/blank`, { method: 'POST', headers: jsonA, body: JSON.stringify({ name: bad }) });
  check(`blank project: name ${JSON.stringify(bad.slice(0, 8))} is refused`, r.status === 400, `got ${r.status}`);
}
const dots = await fetch(`${BASE}/api/projects/${blank.projectId}`, { method: 'PATCH', headers: jsonA, body: JSON.stringify({ name: '..' }) });
check('a project cannot be renamed to ".."', dots.status === 400, `got ${dots.status}`);

const notOwner = await fetch(`${BASE}/api/projects/${blank.projectId}`, { method: 'DELETE', headers: authB });
check('only the owner can trash a project', notOwner.status === 403 || notOwner.status === 404, `got ${notOwner.status}`);
const trashed = await fetch(`${BASE}/api/projects/${blank.projectId}`, { method: 'DELETE', headers: authA });
const inTrash = (await (await fetch(`${BASE}/api/trash`, { headers: authA })).json()).projects;
const hidden = await fetch(`${BASE}/api/projects/${blank.projectId}`, { headers: authA });
const listedNow = (await (await fetch(`${BASE}/api/projects`, { headers: authA })).json()).projects;
check('delete moves the project to the Trash and hides it everywhere', trashed.status === 200 && inTrash.some(p => p.projectId === blank.projectId && p.purgeAt)
  && hidden.status === 404 && !listedNow.some(p => p.projectId === blank.projectId), `delete ${trashed.status}, get ${hidden.status}`);
const otherTrash = (await (await fetch(`${BASE}/api/trash`, { headers: authB })).json()).projects;
check('the Trash is private to the owner', !otherTrash.some(p => p.projectId === blank.projectId));
const strangerRestore = await fetch(`${BASE}/api/projects/${blank.projectId}/undelete`, { method: 'POST', headers: authB });
check('only the owner can restore', strangerRestore.status === 403 || strangerRestore.status === 404, `got ${strangerRestore.status}`);
const restored = await fetch(`${BASE}/api/projects/${blank.projectId}/undelete`, { method: 'POST', headers: authA });
const back = await fetch(`${BASE}/api/projects/${blank.projectId}`, { headers: authA });
check('restore brings it back with its documents', restored.status === 200 && back.status === 200 && (await back.json()).docs?.length === 3);
await fetch(`${BASE}/api/projects/${blank.projectId}`, { method: 'DELETE', headers: authA });
const purge = await fetch(`${BASE}/api/projects/${blank.projectId}?permanent=true`, { method: 'DELETE', headers: authA });
const trashAfter = (await (await fetch(`${BASE}/api/trash`, { headers: authA })).json()).projects;
check('a trashed project can be deleted for good', purge.status === 200 && !trashAfter.some(p => p.projectId === blank.projectId), `got ${purge.status}`);

const toStranger = await fetch(`${BASE}/api/projects/${project.projectId}/transfer`, { method: 'POST', headers: jsonA, body: JSON.stringify({ userId: 999999999 }) });
check('ownership can only go to a member', toStranger.status >= 400 && toStranger.status < 500, `got ${toStranger.status}`);
const byMember = await fetch(`${BASE}/api/projects/${project.projectId}/transfer`, { method: 'POST', headers: jsonB, body: JSON.stringify({ userId: bobId }) });
check('a member cannot take ownership', byMember.status === 403, `got ${byMember.status}`);
const give = await fetch(`${BASE}/api/projects/${project.projectId}/transfer`, { method: 'POST', headers: jsonA, body: JSON.stringify({ userId: bobId }) });
const afterGive = await (await fetch(`${BASE}/api/projects/${project.projectId}/members`, { headers: authB })).json();
check('transfer: the member becomes owner, the old owner stays as editor', give.status === 200 && afterGive.ownerId === bobId && afterGive.canManage === true
  && afterGive.members.length === 1 && afterGive.members[0].role === 'editor', JSON.stringify(afterGive).slice(0, 200));
const giveBack = await fetch(`${BASE}/api/projects/${project.projectId}/transfer`, { method: 'POST', headers: jsonB, body: JSON.stringify({ userId: aliceId }) });
check('…and it can be handed back', giveBack.status === 200, `got ${giveBack.status}`);

// --- member removal (the revoked-link remediation) ---
const rm = await fetch(`${BASE}/api/projects/${project.projectId}/members/${bobId}`, {
  method: 'DELETE', headers: { Authorization: `Bearer ${alice}` } });
check('owner can remove a collaborator', rm.status === 200, `got ${rm.status}`);
const bobAfter = await fetch(`${BASE}/api/projects/${project.projectId}`,
  { headers: { Authorization: `Bearer ${bob}` } });
check('removed collaborator loses access', bobAfter.status === 403, `got ${bobAfter.status}`);
// The removed session stays silent on purpose: it must be cut off without sending anything.
const kicked = await V.wait(m => m.type === 'error' && m.code === 'permission_denied' && !m.clientOpId, 6000).catch(() => null);
check('…and their open session is cut off without it saying a word', !!kicked);
const seenBefore = V.inbox.length;
A.send({ type: 'op', docId: doc.docId, clientOpId: 'alice-1:after-removal', baseSeq: 0,
  changes: [{ id: 'aaaa-after', typeName: 'SCH_LINE', kind: 'ADDED', sexpr: '(wire)' }] });
await A.wait(m => m.type === 'ack' && m.clientOpId === 'alice-1:after-removal');
V.send({ type: 'resync', docId: doc.docId });
await new Promise(r => setTimeout(r, 800));
const leaked = V.inbox.slice(seenBefore).filter(m => m.type === 'op' || m.type === 'snapshot' || m.type === 'doc_info');
check('…later edits and a resync give them nothing', leaked.length === 0, JSON.stringify(leaked).slice(0, 200));

// --- a watcher of a project that goes to the Trash is cut off too ---
{
  const r = await fetch(`${BASE}/api/projects/blank`, { method: 'POST', headers: jsonA, body: JSON.stringify({ name: 'E2E trash watch' }) });
  const p = await r.json();
  const d = p.docs.find(x => x.path.endsWith('.kicad_sch'));
  await fetch(`${BASE}/api/projects/${p.projectId}/invites`, { method: 'POST', headers: jsonA, body: JSON.stringify({ login: 'e2e-bob', role: 'viewer' }) });
  const W = connect(bob, 'bob-watch', 'bob');
  await W.wait(m => m.type === 'hello_ok');
  W.send({ type: 'join_doc', docId: d.docId, sinceSeq: 0 });
  const joinedW = await W.wait(m => m.type === 'doc_info' && m.docId === d.docId).catch(() => null);
  await fetch(`${BASE}/api/projects/${p.projectId}`, { method: 'DELETE', headers: authA });
  const cut = await W.wait(m => m.type === 'error' && m.code === 'permission_denied', 6000).catch(() => null);
  check('trashing a project cuts off someone silently watching it', !!joinedW && !!cut);
  W.close();

  for (const days of [0, -5, 4000, 9e15]) {
    const lr = await fetch(`${BASE}/api/projects/${project.projectId}/links`, { method: 'POST', headers: jsonA, body: JSON.stringify({ role: 'viewer', expiresInDays: days }) });
    check(`a share link expiring in ${days} days is refused`, lr.status === 400, `got ${lr.status}`);
  }
  const okLink = await fetch(`${BASE}/api/projects/${project.projectId}/links`, { method: 'POST', headers: jsonA, body: JSON.stringify({ role: 'viewer', expiresInDays: 7 }) });
  check('a share link expiring in 7 days is accepted', okLink.status === 200, `got ${okLink.status}`);

  const noName = new FormData();
  noName.append('file', new Blob(['{}']), ' .kicad_pro');
  noName.append('file', new Blob([sch]), 'a.kicad_sch');
  const nn = await fetch(`${BASE}/api/projects`, { method: 'POST', headers: authA, body: noName });
  const nnp = await nn.json();
  let nnName = null;
  if (nn.status === 200) nnName = (await (await fetch(`${BASE}/api/projects/${nnp.projectId}`, { headers: authA })).json()).name;
  check('an upload whose project file has no name is called "untitled"', nn.status === 200 && nnName === 'untitled', `${nn.status} ${JSON.stringify(nnName)}`);

  const b2 = await (await fetch(`${BASE}/api/projects/blank`, { method: 'POST', headers: jsonA, body: JSON.stringify({ name: 'e2edocs' }) })).json();
  const existing = b2.docs.find(x => x.path.endsWith('.kicad_sch')).path;
  const mk = (path) => fetch(`${BASE}/api/projects/${b2.projectId}/docs`, { method: 'POST', headers: jsonA, body: JSON.stringify({ path }) });
  const same = await mk(existing);
  check('adding an existing file returns it', same.status === 200 && (await same.json()).existing === true);
  const caseDup = await mk(existing.toUpperCase().replace('.KICAD_SCH', '.kicad_sch'));
  check('adding a file that differs only in case is refused', caseDup.status === 400, `got ${caseDup.status}`);
  const state = await mk('x.collab/base/y.kicad_pcb');
  check('adding a sync-state path is refused', state.status === 400, `got ${state.status}`);
  const fresh = await mk('sheets/new.kicad_sch');
  check('adding a new sheet still works', fresh.status === 200 && (await fresh.json()).existing === false);
}

A.close(); V.close();

// --- cleanup ---
// Projects reference users, so drop everything these users own — including
// leftovers from an earlier interrupted run.
await client.query(
  `DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE github_id IN (-9001, -9002))`);
await client.query(`DELETE FROM users WHERE github_id IN (-9001, -9002)`);
await client.end();
console.log('\ncleaned up test project and users');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// minimal stored (uncompressed) zip writer
async function makeZip(entries) {
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    return t;
  })();
  const crc32 = (buf) => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name), data = Buffer.from(content);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    const local = Buffer.concat([lh, nameBuf, data]);
    locals.push(local);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, nameBuf]));
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
