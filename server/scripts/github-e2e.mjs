// End-to-end test of GitHub repository sync, against the stand-in GitHub in
// fake-github.mjs (no real repository is touched).
//
// Run a LOCAL server on a THROWAWAY database, pointed at the fake:
//
//   node server/scripts/fake-github.mjs &
//
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/collabtest JWT_SECRET=testsecret \
//   PUBLIC_URL=http://127.0.0.1:8099 PORT=8099 KC_DEV_LOGIN=1 \
//   GITHUB_CLIENT_ID=test GITHUB_CLIENT_SECRET=test \
//   GITHUB_API_URL=http://127.0.0.1:8098 GITHUB_WEB_URL=http://127.0.0.1:8098 \
//     cargo run --manifest-path server/Cargo.toml
//
//   cd server/scripts && npm install && \
//   E2E_PG_URL=postgres://postgres@127.0.0.1:55432/collabtest E2E_JWT_SECRET=testsecret \
//     node github-e2e.mjs
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
const canon = (v) => Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const eq = (name, got, want) => check(name, JSON.stringify(canon(got)) === JSON.stringify(canon(want)), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

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

// ---------------------------------------------------------------- helpers
const ctl = async (what, body) => (await fetch(`${GH}/__ctl/${what}`, body
  ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
const ghFiles = (repo, branch) => ctl(`files?repo=${encodeURIComponent(repo)}${branch ? '&branch=' + encodeURIComponent(branch) : ''}`);

async function call(token, method, path, body) {
  const r = await fetch(BASE + path, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
}
const status = async (token, id) => (await call(token, 'GET', `/api/projects/${id}/github`)).j;
const states = (st) => Object.fromEntries((st.files || []).map((f) => [f.path, f.state]));

/** Walk the "connect repositories" browser flow by hand, following each redirect. */
async function connect(jwt, access) {
  let url = `${BASE}/auth/github/connect?next=/github${access ? '&access=' + access : ''}`;
  let last = null;
  for (let hop = 0; hop < 6; hop++) {
    last = await fetch(url, { redirect: 'manual', headers: url.startsWith(BASE) ? { Cookie: `kc_session=${jwt}` } : {} });
    if (last.status < 300 || last.status >= 400) break;
    url = new URL(last.headers.get('location'), url).toString();
  }
  return { status: last.status, url, text: last.status >= 400 ? await last.text() : '' };
}

/** The project file as the server holds it (the latest snapshot). */
async function localFile(token, docId) {
  const r = await fetch(`${BASE}/api/docs/${docId}/content`, { headers: { Authorization: `Bearer ${token}` } });
  return r.text();
}
/** Play the desktop app saving a new version of a document: a snapshot at the next seq. */
async function saveOnline(docId, content) {
  const { rows } = await db.query(
    `SELECT GREATEST(COALESCE((SELECT MAX(seq) FROM ops WHERE doc_id = $1), 0),
                     COALESCE((SELECT MAX(seq) FROM snapshots WHERE doc_id = $1), 0)) AS head`, [docId]);
  await db.query('INSERT INTO snapshots (doc_id, seq, content) VALUES ($1, $2, $3)', [docId, rows[0].head + 1, Buffer.from(content)]);
}
const docsOf = async (token, id) => Object.fromEntries((await call(token, 'GET', `/api/projects/${id}`)).j.docs.map((d) => [d.path, d.docId]));

// ---------------------------------------------------------------- fixtures
const fp = (ref, uuid, x, y, value) => `\t(footprint "Resistor_SMD:R_0603"
\t\t(layer "F.Cu")
\t\t(uuid "${uuid}")
\t\t(at ${x} ${y})
\t\t(property "Reference" "${ref}"
\t\t\t(at 0 -1.4 0)
\t\t\t(layer "F.SilkS")
\t\t\t(uuid "${uuid.slice(0, -4)}aaaa")
\t\t)
\t\t(property "Value" "${value}"
\t\t\t(at 0 1.4 0)
\t\t\t(layer "F.Fab")
\t\t\t(uuid "${uuid.slice(0, -4)}bbbb")
\t\t)
\t)
`;
const board = (items) => `(kicad_pcb
\t(version 20241229)
\t(generator "pcbnew")
\t(generator_version "9.0")
\t(general
\t\t(thickness 1.6)
\t)
\t(paper "A4")
${items.join('')})
`;
const R1 = '11111111-0000-4000-8000-000000001111', R2 = '22222222-0000-4000-8000-000000002222', R3 = '33333333-0000-4000-8000-000000003333';
const PCB0 = board([fp('R1', R1, 100, 50, '10k'), fp('R2', R2, 110, 50, '4k7')]);
const SCH0 = `(kicad_sch\n\t(version 20250114)\n\t(generator "eeschema")\n\t(uuid "aaaaaaaa-0000-4000-8000-00000000aaaa")\n\t(paper "A4")\n)\n`;
const PRO0 = '{\n  "meta": { "filename": "amp.kicad_pro", "version": 3 }\n}\n';

// ---------------------------------------------------------------- users
await ctl('reset', {});
const GH_ALICE = 9101, GH_BOB = 9102;
const mkUser = async (ghId, login) => (await db.query(
  `INSERT INTO users (github_id, login, name) VALUES ($1, $2, $2)
   ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [ghId, login])).rows[0].id;
const aliceId = await mkUser(GH_ALICE, 'gh-alice'), bobId = await mkUser(GH_BOB, 'gh-bob');
await db.query('DELETE FROM github_tokens WHERE user_id = ANY($1)', [[aliceId, bobId]]);
const alice = mintJwt(aliceId, 'gh-alice'), bob = mintJwt(bobId, 'gh-bob');
await ctl('user', { login: 'gh-alice', id: GH_ALICE });
await ctl('user', { login: 'gh-bob', id: GH_BOB });

await ctl('repo', { fullName: 'gh-alice/amp', isPrivate: true, files: {
  'README.md': '# amp\n', 'hw/amp.kicad_pro': PRO0, 'hw/amp.kicad_pcb': PCB0, 'hw/amp.kicad_sch': SCH0,
  'hw/amp-backups/old.kicad_pcb': 'stale', 'hw/notes.txt': 'not a kicad file',
  'fw/main.c': 'int main(){}', 'panel/panel.kicad_pro': '{}', 'panel/panel.kicad_pcb': board([]),
} });

try {
  // ============================================================ connecting
  let r = await call(alice, 'GET', '/api/github');
  check('account starts unconnected', r.status === 200 && r.j.connected === false && r.j.configured === true, JSON.stringify(r.j));
  r = await call(alice, 'GET', '/api/github/repos');
  check('repositories are refused before connecting', r.status === 409 && r.j.error === 'github_not_connected', JSON.stringify(r.j));

  await ctl('browser', { login: 'gh-bob' });
  let c = await connect(alice);
  check('a grant from a different GitHub account is refused', c.status === 400 && /not the account/.test(c.text), `${c.status} ${c.text}`);
  check('…and stores nothing', (await call(alice, 'GET', '/api/github')).j.connected === false);

  await ctl('browser', { login: 'gh-alice' });
  c = await connect(alice, 'public');
  check('connect flow returns to the page it started from', c.status === 200 && c.url === `${BASE}/github`, `${c.status} ${c.url}`);
  r = await call(alice, 'GET', '/api/github');
  check('public-only grant is recorded as such', r.j.connected && r.j.privateRepos === false, JSON.stringify(r.j));
  r = await call(alice, 'GET', '/api/github/scan?repo=gh-alice/amp');
  check('a public-only grant cannot see a private repository', r.status === 404 && r.j.error === 'github_not_found', JSON.stringify(r.j));

  await connect(alice);
  r = await call(alice, 'GET', '/api/github');
  check('full grant replaces it', r.j.connected && r.j.privateRepos === true, JSON.stringify(r.j));
  const enc = (await db.query('SELECT token FROM github_tokens WHERE user_id = $1', [aliceId])).rows[0].token;
  check('the token is not stored in the clear', !enc.toString('latin1').includes('gho_'));

  r = await call(alice, 'GET', '/api/github/repos');
  check('repository list', r.status === 200 && r.j.repos.some((x) => x.fullName === 'gh-alice/amp' && x.private && x.canPush), JSON.stringify(r.j));

  // ============================================================ import
  r = await call(alice, 'GET', '/api/github/scan?repo=https://github.com/gh-alice/amp.git');
  eq('scan finds the project folders', r.j.projects, [{ path: 'hw', name: 'amp', files: 3 }, { path: 'panel', name: 'panel', files: 2 }]);
  check('scan reports branches', r.j.branch === 'main' && r.j.branches.includes('main') && r.j.canPush === true);

  r = await call(alice, 'POST', '/api/github/import', { repo: 'gh-alice/amp', path: 'hw' });
  check('import creates a project', r.status === 200 && r.j.name === 'amp' && r.j.files === 3, JSON.stringify(r.j));
  const pid = r.j.projectId;
  let docs = await docsOf(alice, pid);
  eq('only KiCad files come in (no backups, notes or firmware)', Object.keys(docs).sort(), ['amp.kicad_pcb', 'amp.kicad_pro', 'amp.kicad_sch']);
  check('imported file is byte-identical', await localFile(alice, docs['amp.kicad_pcb']) === PCB0);

  let st = await status(alice, pid);
  eq('fresh import is fully in sync', st.summary, { push: 0, pull: 0, conflict: 0, synced: 3, unsaved: 0 });
  check('status carries the link and recent commits', st.link.repo === 'gh-alice/amp' && st.link.path === 'hw' && st.remote.commits.length === 1, JSON.stringify(st.link));

  // ============================================================ push
  r = await call(alice, 'POST', `/api/projects/${pid}/github/push`, {});
  check('pushing with nothing changed is refused', r.status === 409 && r.j.error === 'nothing_to_push', JSON.stringify(r.j));

  const PCB1 = PCB0.replace('(at 100 50)', '(at 101.5 52)');
  await saveOnline(docs['amp.kicad_pcb'], PCB1);
  st = await status(alice, pid);
  eq('an online edit shows as "push"', states(st), { 'amp.kicad_pcb': 'push', 'amp.kicad_pro': 'synced', 'amp.kicad_sch': 'synced' });

  const before = await ghFiles('gh-alice/amp');
  r = await call(alice, 'POST', `/api/projects/${pid}/github/push`, { message: 'Move R1' });
  check('push succeeds', r.status === 200 && r.j.pushed.length === 1, JSON.stringify(r.j));
  let gh = await ghFiles('gh-alice/amp');
  check('GitHub has the new board, byte for byte', gh.files['hw/amp.kicad_pcb'] === PCB1);
  check('the commit sits on top of the old head with our message', gh.parents[0] === before.head && gh.message === 'Move R1' && gh.head === r.j.commit);
  check('files outside the project folder are untouched', gh.files['README.md'] === '# amp\n' && gh.files['fw/main.c'] === 'int main(){}' && gh.files['hw/notes.txt'] === 'not a kicad file' && Object.keys(gh.files).length === 9);
  eq('in sync again after the push', (await status(alice, pid)).summary, { push: 0, pull: 0, conflict: 0, synced: 3, unsaved: 0 });

  // ============================================================ pull
  const SCH1 = SCH0.replace('(paper "A4")', '(paper "A3")');
  await ctl('commit', { fullName: 'gh-alice/amp', files: { 'hw/amp.kicad_sch': SCH1, 'hw/sub.kicad_sch': SCH0, 'README.md': '# amp 2\n' }, message: 'Bigger sheet', author: 'gh-bob' });
  st = await status(alice, pid);
  eq('a GitHub commit shows as "pull", new file included', states(st), { 'amp.kicad_pcb': 'synced', 'amp.kicad_pro': 'synced', 'amp.kicad_sch': 'pull', 'sub.kicad_sch': 'pull' });
  r = await call(alice, 'POST', `/api/projects/${pid}/github/pull`, {});
  eq('pull updates one file and adds the other', r.j.updated.map((u) => [u.path, u.action]), [['amp.kicad_sch', 'updated'], ['sub.kicad_sch', 'added']]);
  docs = await docsOf(alice, pid);
  check('pulled content is byte-identical', await localFile(alice, docs['amp.kicad_sch']) === SCH1 && await localFile(alice, docs['sub.kicad_sch']) === SCH0);
  const cps = (await call(alice, 'GET', `/api/projects/${pid}/checkpoints`)).j.checkpoints;
  check('the replaced version is kept as a checkpoint', cps.some((x) => x.path === 'amp.kicad_sch' && /^Before GitHub pull/.test(x.name)), JSON.stringify(cps));
  eq('in sync after the pull', (await status(alice, pid)).summary, { push: 0, pull: 0, conflict: 0, synced: 4, unsaved: 0 });

  // ============================================================ merge: both sides, different items
  const PCB_ONLINE = PCB1.replace('"4k7"', '"5k1"');                                // online: R2's value
  const PCB_GITHUB = PCB1.replace('(at 110 50)', '(at 120 60)')                     // GitHub: R2 moved…
    .replace(/\)\n$/, fp('R3', R3, 130, 50, '1k') + ')\n');                         // …and R3 added
  await saveOnline(docs['amp.kicad_pcb'], PCB_ONLINE);
  await ctl('commit', { fullName: 'gh-alice/amp', files: { 'hw/amp.kicad_pcb': PCB_GITHUB }, message: 'Move R2, add R3', author: 'gh-bob' });
  st = await status(alice, pid);
  check('changed on both sides shows as a conflict', states(st)['amp.kicad_pcb'] === 'conflict' && st.summary.conflict === 1, JSON.stringify(st.summary));
  r = await call(alice, 'GET', `/api/projects/${pid}/github/diff?path=amp.kicad_pcb`);
  const brief = (side) => side.changes.map((c) => `${c.kind} ${c.item}${c.parts?.length ? ' [' + c.parts.join(', ') + ']' : ''}`);
  eq('the diff says what changed online…', brief(r.j.online), ['changed footprint R2 [property Value]']);
  eq('…and what changed on GitHub, item by item', brief(r.j.github), ['changed footprint R2 [at]', 'added footprint R3']);
  r = await call(alice, 'GET', `/api/projects/${pid}/github/diff?path=amp.kicad_sch`);
  check('an unchanged file has an empty diff', r.j.online.total === 0 && r.j.github.total === 0, JSON.stringify(r.j));
  r = await call(alice, 'GET', `/api/projects/${pid}/github/diff?path=nope.kicad_sch`);
  check('a diff of a file on neither side is a 404', r.status === 404);
  r = await call(bob, 'GET', `/api/projects/${pid}/github/diff?path=amp.kicad_pcb`);
  check('a stranger cannot read a diff', r.status === 403);

  r = await call(alice, 'POST', `/api/projects/${pid}/github/push`, {});
  check('a plain push will not overwrite GitHub\'s change', r.status === 409 && r.j.error === 'nothing_to_push', JSON.stringify(r.j));

  r = await call(alice, 'POST', `/api/projects/${pid}/github/pull`, {});
  const mu = r.j.updated[0];
  check('pull merges the file', mu?.action === 'merged' && mu.conflicts.length === 0, JSON.stringify(r.j));
  const merged = await localFile(alice, docs['amp.kicad_pcb']);
  const WANT = PCB1.replace('"4k7"', '"5k1"').replace('(at 110 50)', '(at 120 60)').replace(/\)\n$/, fp('R3', R3, 130, 50, '1k') + ')\n');
  check('the merge holds both sides\' changes and nothing else moved', merged === WANT, merged);
  eq('the merge result is now a plain "push"', states(await status(alice, pid))['amp.kicad_pcb'], 'push');
  r = await call(alice, 'POST', `/api/projects/${pid}/github/push`, { message: 'Merge' });
  gh = await ghFiles('gh-alice/amp');
  check('pushing the merge brings both sides level', r.status === 200 && gh.files['hw/amp.kicad_pcb'] === WANT);
  eq('in sync after merge + push', (await status(alice, pid)).summary, { push: 0, pull: 0, conflict: 0, synced: 4, unsaved: 0 });

  // ============================================================ push on checkpoint
  const lastAuto = async (name) => {
    for (let i = 0; i < 50; i++) {
      const la = (await status(alice, pid)).link.lastAuto;
      if (la && la.checkpoint === name) return la;
      await new Promise((res) => setTimeout(res, 100));
    }
    return null;
  };
  r = await call(alice, 'POST', `/api/projects/${pid}/checkpoints`, { name: 'quiet' });
  check('a checkpoint pushes nothing unless the project asks for it', r.status === 200 && r.j.githubPush === false, JSON.stringify(r.j));
  r = await call(bob, 'POST', `/api/projects/${pid}/github/settings`, { autoPush: true });
  check('a stranger cannot change the sync settings', r.status === 403);
  r = await call(alice, 'POST', `/api/projects/${pid}/github/settings`, { autoPush: true });
  check('push-on-checkpoint can be switched on', r.status === 200 && (await status(alice, pid)).link.autoPush === true, JSON.stringify(r.j));
  const AUTO = WANT.replace('"5k1"', '"5k6"');
  await saveOnline(docs['amp.kicad_pcb'], AUTO);
  r = await call(alice, 'POST', `/api/projects/${pid}/checkpoints`, { name: 'rev C' });
  check('saving a checkpoint starts a push', r.status === 200 && r.j.githubPush === true, JSON.stringify(r.j));
  let la = await lastAuto('rev C');
  gh = await ghFiles('gh-alice/amp');
  check('…which lands on GitHub, named after the checkpoint', la?.ok === true && gh.files['hw/amp.kicad_pcb'] === AUTO && gh.message === 'Checkpoint: rev C', JSON.stringify(la));
  eq('in sync after the automatic push', (await status(alice, pid)).summary, { push: 0, pull: 0, conflict: 0, synced: 4, unsaved: 0 });
  r = await call(alice, 'POST', `/api/projects/${pid}/checkpoints`, { name: 'again' });
  la = await lastAuto('again');
  check('a checkpoint with nothing new is reported, not an error', la?.ok === true && /Nothing/.test(la.message), JSON.stringify(la));
  // GitHub and the online copy both move: the automatic push must not overwrite GitHub.
  await saveOnline(docs['amp.kicad_pcb'], AUTO.replace('"5k6"', '"6k8"'));
  await ctl('commit', { fullName: 'gh-alice/amp', files: { 'hw/amp.kicad_pcb': WANT }, author: 'gh-bob' });
  r = await call(alice, 'POST', `/api/projects/${pid}/checkpoints`, { name: 'clash' });
  la = await lastAuto('clash');
  gh = await ghFiles('gh-alice/amp');
  check('an automatic push never overwrites a change made on GitHub', la && gh.files['hw/amp.kicad_pcb'] === WANT && states(await status(alice, pid))['amp.kicad_pcb'] === 'conflict', JSON.stringify(la));
  // Back to where the next section expects to start: both sides at WANT, switch off.
  r = await call(alice, 'POST', `/api/projects/${pid}/github/pull`, { resolve: { 'amp.kicad_pcb': 'github' } });
  r = await call(alice, 'POST', `/api/projects/${pid}/github/settings`, { autoPush: false });
  check('…and can be switched off again', r.status === 200 && (await status(alice, pid)).link.autoPush === false);
  eq('level again', (await status(alice, pid)).summary, { push: 0, pull: 0, conflict: 0, synced: 4, unsaved: 0 });

  // ============================================================ merge: same item on both sides
  await saveOnline(docs['amp.kicad_pcb'], WANT.replace('(at 101.5 52)', '(at 1 1)'));
  await ctl('commit', { fullName: 'gh-alice/amp', files: { 'hw/amp.kicad_pcb': WANT.replace('(at 101.5 52)', '(at 2 2)').replace('"1k"', '"2k"') }, author: 'gh-bob' });
  r = await call(alice, 'POST', `/api/projects/${pid}/github/pull`, { prefer: 'github' });
  const cu = r.j.updated[0];
  check('a true conflict is reported by item', cu?.action === 'merged' && cu.conflicts.length === 1 && cu.conflicts[0].item === 'footprint R1 › at' && cu.conflicts[0].kept === 'github', JSON.stringify(cu));
  const m2 = await localFile(alice, docs['amp.kicad_pcb']);
  check('…resolved to the chosen side, with the other change still merged', m2 === WANT.replace('(at 101.5 52)', '(at 2 2)').replace('"1k"', '"2k"'));
  eq('taking GitHub\'s side everywhere leaves nothing to push', (await status(alice, pid)).summary, { push: 0, pull: 0, conflict: 0, synced: 4, unsaved: 0 });

  // ============================================================ files that cannot be merged
  await saveOnline(docs['amp.kicad_pro'], PRO0.replace('"version": 3', '"version": 4'));
  await ctl('commit', { fullName: 'gh-alice/amp', files: { 'hw/amp.kicad_pro': PRO0.replace('"version": 3', '"version": 5') }, author: 'gh-bob' });
  st = await status(alice, pid);
  r = await call(alice, 'GET', `/api/projects/${pid}/github/diff?path=amp.kicad_pro`);
  check('a file that is not an s-expression is reported as not comparable', r.j.online.opaque === true && r.j.github.opaque === true, JSON.stringify(r.j));
  check('project file conflict is flagged as not mergeable', st.files.find((f) => f.path === 'amp.kicad_pro').mergeable === false);
  r = await call(alice, 'POST', `/api/projects/${pid}/github/pull`, {});
  check('it is left alone until a side is chosen', r.j.updated.length === 0 && /choose which version/.test(r.j.skipped[0]?.reason), JSON.stringify(r.j));
  check('…and the online copy is untouched', (await localFile(alice, docs['amp.kicad_pro'])).includes('"version": 4'));
  r = await call(alice, 'POST', `/api/projects/${pid}/github/pull`, { resolve: { 'amp.kicad_pro': 'online' } });
  eq('"keep online" turns it into a push', states(await status(alice, pid))['amp.kicad_pro'], 'push');
  r = await call(alice, 'POST', `/api/projects/${pid}/github/push`, {});
  check('…which then overwrites GitHub with the online version', (await ghFiles('gh-alice/amp')).files['hw/amp.kicad_pro'].includes('"version": 4'));

  await saveOnline(docs['amp.kicad_pro'], PRO0.replace('"version": 3', '"version": 6'));
  await ctl('commit', { fullName: 'gh-alice/amp', files: { 'hw/amp.kicad_pro': PRO0.replace('"version": 3', '"version": 7') }, author: 'gh-bob' });
  r = await call(alice, 'POST', `/api/projects/${pid}/github/pull`, { resolve: { 'amp.kicad_pro': 'github' } });
  check('"use GitHub\'s" takes their version', (await localFile(alice, docs['amp.kicad_pro'])).includes('"version": 7'), JSON.stringify(r.j));
  r = await call(alice, 'POST', `/api/projects/${pid}/github/push`, { overwrite: ['amp.kicad_pro'] });
  check('nothing left to overwrite afterwards', r.status === 409);

  // ============================================================ unsaved live edits
  await db.query(`INSERT INTO ops (doc_id, seq, author_id, client_id, client_op_id, changes)
                  SELECT $1, MAX(seq) + 1, $2, 'e2e', 'gh-e2e-op', '[]'::jsonb FROM snapshots WHERE doc_id = $1`, [docs['amp.kicad_sch'], aliceId]);
  await ctl('commit', { fullName: 'gh-alice/amp', files: { 'hw/amp.kicad_sch': SCH1.replace('"A3"', '"A2"') }, author: 'gh-bob' });
  st = await status(alice, pid);
  check('unsaved edits are reported', st.summary.unsaved === 1 && st.files.find((f) => f.path === 'amp.kicad_sch').unsavedOps === 1, JSON.stringify(st.summary));
  r = await call(alice, 'POST', `/api/projects/${pid}/github/pull`, {});
  check('pull refuses to replace a document with unsaved edits', r.j.updated.length === 0 && /live edits/.test(r.j.skipped[0]?.reason), JSON.stringify(r.j));
  check('…leaving it as it was', await localFile(alice, docs['amp.kicad_sch']) === SCH1);
  r = await call(alice, 'POST', `/api/projects/${pid}/github/pull`, { force: true });
  check('"pull anyway" replaces it', r.j.updated[0]?.action === 'updated' && (await localFile(alice, docs['amp.kicad_sch'])).includes('"A2"'), JSON.stringify(r.j));

  // ============================================================ a live session (a desktop app is connected)
  {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
    const inbox = [];
    const wait = (pred, ms = 8000) => new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function poll() {
        const hit = inbox.find(pred);
        if (hit) return resolve(hit);
        if (Date.now() - t0 > ms) return reject(new Error('timeout waiting for a websocket message'));
        setTimeout(poll, 25);
      })();
    });
    const pcbId = docs['amp.kicad_pcb'];
    const LIVE = m2.replace('(thickness 1.6)', '(thickness 1.2)');
    let asked = 0;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', proto: 1, token: alice, clientId: 'gh-desktop' }));
    ws.onmessage = async (ev) => {
      const m = JSON.parse(ev.data);
      inbox.push(m);
      // What the desktop app does when asked: write the file as it stands and upload it.
      if (m.type === 'snapshot_request') {
        asked++;
        const seq = inbox.filter((x) => x.type === 'ack').at(-1).seq;
        await fetch(`${BASE}/api/docs/${pcbId}/snapshots?seq=${seq}`, { method: 'POST', headers: { Authorization: `Bearer ${alice}` }, body: LIVE });
      }
    };
    await wait((m) => m.type === 'hello_ok');
    ws.send(JSON.stringify({ type: 'join_doc', docId: pcbId }));
    await wait((m) => m.type === 'doc_info');
    ws.send(JSON.stringify({ type: 'op', docId: pcbId, clientOpId: 'gh-desktop:1',
      changes: [{ id: R1, typeName: 'PCB_FOOTPRINT', kind: 'MODIFIED', properties: [] }] }));
    await wait((m) => m.type === 'ack');
    check('a live edit is ahead of the saved file', (await status(alice, pid)).files.find((f) => f.path === 'amp.kicad_pcb').unsavedOps === 1);

    r = await call(alice, 'POST', `/api/projects/${pid}/github/push`, { message: 'Live edit' });
    check('push asks the connected app to save first', asked === 1 && r.status === 200, `asked ${asked}, ${JSON.stringify(r.j)}`);
    check('…and pushes that fresh save, not the stale one', (await ghFiles('gh-alice/amp')).files['hw/amp.kicad_pcb'] === LIVE);

    await ctl('commit', { fullName: 'gh-alice/amp', files: { 'hw/amp.kicad_pcb': m2 }, author: 'gh-bob' });
    r = await call(alice, 'POST', `/api/projects/${pid}/github/pull`, {});
    const reset = await wait((m) => m.type === 'reset').catch(() => null);
    check('a pull tells connected clients to reload the document', r.j.updated[0]?.action === 'updated' && reset?.docId === pcbId, JSON.stringify(r.j));
    ws.close();
  }

  // ============================================================ pull request
  await saveOnline(docs['amp.kicad_pcb'], m2.replace('"2k"', '"3k3"'));
  const mainBefore = (await ghFiles('gh-alice/amp')).head;
  r = await call(alice, 'POST', `/api/projects/${pid}/github/push`, { pullRequest: true, message: 'R3 to 3k3' });
  check('push as pull request', r.status === 200 && r.j.pullRequest?.number === 1 && /^kicad-collab\//.test(r.j.branch), JSON.stringify(r.j));
  const ghState = await ctl('state?repo=gh-alice/amp');
  check('the linked branch did not move', ghState.branches.main === mainBefore);
  check('the new branch holds the change', (await ghFiles('gh-alice/amp', r.j.branch)).files['hw/amp.kicad_pcb'].includes('"3k3"'));
  eq('the pull request targets the linked branch', [ghState.pulls[0].base, ghState.pulls[0].head, ghState.pulls[0].title], ['main', r.j.branch, 'R3 to 3k3']);
  eq('still "push" until the pull request is merged', states(await status(alice, pid))['amp.kicad_pcb'], 'push');
  r = await call(alice, 'POST', `/api/projects/${pid}/github/push`, {});
  check('a direct push still works afterwards', r.status === 200);

  // ============================================================ linking an existing project
  r = await call(alice, 'PUT', `/api/projects/${pid}/github`, { create: { name: 'amp-copy', private: true }, path: 'board' });
  check('relink to a new repository', r.status === 200 && r.j.repo === 'gh-alice/amp-copy' && r.j.branch === 'main', JSON.stringify(r.j));
  st = await status(alice, pid);
  check('everything is "push" against the fresh repository', st.summary.push === 4 && st.summary.synced === 0, JSON.stringify(st.summary));
  r = await call(alice, 'POST', `/api/projects/${pid}/github/push`, {});
  gh = await ghFiles('gh-alice/amp-copy');
  check('first push lands in the chosen folder, beside the README', r.status === 200 && Object.keys(gh.files).sort().join() === 'README.md,board/amp.kicad_pcb,board/amp.kicad_pro,board/amp.kicad_sch,board/sub.kicad_sch', Object.keys(gh.files).join());

  await ctl('repo', { fullName: 'gh-alice/blank' });
  r = await call(alice, 'PUT', `/api/projects/${pid}/github`, { repo: 'gh-alice/blank', branch: 'main' });
  st = await status(alice, pid);
  check('an empty repository is a valid target', r.status === 200 && st.remote.branchExists === false && st.summary.push === 4, JSON.stringify(st.remote));
  r = await call(alice, 'POST', `/api/projects/${pid}/github/push`, {});
  gh = await ghFiles('gh-alice/blank');
  check('push into an empty repository', r.status === 200 && Object.keys(gh.files).length === 4, JSON.stringify(r.j));
  eq('…and it is in sync', (await status(alice, pid)).summary, { push: 0, pull: 0, conflict: 0, synced: 4, unsaved: 0 });

  r = await call(alice, 'PUT', `/api/projects/${pid}/github`, { repo: 'gh-alice/amp', branch: 'rev-b', path: 'hw' });
  st = await status(alice, pid);
  check('a branch that does not exist yet', st.remote.branchExists === false);
  r = await call(alice, 'POST', `/api/projects/${pid}/github/pull`, {});
  check('pulling from a missing branch explains itself', r.status === 400 && /Push first/.test(r.j.message), JSON.stringify(r.j));
  r = await call(alice, 'POST', `/api/projects/${pid}/github/push`, {});
  const st2 = await ctl('state?repo=gh-alice/amp');
  gh = await ghFiles('gh-alice/amp', 'rev-b');
  check('the first push creates it from the default branch', r.status === 200 && !!st2.branches['rev-b'] && gh.files['README.md'] === '# amp 2\n' && gh.files['hw/amp.kicad_pcb'].includes('"3k3"'), JSON.stringify(r.j));

  // A link between two sides that were never synced and differ: nothing is assumed.
  r = await call(alice, 'PUT', `/api/projects/${pid}/github`, { repo: 'gh-alice/amp', branch: 'main', path: 'panel' });
  st = await status(alice, pid);
  await db.query(`INSERT INTO documents (project_id, path, doc_type) VALUES ($1, 'panel.kicad_pcb', 'kicad_pcb') RETURNING id`, [pid])
    .then((x) => saveOnline(x.rows[0].id, board([fp('R9', R3, 5, 5, '0R')])));
  r = await call(alice, 'GET', `/api/projects/${pid}/github/diff?path=panel.kicad_pcb`);
  eq('never-synced files are compared directly', [r.j.hasBase, brief(r.j.between)], [false, ['added footprint R9']]);
  await db.query(`DELETE FROM documents WHERE project_id = $1 AND path = 'panel.kicad_pcb'`, [pid]);
  st = await status(alice, pid);
  check('unrelated folder: differing files are not silently overwritten either way', st.summary.pull === 2 && st.summary.push === 4 && st.summary.conflict === 0, JSON.stringify(st.summary));

  // ============================================================ permissions
  await call(alice, 'PUT', `/api/projects/${pid}/github`, { repo: 'gh-alice/amp', branch: 'rev-b', path: 'hw' });
  r = await call(bob, 'GET', `/api/projects/${pid}/github`);
  check('a stranger cannot see the sync state', r.status === 403);
  await db.query(`INSERT INTO permissions (project_id, user_id, role) VALUES ($1, $2, 'viewer')`, [pid, bobId]);
  r = await call(bob, 'GET', `/api/projects/${pid}/github`);
  check('a member without a connection sees the link but no file list', r.status === 200 && r.j.link.repo === 'gh-alice/amp' && r.j.github.connected === false && !r.j.files, JSON.stringify(r.j));
  await ctl('browser', { login: 'gh-bob' });
  await connect(bob);
  r = await call(bob, 'GET', `/api/projects/${pid}/github`);
  check('a member GitHub does not let into the repository is told so', r.status === 200 && r.j.remote.reachable === false, JSON.stringify(r.j.remote));
  r = await call(bob, 'POST', `/api/projects/${pid}/github/push`, {});
  check('a viewer cannot push', r.status === 403);
  r = await call(bob, 'POST', `/api/projects/${pid}/github/pull`, {});
  check('a viewer cannot pull', r.status === 403);
  await db.query(`UPDATE permissions SET role = 'editor' WHERE project_id = $1 AND user_id = $2`, [pid, bobId]);
  r = await call(bob, 'PUT', `/api/projects/${pid}/github`, { repo: 'gh-alice/amp' });
  check('only the owner can relink', r.status === 403);
  r = await call(bob, 'DELETE', `/api/projects/${pid}/github`);
  check('only the owner can unlink', r.status === 403);

  await ctl('access', { fullName: 'gh-alice/amp', login: 'gh-bob', push: false });
  r = await call(bob, 'GET', `/api/projects/${pid}/github`);
  check('read-only GitHub access is reported', r.j.remote.reachable && r.j.remote.canPush === false, JSON.stringify(r.j.remote));
  await saveOnline(docs['amp.kicad_sch'], SCH0);
  r = await call(bob, 'POST', `/api/projects/${pid}/github/push`, {});
  check('…and a push with it is refused by GitHub, cleanly', r.status === 403 && r.j.error === 'github_forbidden', JSON.stringify(r.j));
  await ctl('access', { fullName: 'gh-alice/amp', login: 'gh-bob', push: true });
  r = await call(bob, 'POST', `/api/projects/${pid}/github/push`, {});
  check('an editor with write access pushes with their own account', r.status === 200, JSON.stringify(r.j));

  // ============================================================ revoked token, bad input, disconnect, unlink
  await ctl('revoke', { login: 'gh-bob' });
  r = await call(bob, 'GET', `/api/projects/${pid}/github`);
  check('a token revoked on GitHub asks to reconnect', r.status === 409 && r.j.error === 'github_not_connected', JSON.stringify(r.j));

  r = await call(alice, 'PUT', `/api/projects/${pid}/github`, { repo: 'gh-alice/amp', path: '../etc' });
  check('a folder escaping the repository is rejected', r.status === 400);
  r = await call(alice, 'PUT', `/api/projects/${pid}/github`, { repo: 'gh-alice/nope' });
  check('an unknown repository is rejected', r.status === 404);
  r = await call(alice, 'PUT', `/api/projects/${pid}/github`, { create: { name: 'amp' } });
  check('creating a repository whose name is taken explains itself', r.status === 400 && /taken/.test(r.j.message), JSON.stringify(r.j));
  check('…and a failed relink keeps the old link', (await status(alice, pid)).link.branch === 'rev-b');

  r = await call(alice, 'DELETE', `/api/projects/${pid}/github`);
  check('unlink', r.status === 200 && (await status(alice, pid)).link === null);
  check('unlinking deletes nothing on GitHub', !!(await ctl('state?repo=gh-alice/amp')).branches['rev-b']);
  check('…nor online', Object.keys(await docsOf(alice, pid)).length === 4);
  r = await call(alice, 'POST', `/api/projects/${pid}/github/push`, {});
  check('push without a link explains itself', r.status === 400 && /not linked/.test(r.j.message));

  r = await call(alice, 'DELETE', '/api/github');
  check('disconnect', r.status === 200 && (await call(alice, 'GET', '/api/github')).j.connected === false);

  await call(alice, 'DELETE', `/api/projects/${pid}`);
} finally {
  await db.query('DELETE FROM projects WHERE owner_id = ANY($1)', [[aliceId, bobId]]).catch(() => {});
  await db.query('DELETE FROM ops WHERE author_id = ANY($1)', [[aliceId, bobId]]).catch(() => {});
  await db.query('DELETE FROM users WHERE id = ANY($1)', [[aliceId, bobId]]).catch((e) => console.error('cleanup:', e.message));
  await db.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
