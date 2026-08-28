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
  const ws = new WebSocket(WS);
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

// --- member removal (the revoked-link remediation) ---
const rm = await fetch(`${BASE}/api/projects/${project.projectId}/members/${bobId}`, {
  method: 'DELETE', headers: { Authorization: `Bearer ${alice}` } });
check('owner can remove a collaborator', rm.status === 200, `got ${rm.status}`);
const bobAfter = await fetch(`${BASE}/api/projects/${project.projectId}`,
  { headers: { Authorization: `Bearer ${bob}` } });
check('removed collaborator loses access', bobAfter.status === 403, `got ${bobAfter.status}`);

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
