// Browser test of version history and branches: two people in real Chromium windows on a real board, one of
// them also editing over a WebSocket, through saving a version, seeing it appear for the other without a
// refresh, scrubbing and playing the timeline, restoring, branching, merging and deleting the branch.
// Same set-up as versions-e2e.mjs (local server with KC_DEV_LOGIN=1, throwaway database), plus Playwright.
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… BOARD=/path/to/project-dir [SHOTS=/some/dir] node versions-ui.mjs
//
// BOARD is a directory with one .kicad_pcb (and optionally its .kicad_sch / .kicad_pro).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import pg from 'pg';

const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL, BOARD = process.env.BOARD;
const SHOTS = process.env.SHOTS || '';
if (!SECRET || !PG_URL || !BOARD) { console.error('E2E_JWT_SECRET, E2E_PG_URL and BOARD are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintJwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
const mkUser = async (ghId, login, name) => (await db.query(
  `INSERT INTO users (github_id, login, name) VALUES ($1, $2, $3)
   ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login, name = EXCLUDED.name RETURNING id`, [ghId, login, name])).rows[0].id;
const mayaId = await mkUser(-9301, 'ui-maya', 'Maya'), jonasId = await mkUser(-9302, 'ui-jonas', 'Jonas');
await db.query('DELETE FROM projects WHERE owner_id = $1', [mayaId]);
const maya = mintJwt(mayaId, 'ui-maya'), jonas = mintJwt(jonasId, 'ui-jonas');
const call = async (token, method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return r.json().catch(() => null);
};

// ---------------------------------------------------------------- the project
const form = new FormData();
let pcbText = '';
for (const f of fs.readdirSync(BOARD)) {
  if (!/\.kicad_(pcb|sch|pro)$/.test(f) || /placed/.test(f)) continue;
  const text = fs.readFileSync(path.join(BOARD, f), 'utf8');
  if (f.endsWith('.kicad_pcb')) pcbText = text;
  form.append('file', new Blob([text]), f);
}
form.append('name', 'rp2040-devboard');
const project = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { Authorization: `Bearer ${maya}` }, body: form })).json();
const pid = project.projectId;
const board = project.docs.find((d) => d.docType === 'kicad_pcb');
check('the project is uploaded', !!pid && !!board);
await db.query(`INSERT INTO permissions (project_id, user_id, role) VALUES ($1, $2, 'editor')`, [pid, jonasId]);
// footprints of the board: uuid and position (mm)
const fps = [...pcbText.matchAll(/\(footprint (?:"[^"]*"|\S+)\s*\(layer "[^"]*"\)\s*\(uuid "([0-9a-f-]+)"\)\s*\(at ([-\d.]+) ([-\d.]+)/g)].map((m) => ({ id: m[1], x: Number(m[2]), y: Number(m[3]) }));
check('the board has footprints to move', fps.length >= 8, `${fps.length}`);

function socket(token, clientId) {
  const ws = new WebSocket(WS);
  const inbox = [], waiters = [];
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', proto: 1, token, clientId, client: 'web' }));
  ws.onmessage = (e) => { const m = JSON.parse(e.data); inbox.push(m); for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].pred(m)) { waiters[i].resolve(m); waiters.splice(i, 1); } };
  let n = 0;
  const api = {
    wait: (pred, ms = 8000) => new Promise((resolve, reject) => { const hit = inbox.find(pred); if (hit) return resolve(hit); waiters.push({ pred, resolve }); setTimeout(() => reject(new Error(`${clientId}: timeout`)), ms); }),
    join: async (docId) => { ws.send(JSON.stringify({ type: 'join_doc', docId })); await api.wait((m) => m.type === 'snapshot' && m.docId === docId); },
    op: async (docId, changes) => { const id = `${clientId}:${++n}`; ws.send(JSON.stringify({ type: 'op', docId, clientOpId: id, changes })); return (await api.wait((m) => m.type === 'ack' && m.clientOpId === id)).seq; },
    close: () => { try { ws.close(); } catch { /* closed */ } },
  };
  return api;
}
const IU = 1e6;
const moveTo = (fp, x, y) => ({ id: fp.id, typeName: 'FOOTPRINT', kind: 'MODIFIED', properties: [
  { name: 'Position X', after: { type: 'int', v: Math.round(x * IU) } }, { name: 'Position Y', after: { type: 'int', v: Math.round(y * IU) } }] });

const J = socket(jonas, 'ui-j'); await J.wait((m) => m.type === 'hello_ok'); await J.join(board.docId);

// ---------------------------------------------------------------- two browsers
const browser = await chromium.launch();
const open = async (token, w = 1440, h = 900) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const p = await ctx.newPage();
  p.nativeDialogs = 0;
  p.on('dialog', (d) => { p.nativeDialogs++; d.dismiss().catch(() => {}); });
  p.on('pageerror', (e) => console.log('  page error:', e.message));
  await p.goto(`${BASE}/auth/dev?jwt=${token}&next=${encodeURIComponent(`/p/${pid}/edit?doc=${board.docId}`)}`);
  await p.waitForFunction(() => window.CollabApp && window.CollabApp.getState().document.hasDoc && window.CollabApp.getState().connection.status === 'live', null, { timeout: 30000 });
  await p.evaluate(() => window.CollabApp.dispatch({ type: 'showPane', pane: 'history', show: true }));
  return p;
};
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: path.join(SHOTS, name + '.png') }); };
const st = (p) => p.evaluate(() => { const s = window.CollabApp.getState(); return { versions: s.versions, viewOnly: s.viewOnly, role: s.role, project: s.project && s.project.projectId }; });
const posOf = (p, id) => p.evaluate((id) => { const it = window.CollabApp.getState().document.items.find((i) => i.id === id); return it ? Math.round(it.x / 1e4) / 100 : null; }, id);
const until = (p, fn, arg, ms = 10000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);

const A = await open(maya), B = await open(jonas);
check('both people have the board open live', true);

// some work, by Jonas over the wire and so by "somebody else" as far as Maya's window goes
const [f0, f1, f2, f3] = fps;
for (let i = 1; i <= 5; i++) await J.op(board.docId, [moveTo(f0, f0.x + i, f0.y)]);
check('edits arrive in both windows', await until(A, ([id, x]) => { const it = window.CollabApp.getState().document.items.find((i) => i.id === id); return it && Math.abs(it.x / 1e6 - x) < 0.01; }, [f0.id, f0.x + 5]));

// ---------------------------------------------------------------- save a version: a themed dialog, and it shows up for everyone
await A.click('#dockL [data-uiact="save"], [data-pane="history"] [data-uiact="save"]');
check('Save version opens a dialog of the app, not the browser\'s prompt', await A.isVisible('[data-version-dialog] #versionName') && A.nativeDialogs === 0);
check('the dialog will not save without a name', await A.isDisabled('[data-version-dialog] button[type=submit]'));
await A.fill('#versionName', 'Placement done');
await A.fill('#versionNote', 'USB connector moved right');
await shot(A, '01-save-version');
await A.click('[data-version-dialog] button[type=submit]');
check('the new version is in the list at once', await until(A, () => !!document.querySelector('[data-version-name="Placement done"]')) && !(await A.isVisible('[data-version-dialog]')));
check('and in the other person\'s list, with no refresh', await until(B, () => !!document.querySelector('[data-version-name="Placement done"]')));
await shot(B, '02-appears-for-everyone');
const row = await A.textContent('[data-version-name="Placement done"]');
check('the row says who saved it and when', /Maya/.test(row) && /USB connector moved right/.test(row) && /\d{1,2}:\d{2}/.test(row), row);

// more work after the version
for (let i = 1; i <= 6; i++) await J.op(board.docId, [moveTo(f1, f1.x, f1.y + i)]);
for (let i = 1; i <= 4; i++) await J.op(board.docId, [moveTo(f2, f2.x - i, f2.y)]);
await J.op(board.docId, [moveTo(f0, f0.x + 9, f0.y)]);
check('the runs of edits are listed between versions', await until(A, () => document.querySelectorAll('[data-run]').length >= 2), await A.textContent('#history'));

// ---------------------------------------------------------------- look at the version
await A.click('[data-version-name="Placement done"]');
check('clicking a version puts it on the canvas', await until(A, () => { const v = window.CollabApp.getState().versions.view; return v && !v.loading && document.querySelector('#historyBar'); }));
let s = await st(A);
check('the timeline is at the version', s.versions.view.seq === 5 && s.versions.view.head === 16 && s.versions.view.versionId, JSON.stringify(s.versions.view));
check('the board reads as it did then', await posOf(A, f0.id) === f0.x + 5 && await posOf(A, f1.id) === f1.x && await posOf(A, f2.id) === f2.x, `${await posOf(A, f0.id)} vs ${f0.x + 5}`);
check('nothing can be edited while looking at the past', s.viewOnly === true && /earlier version/.test(await A.textContent('#historyBanner')));
check('the bar names the version, its time and its author', /Placement done/.test(await A.textContent('#historyWhere')) && /Jonas/.test(await A.textContent('#historyWhere')), await A.textContent('#historyWhere'));
await shot(A, '03-viewing-a-version');

// scrub: arrows step one edit, the slider jumps
await A.keyboard.press('ArrowRight');
check('the right arrow steps one edit forward', await until(A, () => window.CollabApp.getState().versions.view.seq === 6) && await posOf(A, f1.id) === f1.y * 0 + f1.x);
await A.evaluate(() => { const el = document.querySelector('#historyScrub'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, '11'); el.dispatchEvent(new Event('input', { bubbles: true })); });
check('dragging the slider jumps to that edit', await until(A, () => { const v = window.CollabApp.getState().versions.view; return v.seq === 11 && !v.loading; }));
const y11 = await A.evaluate((id) => window.CollabApp.getState().document.items.find((i) => i.id === id).y / 1e6, f1.id);
check('and the board follows', Math.abs(y11 - (f1.y + 6)) < 0.01, `${y11}`);
await shot(A, '04-scrubbing');
await A.evaluate(() => { const el = document.querySelector('#historyScrub'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, '2'); el.dispatchEvent(new Event('input', { bubbles: true })); });
check('scrubbing backwards works too', await until(A, () => { const v = window.CollabApp.getState().versions.view; return v.seq === 2 && !v.loading; }) && await posOf(A, f0.id) === f0.x + 2);

// the live document moves on underneath, the past on screen does not
await J.op(board.docId, [moveTo(f3, f3.x + 3, f3.y)]);
await A.waitForTimeout(600);
check('edits by others do not disturb the past on screen', await posOf(A, f3.id) === f3.x && await posOf(B, f3.id) === f3.x + 3);

// play
await A.click('[data-history-btn="play"]');
check('Play runs the history forward to the present', await until(A, () => { const v = window.CollabApp.getState().versions.view; return v && v.seq === v.head && !v.playing; }, null, 20000));
s = await st(A);
check('the timeline learned about the newer edit', s.versions.view.head === 17, `head ${s.versions.view.head}`);

// name a point that is not a version
await A.evaluate(() => { const el = document.querySelector('#historyScrub'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, '11'); el.dispatchEvent(new Event('input', { bubbles: true })); });
await until(A, () => { const v = window.CollabApp.getState().versions.view; return v.seq === 11 && !v.loading; });
await A.click('[data-history-btn="name"]');
await A.fill('#versionName', 'Decoupling caps moved');
await A.keyboard.press('Enter');
check('any point of the timeline can be given a name', await until(A, () => { const v = window.CollabApp.getState().versions; return v.view && v.view.versionId && v.list.some((x) => x.name === 'Decoupling caps moved'); }));
check('it shows as a tick on the scrubber', (await A.$$('#historyBar [data-mark]')).length === 2);

// leave
await A.keyboard.press('Escape');
check('Esc leaves the timeline and the present comes back', await until(A, ([id, x]) => { const s = window.CollabApp.getState(); const it = s.document.items.find((i) => i.id === id); return !s.versions.view && !s.viewOnly && it && Math.abs(it.x / 1e6 - x) < 0.01 && !document.querySelector('#historyBar'); }, [f3.id, f3.x + 3]));

// ---------------------------------------------------------------- restore
await A.click('[data-version-name="Placement done"]');
await until(A, () => { const v = window.CollabApp.getState().versions.view; return v && !v.loading; });
await A.click('[data-history-btn="restore"]');
check('Restore asks in a dialog of the app', await A.isVisible('[data-version-dialog] #restoreConfirm') && A.nativeDialogs === 0);
check('the dialog says who else is affected and that it can be undone', /1 other person is here/.test(await A.textContent('[data-version-dialog]')) && /taken back/.test(await A.textContent('[data-version-dialog]')), await A.textContent('[data-version-dialog]'));
await shot(A, '05-restore-dialog');
await A.click('#restoreConfirm');
const restored = ([a, ax, b, bx]) => { const s = window.CollabApp.getState(); const A = s.document.items.find((i) => i.id === a), B = s.document.items.find((i) => i.id === b); return !s.versions.view && A && B && Math.abs(A.x / 1e6 - ax) < 0.01 && Math.abs(B.x / 1e6 - bx) < 0.01; };
check('the restored version is the current one for the person who restored', await until(A, restored, [f0.id, f0.x + 5, f2.id, f2.x]));
check('and for everyone else, live', await until(B, restored, [f0.id, f0.x + 5, f2.id, f2.x]));
check('what was there before is kept in the list for both', await until(A, () => !!document.querySelector('[data-version-name^="Before restoring"]')) && await until(B, () => !!document.querySelector('[data-version-name^="Before restoring"]')));
await shot(B, '06-restored-for-everyone');
// editing goes on
await J.op(board.docId, [moveTo(f3, f3.x - 2, f3.y)]);
check('editing goes on after the restore', await until(A, ([id, x]) => { const it = window.CollabApp.getState().document.items.find((i) => i.id === id); return it && Math.abs(it.x / 1e6 - x) < 0.01; }, [f3.id, f3.x - 2]));

// ---------------------------------------------------------------- branches
await A.click('[data-uiact="branches"]');
check('Branches opens its dialog', await A.isVisible('[data-version-dialog] [data-branch="main"]'));
await A.click('#newBranchBtn');
await A.fill('#branchName', 'tighter-layout');
await A.fill('#branchNote', 'Pack the regulator closer to the USB port');
await shot(A, '07-new-branch');
await A.keyboard.press('Enter');
check('creating a branch switches to it', await until(A, (pid) => { const s = window.CollabApp.getState(); return s.project && s.project.projectId !== pid && s.versions.branchName === 'tighter-layout' && s.document.hasDoc && s.connection.status === 'live'; }, pid, 20000));
check('the menu bar says which branch is open', /tighter-layout/.test(await A.textContent('#branchChip')));
check('the other person sees the branch appear', await until(B, () => /Branches \(1\)/.test(document.querySelector('[data-uiact="branches"]').textContent)));
const bid = (await st(A)).project;
const bdoc = (await call(maya, 'GET', `/api/projects/${pid}/branches`)).branches[0].docs.find((d) => d.docType === 'kicad_pcb');
check('the branch starts as main is', await posOf(A, f0.id) === f0.x + 5 && Math.abs(await posOf(A, f3.id) - (f3.x - 2)) < 0.011);

// work on the branch (Maya, over the wire into the branch's board)
const M = socket(maya, 'ui-m'); await M.wait((m) => m.type === 'hello_ok'); await M.join(bdoc.docId);
for (let i = 1; i <= 4; i++) await M.op(bdoc.docId, [moveTo(f1, f1.x + i, f1.y)]);
await M.op(bdoc.docId, [moveTo(f0, f0.x - 3, f0.y)]);
check('work on the branch shows on the branch', await until(A, ([id, x]) => { const it = window.CollabApp.getState().document.items.find((i) => i.id === id); return it && Math.abs(it.x / 1e6 - x) < 0.01; }, [f1.id, f1.x + 4]));
check('and not on main', await posOf(B, f1.id) === f1.x && await posOf(B, f0.id) === f0.x + 5);
await shot(A, '08-on-the-branch');
// main moves on as well, on the same footprint the branch moved
await J.op(board.docId, [moveTo(f0, f0.x + 20, f0.y)]);
await J.op(board.docId, [moveTo(f2, f2.x + 7, f2.y)]);

await A.click('#branchChip');
check('the dialog counts what each side has that the other has not', await until(A, () => { const r = document.querySelector('[data-branch="tighter-layout"]'); return r && /5 edits not in main/.test(r.textContent) && /2 behind main/.test(r.textContent); }), await A.textContent('[data-branch="tighter-layout"]').catch(() => ''));
await shot(A, '09-branches');
await A.click('[data-branch="tighter-layout"] [data-branch-act="merge"]');
check('the merge is previewed', await until(A, () => !!document.querySelector('#mergeDocs') && /5 changes in 5 edits/.test(document.querySelector('#mergeDocs').textContent)), await A.textContent('[data-version-dialog]'));
check('items both sides changed are named, with a choice', /Both sides changed footprint/.test(await A.textContent('#mergeConflicts')) && (await A.$$('#mergeConflicts .seg button')).length === 2, await A.textContent('#mergeConflicts').catch(() => 'none'));
await shot(A, '10-merge-preview');
await A.click('#mergeConfirm');
check('the dialog closes when the merge is done', await until(A, () => !document.querySelector('[data-version-dialog]')));
check('main gets the branch\'s work live, the branch winning the conflict', await until(B, ([a, ax, b, bx, c, cx]) => { const it = (id) => window.CollabApp.getState().document.items.find((i) => i.id === id); return Math.abs(it(a).x / 1e6 - ax) < 0.01 && Math.abs(it(b).x / 1e6 - bx) < 0.01 && Math.abs(it(c).x / 1e6 - cx) < 0.01; }, [f1.id, f1.x + 4, f0.id, f0.x - 3, f2.id, f2.x + 7]));
check('main kept what it was before the merge', await until(B, () => !!document.querySelector('[data-version-name^="Before merging"]')));
check('the merge shows in main\'s history', await until(B, () => /merged 5 edits/.test(document.querySelector('#history').textContent)), await B.textContent('#history'));
await shot(B, '11-main-after-merge');

// bring main's own work into the branch
await A.click('#branchChip');
await A.click('[data-branch="tighter-layout"] [data-branch-act="update"]');
await until(A, () => !!document.querySelector('#mergeDocs'));
await A.click('#mergeConfirm');
check('Update from main brings main\'s work into the branch', await until(A, ([c, cx]) => { const it = window.CollabApp.getState().document.items.find((i) => i.id === c); return it && Math.abs(it.x / 1e6 - cx) < 0.01; }, [f2.id, f2.x + 7]));

// dark theme, the timeline on the branch
await A.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
await A.click('[data-run]');
await until(A, () => { const v = window.CollabApp.getState().versions.view; return v && !v.loading; });
check('the timeline works on a branch, and does not offer a branch of a branch', !(await A.$('[data-history-btn="branch"]')) && !!(await A.$('[data-history-btn="restore"]')));
await shot(A, '12-branch-timeline-dark');
await A.click('[data-history-btn="done"]');

// switch back to main from the dialog, then delete the branch
await A.click('#branchChip');
await A.click('[data-branch="main"] [data-branch-act="open"]');
check('Open on main switches back', await until(A, (pid) => { const s = window.CollabApp.getState(); return s.project && s.project.projectId === pid && !s.versions.branchName && s.document.hasDoc; }, pid, 20000) && !(await A.$('#branchChip')));
await A.click('[data-uiact="branches"]');
await A.click('[data-branch="tighter-layout"] [data-branch-act="delete"]');
check('deleting a branch asks first, in a dialog of the app', await A.isVisible('#versionConfirm') && A.nativeDialogs === 0);
await A.click('#versionConfirm');
check('the branch is gone for both', await until(A, () => !document.querySelector('[data-branch="tighter-layout"]')) && await until(B, () => /Branches\.\.\./.test(document.querySelector('[data-uiact="branches"]').textContent)));
check('no browser dialog was used anywhere', A.nativeDialogs === 0 && B.nativeDialogs === 0);

// a narrow window
const N = await open(jonas, 760, 700);
await N.evaluate(() => { const s = window.CollabApp.getState(); window.CollabApp.dispatch({ type: 'versions', cmd: 'viewVersion', versionId: s.versions.list.find((v) => v.name === 'Placement done').id }); });
const fits = await until(N, () => { const b = document.querySelector('#historyBar'); if (!b) return false; const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight; });
check('the timeline bar fits a narrow window', fits);
await shot(N, '13-narrow');

J.close(); M.close();
await browser.close();
await db.query('DELETE FROM projects WHERE id = $1', [pid]);
await db.query('DELETE FROM users WHERE github_id IN (-9301, -9302)');
await db.end();
void bid;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
