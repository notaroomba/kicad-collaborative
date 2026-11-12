// End-to-end test of the MCP endpoint (src/mcp.rs, src/oauth.rs, web/mcp): everything an MCP
// client does, against a running server, with a second collaboration client watching the
// documents so that "the edit appears live for everyone" is checked, not assumed.
//
//   - discovery, client registration, the consent page, PKCE, refresh rotation, revocation
//   - the protocol: initialize, tools/list, prompts, JSON and event-stream answers, errors
//   - a design made through the tools: project, schematic, board, placement, rules, routing
//   - reading it back: components, nets, checks, items, source text, pictures
//   - undo, and an undo refused because somebody edited the same item since
//   - comments and checkpoints
//   - a read-only connection and a view-only project
//   - optionally (SHOTS=dir) a browser with the design open, to see the edits and the peer
//
// Server as for the other tests, with node on its PATH (the headless editor runs in it):
//   DATABASE_URL=… JWT_SECRET=testsecret PUBLIC_URL=http://127.0.0.1:8099 PORT=8099 KC_DEV_LOGIN=1 \
//     KICAD_LIBS_URL=http://127.0.0.1:8096 ./target/debug/kicad-collab-server
//   (PORT=8096 node kicad-libs-mirror.mjs when gitlab.com is not reachable directly)
//
//   E2E_PG_URL=… E2E_JWT_SECRET=testsecret [SHOTS=dir] [OUT=dir] node mcp-e2e.mjs
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import pg from 'pg';

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '', OUT = process.env.OUT || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required (see the header comment).'); process.exit(2); }
for (const d of [SHOTS, OUT]) if (d) fs.mkdirSync(d, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); ok ? pass++ : fail++; return ok; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function mintJwt(sub, login) {
  const now = Math.floor(Date.now() / 1000); const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 7200 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}

pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
const user = async (gid, login) => (await db.query(`INSERT INTO users (github_id, login, name) VALUES ($1, $2, $2)
  ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [gid, login])).rows[0].id;
const ada = await user(9411, 'mcp-ada'), bob = await user(9412, 'mcp-bob');
await db.query(`DELETE FROM projects WHERE owner_id = ANY($1)`, [[ada, bob]]);
await db.query(`DELETE FROM mcp_grants WHERE user_id = ANY($1)`, [[ada, bob]]);
const adaJwt = mintJwt(ada, 'mcp-ada'), bobJwt = mintJwt(bob, 'mcp-bob');

// ------------------------------------------------------------------ discovery

{
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
  const www = r.headers.get('www-authenticate') || '';
  check('a call without a token is answered 401 with the way to sign in', r.status === 401 && /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/.test(www), www);
  const meta = await (await fetch(/resource_metadata="([^"]+)"/.exec(www)[1])).json();
  check('protected resource metadata names this endpoint and its authorization server', meta.resource === `${BASE}/mcp` && meta.authorization_servers[0] === BASE, JSON.stringify(meta));
  const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  check('authorization server metadata: endpoints, PKCE S256, public clients',
    as.issuer === BASE && as.authorization_endpoint && as.token_endpoint && as.registration_endpoint && as.code_challenge_methods_supported.includes('S256') && as.token_endpoint_auth_methods_supported.includes('none'));
  const cors = await fetch(`${BASE}/mcp`, { method: 'OPTIONS', headers: { origin: 'https://example.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,mcp-protocol-version' } });
  check('a browser-based client may call the endpoint (CORS preflight)', cors.ok && cors.headers.get('access-control-allow-origin') === '*');
  const page = await fetch(`${BASE}/mcp`, { headers: { accept: 'text/html' }, redirect: 'manual' });
  check('a person who opens the endpoint in a browser is sent to the Connect page', page.status === 303 && page.headers.get('location') === '/connect', `${page.status} ${page.headers.get('location')}`);
  const stream = await fetch(`${BASE}/mcp`, { headers: { accept: 'text/event-stream' } });
  check('GET for a server stream is 405 (there is none)', stream.status === 405);
}

// ------------------------------------------------------------------ OAuth

const REDIRECT = 'http://localhost:53999/callback';
async function register(body) { return fetch(`${BASE}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
const pkce = () => { const verifier = crypto.randomBytes(40).toString('base64url'); return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') }; };
const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });

/** The whole browser leg as a signed-in person: consent page, Allow (or Cancel), back to the app with a code. */
async function authorize(clientId, jwt, { write = true, decision = 'allow', scope, redirect = REDIRECT } = {}) {
  const p = pkce(); const state = crypto.randomBytes(8).toString('hex');
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, state, code_challenge: p.challenge, code_challenge_method: 'S256' });
  if (scope) q.set('scope', scope);
  const pageR = await fetch(`${BASE}/oauth/authorize?${q}`, { headers: { cookie: `kc_session=${jwt}` }, redirect: 'manual' });
  const html = await pageR.text();
  const request = (/name="request" value="([^"]+)"/.exec(html) || [])[1];
  if (!request) return { status: pageR.status, html, location: pageR.headers.get('location') };
  const f = { request, decision }; if (write) f.write = '1';
  const back = await fetch(`${BASE}/oauth/authorize`, { ...form(f), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `kc_session=${jwt}` }, redirect: 'manual' });
  const loc = new URL(back.headers.get('location'));
  return { html, request, verifier: p.verifier, state, location: loc, code: loc.searchParams.get('code'), offersWrite: /name="write"/.test(html) };
}
const exchange = (clientId, code, verifier, redirect = REDIRECT) => fetch(`${BASE}/oauth/token`, form({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: redirect }));

let clientId, tokens;
{
  const bad = await register({ client_name: 'Evil', redirect_uris: ['http://evil.example/cb'] });
  check('registration refuses a plain http redirect to another host', bad.status === 400 && (await bad.json()).error === 'invalid_redirect_uri');
  const r = await register({ client_name: 'MCP e2e client', redirect_uris: ['http://localhost/callback'], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none' });
  const j = await r.json(); clientId = j.client_id;
  check('a client registers itself', r.status === 201 && /^kcm_/.test(clientId) && j.token_endpoint_auth_method === 'none', JSON.stringify(j).slice(0, 200));

  const anon = await fetch(`${BASE}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256' })}`, { redirect: 'manual' });
  check('someone who is not signed in is sent to sign in first, and back', anon.status === 303 && /^\/auth\/github\/login\?next=%2Foauth%2Fauthorize/.test(anon.headers.get('location') || ''), anon.headers.get('location'));
  const stranger = await authorize('kcm_nobody', adaJwt);
  check('an unknown client gets a page, never a redirect', stranger.status === 400 && /not registered/.test(stranger.html));
  const elsewhere = await authorize(clientId, adaJwt, { redirect: 'https://evil.example/cb' });
  check('a redirect address the client did not register is refused', elsewhere.status === 400 && /not one it registered/.test(elsewhere.html));
  const noPkce = await fetch(`${BASE}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 's' })}`, { headers: { cookie: `kc_session=${adaJwt}` }, redirect: 'manual' });
  check('an authorization without PKCE is refused', /error=invalid_request/.test(noPkce.headers.get('location') || ''), noPkce.headers.get('location'));

  const denied = await authorize(clientId, adaJwt, { decision: 'deny' });
  check('the consent page names the app and the account', /MCP e2e client/.test(denied.html) && /mcp-ada/.test(denied.html) && denied.offersWrite);
  check('Cancel returns access_denied with the state', denied.location.searchParams.get('error') === 'access_denied' && denied.location.searchParams.get('state') === denied.state);
  const replay = await fetch(`${BASE}/oauth/authorize`, { ...form({ request: denied.request, decision: 'allow', write: '1' }), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `kc_session=${adaJwt}` }, redirect: 'manual' });
  check('an answered consent cannot be answered again', replay.status === 400);

  const other = await authorize(clientId, adaJwt);
  const hijack = await fetch(`${BASE}/oauth/authorize`, { ...form({ request: (await authorize(clientId, adaJwt, { decision: 'none' }).catch(() => ({}))).request || 'x', decision: 'allow' }), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `kc_session=${bobJwt}` }, redirect: 'manual' });
  check('a consent cannot be given by another account', hijack.status === 400);
  const wrong = await exchange(clientId, other.code, 'x'.repeat(50));
  check('a code with the wrong PKCE verifier is refused', wrong.status === 400 && (await wrong.json()).error === 'invalid_grant');
  const spent = await exchange(clientId, other.code, other.verifier);
  check('and the code is spent by that attempt', spent.status === 400);

  const ok = await authorize(clientId, adaJwt);
  check('Allow returns a code with the state', !!ok.code && ok.location.searchParams.get('state') === ok.state && ok.location.port === '53999');
  const t = await exchange(clientId, ok.code, ok.verifier); tokens = await t.json();
  check('the code is exchanged for an access and a refresh token', t.ok && /^kcm_at_/.test(tokens.access_token) && /^kcm_rt_/.test(tokens.refresh_token) && tokens.scope === 'read write' && tokens.expires_in === 3600, JSON.stringify(tokens).slice(0, 160));
  const again = await exchange(clientId, ok.code, ok.verifier);
  check('a code works once', again.status === 400);
}

// ------------------------------------------------------------------ the protocol

let rpcId = 0;
async function rpc(token, method, params, { sse = false, raw = false } = {}) {
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: sse ? 'application/json, text/event-stream' : 'application/json', authorization: `Bearer ${token}`, 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  if (raw) return r;
  if ((r.headers.get('content-type') || '').includes('text/event-stream')) {
    const text = await r.text(); const events = text.split(/\n\n/).map((f) => f.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')).filter(Boolean).map((d) => JSON.parse(d));
    return Object.assign(events.find((e) => e.id !== undefined) || {}, { __stream: true, __events: events });
  }
  return r.status === 202 ? null : r.json();
}
/** Call a tool; the result's JSON text parsed, with isError and any image alongside. */
async function call(token, name, args, opts) {
  const r = await rpc(token, 'tools/call', { name, arguments: args }, opts);
  if (!r || !r.result) return { isError: true, text: JSON.stringify(r && r.error), rpcError: r && r.error };
  const text = (r.result.content.find((c) => c.type === 'text') || {}).text || ''; let data = null; try { data = JSON.parse(text); } catch { /* prose */ }
  return { isError: !!r.result.isError, text, data, image: r.result.content.find((c) => c.type === 'image'), stream: !!r.__stream };
}
const T = () => tokens.access_token;

{
  const init = await rpc(T(), 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  check('initialize: the version asked for, tools and prompts, instructions, the icon', init.result.serverInfo.icons[0].src === `${BASE}/icon-192.png` && (await fetch(`${BASE}/favicon.ico`)).headers.get('content-type') === 'image/x-icon' && init.result.protocolVersion === '2025-06-18' && init.result.capabilities.tools && init.result.capabilities.prompts && init.result.serverInfo.name === 'kicad-collaborative' && init.result.instructions.length > 200);
  const old = await rpc(T(), 'initialize', { protocolVersion: '1999-01-01' });
  check('an unknown protocol version is answered with one this server speaks', old.result.protocolVersion === '2025-06-18');
  const note = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${T()}` }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  check('a notification is accepted with 202', note.status === 202);
  check('ping', JSON.stringify((await rpc(T(), 'ping')).result) === '{}');
  const list = (await rpc(T(), 'tools/list')).result.tools;
  check('tools/list: the catalog, each tool with a schema and annotations', list.length === 28 && list.every((t) => t.inputSchema && t.inputSchema.type === 'object' && t.annotations && t.description.length > 40), `${list.length} tools`);
  check('the assistant\'s editor-only tools are not offered', !list.some((t) => ['get_selection', 'focus_view', 'open_document', 'propose_changes'].includes(t.name)));
  const unknown = await rpc(T(), 'nope/nothing');
  check('an unknown method is a JSON-RPC error', unknown.error && unknown.error.code === -32601);
  const noTool = await rpc(T(), 'tools/call', { name: 'no_such_tool', arguments: {} });
  check('an unknown tool is a JSON-RPC error', noTool.error && noTool.error.code === -32602);
  const batch = await (await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${T()}` }, body: JSON.stringify([{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 'b', method: 'tools/list' }]) })).json();
  check('a batch is answered request by request', Array.isArray(batch) && batch.length === 2 && batch[0].id === 'a' && batch[1].result.tools.length === list.length);
  const prompts = (await rpc(T(), 'prompts/list')).result.prompts;
  const got = await rpc(T(), 'prompts/get', { name: 'review_design', arguments: { project: 'amp' } });
  check('prompts: listed and filled in', prompts.length === 3 && /project amp/.test(got.result.messages[0].content.text));
  const garbage = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${T()}` }, body: 'not json' });
  check('a body that is not JSON is a parse error', garbage.status === 400 && (await garbage.json()).error.code === -32700);
  const forged = await rpc('kcm_at_' + 'A'.repeat(43), 'ping', undefined, { raw: true });
  check('a made-up token is 401', forged.status === 401);
  const cookieOnly = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `kc_session=${adaJwt}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
  check('the session cookie alone does not open the endpoint', cookieOnly.status === 401);
  const guide = await call(T(), 'get_design_guide', { topic: 'schematic' });
  check('get_design_guide returns the topic with the general rules', !guide.isError && /## Drawing schematics/.test(guide.text) && /## Working on a design/.test(guide.text) && !/## Routing a board/.test(guide.text));
}

// ------------------------------------------------------------------ a second client, watching

/** A collaboration client as the browser is one: joins a document and remembers what arrives. */
function watch(docId, jwt) {
  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws'); const w = { ops: [], presence: {}, peers: [], role: '', ws, ready: null, ack: new Map(), n: 0 };
  w.ready = new Promise((resolve, reject) => {
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', proto: 1, token: jwt, clientId: 'watch-' + crypto.randomBytes(4).toString('hex'), linkToken: null, client: 'web' }));
    ws.onerror = () => reject(new Error('watcher socket failed'));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'hello_ok') ws.send(JSON.stringify({ type: 'join_doc', docId }));
      else if (m.type === 'doc_info') w.role = m.role;
      else if (m.type === 'snapshot') { w.file = m.file; resolve(w); }
      else if (m.type === 'op') w.ops.push(m);
      else if (m.type === 'ops') w.ops.push(...m.ops);
      else if (m.type === 'presence') Object.assign(w.presence, m.peers);
      else if (m.type === 'ack' && w.ack.has(m.clientOpId)) { w.ack.get(m.clientOpId)(m.seq); w.ack.delete(m.clientOpId); }
      else if (m.type === 'comment') (w.comments = w.comments || []).push(m);
    };
  });
  w.send = (changes) => new Promise((ok) => { const id = `watch:${++w.n}`; w.ack.set(id, ok); ws.send(JSON.stringify({ type: 'op', docId, clientOpId: id, baseSeq: null, changes })); });
  w.changes = () => w.ops.flatMap((o) => o.changes || []);
  return w.ready;
}
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(100); } return false; };

// ------------------------------------------------------------------ a project, a schematic

const NAME = 'mcp-e2e-divider';
let projectId, schPath, pcbPath, schDocId, pcbDocId;
{
  const empty = await call(T(), 'list_projects', {});
  check('list_projects: none yet', !empty.isError && empty.data.count === 0 && empty.data.account === 'mcp-ada', empty.text);
  const missing = await call(T(), 'get_design_overview', { project: 'no-such-project' });
  check('a project that does not exist is an error the model can read', missing.isError && /There is no project/.test(missing.text), missing.text);
  const made = await call(T(), 'create_project', { name: NAME });
  projectId = made.data && made.data.project_id;
  check('create_project', !made.isError && !!projectId && made.data.documents.length === 3, made.text);
  const dup = await call(T(), 'create_project', { name: NAME.toUpperCase() });
  check('a second project of the same name is refused, with the id of the first', dup.isError && dup.text.includes(projectId), dup.text);
  const proj = await call(T(), 'get_project', { project: NAME });
  schPath = proj.data.documents.find((d) => d.type === 'schematic').path; pcbPath = proj.data.documents.find((d) => d.type === 'board').path;
  check('get_project by name: documents, role, address', proj.data.your_role === 'editor' && !!schPath && !!pcbPath && proj.data.url.endsWith(`/p/${projectId}/edit`), proj.text);
  const rows = (await db.query(`SELECT id, doc_type FROM documents WHERE project_id = $1`, [projectId])).rows;
  schDocId = rows.find((r) => r.doc_type === 'kicad_sch').id; pcbDocId = rows.find((r) => r.doc_type === 'kicad_pcb').id;
  const over = await call(T(), 'get_design_overview', { project: projectId });
  check('get_design_overview by id describes the root sheet', !over.isError && over.data.project === NAME && over.data.document.type === 'schematic' && over.data.document.components === 0, over.text.slice(0, 300));
}

{
  const bare = await call(T(), 'get_board_info', { project: NAME });
  check('an empty board has no size until an outline is drawn', !bare.isError && bare.data.size_mm === null && /No board outline/.test(bare.data.outline), bare.text.slice(0, 200));
}
const schWatch = await watch(schDocId, adaJwt);
let firstChange;
{
  const part = await call(T(), 'get_library_part', { id: 'Device:R' });
  const pins = part.data && part.data.units && part.data.units[0].pins;
  check('get_library_part: a library symbol with its pin positions', !part.isError && pins && pins.length === 2, part.text.slice(0, 300));
  const found = await call(T(), 'find_parts', { query: 'R_0603', kind: 'footprint', vendor: 'none' });
  check('find_parts searches the KiCad libraries', !found.isError && /R_0603_1608Metric/.test(found.text), found.text.slice(0, 200));
  { // read_datasheet: a PDF served from this machine (the server needs AI_DATASHEET_ALLOW_LOCAL=1), read through MCP
    const http = await import('node:http');
    const pdfBrowser = await createRequire(import.meta.url)('playwright').chromium.launch(); const pdfPage = await pdfBrowser.newPage();
    await pdfPage.setContent('<style>section{break-after:page}</style><section><h1>XR1 Datasheet</h1></section><section><h2>Crystal</h2><p>The crystal load capacitance is 15 pF.</p></section>');
    const bytes = await pdfPage.pdf({ format: 'A4' }); await pdfBrowser.close();
    const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(bytes); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const ds = await call(T(), 'read_datasheet', { url: `http://127.0.0.1:${srv.address().port}/xr1.pdf?t=${Date.now()}`, query: 'crystal load capacitance' });
    if (ds.isError && /https link/.test(ds.text)) console.log('  (skipped: start the server with AI_DATASHEET_ALLOW_LOCAL=1 to test read_datasheet)');
    else check('read_datasheet returns the page that answers', !ds.isError && ds.data && ds.data.page_count === 2 && ds.data.pages[0].page === 2 && /15 pF/.test(ds.data.pages[0].text), ds.text.slice(0, 300));
    srv.close();
  }

  // a two-resistor divider, drawn the way a model would: pin ends from get_library_part, wires between them
  const X = 100.33, Y1 = 80.01, Y2 = 95.25; const top = pins.find((p) => p.dy < 0) || pins[0], bot = pins.find((p) => p !== top);
  const end = (y, p) => [+(X + p.dx).toFixed(2), +(y + p.dy).toFixed(2)];
  const FP = 'Resistor_SMD:R_0603_1608Metric';
  const edits = [
    { op: 'add_symbol', lib_id: 'Device:R', x: X, y: Y1, reference: 'R1', value: '10k', fields: { Footprint: FP } },
    { op: 'add_symbol', lib_id: 'Device:R', x: X, y: Y2, reference: 'R2', value: '4k7', fields: { Footprint: FP } },
    { op: 'add_wire', points: [end(Y1, bot), end(Y2, top)] },
    { op: 'add_label', kind: 'label', text: 'VIN', x: end(Y1, top)[0], y: end(Y1, top)[1] },
    { op: 'add_label', kind: 'label', text: 'GND', x: end(Y2, bot)[0], y: end(Y2, bot)[1] },
    { op: 'add_wire', points: [end(Y1, bot).map((v, i) => (i ? +(v + 3.81).toFixed(2) : v)), [X + 7.62, +(end(Y1, bot)[1] + 3.81).toFixed(2)]] },
    { op: 'add_label', kind: 'label', text: 'VOUT', x: X + 7.62, y: +(end(Y1, bot)[1] + 3.81).toFixed(2) },
  ];
  const dry = await call(T(), 'apply_changes', { project: NAME, document: schPath, title: 'Voltage divider', edits, dry_run: true });
  check('dry_run describes the edits and changes nothing', !dry.isError && dry.data.applied === false && dry.data.edits.length === 7 && schWatch.ops.length === 0, dry.text.slice(0, 300));
  const bad = await call(T(), 'apply_changes', { project: NAME, document: schPath, title: 'Broken', edits: [edits[0], { op: 'add_wire', points: [[1, 1]] }, { op: 'remove', ref: 'R99' }] });
  await sleep(300);
  check('one invalid edit and nothing is applied; every problem is named', bad.isError && /edit 2/.test(bad.text) && /edit 3/.test(bad.text) && schWatch.ops.length === 0, bad.text);

  const done = await call(T(), 'apply_changes', { project: NAME, document: schPath, title: 'Voltage divider', rationale: 'Divide VIN down to VOUT.', edits }, { sse: true });
  firstChange = done.data && done.data.change_id;
  check('apply_changes applies, answers over an event stream, and returns a change id', !done.isError && done.data.applied === true && done.data.changes === 7 && firstChange > 0 && done.stream, done.text.slice(0, 400));
  const seen = await until(() => schWatch.changes().length >= 7);
  const op = schWatch.ops[0] || {};
  check('the other client receives the edit live, as one op', seen && schWatch.ops.length === 1 && schWatch.changes().filter((c) => c.kind === 'ADDED').length === 7, `${schWatch.ops.length} ops, ${schWatch.changes().length} changes`);
  check('the op is attributed to the person, made through an app', op.author && op.author.login === 'mcp-ada' && op.author.client === 'mcp', JSON.stringify(op.author));
  const marked = await until(() => Object.values(schWatch.presence).some((p) => p && p.user && /\(MCP e2e client\)/.test(p.user.name) && p.state && p.state.selection && p.state.selection.length === 7));
  check('peers see who it is and what it just touched', marked, JSON.stringify(Object.values(schWatch.presence).map((p) => p && p.user && p.user.name)));
}

// ------------------------------------------------------------------ reading it back

{
  const comps = await call(T(), 'list_components', { project: NAME, document: schPath });
  check('list_components', !comps.isError && comps.data.count === 2 && comps.data.components.map((c) => c.ref).join() === 'R1,R2', comps.text.slice(0, 300));
  const r1 = await call(T(), 'get_component', { project: NAME, document: schPath, ref: 'R1' });
  check('get_component: fields and the net of each pin', !r1.isError && /"Footprint":"Resistor_SMD:R_0603_1608Metric"/.test(r1.text) && /VIN/.test(r1.text), r1.text.slice(0, 400));
  const nets = await call(T(), 'list_nets', { project: NAME, document: schPath });
  const names = nets.data.nets.map((n) => n.name).sort();
  check('list_nets: the three nets with their pins', names.join() === 'GND,VIN,VOUT' && nets.data.nets.find((n) => n.name === 'VOUT').pins.length === 2, nets.text.slice(0, 400));
  const erc = await call(T(), 'run_checks', { project: NAME, document: schPath });
  check('run_checks runs the ERC', !erc.isError && erc.data.check === 'ERC' && typeof erc.data.errors === 'number', erc.text.slice(0, 200));
  const wires = await call(T(), 'get_items', { project: NAME, document: schPath, kinds: ['wire', 'label'] });
  check('get_items: wires and labels as s-expressions', !wires.isError && wires.data.count === 5 && /\(wire/.test(wires.text), wires.text.slice(0, 200));
  const ds = await call(T(), 'find_datasheets', { project: NAME, document: schPath });
  check('find_datasheets groups the parts', !ds.isError && ds.data.parts.length === 2);
  const src = await call(T(), 'read_document', { project: NAME, document: schPath, max_chars: 2000 });
  check('read_document: KiCad source, in parts', !src.isError && src.data.text.startsWith('(kicad_sch') && src.data.next_offset === 2000 && src.data.total_chars > 2000, src.text.slice(0, 120));
  const rest = await call(T(), 'read_document', { project: NAME, document: 'schematic', offset: src.data.next_offset, max_chars: 100000 });
  check('and the rest of it', !rest.isError && rest.data.offset === 2000 && rest.data.next_offset === undefined && /label "?VOUT/.test(rest.data.text));
  const noDoc = await call(T(), 'list_components', { project: NAME, document: 'nothing.kicad_sch' });
  check('a document that does not exist is named with the ones that do', noDoc.isError && noDoc.text.includes(schPath), noDoc.text);

  const pic = await call(T(), 'render_view', { project: NAME, document: schPath, refs: ['R1', 'R2'], width_px: 1200 });
  const png = pic.image ? Buffer.from(pic.image.data, 'base64') : Buffer.alloc(0);
  check('render_view: a PNG of the part asked for', !pic.isError && pic.image && pic.image.mimeType === 'image/png' && png.subarray(1, 4).toString() === 'PNG' && Math.max(...pic.data.image_px) === 1200 && png.length > 3000, `${png.length} bytes ${pic.text.slice(0, 160)}`);
  if (OUT) fs.writeFileSync(path.join(OUT, 'schematic-divider.png'), png);
  const whole = await call(T(), 'render_view', { project: NAME, document: schPath });
  check('render_view: the whole sheet with its frame', !whole.isError && whole.image && Buffer.from(whole.image.data, 'base64').length > 8000 && whole.data.shown_mm[2] > 200, whole.text.slice(0, 160));
  if (OUT) fs.writeFileSync(path.join(OUT, 'schematic-sheet.png'), Buffer.from(whole.image.data, 'base64'));
}

// ------------------------------------------------------------------ undo

{
  const before = schWatch.ops.length;
  const edit = await call(T(), 'apply_changes', { project: NAME, document: schPath, title: 'R2 to 5k1', edits: [{ op: 'set_field', ref: 'R2', field: 'Value', value: '5k1' }] });
  await until(() => schWatch.ops.length > before);
  const log = await call(T(), 'list_changes', { project: NAME });
  check('list_changes: both changes, newest first', log.data.count === 2 && log.data.changes[0].title === 'R2 to 5k1' && log.data.changes[0].can_undo && log.data.changes[1].change_id === firstChange && log.data.changes[0].made_with === 'MCP e2e client', log.text.slice(0, 300));
  const undo = await call(T(), 'undo_changes', { project: NAME });
  await until(() => schWatch.ops.length > before + 1);
  const r2 = await call(T(), 'get_component', { project: NAME, document: schPath, ref: 'R2' });
  check('undo_changes takes back the newest change, for everyone', !undo.isError && undo.data.change_id === edit.data.change_id && /"Value":"4k7"/.test(r2.text) && schWatch.ops.length === before + 2, undo.text);
  const twice = await call(T(), 'undo_changes', { project: NAME, change_id: edit.data.change_id });
  check('a change is undone once', twice.isError && /already been undone/.test(twice.text), twice.text);
  const redo = await call(T(), 'redo_changes', { project: NAME });
  const r2b = await call(T(), 'get_component', { project: NAME, document: schPath, ref: 'R2' });
  check('redo_changes puts the undone change back', !redo.isError && redo.data.change_id === edit.data.change_id && /"Value":"5k1"/.test(r2b.text), redo.text);
  const reredo = await call(T(), 'redo_changes', { project: NAME });
  check('and there is then nothing left to redo', reredo.isError && /no undone change/.test(reredo.text), reredo.text);
  const unredo = await call(T(), 'undo_changes', { project: NAME, change_id: edit.data.change_id });
  const r2c = await call(T(), 'get_component', { project: NAME, document: schPath, ref: 'R2' });
  check('a redone change can be undone again', !unredo.isError && /"Value":"4k7"/.test(r2c.text), unredo.text);

  // somebody else edits R1 after a change to it: the undo must not overwrite their work
  const mine = await call(T(), 'apply_changes', { project: NAME, document: schPath, title: 'R1 to 12k', edits: [{ op: 'set_field', ref: 'R1', field: 'Value', value: '12k' }] });
  const r1 = (await call(T(), 'get_items', { project: NAME, document: schPath, kinds: ['symbol'] })).data.items.find((i) => i.ref === 'R1');
  const full = (await call(T(), 'get_items', { project: NAME, document: schPath, ids: [r1.id] })).data.items[0].sexpr;
  await schWatch.send([{ id: r1.id, kind: 'MODIFIED', typeName: 'SCH_SYMBOL', sexpr: full.replace('"12k"', '"15k"') }]);
  await sleep(500);
  const blocked = await call(T(), 'undo_changes', { project: NAME, change_id: mine.data.change_id });
  const now = await call(T(), 'get_component', { project: NAME, document: schPath, ref: 'R1' });
  check('an undo is refused when someone has edited the item since, and their edit stands', blocked.isError && /edited since/.test(blocked.text) && /"Value":"15k"/.test(now.text), blocked.text);
  check('the headless editor follows other people\'s edits', /"Value":"15k"/.test(now.text));
}

// ------------------------------------------------------------------ the board

const pcbWatch = await watch(pcbDocId, adaJwt);
{
  const sync = await call(T(), 'apply_changes', { project: NAME, document: 'board', title: 'Bring the parts to the board',
    edits: [{ op: 'update_from_schematic' }, { op: 'add_item', sexpr: '(gr_rect (start 100 80) (end 120 95) (stroke (width 0.1) (type default)) (fill no) (layer "Edge.Cuts"))' }] });
  check('update_from_schematic adds the footprints with their nets', !sync.isError && sync.data.applied && /Add R1/.test(sync.text) && /Add R2/.test(sync.text), sync.text.slice(0, 500));
  const place = await call(T(), 'apply_changes', { project: NAME, document: pcbPath, title: 'Place the divider',
    edits: [{ op: 'move', ref: 'R1', x: 106, y: 87.5 }, { op: 'move', ref: 'R2', x: 114, y: 87.5 }] });
  check('footprints are moved', !place.isError && place.data.applied, place.text.slice(0, 300));
  const rules = await call(T(), 'apply_changes', { project: NAME, document: pcbPath, title: 'Board rules', edits: [{ op: 'set_rules', clearance: 0.2, track_width: 0.3, min_track_width: 0.15 }] });
  const info1 = await call(T(), 'get_board_info', { project: NAME });
  const cls = (i) => (i.data.design_rules.net_classes || {}).Default || {};
  check('set_rules writes the project file and the board reads them back', !rules.isError && rules.data.applied && info1.data.design_rules.min_track_width === 0.15 && cls(info1).track_width === 0.3, JSON.stringify(info1.data.design_rules).slice(0, 400));
  check('get_board_info: outline, footprints, what is unrouted', info1.data.size_mm.width > 19 && info1.data.statistics && info1.data.unrouted_connections >= 1, JSON.stringify(info1.data.size_mm) + ' unrouted ' + info1.data.unrouted_connections);

  const before = pcbWatch.ops.length;
  const route = await call(T(), 'apply_changes', { project: NAME, document: pcbPath, title: 'Route the divider', edits: [{ op: 'autoroute', time_s: 10 }] }, { sse: true });
  const ar = route.data && route.data.details && route.data.details[0] && route.data.details[0].autoroute;
  check('autoroute routes the board and reports', !route.isError && ar && ar.routed === ar.connections && ar.segments >= 1, route.text.slice(0, 500));
  await until(() => pcbWatch.ops.length > before);
  check('the tracks reach the other client', pcbWatch.changes().some((c) => c.kind === 'ADDED' && /segment/.test(c.sexpr || '')), `${pcbWatch.ops.length} ops`);
  const drc = await call(T(), 'run_checks', { project: NAME, document: pcbPath });
  check('the routed board passes the DRC with nothing unconnected', !drc.isError && drc.data.check === 'DRC' && drc.data.errors === 0 && !drc.data.violations.some((v) => v.code === 'unconnected_items'), drc.text.slice(0, 400));
  const pic = await call(T(), 'render_view', { project: NAME, document: 'board' });
  check('render_view draws the board', !pic.isError && pic.image && Buffer.from(pic.image.data, 'base64').length > 3000, pic.text.slice(0, 200));
  if (OUT) fs.writeFileSync(path.join(OUT, 'board-routed.png'), Buffer.from(pic.image.data, 'base64'));
  const cu = await call(T(), 'render_view', { project: NAME, document: 'board', layers: ['F.Cu', 'Edge.Cuts'] });
  const noLayer = await call(T(), 'render_view', { project: NAME, document: 'board', layers: ['Q.Cu'] });
  check('render_view takes layers, and names the ones a board has when asked for another', !cu.isError && cu.image && noLayer.isError && /F\.Cu/.test(noLayer.text), noLayer.text.slice(0, 160));

  const unroute = await call(T(), 'undo_changes', { project: NAME, change_id: route.data.change_id });
  const info2 = await call(T(), 'get_board_info', { project: NAME });
  check('undoing the route removes its tracks', !unroute.isError && info2.data.unrouted_connections === info1.data.unrouted_connections && info2.data.statistics, unroute.text);
  const unrule = await call(T(), 'undo_changes', { project: NAME, change_id: rules.data.change_id });
  const info3 = await call(T(), 'get_board_info', { project: NAME });
  check('undoing set_rules restores the project file', !unrule.isError && unrule.data.board_rules_restored && info3.data.design_rules.min_track_width !== 0.15, JSON.stringify(info3.data.design_rules).slice(0, 300));
  const rerule = await call(T(), 'redo_changes', { project: NAME, change_id: rules.data.change_id });
  const info4 = await call(T(), 'get_board_info', { project: NAME });
  check('redoing set_rules writes them again', !rerule.isError && info4.data.design_rules.min_track_width === 0.15, rerule.text);
  const reroute = await call(T(), 'redo_changes', { project: NAME, change_id: route.data.change_id });
  const info5 = await call(T(), 'get_board_info', { project: NAME });
  check('and redoing the route puts the same tracks back', !reroute.isError && info5.data.unrouted_connections === 0 && info5.data.statistics.tracks.count === ar.segments, reroute.text + ' ' + JSON.stringify(info5.data.statistics.tracks));
  const log = await call(T(), 'list_changes', { project: NAME, document: 'board' });
  check('list_changes says what can be undone and redone', log.data.changes.every((c) => c.can_undo && !c.can_redo), log.text.slice(0, 300));
}

// ------------------------------------------------------------------ comments and checkpoints

{
  const c = await call(T(), 'add_comment', { project: NAME, document: schPath, ref: 'R2', text: 'Check the divider ratio against the ADC range.' });
  check('add_comment pins a comment on a component', !c.isError && c.data.id > 0 && Math.abs(c.data.x - 100.33) < 3, c.text);
  check('and the people in the document see it arrive', await until(() => (schWatch.comments || []).length >= 1));
  const reply = await call(T(), 'add_comment', { project: NAME, document: schPath, reply_to: c.data.id, text: 'Ratio is 0.32.' });
  const list = await call(T(), 'list_comments', { project: NAME, document: schPath });
  check('list_comments: the thread with its reply', !reply.isError && list.data.count === 1 && list.data.comments[0].replies.length === 1 && list.data.comments[0].author === 'mcp-ada', list.text.slice(0, 300));
  const res = await call(T(), 'resolve_comment', { project: NAME, comment_id: c.data.id });
  const after = await call(T(), 'list_comments', { project: NAME, document: schPath });
  const all = await call(T(), 'list_comments', { project: NAME, document: schPath, include_resolved: true });
  check('resolve_comment hides the thread unless resolved ones are asked for', !res.isError && after.data.count === 0 && all.data.count === 1 && all.data.comments[0].resolved);
  const cp = await call(T(), 'create_checkpoint', { project: NAME, name: 'Divider drawn' });
  const cps = await call(T(), 'list_checkpoints', { project: NAME });
  check('create_checkpoint and list_checkpoints', !cp.isError && cps.data.checkpoints.some((k) => k.name === 'Divider drawn'), cp.text + cps.text.slice(0, 200));
}

// ------------------------------------------------------------------ what a connection may not do

{
  // a view-only project: Bob shares one of his with Ada as a viewer
  const made = await (await fetch(`${BASE}/api/projects/blank`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bobJwt}` }, body: JSON.stringify({ name: 'mcp-e2e-bobs' }) })).json();
  await db.query(`INSERT INTO permissions (project_id, user_id, role, created_by) VALUES ($1, $2, 'viewer', $3)`, [made.projectId, ada, bob]);
  const list = await call(T(), 'list_projects', {});
  check('a project shared with the person is listed with their role', list.data.projects.some((p) => p.name === 'mcp-e2e-bobs' && p.role === 'viewer' && p.owner === 'mcp-bob'), list.text.slice(0, 300));
  const read = await call(T(), 'get_design_overview', { project: 'mcp-e2e-bobs' });
  const write = await call(T(), 'apply_changes', { project: 'mcp-e2e-bobs', document: 'schematic', title: 'x', edits: [{ op: 'add_text', text: 'hello', x: 50, y: 50 }] });
  check('a view-only project can be read but not changed', !read.isError && write.isError && /can only view/.test(write.text), write.text);
  const hidden = await db.query(`INSERT INTO projects (owner_id, name) VALUES ($1, 'mcp-e2e-private') RETURNING id`, [bob]);
  const peek = await call(T(), 'get_project', { project: hidden.rows[0].id });
  check('somebody else\'s private project does not exist for this person', peek.isError && /no project/.test(peek.text), peek.text.slice(0, 200));

  // a connection that was allowed to read only
  const ro = await authorize(clientId, adaJwt, { write: false });
  const rt = await (await exchange(clientId, ro.code, ro.verifier)).json();
  check('unticking "Let it make changes" grants read only', rt.scope === 'read');
  const tools = (await rpc(rt.access_token, 'tools/list')).result.tools.map((t) => t.name);
  check('a read-only connection is not shown the tools that change things', !tools.includes('apply_changes') && !tools.includes('add_comment') && tools.includes('list_components') && tools.includes('render_view'));
  const tried = await call(rt.access_token, 'apply_changes', { project: NAME, document: schPath, title: 'x', edits: [{ op: 'add_text', text: 'hello', x: 50, y: 50 }] });
  const stillReads = await call(rt.access_token, 'list_components', { project: NAME, document: schPath });
  check('and cannot call them, while reading works', tried.isError && /read only/.test(tried.text) && !stillReads.isError && stillReads.data.count === 2, tried.text);
  const asked = await authorize(clientId, adaJwt, { scope: 'read' });
  check('an app that asks for read only is not offered the choice', asked.offersWrite === false);

  // two calls at once from one person are run one after the other, both answered
  const [a, b] = await Promise.all([call(T(), 'list_nets', { project: NAME, document: schPath }), call(T(), 'get_board_info', { project: NAME })]);
  check('calls made at the same time are both answered', !a.isError && !b.isError);
}

// ------------------------------------------------------------------ tokens over time

{
  const r1 = await fetch(`${BASE}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }));
  const t2 = await r1.json();
  check('a refresh token is exchanged for a new pair', r1.ok && t2.access_token !== tokens.access_token && t2.refresh_token !== tokens.refresh_token);
  check('the new access token works', !(await call(t2.access_token, 'list_projects', {})).isError);
  const grace = await fetch(`${BASE}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }));
  check('a refresh token presented again at once is honoured (a lost reply)', grace.ok);
  const t3 = await grace.json();
  await db.query(`UPDATE mcp_tokens SET replaced_at = now() - interval '5 minutes' WHERE replaced_at IS NOT NULL`);
  const stolen = await fetch(`${BASE}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }));
  check('presented again later it is treated as stolen: refused', stolen.status === 400 && (await stolen.json()).error === 'invalid_grant');
  const dead = await rpc(t3.access_token, 'ping', undefined, { raw: true });
  check('and the whole connection is revoked with it', dead.status === 401);

  // the Connected apps list, and disconnecting from it
  const fresh = await authorize(clientId, adaJwt); const ft = await (await exchange(clientId, fresh.code, fresh.verifier)).json();
  const grants = (await (await fetch(`${BASE}/api/mcp/grants`, { headers: { authorization: `Bearer ${adaJwt}` } })).json()).grants;
  check('Connected apps lists the connections', grants.length >= 1 && grants.every((g) => g.name === 'MCP e2e client') && grants.some((g) => g.canWrite) && grants.some((g) => !g.canWrite), JSON.stringify(grants).slice(0, 300));
  const page = await (await fetch(`${BASE}/connect`, { headers: { cookie: `kc_session=${adaJwt}` } })).text();
  check('the Connect page shows the address and the connected apps', page.includes(`${BASE}/mcp`) && /MCP e2e client/.test(page) && /data-disconnect/.test(page));
  const notMine = await fetch(`${BASE}/api/mcp/grants/${grants[0].id}`, { method: 'DELETE', headers: { authorization: `Bearer ${bobJwt}` } });
  check('nobody else can disconnect them', notMine.status === 404);
  for (const g of grants) await fetch(`${BASE}/api/mcp/grants/${g.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${adaJwt}` } });
  const gone = await rpc(ft.access_token, 'ping', undefined, { raw: true });
  const noRefresh = await fetch(`${BASE}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: ft.refresh_token, client_id: clientId }));
  check('disconnecting ends the access token and the refresh token at once', gone.status === 401 && noRefresh.status === 400);

  const again = await authorize(clientId, adaJwt); const at = await (await exchange(clientId, again.code, again.verifier)).json();
  const rev = await fetch(`${BASE}/oauth/revoke`, form({ token: at.refresh_token }));
  check('the app can give its tokens back (revocation endpoint)', rev.ok && (await rpc(at.access_token, 'ping', undefined, { raw: true })).status === 401);
  const jwtOk = await call(adaJwt, 'list_projects', {});
  check('the desktop app\'s own session token is accepted as a bearer token too', !jwtOk.isError && jwtOk.data.count >= 1);
}

// ------------------------------------------------------------------ in the browser (optional)

if (SHOTS) {
  const { chromium } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch(); const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/auth/dev?jwt=${bobJwt}&next=/`);
  await db.query(`INSERT INTO permissions (project_id, user_id, role, created_by) VALUES ($1, $2, 'editor', $3)`, [projectId, bob, ada]);
  const open = async (docId) => { await page.goto(`${BASE}/p/${projectId}/edit?doc=${docId}`); await page.waitForFunction(() => window.CollabEditor && window.CollabEditor.kdoc, null, { timeout: 30000 }); await page.waitForTimeout(1500); };
  await open(schDocId);
  const before = await page.evaluate(() => window.CollabEditor.kdoc.items.size);
  // Ada's Claude adds a part while Bob has the sheet open in his browser
  const ro = await authorize(clientId, adaJwt); const t = await (await exchange(clientId, ro.code, ro.verifier)).json();
  const add = await call(t.access_token, 'apply_changes', { project: NAME, document: schPath, title: 'Add a filter capacitor', edits: [
    { op: 'add_symbol', lib_id: 'Device:C', x: 115.57, y: 91.44, reference: 'C1', value: '100n', fields: { Footprint: 'Capacitor_SMD:C_0603_1608Metric' } },
    { op: 'add_text', text: 'Added by Claude over MCP', x: 95.25, y: 109.22 } ] });
  const arrived = await page.waitForFunction((n) => window.CollabEditor.kdoc.items.size >= n + 2, before, { timeout: 10000 }).then(() => true, () => false);
  check('a browser with the sheet open shows the new part without a reload', !add.isError && arrived, add.text.slice(0, 200));
  const peer = await page.waitForFunction(() => Object.values(window.CollabEditor.peerState || {}).map((p) => p.user && p.user.name).find((n) => /\(MCP e2e client\)/.test(n || '')), null, { timeout: 8000 }).then((h) => h.jsonValue(), () => null);
  check('and lists the app as a peer under the person\'s name', !!peer, String(peer));
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SHOTS, '01-browser-sees-claude-edit.png') });
  await open(pcbDocId);
  await page.screenshot({ path: path.join(SHOTS, '02-board-routed-by-claude.png') });
  await page.goto(`${BASE}/auth/dev?jwt=${adaJwt}&next=/connect`); await page.waitForSelector('table.apps');
  await page.screenshot({ path: path.join(SHOTS, '03-connect-page.png'), fullPage: true });
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 's', code_challenge: pkce().challenge, code_challenge_method: 'S256' });
  await page.goto(`${BASE}/oauth/authorize?${q}`); await page.waitForSelector('button.primary');
  await page.screenshot({ path: path.join(SHOTS, '04-consent.png') });
  await ctx.close();
  const dark = await browser.newContext({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2, colorScheme: 'dark' }); const dp = await dark.newPage();
  await dp.goto(`${BASE}/auth/dev?jwt=${adaJwt}&next=/`); await dp.goto(`${BASE}/oauth/authorize?${q}`); await dp.waitForSelector('button.primary');
  await dp.screenshot({ path: path.join(SHOTS, '05-consent-dark.png') });
  await browser.close();
}

schWatch.ws.close(); pcbWatch.ws.close();
await db.query(`DELETE FROM projects WHERE owner_id = ANY($1)`, [[ada, bob]]);
await db.query(`DELETE FROM mcp_grants WHERE user_id = ANY($1)`, [[ada, bob]]);
await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
