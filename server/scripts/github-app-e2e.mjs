// End-to-end test of repository access through Junction's GitHub App (src/github_app.rs),
// against the stand-in GitHub in fake-github.mjs.  Covers registering the app from a
// manifest, switching an old `repo` grant over, installing on chosen repositories, sync
// through the app's token, token refresh (also under concurrent requests), choosing more
// repositories, and disconnecting.
//
//   node server/scripts/fake-github.mjs &
//
//   DATABASE_URL=postgres://postgres:test@127.0.0.1:5432/collabtest JWT_SECRET=testsecret \
//   PUBLIC_URL=http://127.0.0.1:8099 PORT=8099 KC_DEV_LOGIN=1 KC_ADMINS=gh-alice \
//   GITHUB_CLIENT_ID=test GITHUB_CLIENT_SECRET=test \
//   GITHUB_API_URL=http://127.0.0.1:8098 GITHUB_WEB_URL=http://127.0.0.1:8098 \
//     cargo run --manifest-path server/Cargo.toml
//
//   cd server/scripts && E2E_PG_URL=postgres://postgres:test@127.0.0.1:5432/collabtest \
//     E2E_JWT_SECRET=testsecret node github-app-e2e.mjs
//
import crypto from 'node:crypto';
import pg from 'pg';

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const GH = (process.env.E2E_FAKE_GH || 'http://127.0.0.1:8098').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET;
const PG_URL = process.env.E2E_PG_URL;
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required (see the header comment).'); process.exit(2); }

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintJwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub, login, iat: now, exp: now + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();

const ctl = async (what, body) => (await fetch(`${GH}/__ctl/${what}`, body
  ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
async function call(token, method, path, body) {
  const r = await fetch(BASE + path, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
}
/** Follow a browser flow by hand: the session cookie goes to the server only, never to "GitHub". */
async function browse(jwt, url, init = {}) {
  let last = null, hops = [];
  for (let hop = 0; hop < 8; hop++) {
    const headers = { ...(init.headers || {}), ...(url.startsWith(BASE) ? { Cookie: `kc_session=${jwt}` } : {}) };
    last = await fetch(url, { redirect: 'manual', ...init, headers });
    hops.push(new URL(url).pathname);
    if (last.status < 300 || last.status >= 400) break;
    url = new URL(last.headers.get('location'), url).toString();
    init = {};
  }
  return { status: last.status, url, hops, text: await last.text() };
}
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// ---------------------------------------------------------------- fixtures
await ctl('reset', {});
await db.query('DELETE FROM github_app');
const mkUser = async (ghId, login) => (await db.query(
  `INSERT INTO users (github_id, login, name) VALUES ($1, $2, $2)
   ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [ghId, login])).rows[0].id;
const aliceId = await mkUser(9201, 'gh-alice'), bobId = await mkUser(9202, 'gh-bob');
await db.query('DELETE FROM github_tokens WHERE user_id = ANY($1)', [[aliceId, bobId]]);
const alice = mintJwt(aliceId, 'gh-alice'), bob = mintJwt(bobId, 'gh-bob');
await ctl('user', { login: 'gh-alice', id: 9201 });
await ctl('user', { login: 'gh-bob', id: 9202 });
const PRO = '{\n  "meta": { "filename": "amp.kicad_pro", "version": 3 }\n}\n';
const PCB = '(kicad_pcb\n\t(version 20241229)\n\t(generator "pcbnew")\n)\n';
await ctl('repo', { fullName: 'gh-alice/amp', isPrivate: true, files: { 'hw/amp.kicad_pro': PRO, 'hw/amp.kicad_pcb': PCB } });
await ctl('repo', { fullName: 'gh-alice/secret', isPrivate: true, files: { 'notes/x.kicad_pro': PRO } });
await ctl('repo', { fullName: 'gh-alice/open', files: { 'README.md': 'hi' } });

const tokensOf = async (login) => (await ctl('tokens')).filter((t) => t.login === login);
const calls = async () => (await ctl('state?repo=gh-alice/amp')).calls;

try {
  // ============================================================ before the app exists: the old grant
  let r = await call(alice, 'GET', '/api/github');
  check('no app yet: nothing is offered as an app', r.j.app === null && r.j.legacy === false && r.j.connected === false, JSON.stringify(r.j));
  await ctl('browser', { login: 'gh-alice' });
  let c = await browse(alice, `${BASE}/auth/github/connect?next=/github`);
  r = await call(alice, 'GET', '/api/github');
  check('without the app, connecting still uses the old OAuth grant', c.url === `${BASE}/github` && r.j.via === 'oauth' && r.j.privateRepos === true, JSON.stringify(r.j));
  const oldToken = (await tokensOf('gh-alice')).find((t) => !t.app);
  check('…a token with the repo scope', oldToken && oldToken.scopes.includes('repo'));

  // ============================================================ registering the app
  r = await browse(bob, `${BASE}/admin/github-app`);
  check('a non-administrator cannot register the app', r.status === 403 && /Administrators only/.test(r.text), `${r.status}`);
  r = await browse(alice, `${BASE}/admin/github-app`);
  const action = unescape((r.text.match(/action="([^"]+)"/) || [])[1] || '');
  const manifest = JSON.parse(unescape((r.text.match(/name="manifest" id="manifest" value="([^"]+)"/) || [])[1] || '{}'));
  check('the administrator gets the registration form', r.status === 200 && action.startsWith(`${GH}/settings/apps/new?state=`), action);
  check('the manifest asks for contents, metadata and pull requests only',
    JSON.stringify(manifest.default_permissions) === JSON.stringify({ contents: 'write', metadata: 'read', pull_requests: 'write' }),
    JSON.stringify(manifest.default_permissions));
  check('the manifest has the callback and setup URLs on this server',
    manifest.callback_urls?.[0] === `${BASE}/auth/github/callback` && manifest.setup_url === `${BASE}/auth/github/installed`
    && manifest.redirect_url === `${BASE}/admin/github-app/created` && manifest.setup_on_update === true && manifest.public === true,
    JSON.stringify(manifest));
  check('no webhook events are asked for', manifest.hook_attributes?.active === false && manifest.default_events.length === 0);

  // GitHub's "Create GitHub App" press: the form posts the manifest to GitHub.
  manifest.name = 'Junction Test';
  r = await browse(alice, action, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                                    body: new URLSearchParams({ manifest: JSON.stringify(manifest) }).toString() });
  check('GitHub sends the browser back and the server collects the app', r.status === 200 && /Junction Test is registered/.test(r.text)
    && r.hops.includes('/admin/github-app/created'), `${r.status} ${r.hops.join(' > ')}`);
  const row = (await db.query('SELECT slug, client_id, client_secret, private_key FROM github_app')).rows[0];
  const app = await ctl('app');
  check('the app is stored with its client id', row && row.slug === 'junction-test' && row.client_id === app.client_id, JSON.stringify(row));
  check('its client secret and private key are sealed, not plain', !row.client_secret.toString('latin1').includes(app.client_secret)
    && !row.private_key.toString('latin1').includes('PRIVATE KEY'));
  r = await browse(alice, action.replace(/state=[^&]+/, 'state=forged'), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                                    body: new URLSearchParams({ manifest: JSON.stringify(manifest) }).toString() });
  check('a registration with an unknown state is refused', r.status === 400, `${r.status}`);

  // ============================================================ the switch from the old grant
  r = await call(alice, 'GET', '/api/github');
  check('an old grant is now flagged for the switch', r.j.connected && r.j.via === 'oauth' && r.j.legacy === true && r.j.app?.slug === 'junction-test', JSON.stringify(r.j));
  r = await call(alice, 'GET', '/api/github/repos');
  check('…and keeps working until then', r.status === 200 && r.j.repos.length === 3, JSON.stringify(r.j));

  await ctl('install-choice', { repos: ['gh-alice/amp'] });
  c = await browse(alice, `${BASE}/auth/github/connect?next=/github`);
  check('switching authorizes the app, then installs it, then returns to the page',
    c.status === 200 && c.url === `${BASE}/github` && c.hops.join(' > ') ===
      '/auth/github/connect > /login/oauth/authorize > /auth/github/callback > /apps/junction-test/installations/new > /auth/github/installed > /github',
    c.hops.join(' > '));
  r = await call(alice, 'GET', '/api/github');
  check('the connection is now through the app', r.j.via === 'app' && r.j.legacy === false, JSON.stringify(r.j));
  const left = await tokensOf('gh-alice');
  check('the old repo-scope grant was withdrawn on GitHub', !left.some((t) => !t.app) && left.some((t) => t.app), JSON.stringify(left));
  check('…through the OAuth app\'s grant API', (await calls()).includes('DELETE /applications/test/grant'));
  const stored = (await db.query('SELECT kind, refresh IS NOT NULL AS has_refresh, expires_at > now() + interval \'7 hours\' AS long FROM github_tokens WHERE user_id = $1', [aliceId])).rows[0];
  check('the app token is stored with its refresh token and expiry', stored.kind === 'app' && stored.has_refresh && stored.long, JSON.stringify(stored));

  // ============================================================ only the chosen repositories
  r = await call(alice, 'GET', '/api/github/repos');
  check('only the chosen repository is listed', r.status === 200 && r.j.repos.map((x) => x.fullName).join() === 'gh-alice/amp' && r.j.repos[0].canPush, JSON.stringify(r.j));
  r = await call(alice, 'GET', '/api/github/scan?repo=gh-alice/secret');
  check('a repository not chosen cannot be read', r.status === 404 && r.j.error === 'github_not_found' && /chose/.test(r.j.message), JSON.stringify(r.j));

  r = await call(alice, 'POST', '/api/github/import', { repo: 'gh-alice/amp', path: 'hw' });
  check('import through the app', r.status === 200 && r.j.files === 2, JSON.stringify(r.j));
  const pid = r.j.projectId;
  const docs = Object.fromEntries((await call(alice, 'GET', `/api/projects/${pid}`)).j.docs.map((d) => [d.path, d.docId]));
  const head = (await db.query(`SELECT GREATEST(COALESCE((SELECT MAX(seq) FROM ops WHERE doc_id = $1),0), COALESCE((SELECT MAX(seq) FROM snapshots WHERE doc_id = $1),0)) h`, [docs['amp.kicad_pcb']])).rows[0].h;
  const PCB1 = PCB.replace('(generator "pcbnew")', '(generator "pcbnew")\n\t(paper "A3")');
  await db.query('INSERT INTO snapshots (doc_id, seq, content) VALUES ($1, $2, $3)', [docs['amp.kicad_pcb'], head + 1, Buffer.from(PCB1)]);
  r = await call(alice, 'POST', `/api/projects/${pid}/github/push`, { message: 'A3 sheet' });
  const files = await ctl('files?repo=gh-alice%2Famp');
  check('push through the app lands on GitHub', r.status === 200 && files.files['hw/amp.kicad_pcb'] === PCB1 && files.message === 'A3 sheet', JSON.stringify(r.j));
  r = await call(alice, 'PUT', `/api/projects/${pid}/github`, { branch: '', path: '', create: { name: 'brand-new', private: true } });
  check('the app is not allowed to create repositories, and says what to do', r.status === 400 && r.j.error === 'github_app_cannot_create', JSON.stringify(r.j));

  // ============================================================ refresh
  const tokenBefore = (await db.query('SELECT token FROM github_tokens WHERE user_id = $1', [aliceId])).rows[0].token;
  await db.query("UPDATE github_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [aliceId]);
  const refreshesBefore = (await calls()).filter((x) => x === 'REFRESH').length;
  const many = await Promise.all(Array.from({ length: 6 }, () => call(alice, 'GET', '/api/github/repos')));
  const refreshes = (await calls()).filter((x) => x === 'REFRESH').length - refreshesBefore;
  check('an expired token is refreshed, and six requests at once all succeed', many.every((m) => m.status === 200), many.map((m) => m.status).join());
  check('…with exactly one refresh (a refresh token works once)', refreshes === 1, `${refreshes} refreshes`);
  const after = (await db.query('SELECT token, expires_at > now() + interval \'7 hours\' AS long FROM github_tokens WHERE user_id = $1', [aliceId])).rows[0];
  check('the new token and expiry are stored', after.long && !after.token.equals(tokenBefore));

  // ============================================================ choosing more repositories
  await ctl('install-choice', { repos: ['gh-alice/secret'] });
  c = await browse(alice, `${BASE}/auth/github/install?next=/github`);
  check('"Choose repositories" goes to GitHub and back', c.url === `${BASE}/github` && c.hops.includes('/auth/github/installed'), c.hops.join(' > '));
  r = await call(alice, 'GET', '/api/github/repos');
  check('the newly chosen repository appears', r.j.repos.map((x) => x.fullName).sort().join() === 'gh-alice/amp,gh-alice/secret', JSON.stringify(r.j));
  c = await browse(alice, `${BASE}/auth/github/installed?installation_id=1&setup_action=update`);
  check('GitHub\'s setup URL without a state lands on the GitHub page', c.url.endsWith('/github'), c.url);

  // ============================================================ a refresh GitHub refuses
  await db.query("UPDATE github_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [aliceId]);
  await ctl('revoke', { login: 'gh-alice' });
  await db.query('UPDATE github_tokens SET refresh = $2 WHERE user_id = $1', [aliceId, Buffer.alloc(40)]);
  r = await call(alice, 'GET', '/api/github/repos');
  check('an unusable refresh token means "connect again", not an error page', r.status === 409 && r.j.error === 'github_not_connected', JSON.stringify(r.j));
  check('…and the dead grant is forgotten', (await call(alice, 'GET', '/api/github')).j.connected === false);

  // ============================================================ a fresh connect with the app installed already
  c = await browse(alice, `${BASE}/auth/github/connect?next=/p/x/github`);
  check('connecting when the app is installed already skips the install page', c.hops.join(' > ') ===
    '/auth/github/connect > /login/oauth/authorize > /auth/github/callback > /p/x/github', c.hops.join(' > '));
  await ctl('browser', { login: 'gh-bob' });
  c = await browse(alice, `${BASE}/auth/github/connect?next=/github`);
  check('the app grant is refused for a different GitHub account', c.status === 400 && /not the account/.test(c.text), `${c.status}`);
  await ctl('browser', { login: 'gh-alice' });

  // ============================================================ disconnect
  r = await call(alice, 'DELETE', '/api/github');
  check('disconnect', r.status === 200 && (await call(alice, 'GET', '/api/github')).j.connected === false);
  check('…withdraws the app\'s authorization on GitHub too', !(await tokensOf('gh-alice')).some((t) => t.app));
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  await db.end();
  process.exit(fail ? 1 : 0);
}
