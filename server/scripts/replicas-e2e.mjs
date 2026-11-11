// End-to-end test of running more than one server replica (src/relay.rs).
//
// Two server processes share one database.  Clients are spread over both and must not
// be able to tell: ops keep one order, cursors and joins cross over, comments and
// history restores reach everyone, a sign-in started on one replica finishes on the
// other, and when a replica dies its people disappear from the other's documents.
//
// Run it against LOCAL servers and a THROWAWAY database — it writes to both:
//
//   export DATABASE_URL=postgres://postgres:test@127.0.0.1:5432/collabtest JWT_SECRET=testsecret
//   export GITHUB_CLIENT_ID=x GITHUB_CLIENT_SECRET=y PUBLIC_URL=http://127.0.0.1:8099
//   PORT=8099 ./target/debug/kicad-collab-server &
//   PORT=8098 ./target/debug/kicad-collab-server & echo $! > /tmp/replica-b.pid
//
//   cd server/scripts && npm install && \
//   E2E_PG_URL=$DATABASE_URL E2E_JWT_SECRET=testsecret \
//   E2E_BASE=http://127.0.0.1:8099 E2E_BASE_B=http://127.0.0.1:8098 \
//   E2E_KILL_B_PID=$(cat /tmp/replica-b.pid) node replicas-e2e.mjs
//
// E2E_KILL_B_PID is optional: with it the test ends by killing replica B and checking
// that replica A notices (this takes about 45 seconds).
import crypto from 'node:crypto';
import pg from 'pg';

const BASE_A = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const BASE_B = (process.env.E2E_BASE_B || 'http://127.0.0.1:8098').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET;
const PG_URL = process.env.E2E_PG_URL;
const OPS_EACH = Number(process.env.E2E_OPS_EACH || 150);

if (!SECRET || !PG_URL) {
  console.error('E2E_JWT_SECRET and E2E_PG_URL are required (see the header comment).');
  process.exit(2);
}

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintJwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub, login, iat: now, exp: now + 3600 });
  const sig = crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const client = new pg.Client({ connectionString: PG_URL });
await client.connect();
const mkUser = async (ghId, login) => (await client.query(
  `INSERT INTO users (github_id, login, name) VALUES ($1, $2, $3)
   ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [ghId, login, login])).rows[0].id;
const aliceId = await mkUser(-9101, 'rep-alice');
const bobId = await mkUser(-9102, 'rep-bob');
const alice = mintJwt(aliceId, 'rep-alice');
const bob = mintJwt(bobId, 'rep-bob');
const authA = { Authorization: `Bearer ${alice}` }, authB = { Authorization: `Bearer ${bob}` };
const json = (h) => ({ ...h, 'Content-Type': 'application/json' });

function connect(base, token, clientId, label, kind) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
  const inbox = [], waiters = [];
  let closed = null;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', proto: 1, token, clientId, client: kind }));
  ws.onclose = (e) => { closed = `closed (${e.code})`; for (const w of waiters.splice(0)) w.reject(new Error(`${label}: ${closed}`)); };
  ws.onerror = () => { closed = closed || 'socket error'; };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data); inbox.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].pred(m)) { waiters[i].resolve(m); waiters.splice(i, 1); }
  };
  return {
    ws, inbox, label,
    send: (m) => ws.send(JSON.stringify(m)),
    wait: (pred, ms = 15000) => new Promise((resolve, reject) => {
      const hit = inbox.find(pred); if (hit) return resolve(hit);
      if (closed) return reject(new Error(`${label}: ${closed}`));
      waiters.push({ pred, resolve, reject });
      setTimeout(() => reject(new Error(`${label}: timeout waiting for a message`)), ms);
    }),
    close: () => { try { ws.close(); } catch {} },
  };
}

// --- a project on replica A, shared with Bob through replica B ---
const sch = `(kicad_sch (version 20260101) (generator "e2e")
  (symbol (lib_id "Device:R") (at 100 100 0) (uuid "11111111-1111-1111-1111-111111111111")))`;
const form = new FormData();
form.append('archive', new Blob([await makeZip([['test.kicad_sch', sch], ['test.kicad_pro', '{}']])], { type: 'application/zip' }), 'project.zip');
form.append('name', 'replicas-e2e');
const project = await (await fetch(`${BASE_A}/api/projects`, { method: 'POST', headers: authA, body: form })).json();
const doc = project.docs?.find((d) => d.docType === 'kicad_sch');
check('project created through replica A', !!doc, JSON.stringify(project).slice(0, 160));
const link = await (await fetch(`${BASE_A}/api/projects/${project.projectId}/links`, { method: 'POST', headers: json(authA), body: JSON.stringify({ role: 'editor' }) })).json();
const claim = await fetch(`${BASE_B}/api/join/${link.token}`, { method: 'POST', headers: authB });
check('a link made on replica A is claimed through replica B', claim.status === 200, `got ${claim.status}`);

// --- four clients, two on each replica ---
const A1 = connect(BASE_A, alice, 'a1', 'alice@A', 'desktop');
const A2 = connect(BASE_A, bob, 'a2', 'bob@A', 'web');
const B1 = connect(BASE_B, alice, 'b1', 'alice@B', 'web');
const B2 = connect(BASE_B, bob, 'b2', 'bob@B', 'desktop');
const all = [A1, A2, B1, B2];
const hellos = await Promise.all(all.map((c) => c.wait((m) => m.type === 'hello_ok')));
check('peers on different replicas get distinct colours', new Set(hellos.map((h) => h.color)).size === 4, hellos.map((h) => h.color).join(' '));
const idOf = new Map(all.map((c, i) => [c, hellos[i].clientId]));

A1.send({ type: 'join_doc', docId: doc.docId }); await A1.wait((m) => m.type === 'snapshot');
B1.send({ type: 'join_doc', docId: doc.docId });
const b1Info = await B1.wait((m) => m.type === 'doc_info'); await B1.wait((m) => m.type === 'snapshot');
const seenFromA = await A1.wait((m) => m.type === 'peer_joined' && m.peer?.clientId === idOf.get(B1)).catch(() => null);
check('a join on replica B is announced on replica A', !!seenFromA && seenFromA.peer.client === 'web', JSON.stringify(seenFromA?.peer));
// The joiner on B learns of A's client either in doc_info (roster already in) or as a join right after.
const knowsA1 = b1Info.peers.some((p) => p.clientId === idOf.get(A1))
  || !!(await B1.wait((m) => m.type === 'peer_joined' && m.peer?.clientId === idOf.get(A1), 5000).catch(() => null));
check('the joiner on replica B learns who is already there on replica A', knowsA1, JSON.stringify(b1Info.peers));

// presence both ways, and a late joiner inherits it
A1.send({ type: 'presence', docId: doc.docId, state: { cursor: [111, 222], selection: [] } });
const pB = await B1.wait((m) => m.type === 'presence' && m.peers?.[idOf.get(A1)]?.state).catch(() => null);
check('a cursor on replica A shows on replica B', pB?.peers[idOf.get(A1)].state.cursor[0] === 111 && pB.peers[idOf.get(A1)].user.login === 'rep-alice');
B1.send({ type: 'presence', docId: doc.docId, state: { cursor: [333, 444], selection: ['x'] } });
const pA = await A1.wait((m) => m.type === 'presence' && m.peers?.[idOf.get(B1)]?.state).catch(() => null);
check('a cursor on replica B shows on replica A', pA?.peers[idOf.get(B1)].state.cursor[0] === 333);
const bigState = { cursor: [5, 6], selection: Array.from({ length: 190 }, () => crypto.randomUUID()) };   // ~7.6 kB: too big for one NOTIFY
A1.send({ type: 'presence', docId: doc.docId, state: bigState });
const pBig = await B1.wait((m) => m.type === 'presence' && m.peers?.[idOf.get(A1)]?.state?.selection?.length === 190).catch(() => null);
check('a presence state too large for one notification still crosses', !!pBig);

A2.send({ type: 'join_doc', docId: doc.docId }); await A2.wait((m) => m.type === 'snapshot');
B2.send({ type: 'join_doc', docId: doc.docId });
const b2Info = await B2.wait((m) => m.type === 'doc_info'); await B2.wait((m) => m.type === 'snapshot');
// Someone who joined on the other replica a moment ago may arrive as a join right after instead.
const b2Knows = [];
for (const c of [A1, A2, B1]) b2Knows.push(b2Info.peers.some((p) => p.clientId === idOf.get(c))
  || !!(await B2.wait((m) => m.type === 'peer_joined' && m.peer?.clientId === idOf.get(c), 5000).catch(() => null)));
check('a joiner on replica B learns of everyone on replica A', b2Knows.every(Boolean) && b2Info.peers.some((p) => p.clientId === idOf.get(A1)),
  JSON.stringify(b2Info.peers.map((p) => p.clientId)));
const inherited = await B2.wait((m) => m.type === 'presence' && m.peers?.[idOf.get(A1)]?.state, 5000).catch(() => null);
check('a late joiner on replica B is shown the cursor of someone on replica A', !!inherited);

// --- the op stream: everyone writes at once, through both replicas ---
const change = (n) => [{ id: '11111111-1111-1111-1111-111111111111', typeName: 'SCH_SYMBOL', kind: 'MODIFIED',
  properties: [{ name: 'Position X', before: { type: 'int', v: 0 }, after: { type: 'int', v: n } }] }];
const t0 = Date.now();
for (let i = 1; i <= OPS_EACH; i++) for (const c of all) c.send({ type: 'op', docId: doc.docId, clientOpId: `${c.label}:${i}`, changes: change(i) });
const total = OPS_EACH * all.length;
const settled = async (c) => {
  for (let i = 0; i < 600; i++) {
    const n = c.inbox.filter((m) => m.type === 'ack' || m.type === 'op').length;
    if (n >= total) return true; await sleep(100);
  }
  return false;
};
const done = await Promise.all(all.map(settled));
check(`all ${total} concurrent ops reach every client`, done.every(Boolean), all.map((c) => c.inbox.filter((m) => m.type === 'ack' || m.type === 'op').length).join(' ') + ` in ${Date.now() - t0} ms`);
for (const c of all) {
  const seqs = c.inbox.filter((m) => m.type === 'ack' || m.type === 'op').map((m) => m.seq);
  const uniq = new Set(seqs);
  check(`${c.label}: every seq from 1 to ${total} exactly once`, uniq.size === total && seqs.length === total && Math.min(...seqs) === 1 && Math.max(...seqs) === total, `${uniq.size} distinct of ${seqs.length}`);
  const remote = c.inbox.filter((m) => m.type === 'op').map((m) => m.seq);
  check(`${c.label}: other people's ops arrive in seq order`, remote.every((s, i) => i === 0 || s > remote[i - 1]));
  check(`${c.label}: no resync was needed`, !c.inbox.some((m) => m.type === 'error'), JSON.stringify(c.inbox.find((m) => m.type === 'error')));
}
const stored = (await client.query('SELECT count(*)::int AS n, max(seq)::int AS head FROM ops WHERE doc_id = $1', [doc.docId])).rows[0];
check('the op table holds one gapless sequence', stored.n === total && stored.head === total, JSON.stringify(stored));
const viaB = A1.inbox.find((m) => m.type === 'op' && m.author?.clientId === idOf.get(B1));
check('an op relayed from the other replica names its author', viaB?.author?.login === 'rep-alice', JSON.stringify(viaB?.author));

// an op resubmitted to the other replica after a reconnect is acked with its old seq
const firstAck = A1.inbox.find((m) => m.type === 'ack' && m.clientOpId === 'alice@A:1');
const A1b = connect(BASE_B, alice, 'a1', 'alice@A-moved', 'desktop');
await A1b.wait((m) => m.type === 'hello_ok');
A1b.send({ type: 'join_doc', docId: doc.docId, sinceSeq: total });
await A1b.wait((m) => m.type === 'doc_info');
A1b.send({ type: 'op', docId: doc.docId, clientOpId: 'alice@A:1', changes: change(1) });
const reAck = await A1b.wait((m) => m.type === 'ack').catch(() => null);
check('a replay through the other replica is recognised, not applied twice', reAck?.seq === firstAck.seq, `${reAck?.seq} vs ${firstAck.seq}`);
A1b.close();

// --- server-initiated events cross too ---
const comment = await fetch(`${BASE_B}/api/docs/${doc.docId}/comments`, { method: 'POST', headers: json(authB), body: JSON.stringify({ body: 'from replica B', x: 1, y: 2 }) });
const gotComment = await A1.wait((m) => m.type === 'comment', 8000).catch(() => null);
check('a comment posted through replica B reaches a socket on replica A', comment.status === 200 && !!gotComment, `status ${comment.status}`);

const cp = await fetch(`${BASE_A}/api/projects/${project.projectId}/checkpoints`, { method: 'POST', headers: json(authA), body: JSON.stringify({ name: 'rep-cp' }) });
if (cp.status === 200) {
  const restore = await fetch(`${BASE_B}/api/projects/${project.projectId}/restore`, { method: 'POST', headers: json(authA), body: JSON.stringify({ name: 'rep-cp' }) });
  const reset = await A2.wait((m) => m.type === 'reset', 8000).catch(() => null);
  check('a history restore through replica B resets a client on replica A', restore.status === 200 && !!reset, `status ${restore.status}`);
  if (reset) {
    A2.send({ type: 'op', docId: doc.docId, clientOpId: 'after-reset', changes: change(7) });
    const ack = await A2.wait((m) => m.type === 'ack' && m.clientOpId === 'after-reset').catch(() => null);
    check('the next op on replica A is numbered after the restore', ack?.seq === reset.seq + 1, `${ack?.seq} after reset ${reset.seq}`);
  }
} else check('checkpoint created', false, `status ${cp.status}`);

// --- access changes take effect on the other replica at once ---
const demote = await fetch(`${BASE_A}/api/projects/${project.projectId}/members/${bobId}`, { method: 'PATCH', headers: json(authA), body: JSON.stringify({ role: 'viewer' }) });
B2.send({ type: 'op', docId: doc.docId, clientOpId: 'demoted', changes: change(9) });
const refused = await B2.wait((m) => m.type === 'error' && m.code === 'permission_denied' && m.clientOpId === 'demoted', 8000).catch(() => null);
check('a demotion made through replica A stops a write through replica B', demote.status === 200 && !!refused);

// --- a sign-in that starts on one replica and finishes on the other ---
const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const redirect = 'http://127.0.0.1:53999/callback';
const authorize = await fetch(`${BASE_A}/auth/desktop/authorize?code_challenge=${challenge}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(redirect)}&state=xyz`,
  { headers: { Cookie: `kc_session=${alice}` }, redirect: 'manual' });
const page = await authorize.text();
const code = (page.match(/name="code"\s+value="([^"]+)"/) || [])[1];
if (!code) check('desktop sign-in page offers a code (needs GITHUB_CLIENT_ID set to anything)', false, `status ${authorize.status}`);
else {
  const confirm = await fetch(`${BASE_B}/auth/desktop/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `code=${encodeURIComponent(code)}`, redirect: 'manual' });
  check('a sign-in started on replica A is confirmed on replica B', [302, 303, 307].includes(confirm.status) && (confirm.headers.get('location') || '').startsWith(redirect), `${confirm.status} ${confirm.headers.get('location')}`);
  const tokenReq = () => fetch(`${BASE_B}/auth/desktop/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect }) });
  const token = await tokenReq();
  const tokenBody = await token.json().catch(() => ({}));
  const who = tokenBody.access_token ? await (await fetch(`${BASE_A}/api/me`, { headers: { Authorization: `Bearer ${tokenBody.access_token}` } })).json() : {};
  check('…and its token is issued by replica B and accepted by replica A', token.status === 200 && who.login === 'rep-alice', `status ${token.status} ${JSON.stringify(who).slice(0, 80)}`);
  const again = await tokenReq();
  check('…and the one-time code works once', again.status === 400, `got ${again.status}`);
}

// --- the browser asks a desktop editor to refill zones, wherever that desktop is connected ---
{
  B1.send({ type: 'request', docId: doc.docId, action: 'fill_zones' });
  const asked = await A1.wait((m) => m.type === 'request' && m.action === 'fill_zones', 8000).catch(() => null);
  check('a fill request from a browser on replica B reaches the desktop editor on replica A', asked?.from?.login === 'rep-alice', JSON.stringify(asked));
  B1.send({ type: 'request', docId: doc.docId, action: 'format_disk' });
  const no = await B1.wait((m) => m.type === 'error' && m.code === 'request_refused', 8000).catch(() => null);
  check('an action that is not on the list is refused', !!no);

  const form2 = new FormData();
  form2.append('archive', new Blob([await makeZip([['solo.kicad_sch', sch], ['solo.kicad_pro', '{}']])], { type: 'application/zip' }), 'project.zip');
  form2.append('name', 'replicas-e2e-solo');
  const solo = await (await fetch(`${BASE_A}/api/projects`, { method: 'POST', headers: authA, body: form2 })).json();
  const soloDoc = solo.docs?.find((d) => d.docType === 'kicad_sch');
  const W = connect(BASE_B, alice, 'w1', 'alice-web@B', 'web');
  await W.wait((m) => m.type === 'hello_ok');
  W.send({ type: 'join_doc', docId: soloDoc.docId }); await W.wait((m) => m.type === 'snapshot');
  W.send({ type: 'request', docId: soloDoc.docId, action: 'fill_zones' });
  const nobody = await W.wait((m) => m.type === 'error' && m.code === 'no_desktop', 8000).catch(() => null);
  check('with no desktop editor anywhere, the browser is told so', !!nobody);
  W.close();
}

// --- leaving, and a replica dying ---
B1.close();
const left = await A1.wait((m) => m.type === 'peer_left' && m.clientId === idOf.get(B1), 8000).catch(() => null);
check('a leave on replica B is announced on replica A', !!left);

const killPid = Number(process.env.E2E_KILL_B_PID || 0);
if (killPid) {
  process.kill(killPid, 'SIGKILL');
  console.log('      (replica B killed; waiting for replica A to notice)');
  const gone = await A1.wait((m) => m.type === 'peer_left' && m.clientId === idOf.get(B2), 60000).catch(() => null);
  check('when replica B dies, its people leave the documents on replica A', !!gone);
  A1.send({ type: 'op', docId: doc.docId, clientOpId: 'alone', changes: change(11) });
  const ack = await A1.wait((m) => m.type === 'ack' && m.clientOpId === 'alone').catch(() => null);
  check('replica A carries on by itself', !!ack);
}

for (const c of all) c.close();
await client.query(`DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE github_id IN (-9101, -9102))`);
await client.query(`DELETE FROM users WHERE github_id IN (-9101, -9102)`);
await client.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// minimal stored (uncompressed) zip writer
async function makeZip(entries) {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  const crc32 = (buf) => { let c = -1; for (const b of buf) c = t[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const locals = [], centrals = []; let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name), data = Buffer.from(content), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    const local = Buffer.concat([lh, nameBuf, data]); locals.push(local); centrals.push(Buffer.concat([ch, nameBuf])); offset += local.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
