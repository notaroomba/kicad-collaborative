// API test of the web addresses a person lets an official plugin reach beyond those its own code names
// (src/pcm.rs approve_host / net_fetch, table plugin_net_hosts): a self-hosted service such as a KiComLib
// library server.  A stand-in service listens on this machine, so the server runs with KC_PLUGIN_NETWORK=test
// and KC_PCM_REPOSITORY pointing at a PCM fixture that holds the plugin.
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… [PLUGIN=com.github.heronitec-solutions.kicomlib] node plugin-hosts-e2e.mjs
import crypto from 'node:crypto';
import http from 'node:http';
import pg from 'pg';

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const ID = process.env.PLUGIN || 'com.github.heronitec-solutions.kicomlib';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const mint = (sub, login) => { const now = Math.floor(Date.now() / 1000); const h = b64({ alg: 'HS256', typ: 'JWT' }), b = b64({ sub, login, iat: now, exp: now + 3600 }); return `${h}.${b}.${crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url')}`; };

pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL }); await db.connect();
const user = async (gid, login) => (await db.query(`INSERT INTO users (github_id, login, name) VALUES ($1, $2, $2) ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [gid, login])).rows[0].id;
const ann = await user(-9811, 'hosts-ann'), ben = await user(-9812, 'hosts-ben');
await db.query('DELETE FROM plugins WHERE user_id = ANY($1)', [[ann, ben]]);
const install = (u, granted) => db.query(`INSERT INTO plugins (user_id, identifier, manifest, files, granted, source) VALUES ($1, $2, '{}', '{}', $3, 'kicad')`, [u, ID, JSON.stringify(granted)]);
await install(ann, ['network', 'design:read']); await install(ben, ['design:read']);

// the stand-in for the person's own library server
const seen = [];
const svc = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ name: 'KiComLib stand-in', version: '1.0' })); });
await new Promise((r) => svc.listen(0, '127.0.0.1', r)); const port = svc.address().port;

const as = (u, login) => { const jwt = mint(u, login); return (path, init = {}) => fetch(`${BASE}${path}`, Object.assign({}, init, { headers: Object.assign({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }, init.headers || {}) })); };
const A = as(ann, 'hosts-ann'), B = as(ben, 'hosts-ben');
const P = `/api/plugins/pcm/${encodeURIComponent(ID)}`;
const fetchVia = (who) => who(`${P}/fetch`, { method: 'POST', body: JSON.stringify({ url: `http://127.0.0.1:${port}/info`, method: 'GET', headers: [], body: '' }) });

let r = await fetchVia(A), j = await r.json();
check('an address the plugin does not name is refused until the person allows it', r.status === 403 && j.error === 'plugin_host_unapproved' && seen.length === 0, `${r.status} ${JSON.stringify(j)}`);
for (const bad of ['localhost', '10.0.0.5', '192.168.1.20', 'nas.local', 'lib.internal', 'x.lan', 'a b.com']) {
  r = await A(`${P}/hosts`, { method: 'POST', body: JSON.stringify({ host: bad }) });
  check(`"${bad}" cannot be allowed`, r.status === 400, String(r.status));
}
r = await B(`${P}/hosts`, { method: 'POST', body: JSON.stringify({ host: '127.0.0.1' }) });
check('a plugin without network access cannot be given an address', r.status === 403, String(r.status));
r = await A(`/api/plugins/pcm/com.example.not-installed/hosts`, { method: 'POST', body: JSON.stringify({ host: '127.0.0.1' }) });
check('nor can a plugin the person has not installed', r.status === 404, String(r.status));
r = await A(`${P}/hosts`, { method: 'POST', body: JSON.stringify({ host: 'kicomlib.example-company.com' }) }); j = await r.json();
check('a public host name can be allowed', r.status === 200 && j.host === 'kicomlib.example-company.com', JSON.stringify(j));
r = await A(`${P}/hosts`, { method: 'POST', body: JSON.stringify({ host: '127.0.0.1' }) });
check('(test mode) the stand-in on this machine can be allowed', r.status === 200, String(r.status));
r = await fetchVia(A); j = await r.json();
check('then the request is carried to it', r.status === 200 && seen.length === 1 && seen[0] === 'GET /info' && Buffer.from(j.body || '', 'base64').toString().includes('stand-in'), `${r.status} ${JSON.stringify(j).slice(0, 200)} ${seen}`);
r = await fetchVia(B); j = await r.json();
check('another person is still refused', r.status === 403 && seen.length === 1, `${r.status} ${JSON.stringify(j)}`);
r = await A(`${P}/hosts`); j = await r.json();
check('the person sees what they allowed', JSON.stringify(j.hosts) === JSON.stringify(['127.0.0.1', 'kicomlib.example-company.com']), JSON.stringify(j));
r = await A(`${P}/hosts/127.0.0.1`, { method: 'DELETE' }); j = await r.json();
r = await fetchVia(A);
check('and can take it back', j.removed === true && r.status === 403 && seen.length === 1, `${JSON.stringify(j)} ${r.status}`);
await db.query('DELETE FROM plugins WHERE user_id = $1', [ann]);
const left = (await db.query('SELECT count(*)::int AS n FROM plugin_net_hosts WHERE user_id = $1', [ann])).rows[0].n;
check('uninstalling the plugin forgets its addresses', left === 0, String(left));

await db.query('DELETE FROM plugins WHERE user_id = $1', [ben]);
svc.close(); await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
