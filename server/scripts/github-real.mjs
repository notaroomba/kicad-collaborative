#!/usr/bin/env node
// github-real.mjs — GitHub sync against the real github.com, on a throwaway repository.
//
// The stand-in (fake-github.mjs + github-e2e.mjs) covers every path; this run checks
// that the real API behaves the way the stand-in says it does. It writes to the
// repository named in REAL_REPO (which must be a throwaway one) and nowhere else.
//
//   REAL_REPO=owner/name         the throwaway repository (must exist, may hold anything)
//   REAL_GH_ID=<github user id>  the account that owns the token the server will use
//   E2E_BASE                     server under test, run with GITHUB_API_URL pointing at
//                                something that reaches api.github.com with that token
//   E2E_FAKE_GH                  fake-github.mjs, used only for the OAuth hand-off
//   E2E_PG_URL, E2E_JWT_SECRET   as for github-e2e.mjs
//   GH_DIRECT                    a command prefix able to call api.github.com as the same
//                                account, used to make "someone else edited it on GitHub"
//                                commits (default: curl, relying on an authenticating proxy
//                                or GH_TOKEN)
//   KICAD_DEMO                   a KiCad project folder to use (default: demos/ecc83)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pg = createRequire(here + '/')('pg');
const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8096').replace(/\/$/, '');
const FAKE = (process.env.E2E_FAKE_GH || 'http://127.0.0.1:8098').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const REPO = process.env.REAL_REPO, GH_ID = Number(process.env.REAL_GH_ID);
const DEMO = process.env.KICAD_DEMO || path.join(here, '../../demos/ecc83');
if (!SECRET || !PG_URL || !REPO || !GH_ID) { console.error('E2E_JWT_SECRET, E2E_PG_URL, REAL_REPO and REAL_GH_ID are required.'); process.exit(2); }
const SUB = 'hardware';
const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' — ' + String(detail).slice(0, 600) : ''}`); ok ? pass++ : fail++; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const mint = (sub, login) => { const n = Math.floor(Date.now() / 1000); const h = b64({ alg: 'HS256', typ: 'JWT' }), b = b64({ sub, login, iat: n, exp: n + 3600 });
  return `${h}.${b}.${crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url')}`; };
const blobSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

// ---- GitHub, directly (as "a collaborator editing on github.com")
function gh(method, p, body) {
  const args = ['-sS', '-X', method, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', '-w', '\n%{http_code}'];
  if (process.env.GH_TOKEN) args.push('-H', `Authorization: Bearer ${process.env.GH_TOKEN}`);
  if (body) args.push('-H', 'Content-Type: application/json', '--data-binary', '@-');
  args.push('https://api.github.com' + p);
  const out = execFileSync('curl', args, { input: body ? JSON.stringify(body) : undefined, maxBuffer: 1 << 28 }).toString();
  const i = out.lastIndexOf('\n');
  const status = Number(out.slice(i + 1));
  let j = null; try { j = JSON.parse(out.slice(0, i)); } catch {}
  return { status, j };
}
const ghFile = (p, ref = 'main') => {
  const r = gh('GET', `/repos/${REPO}/contents/${p}?ref=${encodeURIComponent(ref)}`);
  if (r.status !== 200) return null;
  if (r.j.content) return Buffer.from(r.j.content, 'base64').toString();
  return Buffer.from(gh('GET', `/repos/${REPO}/git/blobs/${r.j.sha}`).j.content, 'base64').toString();
};
const ghEdit = (p, content, message, branch = 'main') => {
  const cur = gh('GET', `/repos/${REPO}/contents/${p}?ref=${branch}`);
  return gh('PUT', `/repos/${REPO}/contents/${p}`, { message, content: Buffer.from(content).toString('base64'), sha: cur.j?.sha, branch });
};
const ghHead = (branch = 'main') => gh('GET', `/repos/${REPO}/git/ref/heads/${branch}`).j?.object?.sha;

// ---- the server
const db = new pg.Client({ connectionString: PG_URL });
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
await db.connect();
const uid = (await db.query(`INSERT INTO users (github_id, login, name) VALUES ($1, 'real-test', 'real-test')
  ON CONFLICT (github_id) DO UPDATE SET login = users.login RETURNING id`, [GH_ID])).rows[0].id;
const jwt = mint(uid, 'real-test');
const call = async (method, p, body) => {
  const t0 = Date.now();
  const r = await fetch(BASE + p, { method, headers: { Authorization: `Bearer ${jwt}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j, ms: Date.now() - t0 };
};
const status = async (pid) => (await call('GET', `/api/projects/${pid}/github`)).j;
const states = (st) => Object.fromEntries(st.files.map((f) => [f.path, f.state]));
const docIds = async (pid) => Object.fromEntries((await db.query('SELECT id, path FROM documents WHERE project_id = $1', [pid])).rows.map((r) => [r.path, r.id]));
const online = async (docId) => (await db.query('SELECT content FROM snapshots WHERE doc_id = $1 ORDER BY seq DESC LIMIT 1', [docId])).rows[0].content.toString();
async function saveOnline(docId, content) {
  const { rows } = await db.query(`SELECT GREATEST(COALESCE((SELECT MAX(seq) FROM ops WHERE doc_id = $1), 0),
    COALESCE((SELECT MAX(seq) FROM snapshots WHERE doc_id = $1), 0)) AS head`, [docId]);
  await db.query('INSERT INTO snapshots (doc_id, seq, content) VALUES ($1, $2, $3)', [docId, rows[0].head + 1, Buffer.from(content)]);
}

// ---- edits to a real board: the k-th footprint's position or value
const nth = (text, k) => { let i = -1; for (let n = 0; n <= k; n++) { i = text.indexOf('\n\t(footprint ', i + 1); if (i < 0) throw new Error('no footprint ' + k); } return i; };
const moveFp = (text, k, dx) => { const i = nth(text, k); const j = text.indexOf('(at ', i);
  return text.slice(0, j) + text.slice(j).replace(/^\(at ([-\d.]+)/, (m, x) => `(at ${+(+x + dx).toFixed(4)}`); };
const setValue = (text, k, v) => { const i = nth(text, k); const j = text.indexOf('(property "Value" "', i);
  return text.slice(0, j) + text.slice(j).replace(/^\(property "Value" "[^"]*"/, `(property "Value" "${v}"`); };

const cleanup = [];
let pid;
try {
  // ============================================================ connect (real /user behind the fake OAuth)
  await fetch(`${FAKE}/__ctl/browser`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'whoever' }) });
  let url = `${BASE}/auth/github/connect?next=/github`, last;
  for (let i = 0; i < 6; i++) { last = await fetch(url, { redirect: 'manual', headers: url.startsWith(BASE) ? { Cookie: `kc_session=${jwt}` } : {} }); if (last.status < 300 || last.status >= 400) break; url = new URL(last.headers.get('location'), url).toString(); }
  const conn = (await call('GET', '/api/github')).j;
  check('connected as the real account', last.status === 200 && conn.connected, JSON.stringify(conn));

  // ============================================================ a project online, linked to a new folder
  const files = {};
  for (const f of fs.readdirSync(DEMO)) {
    if (/\.(kicad_pcb|kicad_sch|kicad_pro)$/.test(f) && !/_v2\./.test(f) || f === 'fp-lib-table') files[f] = fs.readFileSync(path.join(DEMO, f));
  }
  const pcbName = Object.keys(files).find((f) => f.endsWith('.kicad_pcb'));
  // Uploaded the way the web app's folder upload does it.
  const form = new FormData();
  form.append('name', `real-sync-${STAMP}`);
  for (const [p, c] of Object.entries(files)) form.append('file', new Blob([c]), p);
  const up = await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: form });
  const proj = await up.json();
  check('upload the demo project', up.status === 200 || up.status === 201, JSON.stringify(proj));
  pid = proj.projectId;
  const folder = `${SUB}/${STAMP}`;
  let r = await call('PUT', `/api/projects/${pid}/github`, { repo: REPO, path: folder });
  check('link to a folder of the real repository', r.status === 200, JSON.stringify(r.j));
  let st = await status(pid);
  check('everything is waiting to be pushed', st.summary.push === Object.keys(files).length && st.remote.canPush === true, JSON.stringify(st.summary));

  // ============================================================ push
  r = await call('POST', `/api/projects/${pid}/github/push`, { message: `kicad-collab real test ${STAMP}: first push` });
  check('push to github.com', r.status === 200 && r.j.pushed.length === Object.keys(files).length, JSON.stringify(r.j) + ` ${r.ms}ms`);
  const pushedHead = ghHead();
  check('the branch now points at the pushed commit', pushedHead === r.j.commit, `${pushedHead} vs ${r.j.commit}`);
  let same = true;
  for (const [p, c] of Object.entries(files)) {
    const back = ghFile(`${folder}/${p}`);
    if (back !== c.toString()) { same = false; console.log('   differs:', p); }
  }
  check('every file on GitHub is byte-identical to the online copy', same);
  const commit = gh('GET', `/repos/${REPO}/commits/${r.j.commit}`).j;
  check('the commit touched only the project folder', commit.files.every((f) => f.filename.startsWith(folder + '/')), commit.files.map((f) => f.filename).join(', '));
  check('…and kept what was already in the repository', ghFile('README.md') !== null);
  st = await status(pid);
  check('in sync after the push', st.summary.synced === Object.keys(files).length && st.summary.push + st.summary.pull + st.summary.conflict === 0, JSON.stringify(st.summary));

  // ============================================================ someone edits on github.com, we pull
  const docs = await docIds(pid);
  const pcb0 = files[pcbName].toString();
  const pcbGh = moveFp(pcb0, 2, 5);
  r = ghEdit(`${folder}/${pcbName}`, pcbGh, 'Move a footprint on GitHub');
  check('a direct edit on GitHub (the collaborator)', r.status === 200, JSON.stringify(r.j).slice(0, 300));
  st = await status(pid);
  check('it shows as a pull', states(st)[pcbName] === 'pull' && st.summary.pull === 1, JSON.stringify(st.summary));
  r = await call('GET', `/api/projects/${pid}/github/diff?path=${encodeURIComponent(pcbName)}`);
  check('the diff names the footprint that moved', r.status === 200 && r.j.github.total === 1 && r.j.github.changes[0].parts.includes('at'), JSON.stringify(r.j.github));
  r = await call('POST', `/api/projects/${pid}/github/pull`, {});
  check('pull', r.status === 200 && r.j.updated.length === 1, JSON.stringify(r.j));
  check('the online board is now GitHub\'s, byte for byte', (await online(docs[pcbName])) === pcbGh);

  // ============================================================ both sides edit the same board: item merge
  const ours = setValue(pcbGh, 0, '470k');
  await saveOnline(docs[pcbName], ours);
  const theirs = moveFp(pcbGh, 5, -3);
  ghEdit(`${folder}/${pcbName}`, theirs, 'Move another footprint on GitHub');
  st = await status(pid);
  check('edited on both sides shows as a conflict', states(st)[pcbName] === 'conflict', JSON.stringify(states(st)));
  r = await call('POST', `/api/projects/${pid}/github/push`, {});
  check('a plain push will not overwrite GitHub', r.status === 409, JSON.stringify(r.j));
  r = await call('POST', `/api/projects/${pid}/github/pull`, {});
  const u = r.j?.updated?.[0];
  check('pull merges the two edits item by item', u?.action === 'merged' && u.conflicts.length === 0, JSON.stringify(r.j));
  const want = moveFp(ours, 5, -3);
  check('the merge holds both edits and changes nothing else', (await online(docs[pcbName])) === want);
  r = await call('POST', `/api/projects/${pid}/github/push`, { message: 'Merge online and GitHub edits' });
  check('push the merge', r.status === 200, JSON.stringify(r.j));
  check('GitHub has the merged board', ghFile(`${folder}/${pcbName}`) === want);
  st = await status(pid);
  check('in sync after merge and push', st.summary.push + st.summary.pull + st.summary.conflict === 0, JSON.stringify(st.summary));

  // ============================================================ a pull request instead of a commit
  await saveOnline(docs[pcbName], setValue(want, 1, '1M'));
  r = await call('POST', `/api/projects/${pid}/github/push`, { message: `kicad-collab real test ${STAMP}: as a pull request`, pullRequest: true });
  check('push as a pull request', r.status === 200 && r.j.pullRequest?.number > 0, JSON.stringify(r.j));
  if (r.j?.pullRequest?.number) {
    cleanup.push(() => gh('PATCH', `/repos/${REPO}/pulls/${r.j.pullRequest.number}`, { state: 'closed' }));
    cleanup.push(() => gh('DELETE', `/repos/${REPO}/git/refs/heads/${r.j.branch}`));
    const pr = gh('GET', `/repos/${REPO}/pulls/${r.j.pullRequest.number}`).j;
    check('…which is open against main with the one file', pr.state === 'open' && pr.base.ref === 'main' && pr.changed_files === 1, `${pr.state} ${pr.base?.ref} ${pr.changed_files}`);
    check('main did not move', ghHead() === ghHead() && ghFile(`${folder}/${pcbName}`) === want);
  }
  st = await status(pid);
  check('the file still shows as waiting to push', states(st)[pcbName] === 'push');

  // ============================================================ push on checkpoint
  r = await call('POST', `/api/projects/${pid}/github/settings`, { autoPush: true });
  check('switch on push-on-checkpoint', r.status === 200);
  r = await call('POST', `/api/projects/${pid}/checkpoints`, { name: `Rev ${STAMP}` });
  check('saving a checkpoint starts a push', r.j?.githubPush === true, JSON.stringify(r.j));
  let la = null;
  for (let i = 0; i < 60 && !(la && la.checkpoint === `Rev ${STAMP}`); i++) { await new Promise((res) => setTimeout(res, 500)); la = (await status(pid)).link.lastAuto; }
  check('…which lands on github.com named after the checkpoint', la?.ok === true && gh('GET', `/repos/${REPO}/commits/main`).j.commit.message === `Checkpoint: Rev ${STAMP}`, JSON.stringify(la));
  check('…with the edit', ghFile(`${folder}/${pcbName}`) === setValue(want, 1, '1M'));
  await call('POST', `/api/projects/${pid}/github/settings`, { autoPush: false });

  // ============================================================ import the folder as a new project
  r = await call('GET', `/api/github/scan?repo=${REPO}`);
  check('scan finds the project folder', r.status === 200 && r.j.projects.some((p) => p.path === folder), JSON.stringify(r.j?.projects));
  r = await call('POST', '/api/github/import', { repo: REPO, path: folder });
  check('import it as a second project', r.status === 200, JSON.stringify(r.j));
  const pid2 = r.j?.projectId;
  if (pid2) {
    cleanup.push(() => call('DELETE', `/api/projects/${pid2}`));
    st = await status(pid2);
    check('the import is in sync straight away', st.summary.synced === Object.keys(files).length && st.summary.push + st.summary.pull + st.summary.conflict === 0, JSON.stringify(st.summary));
    const d2 = await docIds(pid2);
    check('…with identical content', (await online(d2[pcbName])) === setValue(want, 1, '1M'));
  }

  // ============================================================ a branch that does not exist yet
  const br = `kicad-collab-test-${STAMP}`;
  cleanup.push(() => gh('DELETE', `/repos/${REPO}/git/refs/heads/${br}`));
  r = await call('PUT', `/api/projects/${pid}/github`, { repo: REPO, branch: br, path: folder });
  st = await status(pid);
  check('linking to a missing branch says so', st.remote.branchExists === false, JSON.stringify(st.remote));
  await saveOnline(docs[pcbName], setValue(want, 2, '2k2'));
  r = await call('POST', `/api/projects/${pid}/github/push`, {});
  check('the first push creates the branch from main', r.status === 200 && ghHead(br) === r.j.commit && gh('GET', `/repos/${REPO}/commits/${r.j.commit}`).j.parents[0].sha === ghHead('main'), JSON.stringify(r.j));

  // ============================================================ the server never forced anything
  const mainLog = gh('GET', `/repos/${REPO}/commits?sha=main&per_page=10`).j.map((c) => c.sha);
  check('every earlier commit is still in main\'s history', mainLog.includes(pushedHead));
} catch (e) {
  check('run completed', false, e.stack || String(e));
} finally {
  for (const f of cleanup.reverse()) { try { await f(); } catch {} }
  if (pid) await call('DELETE', `/api/projects/${pid}`).catch(() => {});
  await db.query('DELETE FROM projects WHERE owner_id = $1', [uid]).catch(() => {});
  await db.query('DELETE FROM users WHERE id = $1', [uid]).catch(() => {});
  await db.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
