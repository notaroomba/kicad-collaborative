// A stand-in for github.com + api.github.com, for testing repository sync without
// touching anyone's real repositories.
//
// It implements the slice of GitHub the server uses — the OAuth web flow, repository
// metadata, and the git database API (refs, commits, trees, blobs), the contents API
// for the first commit in an empty repository, and pull requests — over an in-memory
// object store.  Blob ids are real git blob ids, so the server's own hashing is
// checked against them.
//
//   node fake-github.mjs            # listens on FAKE_GH_PORT (default 8098)
//
// Point the server at it with GITHUB_API_URL and GITHUB_WEB_URL (both this origin).
// `/__ctl/*` endpoints let a test play the part of GitHub's users: choose who the
// browser is signed in as, create repositories, commit as a collaborator, read files.
import crypto from 'node:crypto';
import http from 'node:http';

const PORT = +(process.env.FAKE_GH_PORT || 8098);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const blobId = (buf) => sha1(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf]));

// ---------------------------------------------------------------- state
const users = new Map();     // login -> { id, login, name }
const tokens = new Map();    // token -> { login, scopes: Set }
const codes = new Map();     // oauth code -> { login, scope }
const repos = new Map();     // "owner/name" -> repo
const blobs = new Map();     // sha -> Buffer
const trees = new Map();     // sha -> Map(path -> blob sha)   (flat: a whole tree per id)
const commits = new Map();   // sha -> { tree, parents, message, author, date }
let browserUser = null;      // who "is signed in to github.com" for the next authorize
let calls = [];              // method + path of every API call, for assertions
let nextPr = 1;
// The GitHub App side (github_app.rs): one registered app, its installations and refresh tokens.
let ghApp = null;            // { id, slug, name, client_id, client_secret, manifest }
const manifestCodes = new Map(); // code -> manifest JSON
const installations = new Map(); // id -> { id, account, repos: Set<fullName> }
const refreshTokens = new Map(); // refresh token -> login
let nextInstall = 1;
let installChoice = null;    // repositories the next install picks (POST /__ctl/install-choice)
const installedOn = (repo) => [...installations.values()].some((i) => i.account === repo.owner && i.repos.has(repo.fullName));
const issueAppToken = (login) => {
  const token = 'ghu_' + crypto.randomBytes(18).toString('hex');
  const refresh = 'ghr_' + crypto.randomBytes(18).toString('hex');
  tokens.set(token, { login, scopes: new Set(), app: true });
  refreshTokens.set(refresh, login);
  return { access_token: token, token_type: 'bearer', scope: '', expires_in: 28800, refresh_token: refresh, refresh_token_expires_in: 15811200 };
};

function user(login, id) {
  if (!users.has(login)) users.set(login, { id: id ?? 1000 + users.size, login, name: login });
  return users.get(login);
}

function putBlob(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const sha = blobId(buf);
  blobs.set(sha, buf);
  return sha;
}
function putTree(map) {
  const sha = sha1(JSON.stringify([...map.entries()].sort()));
  trees.set(sha, new Map(map));
  return sha;
}
function putCommit(tree, parents, message, author) {
  const date = new Date().toISOString();
  const sha = sha1(JSON.stringify({ tree, parents, message, author, date, n: crypto.randomUUID() }));
  commits.set(sha, { tree, parents, message, author, date });
  return sha;
}

function makeRepo(fullName, { isPrivate = false, files = null, branch = 'main', collaborators = [] } = {}) {
  const [owner, name] = fullName.split('/');
  user(owner);
  const repo = { owner, name, fullName, private: isPrivate, defaultBranch: branch, refs: new Map(),
                 collaborators: new Set(collaborators), readers: new Set(), pulls: [] };
  repos.set(fullName, repo);
  if (files) commitFiles(repo, branch, files, 'Initial commit', owner);
  return repo;
}

/** Commit `files` ({ path: content | null }) on top of a branch, as `author`. */
function commitFiles(repo, branch, files, message, author) {
  const parent = repo.refs.get(branch) || null;
  const map = new Map(parent ? trees.get(commits.get(parent).tree) : []);
  for (const [path, content] of Object.entries(files)) {
    if (content === null) map.delete(path); else map.set(path, putBlob(content));
  }
  const sha = putCommit(putTree(map), parent ? [parent] : [], message, author);
  repo.refs.set(branch, sha);
  return sha;
}

// ---------------------------------------------------------------- http plumbing
function send(res, status, body, headers = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(data);
}
const notFound = (res) => send(res, 404, { message: 'Not Found' });

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  if (!raw) return {};
  if ((req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  try { return JSON.parse(raw); } catch { return {}; }
}

function auth(req) {
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  return m ? tokens.get(m[1]) || null : null;
}

/** What GitHub lets this token do with a repository: null = cannot even see it. */
function reach(t, repo) {
  if (t.app) {
    // An app user token: only repositories the app is installed on, and only as far as the person may go.
    const member = repo.owner === t.login || repo.collaborators.has(t.login);
    if (!installedOn(repo) || !(member || repo.readers.has(t.login) || !repo.private)) return null;
    return { push: member };
  }
  const member = repo.owner === t.login || repo.collaborators.has(t.login);
  const reader = member || repo.readers.has(t.login);
  if (repo.private) {
    if (!reader || !t.scopes.has('repo')) return null;
    return { push: member };
  }
  return { push: member && (t.scopes.has('repo') || t.scopes.has('public_repo')) };
}

const repoJson = (repo, perms) => ({
  id: 1, name: repo.name, full_name: repo.fullName, private: repo.private,
  default_branch: repo.defaultBranch, description: null,
  pushed_at: new Date().toISOString(), html_url: `${ORIGIN}/${repo.fullName}`,
  permissions: { admin: perms.push, push: perms.push, pull: true },
});
const commitJson = (repo, sha) => {
  const c = commits.get(sha);
  return { sha, html_url: `${ORIGIN}/${repo.fullName}/commit/${sha}`, tree: { sha: c.tree },
           parents: c.parents.map((p) => ({ sha: p })), message: c.message,
           author: { name: c.author, date: c.date } };
};

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const path = decodeURIComponent(url.pathname);
  const q = url.searchParams;
  const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {};

  // ---- test controls
  if (path.startsWith('/__ctl/')) {
    const what = path.slice(7);
    if (what === 'reset') {
      users.clear(); tokens.clear(); codes.clear(); repos.clear(); blobs.clear(); trees.clear(); commits.clear();
      browserUser = null; calls = []; nextPr = 1;
      ghApp = null; manifestCodes.clear(); installations.clear(); refreshTokens.clear(); nextInstall = 1; installChoice = null;
      return send(res, 200, { ok: true });
    }
    if (what === 'user') return send(res, 200, user(body.login, body.id));
    if (what === 'browser') { browserUser = body.login; user(body.login); return send(res, 200, { ok: true }); }
    if (what === 'repo') {
      const repo = makeRepo(body.fullName, body);
      return send(res, 200, { fullName: repo.fullName, head: repo.refs.get(repo.defaultBranch) || null });
    }
    if (what === 'commit') {
      const repo = repos.get(body.fullName);
      if (!repo) return notFound(res);
      return send(res, 200, { sha: commitFiles(repo, body.branch || repo.defaultBranch, body.files, body.message || 'Edit on GitHub', body.author || repo.owner) });
    }
    if (what === 'files') {
      const repo = repos.get(q.get('repo'));
      const head = repo && repo.refs.get(q.get('branch') || repo.defaultBranch);
      if (!head) return send(res, 200, { head: null, files: {} });
      const files = {};
      for (const [p, s] of trees.get(commits.get(head).tree)) files[p] = blobs.get(s).toString();
      return send(res, 200, { head, parents: commits.get(head).parents, message: commits.get(head).message, files });
    }
    if (what === 'state') {
      const repo = repos.get(q.get('repo'));
      return send(res, 200, { branches: repo ? Object.fromEntries(repo.refs) : {}, pulls: repo ? repo.pulls : [], calls });
    }
    if (what === 'install-choice') { installChoice = body.repos; return send(res, 200, { ok: true }); }
    if (what === 'installations') return send(res, 200, [...installations.values()].map((i) => ({ ...i, repos: [...i.repos] })));
    if (what === 'app') return send(res, 200, ghApp && { ...ghApp, publicKey: undefined });
    if (what === 'rename') { ghApp.name = body.name; ghApp.slug = body.slug; return send(res, 200, { ok: true }); }
    if (what === 'tokens') return send(res, 200, [...tokens.entries()].map(([k, v]) => ({ token: k, login: v.login, app: !!v.app, scopes: [...v.scopes] })));
    if (what === 'revoke') { for (const [t, v] of tokens) if (v.login === body.login) tokens.delete(t); return send(res, 200, { ok: true }); }
    if (what === 'access') {
      const repo = repos.get(body.fullName);
      if (!repo) return notFound(res);
      (body.push ? repo.collaborators : repo.readers).add(body.login);
      return send(res, 200, { ok: true });
    }
    return notFound(res);
  }

  // ---- App manifest flow (github.com/settings/apps/new, then api /app-manifests/<code>/conversions)
  if (/^(\/organizations\/[^/]+)?\/settings\/apps\/new$/.test(path) && req.method === 'POST') {
    if (!browserUser) { res.writeHead(400); return res.end('nobody is signed in to the fake github'); }
    const manifest = JSON.parse(body.manifest || '{}');
    const code = crypto.randomUUID();
    manifestCodes.set(code, { manifest, owner: path.startsWith('/organizations/') ? path.split('/')[2] : browserUser });
    const back = new URL(manifest.redirect_url);
    back.searchParams.set('code', code);
    if (q.get('state')) back.searchParams.set('state', q.get('state'));
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }
  let am;
  if ((am = path.match(/^\/app-manifests\/([^/]+)\/conversions$/)) && req.method === 'POST') {
    const got = manifestCodes.get(am[1]);
    manifestCodes.delete(am[1]);
    if (!got) return notFound(res);
    const slug = got.manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    ghApp = { id: 4242, slug, name: got.manifest.name, client_id: 'Iv23test' + slug, client_secret: crypto.randomBytes(20).toString('hex'),
              manifest: got.manifest, publicKey: keys.publicKey,
              pem: keys.privateKey.export({ type: 'pkcs1', format: 'pem' }) };
    return send(res, 201, { id: ghApp.id, slug, name: ghApp.name, owner: { login: got.owner }, html_url: `${ORIGIN}/apps/${slug}`,
                            client_id: ghApp.client_id, client_secret: ghApp.client_secret, webhook_secret: 'whsec',
                            pem: ghApp.pem, permissions: got.manifest.default_permissions });
  }
  if ((am = path.match(/^\/apps\/([^/]+)\/installations\/new$/))) {
    if (!ghApp || am[1] !== ghApp.slug) { res.writeHead(404); return res.end('no such app'); }
    if (!browserUser) { res.writeHead(400); return res.end('nobody is signed in to the fake github'); }
    let inst = [...installations.values()].find((i) => i.account === browserUser);
    const action = inst ? 'update' : 'install';
    if (!inst) { inst = { id: nextInstall++, account: browserUser, repos: new Set() }; installations.set(inst.id, inst); }
    for (const r of installChoice || []) inst.repos.add(r);
    const back = new URL(ghApp.manifest.setup_url);
    back.searchParams.set('installation_id', String(inst.id));
    back.searchParams.set('setup_action', action);
    if (q.get('state')) back.searchParams.set('state', q.get('state'));
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }
  if ((am = path.match(/^\/applications\/([^/]+)\/grant$/)) && req.method === 'DELETE') {
    const basic = Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString();
    const [cid, secret] = basic.split(':');
    const okApp = ghApp && cid === ghApp.client_id && secret === ghApp.client_secret;
    if (cid !== am[1] || !(okApp || secret === 'test')) return send(res, 404, { message: 'Not Found' });
    calls.push(`DELETE ${path}`);
    const t = tokens.get(body.access_token);
    if (!t) return send(res, 404, { message: 'Not Found' });
    for (const [k, v] of tokens) if (v.login === t.login && !!v.app === okApp) tokens.delete(k);
    res.writeHead(204); return res.end();
  }

  // ---- GET /app, signed by the app's own JWT (RS256 with its private key)
  if (path === '/app' && req.method === 'GET') {
    calls.push('GET /app');
    const jwt = (req.headers.authorization || '').replace(/^Bearer /, '');
    const [h, b, sig] = jwt.split('.');
    const ok = ghApp && sig && crypto.verify('RSA-SHA256', Buffer.from(`${h}.${b}`), ghApp.publicKey, Buffer.from(sig, 'base64url'))
      && String(JSON.parse(Buffer.from(b, 'base64url')).iss) === String(ghApp.id);
    if (!ok) return send(res, 401, { message: 'A JSON web token could not be decoded' });
    return send(res, 200, { id: ghApp.id, slug: ghApp.slug, name: ghApp.name, html_url: `${ORIGIN}/apps/${ghApp.slug}` });
  }

  // ---- OAuth web flow (github.com)
  if (path === '/login/oauth/authorize') {
    if (!browserUser) { res.writeHead(400); return res.end('nobody is signed in to the fake github (POST /__ctl/browser)'); }
    const code = crypto.randomUUID();
    codes.set(code, { login: browserUser, scope: q.get('scope') || '', app: !!ghApp && q.get('client_id') === ghApp.client_id });
    const back = new URL(q.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', q.get('state'));
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }
  if (path === '/login/oauth/access_token') {
    if (body.grant_type === 'refresh_token') {
      calls.push('REFRESH');
      const login = refreshTokens.get(body.refresh_token);
      refreshTokens.delete(body.refresh_token);
      if (!login || !ghApp || body.client_secret !== ghApp.client_secret) return send(res, 200, { error: 'bad_refresh_token' });
      return send(res, 200, issueAppToken(login));
    }
    const grant = codes.get(body.code);
    if (grant && grant.app) {
      codes.delete(body.code);
      if (body.client_id !== ghApp.client_id || body.client_secret !== ghApp.client_secret) return send(res, 200, { error: 'incorrect_client_credentials' });
      return send(res, 200, issueAppToken(grant.login));
    }
    codes.delete(body.code);
    if (!grant) return send(res, 200, { error: 'bad_verification_code' });
    const token = 'gho_' + crypto.randomBytes(18).toString('hex');
    const scopes = grant.scope.split(/[ ,]+/).filter(Boolean);
    tokens.set(token, { login: grant.login, scopes: new Set(scopes) });
    return send(res, 200, { access_token: token, token_type: 'bearer', scope: scopes.join(',') });
  }

  // ---- REST API (api.github.com)
  calls.push(`${req.method} ${path}`);
  const t = auth(req);
  if (!t) return send(res, 401, { message: 'Bad credentials' });
  const me = user(t.login);

  if (path === '/user' && req.method === 'GET') return send(res, 200, { id: me.id, login: me.login, name: me.name, avatar_url: null });
  if (path === '/user/emails') return send(res, 200, [{ email: `${me.login}@example.test`, primary: true, verified: true }]);
  if (path === '/user/installations' && req.method === 'GET') {
    if (!t.app) return send(res, 403, { message: 'You must authenticate with an access token authorized to a GitHub App' });
    const mine = [...installations.values()].filter((i) => i.account === t.login);
    return send(res, 200, { total_count: mine.length, installations: mine.map((i) => ({ id: i.id, account: { login: i.account }, app_id: ghApp.id })) });
  }
  if ((am = path.match(/^\/user\/installations\/(\d+)\/repositories$/)) && req.method === 'GET') {
    const inst = installations.get(+am[1]);
    if (!t.app || !inst || inst.account !== t.login) return notFound(res);
    if (+(q.get('page') || 1) > 1) return send(res, 200, { total_count: inst.repos.size, repositories: [] });
    const list = [...inst.repos].map((n) => repos.get(n)).filter(Boolean).map((r) => repoJson(r, reach(t, r) || { push: false }));
    return send(res, 200, { total_count: list.length, repositories: list });
  }
  if (path === '/user/repos' && req.method === 'POST' && t.app) return send(res, 403, { message: 'Resource not accessible by integration' });
  if (path === '/user/repos' && req.method === 'GET') {
    if (+(q.get('page') || 1) > 1) return send(res, 200, []);
    const out = [];
    for (const repo of repos.values()) {
      const perms = reach(t, repo);
      if (perms && (repo.owner === t.login || repo.collaborators.has(t.login) || repo.readers.has(t.login))) out.push(repoJson(repo, perms));
    }
    return send(res, 200, out);
  }
  if (path === '/user/repos' && req.method === 'POST') {
    const fullName = `${t.login}/${body.name}`;
    if (repos.has(fullName)) return send(res, 422, { message: 'Repository creation failed: name already exists on this account' });
    if (body.private && !t.scopes.has('repo')) return send(res, 403, { message: 'Resource not accessible by this token' });
    const repo = makeRepo(fullName, { isPrivate: !!body.private, files: body.auto_init ? { 'README.md': `# ${body.name}\n` } : null });
    return send(res, 201, repoJson(repo, { push: true }));
  }

  const m = path.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!m) return notFound(res);
  const repo = repos.get(`${m[1]}/${m[2]}`);
  const perms = repo && reach(t, repo);
  if (!perms) return notFound(res);
  const rest = m[3] || '';
  const empty = repo.refs.size === 0;
  const needPush = () => { if (!perms.push) { send(res, 403, { message: 'Resource not accessible by this token' }); return false; } return true; };

  if (rest === '' && req.method === 'GET') return send(res, 200, repoJson(repo, perms));
  if (rest === '/branches') return send(res, 200, [...repo.refs.keys()].map((name) => ({ name, commit: { sha: repo.refs.get(name) } })));

  if (rest === '/commits' && req.method === 'GET') {
    let sha = repo.refs.get(q.get('sha') || repo.defaultBranch);
    if (!sha) return send(res, 409, { message: 'Git Repository is empty.' });
    const out = [];
    const only = q.get('path') || '', prefix = only ? only + '/' : '';
    while (sha && out.length < +(q.get('per_page') || 30)) {
      const c = commits.get(sha);
      const parentTree = c.parents[0] ? trees.get(commits.get(c.parents[0]).tree) : new Map();
      const tree = trees.get(c.tree);
      const touched = [...new Set([...tree.keys(), ...parentTree.keys()])]
        .some((p) => (p === only || p.startsWith(prefix)) && tree.get(p) !== parentTree.get(p));   // a file or a folder, as GitHub
      if (touched) out.push({ sha, html_url: `${ORIGIN}/${repo.fullName}/commit/${sha}`, author: { login: c.author },
                              commit: { message: c.message, author: { name: c.author, date: c.date } } });
      sha = c.parents[0];
    }
    return send(res, 200, out);
  }

  // refs
  let mm;
  if ((mm = rest.match(/^\/git\/ref\/heads\/(.+)$/)) && req.method === 'GET') {
    if (empty) return send(res, 409, { message: 'Git Repository is empty.' });
    const sha = repo.refs.get(mm[1]);
    return sha ? send(res, 200, { ref: `refs/heads/${mm[1]}`, object: { type: 'commit', sha } }) : notFound(res);
  }
  if (rest === '/git/refs' && req.method === 'POST') {
    if (!needPush()) return;
    const name = String(body.ref || '').replace(/^refs\/heads\//, '');
    if (repo.refs.has(name)) return send(res, 422, { message: 'Reference already exists' });
    if (!commits.has(body.sha)) return send(res, 422, { message: 'Object does not exist' });
    repo.refs.set(name, body.sha);
    return send(res, 201, { ref: body.ref, object: { sha: body.sha } });
  }
  if ((mm = rest.match(/^\/git\/refs\/heads\/(.+)$/)) && req.method === 'PATCH') {
    if (!needPush()) return;
    const cur = repo.refs.get(mm[1]);
    if (!cur) return send(res, 422, { message: 'Reference does not exist' });
    // Fast-forward only unless forced, like the real thing.
    let ff = false;
    for (let s = body.sha, n = 0; s && n < 10000; s = commits.get(s)?.parents[0], n++) if (s === cur) { ff = true; break; }
    if (!ff && !body.force) return send(res, 422, { message: 'Update is not a fast forward' });
    repo.refs.set(mm[1], body.sha);
    return send(res, 200, { ref: `refs/heads/${mm[1]}`, object: { sha: body.sha } });
  }

  // git objects
  if ((mm = rest.match(/^\/git\/commits\/([0-9a-f]+)$/)) && req.method === 'GET') {
    return commits.has(mm[1]) ? send(res, 200, commitJson(repo, mm[1])) : notFound(res);
  }
  if ((mm = rest.match(/^\/git\/trees\/([0-9a-f]+)$/)) && req.method === 'GET') {
    const tree = trees.get(mm[1]);
    if (!tree) return notFound(res);
    const blobEntry = ([p, s]) => ({ path: p, mode: '100644', type: 'blob', sha: s, size: blobs.get(s).length });
    if (q.get('recursive')) return send(res, 200, { sha: mm[1], truncated: false, tree: [...tree.entries()].map(blobEntry) });
    // Like GitHub: without ?recursive only the direct children, folders as "tree" entries.
    const out = [], dirs = new Map();
    for (const [p, s] of tree) {
      const i = p.indexOf('/');
      if (i < 0) out.push(blobEntry([p, s]));
      else { const d = p.slice(0, i); if (!dirs.has(d)) dirs.set(d, new Map()); dirs.get(d).set(p.slice(i + 1), s); }
    }
    for (const [d, sub] of dirs) out.push({ path: d, mode: '040000', type: 'tree', sha: putTree(sub) });
    return send(res, 200, { sha: mm[1], truncated: false, tree: out });
  }
  if ((mm = rest.match(/^\/git\/blobs\/([0-9a-f]+)$/)) && req.method === 'GET') {
    const b = blobs.get(mm[1]);
    if (!b) return notFound(res);
    // GitHub wraps its base64 at 60 columns.
    return send(res, 200, { sha: mm[1], size: b.length, encoding: 'base64', content: b.toString('base64').replace(/(.{60})/g, '$1\n') });
  }
  if (rest === '/git/blobs' && req.method === 'POST') {
    if (!needPush()) return;
    if (empty) return send(res, 409, { message: 'Git Repository is empty.' });
    const sha = putBlob(Buffer.from(body.content || '', body.encoding === 'base64' ? 'base64' : 'utf8'));
    return send(res, 201, { sha });
  }
  if (rest === '/git/trees' && req.method === 'POST') {
    if (!needPush()) return;
    const map = new Map(body.base_tree ? trees.get(body.base_tree) : []);
    for (const e of body.tree || []) {
      if (e.sha === null) map.delete(e.path);
      else { if (!blobs.has(e.sha)) return send(res, 422, { message: 'tree.sha is not a valid blob' }); map.set(e.path, e.sha); }
    }
    return send(res, 201, { sha: putTree(map) });
  }
  if (rest === '/git/commits' && req.method === 'POST') {
    if (!needPush()) return;
    if (!trees.has(body.tree)) return send(res, 422, { message: 'Tree SHA is not a tree object' });
    const sha = putCommit(body.tree, body.parents || [], body.message, t.login);
    return send(res, 201, commitJson(repo, sha));
  }

  // contents API (only what a first commit needs)
  if ((mm = rest.match(/^\/contents\/(.+)$/)) && req.method === 'PUT') {
    if (!needPush()) return;
    const branch = body.branch || repo.defaultBranch;
    if (empty) repo.defaultBranch = branch;
    const sha = commitFiles(repo, branch, { [mm[1]]: Buffer.from(body.content, 'base64') }, body.message, t.login);
    return send(res, 201, { content: { path: mm[1] }, commit: { sha } });
  }

  if (rest === '/pulls' && req.method === 'POST') {
    if (!needPush()) return;
    if (!repo.refs.has(body.head) || !repo.refs.has(body.base)) return send(res, 422, { message: 'Validation Failed' });
    const pr = { number: nextPr++, title: body.title, head: body.head, base: body.base, body: body.body };
    repo.pulls.push(pr);
    return send(res, 201, { ...pr, html_url: `${ORIGIN}/${repo.fullName}/pull/${pr.number}` });
  }

  return notFound(res);
});

server.listen(PORT, '127.0.0.1', () => console.log(`fake github listening on ${ORIGIN}`));
