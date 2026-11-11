// End-to-end test of roles and sharing: viewer / commenter / editor / owner, share links
// (also without signing in), the per-project permission settings, and live role changes.
//
// Runs against a LOCAL server and a THROWAWAY database (see e2e.mjs for how to start them):
//
//   cd server/scripts && npm install --no-save --no-package-lock pg && \
//   E2E_PG_URL=postgres://postgres:test@127.0.0.1:5432/collabtest \
//   E2E_JWT_SECRET=testsecret node roles-e2e.mjs
//
import crypto from 'node:crypto';
import pg from 'pg';

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const SECRET = process.env.E2E_JWT_SECRET;
const PG_URL = process.env.E2E_PG_URL;
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintJwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL });
await db.connect();
const people = {};
for (const [i, name] of ['owner', 'ed', 'com', 'view', 'out', 'late'].entries()) {
  const login = `roles-${name}`;
  const r = await db.query(`INSERT INTO users (github_id, login, name) VALUES ($1, $2, $2)
    ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [-9100 - i, login]);
  people[name] = { id: r.rows[0].id, login, jwt: mintJwt(r.rows[0].id, login) };
}
const { owner, ed, com, view, out, late } = people;

/** fetch as a person (or as nobody), with optional cookies; answers { status, json, text, headers }. */
async function call(who, method, path, body, cookie) {
  const headers = {};
  if (who) headers.Authorization = `Bearer ${who.jwt}`;
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, headers: r.headers };
}

function connect(who, label, extra = {}) {
  const ws = new WebSocket(WS);
  const inbox = [], waiters = [];
  let closed = null;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', proto: 1, token: who ? who.jwt : '', clientId: label, client: 'web', ...extra }));
  ws.onclose = () => { closed = 'closed'; for (const w of waiters.splice(0)) w.reject(new Error(`${label}: closed`)); };
  ws.onerror = () => { closed = closed || 'socket error'; };
  ws.onmessage = (e) => { const m = JSON.parse(e.data); inbox.push(m); for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].pred(m)) { waiters[i].resolve(m); waiters.splice(i, 1); } };
  return {
    inbox,
    send: (m) => ws.send(JSON.stringify(m)),
    wait: (pred, ms = 8000) => new Promise((resolve, reject) => {
      const hit = inbox.find(pred); if (hit) return resolve(hit);
      if (closed) return reject(new Error(`${label}: ${closed}`));
      waiters.push({ pred, resolve, reject }); setTimeout(() => reject(new Error(`${label}: timeout`)), ms);
    }),
    /** Whether a matching message arrives within `ms`, counting only messages after this call. */
    hears: async function (pred, ms = 2500) { const from = inbox.length; const until = Date.now() + ms; while (Date.now() < until) { if (inbox.slice(from).some(pred)) return true; await sleep(50); } return false; },
    close: () => { try { ws.close(); } catch { /* gone */ } },
  };
}
let opN = 0;
const U = '11111111-1111-1111-1111-111111111111';
const change = (x) => [{ id: U, typeName: 'SCH_SYMBOL', kind: 'MODIFIED', screen: 'roles.kicad_sch',
  properties: [{ name: 'Position X', before: { type: 'int', v: 1 }, after: { type: 'int', v: x } }] }];
/** Send an op and report 'ack' or the error code it was answered with. */
async function tryOp(sock, docId) {
  const id = `op-${++opN}`;
  sock.send({ type: 'op', docId, clientOpId: id, changes: change(1000 + opN) });
  const m = await sock.wait((m) => (m.type === 'ack' || m.type === 'error') && m.clientOpId === id);
  return m.type === 'ack' ? 'ack' : m.code;
}
async function join(sock, docId) {
  await sock.wait((m) => m.type === 'hello_ok');
  sock.send({ type: 'join_doc', docId });
  return sock.wait((m) => (m.type === 'doc_info' || m.type === 'error') && m.docId === docId);
}

// ---------------------------------------------------------------- a project and its people
const sch = `(kicad_sch (version 20260101) (generator "e2e")\n  (symbol (lib_id "Device:R") (at 100 100 0) (uuid "${U}")))`;
const form = new FormData();
form.append('name', 'roles-e2e');
form.append('file', new Blob([sch]), 'roles.kicad_sch');
form.append('file', new Blob(['{}']), 'roles.kicad_pro');
const created = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { Authorization: `Bearer ${owner.jwt}` }, body: form })).json();
const P = created.projectId, D = created.docs.find((d) => d.docType === 'kicad_sch').docId;
check('project created', !!P && !!D, JSON.stringify(created).slice(0, 200));
const api = `/api/projects/${P}`;

{
  const bad = await call(owner, 'POST', `${api}/invites`, { login: ed.login, role: 'admin' });
  check('an unknown role is refused', bad.status === 400 && /editor, commenter or viewer/.test(bad.json.message), bad.text);
  for (const [p, role] of [[ed, 'editor'], [com, 'commenter'], [view, 'viewer']]) {
    const r = await call(owner, 'POST', `${api}/invites`, { login: p.login, role });
    check(`invite as ${role}`, r.status === 200 && r.json.status === 'granted' && r.json.role === role, r.text);
  }
  const m = await call(owner, 'GET', `${api}/members`);
  check('the member list names the three roles', ['editor', 'commenter', 'viewer'].every((r) => m.json.members.some((x) => x.role === r)) && m.json.canManage && m.json.canShare, m.text);
  for (const [p, role, can] of [[owner, 'editor', { edit: true, comment: true, copy: true, share: true, manage: true }],
    [ed, 'editor', { edit: true, comment: true, copy: true, share: false, manage: false }],
    [com, 'commenter', { edit: false, comment: true, copy: true, share: false, manage: false }],
    [view, 'viewer', { edit: false, comment: false, copy: true, share: false, manage: false }]]) {
    const r = await call(p, 'GET', api);
    check(`${p.login}: role ${role} and what it allows`, r.status === 200 && r.json.role === role && Object.entries(can).every(([k, v]) => r.json.can[k] === v), r.text);
  }
  check('someone outside sees nothing', (await call(out, 'GET', api)).status === 403 && (await call(out, 'GET', `/api/docs/${D}/content`)).status === 403
    && (await call(null, 'GET', `${api}/info`)).status === 404 && (await call(null, 'GET', `/api/docs/${D}/content`)).status === 401);
}

// ---------------------------------------------------------------- what each role may do over HTTP
let thread;
{
  for (const p of [view, com, ed]) check(`${p.login} reads the document`, (await call(p, 'GET', `/api/docs/${D}/content`)).status === 200);
  const v = await call(view, 'POST', `/api/docs/${D}/comments`, { body: 'hello', x: 0, y: 0 });
  check('a viewer cannot comment', v.status === 403 && v.json.error === 'comment_denied', v.text);
  check('a viewer reads comments', (await call(view, 'GET', `/api/docs/${D}/comments`)).status === 200);
  const c = await call(com, 'POST', `/api/docs/${D}/comments`, { body: 'R1 looks too close to the edge', x: 1000, y: 2000 });
  check('a commenter comments', c.status === 200 && c.json.id > 0, c.text);
  thread = c.json.id;
  check('an editor replies', (await call(ed, 'POST', `/api/docs/${D}/comments`, { body: 'moved it', parentId: thread })).status === 200);
  check('a commenter resolves', (await call(com, 'PATCH', `/api/comments/${thread}`, { resolved: true })).status === 200);
  check('a viewer cannot resolve', (await call(view, 'PATCH', `/api/comments/${thread}`, { resolved: false })).status === 403);
  check('someone outside cannot comment or read comments', (await call(out, 'POST', `/api/docs/${D}/comments`, { body: 'x', x: 0, y: 0 })).status === 403
    && (await call(out, 'GET', `/api/docs/${D}/comments`)).status === 403);
  check('nobody signed out comments', (await call(null, 'POST', `/api/docs/${D}/comments`, { body: 'x', x: 0, y: 0 })).status === 403);

  for (const p of [view, com]) {
    check(`${p.login} cannot save a version`, (await call(p, 'POST', `${api}/checkpoints`, { name: 'v' })).status === 403);
    check(`${p.login} cannot add a file`, (await call(p, 'POST', `${api}/docs`, { path: 'x.kicad_sch', docType: 'kicad_sch' })).status === 403);
    const up = await fetch(`${BASE}/api/docs/${D}/snapshots?seq=0`, { method: 'POST', headers: { Authorization: `Bearer ${p.jwt}` }, body: sch });
    check(`${p.login} cannot upload a snapshot`, up.status === 403, `got ${up.status}`);
    check(`${p.login} cannot rename, share or change permissions`, (await call(p, 'PATCH', api, { name: 'mine' })).status === 403
      && (await call(p, 'POST', `${api}/links`, { role: 'viewer' })).status === 403
      && (await call(p, 'POST', `${api}/invites`, { login: out.login, role: 'viewer' })).status === 403
      && (await call(p, 'PATCH', `${api}/permissions`, { editorsCanShare: true })).status === 403
      && (await call(p, 'PATCH', `${api}/members/${ed.id}`, { role: 'viewer' })).status === 403);
    check(`${p.login} can download the project`, (await call(p, 'GET', `${api}/archive`)).status === 200);
  }
  check('an editor adds a file', (await call(ed, 'POST', `${api}/docs`, { path: 'sub.kicad_sch', docType: 'kicad_sch' })).status === 200);
  check('an editor cannot share or manage by default', (await call(ed, 'POST', `${api}/links`, { role: 'viewer' })).status === 403
    && (await call(ed, 'POST', `${api}/invites`, { login: out.login, role: 'viewer' })).status === 403
    && (await call(ed, 'PATCH', `${api}/permissions`, { editorsCanShare: true })).status === 403
    && (await call(ed, 'DELETE', `${api}/members/${view.id}`)).status === 403);
}

// ---------------------------------------------------------------- the op pipeline, and role changes on a live socket
const S = { owner: connect(owner, 'o'), ed: connect(ed, 'e'), com: connect(com, 'c'), view: connect(view, 'v') };
{
  for (const [k, role] of [['owner', 'editor'], ['ed', 'editor'], ['com', 'commenter'], ['view', 'viewer']]) {
    const info = await join(S[k], D);
    check(`${k} joins as ${role}`, info.type === 'doc_info' && info.role === role, JSON.stringify(info).slice(0, 120));
  }
  check('an editor\'s edit is accepted', await tryOp(S.ed, D) === 'ack');
  check('…and the viewer and the commenter both receive it', !!(await S.view.wait((m) => m.type === 'op').catch(() => null)) && !!(await S.com.wait((m) => m.type === 'op').catch(() => null)));
  check('a commenter\'s edit is refused', await tryOp(S.com, D) === 'permission_denied');
  check('a viewer\'s edit is refused', await tryOp(S.view, D) === 'permission_denied');
  const before = S.owner.inbox.filter((m) => m.type === 'op').length;
  await sleep(300);
  check('…and nobody else saw the refused edits', S.owner.inbox.filter((m) => m.type === 'op').length === before);

  check('owner makes the commenter an editor', (await call(owner, 'PATCH', `${api}/members/${com.id}`, { role: 'editor' })).status === 200);
  check('…and their open session can edit at once', await tryOp(S.com, D) === 'ack');
  check('owner makes them a commenter again', (await call(owner, 'PATCH', `${api}/members/${com.id}`, { role: 'commenter' })).status === 200);
  check('…and their open session is refused again', await tryOp(S.com, D) === 'permission_denied');
  check('…while they can still comment', (await call(com, 'POST', `/api/docs/${D}/comments`, { body: 'still here', x: 5, y: 5 })).status === 200);
  check('a viewer cannot ask a desktop editor to fill zones', await (async () => { S.view.send({ type: 'request', docId: D, action: 'fill_zones' }); return !!(await S.view.wait((m) => m.code === 'request_refused').catch(() => null)); })());
}

// ---------------------------------------------------------------- comments: who may take one back
{
  const mine = (await call(com, 'POST', `/api/docs/${D}/comments`, { body: 'to delete', x: 1, y: 1 })).json.id;
  const other = (await call(com, 'POST', `/api/docs/${D}/comments`, { body: 'to keep', x: 2, y: 2 })).json.id;
  check('an editor cannot delete someone else\'s comment', (await call(ed, 'DELETE', `/api/comments/${other}`)).status === 403);
  await call(owner, 'PATCH', `${api}/members/${com.id}`, { role: 'viewer' });
  check('made a viewer, the author can no longer comment', (await call(com, 'POST', `/api/docs/${D}/comments`, { body: 'x', x: 1, y: 1 })).status === 403);
  check('…but can still delete their own comment', (await call(com, 'DELETE', `/api/comments/${mine}`)).status === 200);
  check('the owner can delete anyone\'s', (await call(owner, 'DELETE', `/api/comments/${other}`)).status === 200);
  await call(owner, 'PATCH', `${api}/members/${com.id}`, { role: 'commenter' });
}

// ---------------------------------------------------------------- share links
const mkLink = async (who, role, extra = {}) => (await call(who, 'POST', `${api}/links`, { role, ...extra })).json;
const cookieOf = (r) => (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('kc_links=')) || '';
let viewLink, commentLink;
{
  viewLink = await mkLink(owner, 'viewer', { label: 'for the fab house' });
  commentLink = await mkLink(owner, 'commenter', { expiresInDays: 7 });
  check('view and comment links are made, with a label and an expiry', viewLink.role === 'viewer' && viewLink.label === 'for the fab house' && commentLink.role === 'commenter' && !!commentLink.expiresAt);
  check('a link role that does not exist is refused', (await call(owner, 'POST', `${api}/links`, { role: 'owner' })).status === 400);

  // ---- nobody signed in, a view link
  const page = await call(null, 'GET', `/j/${viewLink.token}`);
  const cookie = cookieOf(page);
  check('opening a view link shows what it gives and remembers it in the browser', page.status === 200 && /data-role="viewer"/.test(page.text) && /No account needed/.test(page.text) && cookie.includes(viewLink.token), cookie);
  const info = await call(null, 'GET', `${api}/info`, undefined, cookie);
  check('with the link, the project opens without signing in, view only', info.status === 200 && info.json.role === 'viewer' && !info.json.can.edit && !info.json.can.comment && !info.json.viewer, info.text);
  check('…its documents and comments can be read', (await call(null, 'GET', `/api/docs/${D}/content`, undefined, cookie)).status === 200
    && (await call(null, 'GET', `/api/docs/${D}/comments`, undefined, cookie)).status === 200);
  check('…and nothing can be written', (await call(null, 'POST', `/api/docs/${D}/comments`, { body: 'x', x: 0, y: 0 }, cookie)).status === 401
    && (await call(null, 'POST', `${api}/checkpoints`, { name: 'x' }, cookie)).status === 401
    && (await call(null, 'GET', `${api}/members`, undefined, cookie)).status === 401);
  check('a made-up link opens nothing', (await call(null, 'GET', `${api}/info`, undefined, 'kc_links=AAAAAAAAAAAAAAAAAAAAAA')).status === 404);

  // ---- a guest on the live session
  const G = connect(null, 'guest', { linkToken: viewLink.token });
  const hello = await G.wait((m) => m.type === 'hello_ok');
  check('a guest connects and is named Guest', hello.guest === true && hello.name === 'Guest' && hello.clientId.startsWith('guest:'), JSON.stringify(hello));
  G.send({ type: 'join_doc', docId: D });
  const ginfo = await G.wait((m) => m.type === 'doc_info' || m.type === 'error');
  check('the guest joins the document as a viewer', ginfo.type === 'doc_info' && ginfo.role === 'viewer', JSON.stringify(ginfo).slice(0, 120));
  check('people in the session see the guest arrive', !!(await S.owner.wait((m) => m.type === 'peer_joined' && m.peer?.name === 'Guest').catch(() => null)));
  const live = G.hears((m) => m.type === 'op');
  await tryOp(S.ed, D);
  check('the guest sees edits live', await live);
  check('a guest\'s edit is refused', await tryOp(G, D) === 'permission_denied');
  const G2 = connect(null, 'guest2');
  await G2.wait((m) => m.type === 'hello_ok');
  G2.send({ type: 'join_doc', docId: D });
  check('a guest without a link is turned away', (await G2.wait((m) => m.type === 'error' || m.type === 'doc_info')).code === 'permission_denied');
  G2.close();
  const noDesktop = new WebSocket(WS);
  const refused = await new Promise((res) => { noDesktop.onopen = () => noDesktop.send(JSON.stringify({ type: 'hello', proto: 1, token: '', clientId: 'x' })); noDesktop.onmessage = (e) => res(JSON.parse(e.data)); noDesktop.onclose = () => res({ code: 'closed' }); });
  check('a desktop client cannot be a guest', refused.code === 'auth_failed', JSON.stringify(refused));

  // ---- sign-in required
  check('owner asks for a sign-in on links', (await call(owner, 'PATCH', `${api}/permissions`, { linksRequireSignin: true })).json?.permissions?.linksRequireSignin === true);
  check('…the guest is dropped from the session', !!(await G.wait((m) => m.type === 'error' && m.code === 'permission_denied' && !m.clientOpId, 5000).catch(() => null)));
  check('…and the project no longer opens signed out', (await call(null, 'GET', `${api}/info`, undefined, cookie)).status === 404);
  check('…the link page asks to sign in', /asks everyone to sign in/.test((await call(null, 'GET', `/j/${viewLink.token}`)).text));
  G.close();

  // ---- signed in, a link opened but not joined
  const ccookie = `kc_links=${commentLink.token}`;
  const peek = await call(out, 'GET', `${api}/info`, undefined, ccookie);
  check('signed in with an opened comment link: view only, with an offer to join as commenter', peek.status === 200 && peek.json.role === 'viewer' && !peek.json.can.comment && peek.json.can.join === 'commenter' && !peek.json.isMember, peek.text);
  check('…the link alone does not let them comment', (await call(out, 'POST', `/api/docs/${D}/comments`, { body: 'x', x: 0, y: 0 }, ccookie)).status === 403);
  check('…nor is the project in their list yet', !(await call(out, 'GET', '/api/projects')).json.projects.some((p) => p.projectId === P));
  const joined = await call(out, 'POST', `${api}/join`, undefined, ccookie);
  check('joining makes them a commenter', joined.status === 200 && joined.json.role === 'commenter', joined.text);
  check('…who can comment and has the project in their list', (await call(out, 'POST', `/api/docs/${D}/comments`, { body: 'joined', x: 9, y: 9 })).status === 200
    && (await call(out, 'GET', '/api/projects')).json.projects.some((p) => p.projectId === P && p.role === 'commenter'));
  check('joining without a link is refused', (await call(late, 'POST', `${api}/join`)).status === 404);
  await call(owner, 'PATCH', `${api}/permissions`, { linksRequireSignin: false });

  // ---- a link never lowers a role, and never overrides the owner's choice
  await call(out, 'POST', `/api/join/${viewLink.token}`);
  check('a view link does not lower a commenter', (await call(out, 'GET', api)).json.role === 'commenter');
  await call(view, 'POST', `/api/join/${commentLink.token}`);
  check('a comment link raises a viewer to commenter', (await call(view, 'GET', api)).json.role === 'commenter');
  await call(owner, 'PATCH', `${api}/members/${view.id}`, { role: 'viewer' });
  await call(view, 'POST', `/api/join/${commentLink.token}`);
  check('…but not one the owner set to viewer by hand', (await call(view, 'GET', api)).json.role === 'viewer');
  const listed = (await call(owner, 'GET', `${api}/links`)).json.links;
  check('the owner sees the links, who made them and how often they were used', listed.length === 2 && listed.every((l) => l.createdBy === owner.login && l.canRevoke)
    && listed.find((l) => l.token === commentLink.token).uses >= 2 && listed.find((l) => l.token === viewLink.token).label === 'for the fab house', JSON.stringify(listed));

  // ---- turning a link off
  const G3 = connect(null, 'guest3', { linkToken: viewLink.token });
  await G3.wait((m) => m.type === 'hello_ok'); G3.send({ type: 'join_doc', docId: D });
  await G3.wait((m) => m.type === 'doc_info');
  check('turning the link off', (await call(owner, 'DELETE', `/api/links/${viewLink.token}`)).status === 200);
  check('…drops the guest watching through it', !!(await G3.wait((m) => m.type === 'error' && m.code === 'permission_denied', 5000).catch(() => null)));
  check('…and it opens nothing any more', (await call(null, 'GET', `${api}/info`, undefined, cookie)).status === 404 && /invalid or has expired/.test((await call(null, 'GET', `/j/${viewLink.token}`)).text));
  check('…while the person who joined through the other link stays', (await call(out, 'GET', api)).json.role === 'commenter');
  G3.close();
}

// ---------------------------------------------------------------- per-project permissions
{
  // editors can share
  check('owner lets editors share', (await call(owner, 'PATCH', `${api}/permissions`, { editorsCanShare: true })).status === 200);
  const mine = await call(ed, 'POST', `${api}/links`, { role: 'commenter' });
  check('an editor now makes a link', mine.status === 200);
  const inv = await call(ed, 'POST', `${api}/invites`, { login: 'roles-nobody-yet', role: 'viewer' });
  check('…and invites someone', inv.status === 200 && inv.json.status === 'pending', inv.text);
  const edLinks = (await call(ed, 'GET', `${api}/links`)).json.links;
  check('…sees only the links they made', edLinks.length === 1 && edLinks[0].token === mine.json.token);
  check('…cannot turn off the owner\'s link', (await call(ed, 'DELETE', `/api/links/${commentLink.token}`)).status === 404);
  check('…cannot change or remove members, or the permissions', (await call(ed, 'PATCH', `${api}/members/${view.id}`, { role: 'editor' })).status === 403
    && (await call(ed, 'DELETE', `${api}/members/${view.id}`)).status === 403 && (await call(ed, 'PATCH', `${api}/permissions`, { viewersCanCopy: false })).status === 403);
  const edView = (await call(ed, 'GET', `${api}/members`)).json;
  check('…sees the invite they sent and can cancel it', edView.canShare && !edView.canManage && edView.pending.length === 1
    && (await call(ed, 'DELETE', `${api}/invites/${edView.pending[0].inviteId}`)).status === 200);
  check('a commenter still cannot share', (await call(com, 'POST', `${api}/links`, { role: 'viewer' })).status === 403);
  check('…the editor turns their own link off', (await call(ed, 'DELETE', `/api/links/${mine.json.token}`)).status === 200);
  await call(owner, 'PATCH', `${api}/permissions`, { editorsCanShare: false });
  check('with the setting off again an editor cannot share', (await call(ed, 'POST', `${api}/links`, { role: 'viewer' })).status === 403);

  // viewers can copy
  check('owner stops viewers copying', (await call(owner, 'PATCH', `${api}/permissions`, { viewersCanCopy: false })).status === 200);
  for (const p of [view, com]) {
    const a = await call(p, 'GET', `${api}/archive`), c = await call(p, 'POST', `${api}/clone`);
    check(`${p.login} can no longer download or copy the project`, a.status === 403 && a.json.error === 'copy_disabled' && c.status === 403 && c.json.error === 'copy_disabled' && (await call(p, 'GET', api)).json.can.copy === false, a.text);
    check(`…but still opens it`, (await call(p, 'GET', `/api/docs/${D}/content`)).status === 200);
  }
  check('an editor still downloads it', (await call(ed, 'GET', `${api}/archive`)).status === 200);
  await call(owner, 'PATCH', `${api}/permissions`, { viewersCanCopy: true });

  // public projects
  check('made public, a signed-in visitor views', (await call(owner, 'PATCH', api, { public: true })).status === 200 && (await call(late, 'GET', api)).json.role === 'viewer');
  check('…but cannot comment', (await call(late, 'POST', `/api/docs/${D}/comments`, { body: 'x', x: 0, y: 0 })).status === 403);
  check('…a visitor is not a member', (await call(late, 'GET', `${api}/members`)).status === 403);
  check('visitors cannot be given the editor role', (await call(owner, 'PATCH', `${api}/permissions`, { publicRole: 'editor' })).status === 400);
  const L = connect(late, 'late'); const linfo = await join(L, D);
  check('owner lets visitors comment', (await call(owner, 'PATCH', `${api}/permissions`, { publicRole: 'commenter' })).status === 200);
  check('…a signed-in visitor can', (await call(late, 'GET', api)).json.role === 'commenter' && (await call(late, 'POST', `/api/docs/${D}/comments`, { body: 'nice board', x: 3, y: 3 })).status === 200);
  check('…but still cannot edit', linfo.role === 'viewer' && await tryOp(L, D) === 'permission_denied');
  const anon = await call(null, 'GET', `${api}/info`);
  check('…someone signed out reads and nothing more', anon.status === 200 && anon.json.role === 'viewer' && !anon.json.can.comment
    && (await call(null, 'POST', `/api/docs/${D}/comments`, { body: 'x', x: 0, y: 0 })).status === 401);
  const AG = connect(null, 'anon'); const ainfo = await join(AG, D);
  check('…and can watch a public project live as a guest', ainfo.type === 'doc_info' && ainfo.role === 'viewer');
  check('made private again', (await call(owner, 'PATCH', api, { public: false })).status === 200);
  check('…the visitor and the guest are dropped', !!(await L.wait((m) => m.type === 'error' && m.code === 'permission_denied' && !m.clientOpId, 5000).catch(() => null))
    && !!(await AG.wait((m) => m.type === 'error' && m.code === 'permission_denied', 5000).catch(() => null)));
  L.close(); AG.close();
  const perms = (await call(view, 'GET', `${api}/permissions`)).json;
  check('anyone in the project can read the settings', perms.role === 'viewer' && perms.permissions.publicRole === 'commenter' && perms.permissions.viewersCanCopy === true, JSON.stringify(perms));
}

// ---------------------------------------------------------------- Claude over MCP follows the person's role
if (process.env.ROLES_SKIP_MCP !== '1') {
  const rpc = async (who, method, params) => {
    const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${who.jwt}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const text = await r.text();
    const line = text.startsWith('{') ? text : (text.split('\n').filter((l) => l.startsWith('data:')).pop() || '').slice(5);
    try { return JSON.parse(line); } catch { return { error: { message: text.slice(0, 200) } }; }
  };
  const tool = async (who, name, args) => { const r = await rpc(who, 'tools/call', { name, arguments: args }); const c = r.result?.content?.find((x) => x.type === 'text'); return { isError: !!r.result?.isError || !!r.error, text: c?.text || JSON.stringify(r.error) }; };
  const v = await tool(view, 'add_comment', { project: P, document: 'roles.kicad_sch', text: 'from a viewer', x: 1, y: 1 });
  check('MCP: a viewer\'s Claude cannot comment', v.isError && /only view/.test(v.text), v.text);
  const v2 = await tool(view, 'create_checkpoint', { project: P, name: 'x' });
  check('MCP: …nor save a version', v2.isError && /only view/.test(v2.text), v2.text);
  const v3 = await tool(view, 'get_project', { project: P });
  check('MCP: …but can read, and is told its role', !v3.isError && /viewer/.test(v3.text), v3.text.slice(0, 200));
  const c = await tool(com, 'apply_changes', { project: P, title: 'x', changes: [] });
  check('MCP: a commenter\'s Claude cannot change the design', c.isError && /can comment/.test(c.text), c.text);
  const c2 = await tool(com, 'add_comment', { project: P, document: 'roles.kicad_sch', text: 'from a commenter over MCP', x: 10, y: 10 });
  check('MCP: …but can comment', !c2.isError, c2.text.slice(0, 300));
  const all = (await call(owner, 'GET', `/api/docs/${D}/comments`)).json.comments;
  check('MCP: …and the comment is there, under their name', all.some((x) => /over MCP/.test(x.body) && x.authorLogin === com.login), JSON.stringify(all.slice(-1)));
}

// ---------------------------------------------------------------- clean up
for (const s of Object.values(S)) s.close();
await call(owner, 'DELETE', `${api}?permanent=true`);
await db.query('DELETE FROM projects WHERE id = $1', [P]).catch(() => {});
await db.query(`DELETE FROM users WHERE login LIKE 'roles-%'`).catch((e) => console.log('cleanup:', e.message));
await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
