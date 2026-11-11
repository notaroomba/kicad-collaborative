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
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};

  // ---- test controls
  if (path.startsWith('/__ctl/')) {
    const what = path.slice(7);
    if (what === 'reset') {
      users.clear(); tokens.clear(); codes.clear(); repos.clear(); blobs.clear(); trees.clear(); commits.clear();
      browserUser = null; calls = []; nextPr = 1;
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
    if (what === 'revoke') { for (const [t, v] of tokens) if (v.login === body.login) tokens.delete(t); return send(res, 200, { ok: true }); }
    if (what === 'access') {
      const repo = repos.get(body.fullName);
      if (!repo) return notFound(res);
      (body.push ? repo.collaborators : repo.readers).add(body.login);
      return send(res, 200, { ok: true });
    }
    return notFound(res);
  }

  // ---- OAuth web flow (github.com)
  if (path === '/login/oauth/authorize') {
    if (!browserUser) { res.writeHead(400); return res.end('nobody is signed in to the fake github (POST /__ctl/browser)'); }
    const code = crypto.randomUUID();
    codes.set(code, { login: browserUser, scope: q.get('scope') || '' });
    const back = new URL(q.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', q.get('state'));
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }
  if (path === '/login/oauth/access_token') {
    const grant = codes.get(body.code);
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
    const prefix = q.get('path') ? q.get('path') + '/' : '';
    while (sha && out.length < +(q.get('per_page') || 30)) {
      const c = commits.get(sha);
      const parentTree = c.parents[0] ? trees.get(commits.get(c.parents[0]).tree) : new Map();
      const tree = trees.get(c.tree);
      const touched = [...new Set([...tree.keys(), ...parentTree.keys()])]
        .some((p) => p.startsWith(prefix) && tree.get(p) !== parentTree.get(p));
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
    return send(res, 200, { sha: mm[1], truncated: false,
      tree: [...tree.entries()].map(([p, s]) => ({ path: p, mode: '100644', type: 'blob', sha: s, size: blobs.get(s).length })) });
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
