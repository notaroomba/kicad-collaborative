// Browser test of the projects home (server/web/home): two real browsers, an owner and a
// collaborator, go through listing, upload, rename, sharing, joining by link, Trash, stars,
// blank projects, ownership transfer, selecting several, and the phone layout.
// Needs a local server with KC_DEV_LOGIN=1 on a throwaway database, Playwright, and `zip`.
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… [E2E_BASE=http://127.0.0.1:8099] [SHOTS=/some/dir] node home-ui.mjs
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { chromium, devices } = createRequire(import.meta.url)('playwright');

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
const DEMOS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../demos');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'home-ui-'));
const out = process.env.SHOTS || path.join(TMP, 'shots'); fs.mkdirSync(out, { recursive: true });

let pass = 0, fail = 0; const fails = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (ok) pass++; else { fail++; fails.push(name); } };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'HS256', typ: 'JWT' }), b = b64({ sub, login, iat: now, exp: now + 36000 });
  return `${h}.${b}.${crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url')}`;
}
async function api(token, p, opts = {}) {
  const r = await fetch(BASE + p, { ...opts, headers: { authorization: `Bearer ${token}`, ...(opts.json ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) }, body: opts.json ? JSON.stringify(opts.json) : opts.body });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}

// ---------------------------------------------------------------- fixtures
// Three throwaway users (negative GitHub ids) and five demo projects; leftovers of an earlier run go first.
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
const GH_IDS = [-9101, -9102, -9103, -9104];
const cleanup = async () => {
  await db.query('DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE github_id = ANY($1))', [GH_IDS]);
  // A user who left traces in someone else's project (possible only when the database is shared with
  // other data) cannot be deleted; the next run on a clean database is not affected.
  await db.query('DELETE FROM users WHERE github_id = ANY($1)', [GH_IDS]).catch((e) => console.warn('cleanup: ' + e.message));
};
await cleanup();
const user = async (ghId, login) => (await db.query(
  'INSERT INTO users (github_id, login, name, email) VALUES ($1, $2, $3, $4) RETURNING id', [ghId, login, `${login} name`, `${login}@example.com`])).rows[0].id;
const alice = await user(-9101, 'alice'), bob = await user(-9102, 'bob'), carol = await user(-9103, 'carol');
const ids = { ta: jwt(alice, 'alice'), tb: jwt(bob, 'bob'), tc: jwt(carol, 'carol') };
const zipOf = (dir, name, extra = '') => {
  const file = path.join(TMP, name);
  execSync(`cd "${dir}" && zip -qr "${file}" . ${extra}`); return file;
};
const up = async (tok, dir, name) => {
  const file = zipOf(path.join(DEMOS, dir), `${dir}.zip`, `-i '*.kicad_pro' '*.kicad_sch' '*.kicad_pcb'`);
  const f = new FormData(); f.append('name', name); f.append('archive', new Blob([fs.readFileSync(file)]), 'p.zip');
  const r = await api(tok, '/api/projects', { method: 'POST', body: f }); if (r.status !== 200) throw new Error(JSON.stringify(r)); return r.body.projectId;
};
ids.p1 = await up(ids.ta, 'pic_programmer', 'PIC programmer');
ids.p2 = await up(ids.ta, 'ecc83', 'ECC83 preamp');
ids.p3 = await up(ids.ta, 'stickhub', 'StickHub');
ids.p4 = await up(ids.tb, 'video', 'Video card');
ids.p5 = await up(ids.tb, 'microwave', 'Microwave filter');
await api(ids.ta, `/api/projects/${ids.p2}`, { method: 'PATCH', json: { description: 'Tube preamp with an ECC83 double triode', public: true } });
await api(ids.tb, `/api/projects/${ids.p4}/invites`, { method: 'POST', json: { login: 'alice', role: 'editor' } });
await api(ids.tb, `/api/projects/${ids.p5}`, { method: 'PATCH', json: { public: true, description: 'A microstrip band-pass filter' } });
await api(ids.ta, `/api/projects/${ids.p1}/invites`, { method: 'POST', json: { login: 'bob', role: 'viewer' } });
await api(ids.ta, `/api/projects/${ids.p1}/invites`, { method: 'POST', json: { email: 'dave@example.com', role: 'editor' } });

const browser = await chromium.launch();
const errors = []; const netlog = [];
async function open(token, opts = { viewport: { width: 1280, height: 800 } }, next = '/') {
  const c = await browser.newContext({ ...opts, permissions: ['clipboard-read', 'clipboard-write'] });
  const p = await c.newPage(); p.setDefaultTimeout(8000);
  p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  p.on('response', (r) => { const q = r.request(); if (q.method() !== 'GET' || /api\/(trash|projects)$/.test(r.url())) netlog.push(`${Date.now() % 100000} ${q.method()} ${r.url().replace(BASE, '')} ${r.status()}`); });
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await p.goto(token ? `${BASE}/auth/dev?jwt=${token}&next=${encodeURIComponent(next)}` : BASE + next);
  return p;
}
// List changes run as view transitions, which apply a frame or two after the click.
const settle = (p) => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30)))));
/** Poll until `fn` is true (the UI answers first and tells the server right after). */
const until = async (fn, ms = 4000) => { const t = Date.now(); for (;;) { if (await fn()) return true; if (Date.now() - t > ms) return false; await new Promise((r) => setTimeout(r, 100)); } };
const names = async (p) => { await settle(p); return p.locator('.hp-item:not(.skel) .hp-item-name').allTextContents(); };
const card = (p, name) => p.locator('.hp-item', { has: p.locator('.hp-item-name', { hasText: new RegExp('^' + name + '$') }) });
const menu = async (p, name, item) => { await card(p, name).locator('.hp-iconbtn').click(); await p.locator('.hp-menu button', { hasText: item }).click(); };
const toastText = async (p, re) => { try { await p.locator('.hp-toast', { hasText: re }).first().waitFor({ timeout: 5000 }); return true; } catch { return false; } };
const step = async (name, fn) => { try { await fn(); } catch (e) { check(name, false, String(e.message).split('\n').slice(0, 4).join(' / ')); console.log(netlog.slice(-25).join('\n')); await a.screenshot({ path: out + '/FAIL-' + name.replace(/\W+/g, '-') + '.png' }).catch(() => {}); } };

const a = await open(ids.ta); const b = await open(ids.tb);
await a.waitForSelector('.hp-item:not(.skel)'); await b.waitForSelector('.hp-item:not(.skel)');

await step('list', async () => {
  const frame = await a.evaluate(() => ({ sb: document.querySelector('#statusbar')?.getBoundingClientRect().height || 0, menus: document.querySelectorAll('#homeMenus .menu').length,
    gap: innerHeight - document.querySelector('.hp').getBoundingClientRect().bottom, out: [...document.querySelectorAll('#logoutBtn, .hp-logout')].filter((e) => e.getBoundingClientRect().width > 0).length }));
  check('the dashboard has no editor status bar or menus, and fills the window', frame.sb === 0 && frame.menus === 0 && Math.abs(frame.gap) < 1, JSON.stringify(frame));
  check('Log out is one click away, in the top bar and the sidebar', frame.out === 2, JSON.stringify(frame));
  check('alice sees her 3 projects and the one shared with her', (await names(a)).length === 4, (await names(a)).join(', '));
  check('role pills: owner on own, editor on shared', await card(a, 'StickHub').locator('.pill.owner').count() === 1 && await card(a, 'Video card').locator('.pill.editor').count() === 1);
  await a.click('.hp-seg button:has-text("Shared with me")'); check('"Shared with me" filter', (await names(a)).join() === 'Video card');
  await a.click('.hp-seg button:has-text("Owned by me")'); check('"Owned by me" filter', (await names(a)).length === 3);
  await a.click('.hp-seg button:has-text("All")');
  await a.keyboard.press('/'); await a.keyboard.type('ecc'); check('"/" focuses search and it filters', (await names(a)).join() === 'ECC83 preamp');
  await a.keyboard.type('zzz'); check('no-match message offers a way back', await a.locator('.hp-empty.small button').count() === 1);
  await a.click('.hp-empty.small button'); check('"Show all projects" clears the search', (await names(a)).length === 4);
  await a.selectOption('select[aria-label="Sort by"]', 'name'); check('sort by name', (await names(a)).join() === 'ECC83 preamp,PIC programmer,StickHub,Video card', (await names(a)).join());
  await a.reload(); await a.waitForSelector('.hp-item:not(.skel)'); check('sort choice survives a reload', (await names(a))[0] === 'ECC83 preamp');
  await a.selectOption('select[aria-label="Sort by"]', 'updated');
});

await step('upload', async () => {
  await a.click('.hp-head-acts .btn.primary');
  const demo = path.join(DEMOS, 'complex_hierarchy');
  const files = fs.readdirSync(demo).filter((f) => !fs.statSync(`${demo}/${f}`).isDirectory()).map((f) => `${demo}/${f}`);
  const notes = path.join(TMP, 'notes.txt'); fs.writeFileSync(notes, 'not a kicad file'); files.push(notes);
  await a.locator('.hp-modal input[type=file]').first().setInputFiles(files);
  await a.waitForSelector('.hp-summary');
  check('upload dialog names the project after its .kicad_pro', await a.locator('.hp-field input').inputValue() === 'complex_hierarchy', await a.locator('.hp-field input').inputValue());
  check('upload dialog says what will be left out', /other file/.test(await a.locator('.hp-skipped summary').textContent()));
  await a.screenshot({ path: `${out}/01-upload-ready.png` });
  await a.locator('.hp-field input').fill('Hierarchy demo');
  await a.click('.hp-modal-f .btn.primary');
  check('upload finishes with a toast', await toastText(a, /Hierarchy demo.*online/));
  await a.waitForSelector('.hp-item-name:has-text("Hierarchy demo")');
  check('the new project is first in the list', (await names(a))[0] === 'Hierarchy demo');
  await a.waitForTimeout(2500); await a.screenshot({ path: `${out}/02-uploaded.png` });
  // a zip, through the same dialog
  const mw = path.join(TMP, 'mw.zip'); execSync(`cd "${DEMOS}" && zip -qr "${mw}" microwave -x '*.kicad_prl'`);
  await a.click('.hp-head-acts .btn.primary');
  await a.locator('.hp-modal input[type=file]').first().setInputFiles(mw);
  await a.waitForSelector('.hp-summary');
  check('a .zip is named after the archive', await a.locator('.hp-field input').inputValue() === 'mw');
  await a.locator('.hp-field input').fill('Zipped microwave'); await a.click('.hp-modal-f .btn.primary');
  await a.waitForSelector('.hp-item-name:has-text("Zipped microwave")');
  const list = (await api(ids.ta, '/api/projects')).body.projects; const z = list.find((x) => x.name === 'Zipped microwave');
  const info = (await api(ids.ta, `/api/projects/${z.projectId}`)).body;
  check('zip of a folder is stored project-relative (no "microwave/" prefix)', info.docs.every((d) => !d.path.startsWith('microwave/')) && info.docs.some((d) => d.path.endsWith('.kicad_pro')), info.docs.map((d) => d.path).join(','));
  // nothing usable
  await a.click('.hp-head-acts .btn.primary');
  await a.locator('.hp-modal input[type=file]').first().setInputFiles(path.join(TMP, 'notes.txt'));
  check('a non-KiCad file is refused before upload, with a reason', await a.locator('.hp-note.err').count() === 1 && await a.locator('.hp-modal-f .btn.primary').isDisabled());
  await a.keyboard.press('Escape');
});

await step('rename + details + visibility', async () => {
  await menu(a, 'Hierarchy demo', 'Rename');
  const inp = a.locator('.hp-rename'); await inp.fill('Hierarchy v2'); await inp.press('Enter');
  check('inline rename updates the card at once', await card(a, 'Hierarchy v2').count() === 1);
  check('rename toast', await toastText(a, /Renamed/));
  const srv = (await api(ids.ta, '/api/projects')).body.projects.map((x) => x.name);
  check('rename reached the server', srv.includes('Hierarchy v2') && !srv.includes('Hierarchy demo'));
  await menu(a, 'Hierarchy v2', 'Rename'); await a.locator('.hp-rename').fill('nope'); await a.locator('.hp-rename').press('Escape');
  check('Escape cancels a rename', await card(a, 'Hierarchy v2').count() === 1 && await card(a, 'nope').count() === 0);
  await card(a, 'Hierarchy v2').locator('.hp-item-link').focus(); await a.keyboard.press('F2');
  check('F2 starts a rename', await a.locator('.hp-rename').count() === 1); await a.keyboard.press('Escape');
  await menu(a, 'Hierarchy v2', 'Edit details');
  await a.locator('.hp-modal textarea').fill('A multi-sheet demo'); await a.click('.hp-modal-f .btn.primary');
  await a.waitForSelector('.hp-modal', { state: 'detached' });
  await menu(a, 'Hierarchy v2', 'Make public');
  await settle(a); check('card shows the public pill', await card(a, 'Hierarchy v2').locator('.pill', { hasText: 'public' }).count() === 1);
  await b.click('.hp-nav a:has-text("Explore")'); await b.waitForSelector('.hp-item-name:has-text("Hierarchy v2")');
  check('bob finds it in Explore, with its description', await b.locator('.hp-item', { hasText: 'Hierarchy v2' }).locator('.hp-item-desc').textContent() === 'A multi-sheet demo');
  await b.screenshot({ path: `${out}/03-bob-explore.png` });
  await b.locator('.hp-item', { hasText: 'Hierarchy v2' }).locator('button:has-text("Make a copy")').click();
  check('bob copies a public project', await toastText(b, /in your projects/));
  await b.click('.hp-nav a:has-text("Projects")'); await b.waitForSelector('.hp-item-name:has-text("Hierarchy v2 (copy)")');
  check('the copy is in bob\'s list', true);
  await a.locator('.hp-toast button:has-text("Undo")').click().catch(() => {});
});

await step('share', async () => {
  await menu(a, 'StickHub', 'Share');
  await a.waitForSelector('.hp-people li');
  check('share dialog lists the owner', await a.locator('.hp-people li').first().textContent().then((t) => /alice.*owner/i.test(t)));
  await a.locator('.hp-combo input').fill('bo');
  await a.waitForSelector('.hp-suggest li');
  check('typeahead finds bob', /bob/.test(await a.locator('.hp-suggest li').first().textContent()));
  await a.screenshot({ path: `${out}/04-share-typeahead.png` });
  await a.keyboard.press('ArrowDown'); await a.keyboard.press('Enter');
  await a.waitForSelector('.hp-people li:has-text("bob")');
  check('invite by username grants access immediately, with an inline note', /bob can now edit/.test(await a.locator('.hp-invite .hp-note').textContent()));
  await b.reload(); await b.waitForSelector('.hp-item:not(.skel)');
  check('bob now sees StickHub as editor', await card(b, 'StickHub').locator('.pill.editor').count() === 1);
  await a.locator('.hp-people li:has-text("bob") select').selectOption('viewer');
  await a.waitForTimeout(400);
  const m1 = (await api(ids.ta, `/api/projects/${ids.p3}/members`)).body;
  check('owner changes bob to viewer (server agrees)', m1.members.find((m) => m.login === 'bob')?.role === 'viewer');
  // email invite -> pending
  await a.locator('.hp-combo input').fill('erin@example.com'); await a.keyboard.press('Enter');
  await a.waitForSelector('.hp-people li.pending');
  check('email invite is pending, and says so', /first time they sign in/.test(await a.locator('.hp-invite .hp-note').textContent()));
  await a.locator('.hp-people li.pending select').selectOption('viewer');
  let m2; for (let i = 0; i < 20; i++) { m2 = (await api(ids.ta, `/api/projects/${ids.p3}/members`)).body; if (m2.pending[0]?.role === 'viewer') break; await a.waitForTimeout(150); }
  check('pending invite role can be changed', m2.pending[0]?.role === 'viewer');
  await a.locator('.hp-combo input').fill('bob'); await a.locator('.hp-combo input').press('Enter');
  check('inviting someone who already has access is explained', /already has access/.test(await a.locator('.hp-invite .hp-note').textContent()));
  await a.locator('.hp-combo input').fill('not a name!'); await a.locator('.hp-combo input').press('Enter');
  check('nonsense is rejected inline', /username or an email/.test(await a.locator('.hp-invite .hp-note').textContent()));
  await a.locator('.hp-combo input').fill('');
  await a.locator('.hp-people li.pending .hp-iconbtn').click(); await a.waitForSelector('.hp-people li.pending', { state: 'detached' });
  check('pending invite can be cancelled', await until(async () => (await api(ids.ta, `/api/projects/${ids.p3}/members`)).body.pending.length === 0));
  // links
  await a.click('button:has-text("Create and copy link")'); await a.waitForSelector('.hp-links li');
  const url = await a.locator('.hp-links input').inputValue();
  check('share link is created, listed and on the clipboard', /\/j\//.test(url) && (await a.evaluate(() => navigator.clipboard.readText())) === url, url);
  await a.screenshot({ path: `${out}/05-share-full.png` });
  // carol joins with it through the Join dialog
  const c = await open(ids.tc); await c.waitForSelector('.hp-empty');
  check('a new user sees the empty state with both ways in', await c.locator('.hp-empty button').count() === 2);
  await c.screenshot({ path: `${out}/06-empty-state.png` });
  await c.click('.hp-empty button:has-text("Join with link")'); await c.locator('.hp-modal input').fill(url); await c.click('.hp-modal-f .btn.primary');
  await c.waitForURL(/\/p\/.*\/edit/); check('carol joins by pasting the link and lands in the project', c.url().includes(ids.p3));
  await c.waitForTimeout(1500); await c.screenshot({ path: `${out}/07-carol-in-editor.png` });
  // the editor's own Share entry opens the same dialog, read-only for carol
  await c.evaluate(() => window.CollabApp.dispatch({ type: 'action', id: 'share' }));
  await c.waitForSelector('.hp-people li');
  check('in the editor, Share opens the dialog; a non-owner sees it read-only', await c.locator('.hp-combo').count() === 0 && await c.locator('.hp-people li').count() >= 3);
  await c.screenshot({ path: `${out}/08-editor-share-readonly.png` });
  await c.keyboard.press('Escape');
  await a.keyboard.press('Escape'); await menu(a, 'StickHub', 'Share'); await a.waitForSelector('.hp-people li:has-text("carol")');
  check('alice sees carol in the list after reopening', true);
  await a.locator('.hp-links li .hp-iconbtn[aria-label="Turn off link"]').click(); await a.click('.hp-modal-f .hp-danger');
  await a.waitForSelector('.hp-links li', { state: 'detached' });
  check('turned-off link no longer works', (await api(ids.tb, `/api/join/${url.split('/j/')[1]}`, { method: 'POST' })).status === 404);
  await a.locator('.hp-people li:has-text("carol") .hp-iconbtn').click(); await a.click('.hp-modal-f .hp-danger');
  await a.waitForSelector('.hp-people li:has-text("carol")', { state: 'detached' });
  check('removing a member takes their access away', (await api(ids.tc, `/api/projects/${ids.p3}`)).status === 403);
  await a.locator('select[aria-label="General access"]').selectOption('public'); check('general access toggles from the dialog', await toastText(a, /Listed in Explore/));
  await a.locator('select[aria-label="General access"]').selectOption('private'); await a.waitForTimeout(300);
  await a.keyboard.press('Escape'); await a.waitForSelector('.hp-modal', { state: 'detached' });
  check('people count on the card follows the dialog', (await card(a, 'StickHub').locator('.hp-chip').textContent()).trim() === '2', await card(a, 'StickHub').locator('.hp-chip').textContent());
  await c.context().close();
});

await step('non-owner', async () => {
  await card(b, 'StickHub').locator('.hp-iconbtn').click();
  const items = await b.locator('.hp-menu button').allTextContents();
  check('a member\'s menu has no owner actions', !items.some((t) => /Rename|Delete|Make p/.test(t)) && items.some((t) => /Leave/.test(t)), items.join(' | '));
  await b.locator('.hp-menu button', { hasText: 'Leave' }).click(); await b.screenshot({ path: `${out}/09-leave-confirm.png` }); await b.click('.hp-modal-f .hp-danger');
  await b.waitForSelector('.hp-item-name:has-text("StickHub")', { state: 'detached' });
  check('bob leaves and the project is gone from his list', (await api(ids.tb, `/api/projects/${ids.p3}`)).status === 403);
});

await step('link landing page joins on a click, not on the visit', async () => {
  const l = (await api(ids.ta, `/api/projects/${ids.p3}/links`, { method: 'POST', json: { role: 'viewer' } })).body;
  await b.goto(l.url); await b.waitForSelector('.choice.web');
  check('/j/ page: just visiting does not enrol anybody', (await api(ids.tb, `/api/projects/${ids.p3}`)).status === 403);
  await b.click('.choice.web'); await b.waitForURL(/\/edit/);
  check('/j/ page: "Open in the web editor" joins and opens the project', (await api(ids.tb, `/api/projects/${ids.p3}`)).body.role === 'viewer');
  // the owner pins bob to viewer; an editor link opened later must not raise him again
  const me = (await api(ids.tb, '/api/me')).body;
  await api(ids.ta, `/api/projects/${ids.p3}/members/${me.id ?? me.userId}`, { method: 'PATCH', json: { role: 'viewer' } });
  const ed = (await api(ids.ta, `/api/projects/${ids.p3}/links`, { method: 'POST', json: { role: 'editor' } })).body;
  const claim = await api(ids.tb, `/api/join/${ed.token}`, { method: 'POST' });
  check('a role the owner chose survives an editor link', claim.body.role === 'viewer' && (await api(ids.tb, `/api/projects/${ids.p3}`)).body.role === 'viewer', JSON.stringify(claim.body));
  const own = await api(ids.ta, `/api/join/${ed.token}`, { method: 'POST' });
  const mem = (await api(ids.ta, `/api/projects/${ids.p3}/members`)).body;
  check('the owner opening their own link does not become a member', own.status === 200 && !mem.members.some((m) => m.userId === mem.ownerId));
  await b.goto(BASE + '/'); await b.waitForSelector('.hp-item:not(.skel)');
});

await step('trash', async () => {
  await menu(a, 'Zipped microwave', 'Move to Trash');
  await a.waitForSelector('.hp-item-name:has-text("Zipped microwave")', { state: 'detached' });
  check('an unshared project goes to Trash at once, with Undo', await toastText(a, /Moved .* to Trash/));
  await a.screenshot({ path: `${out}/10-trash-toast.png` });
  await a.locator('.hp-toast button', { hasText: 'Undo' }).click(); await a.waitForSelector('.hp-item-name:has-text("Zipped microwave")');
  check('Undo brings it back', (await api(ids.ta, '/api/projects')).body.projects.some((x) => x.name === 'Zipped microwave'));
  await menu(a, 'Zipped microwave', 'Move to Trash'); await a.waitForSelector('.hp-item-name:has-text("Zipped microwave")', { state: 'detached' });
  // a shared project asks first
  await menu(a, 'StickHub', 'Move to Trash'); await a.waitForSelector('.hp-modal'); await a.screenshot({ path: `${out}/10b-trash-confirm.png` });
  check('a shared project asks before it is trashed, focus on Cancel', await a.evaluate(() => document.activeElement?.textContent === 'Cancel'));
  await a.click('.hp-modal-f .btn:has-text("Cancel")'); check('Cancel keeps the project', await card(a, 'StickHub').count() === 1);
  await a.locator('.hp-side-btn', { hasText: 'Trash' }).click(); await a.waitForSelector('.hp-trash-row');
  check('Trash has its own URL and lists the project', a.url().endsWith('/trash') && /Zipped microwave/.test(await a.locator('.hp-trash-row').first().textContent()));
  await a.screenshot({ path: `${out}/10c-trash.png` });
  const gone = (await api(ids.ta, '/api/trash')).body.projects[0];
  check('a trashed project is closed to everyone', (await api(ids.ta, `/api/projects/${gone.projectId}`)).status === 404 && (await api(ids.ta, `/api/projects/${gone.projectId}/archive`)).status === 404);
  await a.locator('.hp-trash-row button', { hasText: 'Restore' }).click(); await toastText(a, /Restored/);
  await a.locator('.hp-nav a', { hasText: 'Projects' }).click(); await a.waitForSelector('.hp-item-name:has-text("Zipped microwave")');
  check('Restore puts it back in Projects', true);
  await menu(a, 'Zipped microwave', 'Move to Trash'); await a.waitForSelector('.hp-item-name:has-text("Zipped microwave")', { state: 'detached' });
  await a.goto(BASE + '/trash'); await a.waitForSelector('.hp-trash-row');
  await a.locator('.hp-trash-row .hp-iconbtn').click(); await a.click('.hp-modal-f .hp-danger'); await a.waitForSelector('.hp-trash-row', { state: 'detached' });
  check('Delete forever empties it for good', (await api(ids.ta, '/api/trash')).body.projects.length === 0);
  check('only the owner can trash or restore', (await api(ids.tb, `/api/projects/${ids.p1}`, { method: 'DELETE' })).status >= 403 && (await api(ids.tb, `/api/projects/${ids.p1}/undelete`, { method: 'POST' })).status >= 403);
  await a.goto(BASE + '/'); await a.waitForSelector('.hp-item:not(.skel)');
});

await step('stars', async () => {
  const before = await names(a);
  const last = before[before.length - 1];
  await card(a, last).hover(); await card(a, last).locator('.hp-star').click();
  await a.waitForFunction((n) => document.querySelector('.hp-item:not(.skel) .hp-item-name')?.textContent === n, last);
  check('a starred project moves to the top', (await names(a))[0] === last);
  await a.click('.hp-seg button:has-text("Starred")'); check('"Starred" filter', (await names(a)).join() === last);
  await a.screenshot({ path: `${out}/16-starred.png` });
  await a.click('.hp-seg button:has-text("All")'); await a.reload(); await a.waitForSelector('.hp-item:not(.skel)');
  check('the star is saved', (await names(a))[0] === last && (await api(ids.ta, '/api/projects')).body.projects.find((x) => x.name === last).starred === true);
  check("stars are per person", !(await api(ids.tb, '/api/projects')).body.projects.some((x) => x.starred));
  await card(a, last).locator('.hp-star').click();
});

await step('blank project', async () => {
  await a.locator('.hp-head-acts .btn.primary').click(); await a.waitForSelector('.hp-modes');
  await a.locator('.hp-modes button', { hasText: 'Blank project' }).click(); await a.fill('.hp-modal input.hp-input', 'Fresh idea'); await a.screenshot({ path: `${out}/17-blank.png` });
  await a.click('.hp-modal-f .btn.primary'); await a.waitForURL(/\/edit/); await a.waitForTimeout(2500);
  const id = a.url().match(/\/p\/([0-9a-f-]+)/)[1];
  const info = (await api(ids.ta, `/api/projects/${id}`)).body;
  check('a blank project has a project file, a schematic and a board', info.name === 'Fresh idea' && ['kicad_pro', 'kicad_sch', 'kicad_pcb'].every((t) => info.docs.some((d) => d.docType === t)), info.docs.map((d) => d.path).join(', '));
  await a.screenshot({ path: `${out}/17b-blank-editor.png` });
  check('…and it opens in the editor without errors', errors.length === 0, errors.join(' | '));
  await a.goBack(); await a.waitForSelector('.hp-item-name:has-text("Fresh idea")'); check('…and is in the list on the way back', true);
});

await step('transfer ownership', async () => {
  await api(ids.ta, `/api/projects/${ids.p1}/invites`, { method: 'POST', json: { login: 'bob', role: 'editor' } });
  const p1 = (await api(ids.ta, '/api/projects')).body.projects.find((x) => x.projectId === ids.p1);
  await menu(a, p1.name, 'Share'); await a.waitForSelector('.hp-people li:has-text("bob")');
  await a.locator('.hp-people li:has-text("bob") select').selectOption('owner'); await a.waitForSelector('.hp-modal >> text=Transfer ownership'); await a.screenshot({ path: `${out}/18-transfer.png` });
  await a.locator('.hp-modal-f .btn', { hasText: 'Make owner' }).click(); await toastText(a, /now owns/);
  const after = (await api(ids.tb, `/api/projects/${ids.p1}/members`)).body;
  check('ownership moves to bob and alice stays as an editor', after.owner.login === 'bob' && after.members.some((m) => m.login === 'alice' && m.role === 'editor') && after.canManage === true);
  check('the old owner can no longer manage access', (await api(ids.ta, `/api/projects/${ids.p1}/links`, { method: 'POST', json: { role: 'viewer' } })).status === 403);
  await a.keyboard.press('Escape'); await a.waitForSelector('.hp-modal', { state: 'detached' });
  const me = (await api(ids.ta, '/api/me')).body;
  await api(ids.tb, `/api/projects/${ids.p1}/transfer`, { method: 'POST', json: { userId: me.id ?? me.userId } });   // hand it back for the rest of the run
  await a.click('.hp-head-title .hp-iconbtn'); await a.waitForTimeout(600);
});

await step('select several', async () => {
  await a.click('.hp-selbtn'); const n = await names(a);
  await card(a, n[0]).locator('.hp-item-link').click(); await card(a, n[2]).locator('.hp-item-link').click({ modifiers: ['Shift'] });
  check('Select mode: click picks, Shift-click picks the range', /3 selected/.test(await a.locator('.hp-bulk').textContent()) && !/\/edit/.test(a.url()));
  await a.screenshot({ path: `${out}/19-select.png` });
  await a.locator('.hp-bulk .btn', { hasText: 'Star' }).click(); await toastText(a, /Starred 3/);
  check('bulk star', (await api(ids.ta, '/api/projects')).body.projects.filter((x) => x.starred).length === 3);
  await a.locator('.hp-bulk .btn', { hasText: 'Remove stars' }).click(); await toastText(a, /Removed 3 stars/);
  await a.keyboard.press('Escape'); check('Escape leaves select mode', await a.locator('.hp-bulk').count() === 0);
  await a.click('.hp-selbtn'); await card(a, 'Fresh idea').locator('.hp-item-link').click();
  await a.locator('.hp-bulk .hp-danger').click(); await a.click('.hp-modal-f .hp-danger'); await a.waitForSelector('.hp-item-name:has-text("Fresh idea")', { state: 'detached' });
  check('bulk remove sends owned projects to Trash', (await api(ids.ta, '/api/trash')).body.projects.some((x) => x.name === 'Fresh idea'));
});

await step('dialogs and the keyboard', async () => {
  const p = (await names(a))[0];
  await menu(a, p, 'Share'); await a.waitForSelector('.hp-people li');
  const l = await a.locator('.hp-linknew .btn').first(); if (await a.locator('.hp-links li').count() === 0) { await l.click(); await a.waitForSelector('.hp-links li'); }
  await a.locator('.hp-links li button[aria-label="Turn off link"]').first().click(); await a.waitForFunction(() => document.querySelectorAll('.hp-modal').length === 2);
  await a.keyboard.press('Escape'); await a.waitForFunction(() => document.querySelectorAll('.hp-modal').length === 1);
  check('Escape closes only the confirm on top of the Share dialog', await a.locator('.hp-modal').count() === 1);
  await a.keyboard.press('Escape'); await a.waitForSelector('.hp-modal', { state: 'detached' });
  await card(a, p).locator('.hp-iconbtn').click(); await a.waitForSelector('.hp-menu');
  check('a menu takes keyboard focus on its first item', await a.evaluate(() => document.activeElement?.closest('.hp-menu') !== null));
  await a.keyboard.press('Escape');
  check('…and gives it back to the button that opened it', await a.evaluate(() => document.activeElement?.classList.contains('hp-iconbtn')));
});

await step('open + back', async () => {
  await card(a, 'ECC83 preamp').locator('.hp-item-link').click(); await a.waitForURL(/\/edit/); await a.waitForTimeout(800);
  await a.goBack(); await a.waitForSelector('.hp-item:not(.skel)');
  check('back from the editor shows the list at once (cached)', (await names(a)).length >= 4);
  await a.locator('.hp-nav a:has-text("Explore")').click(); check('Explore has its own URL', a.url().endsWith('/gallery'));
  await a.goBack(); check('browser back returns to Projects', await a.locator('.hp-head h1').textContent() === 'Projects');
});

await step('errors', async () => {
  await a.route('**/api/projects', (r) => r.abort());
  await a.click('.hp-head-title .hp-iconbtn'); await a.waitForSelector('.hp-error');
  check('a failed refresh keeps the list and says why', (await names(a)).length >= 4 && /reach the server/.test(await a.locator('.hp-error').textContent()));
  await a.screenshot({ path: `${out}/11-refresh-error.png` });
  await a.unroute('**/api/projects'); await a.click('.hp-error button'); await a.waitForSelector('.hp-error', { state: 'detached' }); check('Try again recovers', true);
});

// ---------------------------------------------------------------- slow, failing and out-of-order answers
/** Hold (and optionally fail) the requests of one method to a URL. */
const hold = (p, url, method, ms, status = 0) => p.route(url, async (r) => {
  if (r.request().method() !== method) return r.continue();
  await new Promise((x) => setTimeout(x, ms));
  return (status ? r.fulfill({ status, contentType: 'application/json', body: '{"error":"internal"}' }) : r.continue()).catch(() => {});   // the page may have moved on
});
const mine = async () => (await api(ids.ta, '/api/projects')).body.projects;
const idOf = async (name) => (await mine()).find((x) => x.name === name)?.projectId;

await step('loading state', async () => {
  await hold(a, '**/api/projects', 'GET', 1500);
  await a.reload(); await a.waitForSelector('.hp-item.skel');
  check('while the list loads there is no toolbar of zero counts', await a.locator('.hp-tools').count() === 0);
  await a.unroute('**/api/projects'); await a.waitForSelector('.hp-item:not(.skel)');
  check('…and it is there once the list is', await a.locator('.hp-tools .hp-seg button span').first().textContent() !== '0');
});

await step('a slow change is not undone', async () => {
  await hold(a, `**/api/projects/${ids.p3}`, 'PATCH', 3600);
  await menu(a, 'StickHub', 'Rename'); await a.locator('.hp-rename').fill('StickHub 2'); await a.locator('.hp-rename').press('Enter');
  await a.waitForTimeout(3100);
  check('a rename still on its way is not put back by a list reload', await card(a, 'StickHub 2').count() === 1 && await card(a, 'StickHub').count() === 0, (await names(a)).join(', '));
  check('…the toast comes when the server has it', await toastText(a, /Renamed/));
  await a.waitForTimeout(900);   // the look that follows the answer
  check('…and the card keeps the new name afterwards', await card(a, 'StickHub 2').count() === 1 && (await mine()).some((x) => x.name === 'StickHub 2'));
  await a.unroute(`**/api/projects/${ids.p3}`);
  // a star whose request is slow
  await hold(a, `**/api/projects/${ids.p2}/star`, 'PUT', 3200);
  await card(a, 'ECC83 preamp').hover(); await card(a, 'ECC83 preamp').locator('.hp-star').click();
  await a.waitForTimeout(2900);
  check('a slow star stays on', await card(a, 'ECC83 preamp').locator('.hp-star').getAttribute('aria-pressed') === 'true');
  await until(async () => (await mine()).find((x) => x.projectId === ids.p2).starred === true); await a.waitForTimeout(700);
  check('…and is still on after the server answered', await card(a, 'ECC83 preamp').locator('.hp-star').getAttribute('aria-pressed') === 'true');
  await a.unroute(`**/api/projects/${ids.p2}/star`);
  await card(a, 'ECC83 preamp').locator('.hp-star').click(); await until(async () => !(await mine()).find((x) => x.projectId === ids.p2).starred);
});

await step('a failed Move to Trash brings back only that project', async () => {
  const hid = await idOf('Hierarchy v2');
  await hold(a, `**/api/projects/${hid}`, 'DELETE', 1500, 500);
  await menu(a, 'Hierarchy v2', 'Move to Trash'); await a.waitForSelector('.hp-item-name:has-text("Hierarchy v2")', { state: 'detached' });
  await menu(a, 'ECC83 preamp', 'Rename'); await a.locator('.hp-rename').fill('ECC83 v2'); await a.locator('.hp-rename').press('Enter');
  check('the failure is reported', await toastText(a, /server had a problem/));
  const n = await names(a);
  check('…the project is back, and a rename made meanwhile stays', n.includes('Hierarchy v2') && n.includes('ECC83 v2') && !n.includes('ECC83 preamp'), n.join(', '));
  await a.unroute(`**/api/projects/${hid}`);
  await a.waitForTimeout(800);
});

await step('Undo after moving to another page', async () => {
  await menu(a, 'Hierarchy v2', 'Move to Trash'); await toastText(a, /Moved .Hierarchy v2. to Trash/);
  await a.click('.hp-nav a:has-text("Explore")'); await a.waitForSelector('.hp-head h1:has-text("Explore")');
  await a.click('.hp-nav a:has-text("Projects")'); await a.waitForSelector('.hp-item:not(.skel)');
  await a.locator('.hp-toast button', { hasText: 'Undo' }).click();
  let ok = true; try { await a.waitForSelector('.hp-item-name:has-text("Hierarchy v2")', { timeout: 4000 }); } catch { ok = false; }
  check('Undo pressed after leaving and coming back shows the project again', ok, (await names(a)).join(', '));
  await menu(a, 'Hierarchy v2', 'Move to Trash'); await toastText(a, /Moved .Hierarchy v2. to Trash/);
  await a.locator('.hp-side-btn', { hasText: 'Trash' }).click(); await a.waitForSelector('.hp-trash-row:has-text("Hierarchy v2")');
  await a.locator('.hp-toast button', { hasText: 'Undo' }).click();
  ok = true; try { await a.waitForSelector('.hp-trash-row:has-text("Hierarchy v2")', { state: 'detached', timeout: 4000 }); } catch { ok = false; }
  check('Undo pressed on the Trash page takes the project off that page', ok && (await mine()).some((x) => x.name === 'Hierarchy v2'));
  await a.locator('.hp-nav a', { hasText: 'Projects' }).click(); await a.waitForSelector('.hp-item-name:has-text("Hierarchy v2")');
});

await step('selection covers only what is shown', async () => {
  await a.click('.hp-selbtn');
  await card(a, 'ECC83 v2').locator('.hp-item-link').click(); await card(a, 'StickHub 2').locator('.hp-item-link').click();
  check('two picked', /2 selected/.test(await a.locator('.hp-bulk').textContent()));
  await a.locator('.hp-search input').fill('pic'); await settle(a);
  check('a search that hides the picked projects leaves nothing selected to act on', /0 selected/.test(await a.locator('.hp-bulk').textContent())
    && await a.locator('.hp-bulk .hp-danger').isDisabled() && await a.locator('.hp-bulk .btn', { hasText: 'Select all' }).isEnabled(), await a.locator('.hp-bulk').textContent());
  await a.locator('.hp-search input').fill(''); await settle(a);
  check('…and they are selected again when they are back', /2 selected/.test(await a.locator('.hp-bulk').textContent()));
  // Delete acts on the selection, not on the card that has the focus
  const before = (await names(a)).length;
  await card(a, 'PIC programmer').locator('.hp-item-link').focus(); await a.keyboard.press('Delete');
  await a.waitForSelector('.hp-modal');
  check('Delete while selecting asks about the selection', /Remove projects/.test(await a.locator('.hp-modal-h').textContent()) && /2 projects/.test(await a.locator('.hp-modal-b').textContent()), await a.locator('.hp-modal-b').textContent());
  await a.click('.hp-modal-f .btn:has-text("Cancel")'); await a.waitForSelector('.hp-modal', { state: 'detached' });
  check('…and the focused card is not trashed', (await names(a)).length === before && (await mine()).some((x) => x.name === 'PIC programmer'));
  // several archives: downloads, not pop-ups
  const got = []; const pages = []; const onDl = (d) => got.push(d.suggestedFilename()); const onPage = (pg) => pages.push(pg);
  a.on('download', onDl); a.context().on('page', onPage);
  await a.locator('.hp-bulk .btn', { hasText: 'Download' }).click();
  await until(async () => got.length === 2, 6000); await a.waitForTimeout(500);
  check('bulk Download fetches every selected archive without opening windows', got.length === 2 && pages.length === 0, `${got.join(', ')} / ${pages.length} windows`);
  a.off('download', onDl); a.context().off('page', onPage);
  await a.keyboard.press('Escape');
  check('nothing picked: Delete does nothing', await (async () => { await a.click('.hp-selbtn'); await card(a, 'PIC programmer').locator('.hp-item-link').focus(); await a.keyboard.press('Delete'); await a.waitForTimeout(300); const r = await a.locator('.hp-modal').count() === 0 && (await names(a)).length === before; await a.keyboard.press('Escape'); return r; })());
});

await step('menu placement', async () => {
  const n = await names(a); const last = n[n.length - 1];
  const btn = card(a, last).locator('.hp-item-acts .hp-iconbtn'); await btn.click(); await a.waitForSelector('.hp-menu'); await a.waitForTimeout(200);
  const bb = await btn.boundingBox(), mb = await a.locator('.hp-menu').boundingBox();
  check('a menu with no room below opens above its button, not over it', mb.y + mb.height <= bb.y + 1 || mb.y >= bb.y + bb.height, JSON.stringify({ bb, mb }));
  await a.locator('.hp-menu button', { hasText: 'Copy link' }).hover();
  const lit = await a.evaluate(() => { const blue = getComputedStyle(document.activeElement).backgroundColor; return [...document.querySelectorAll('.hp-menu button')].filter((b) => getComputedStyle(b).backgroundColor === blue).map((b) => b.textContent); });
  check('only one menu item is highlighted', lit.length === 1 && lit[0] === 'Copy link', lit.join(' | '));
  await a.screenshot({ path: `${out}/20-menu-above.png` });
  await a.keyboard.press('Escape');
});

await step('share dialog: answers out of order, files dropped on it', async () => {
  await menu(a, 'StickHub 2', 'Share'); await a.waitForSelector('.hp-people li:has-text("bob")');
  const before = await a.locator('.hp-people li:has-text("bob") select').inputValue();
  const next = before === 'viewer' ? 'editor' : 'viewer';
  let held = 0;
  await a.route(`**/api/projects/${ids.p3}/members`, async (r) => { if (r.request().method() !== 'GET' || held++) return r.continue(); const resp = await r.fetch(); await new Promise((x) => setTimeout(x, 1500)); return r.fulfill({ response: resp }).catch(() => {}); });
  const asked = a.waitForRequest((q) => q.method() === 'GET' && q.url().endsWith(`/api/projects/${ids.p3}/members`));
  await a.locator('.hp-combo input').fill('frank@example.com'); await a.keyboard.press('Enter'); await asked; await a.waitForTimeout(150);
  await a.locator('.hp-people li:has-text("bob") select').selectOption(next);
  await a.waitForTimeout(2200);
  const srv = (await api(ids.ta, `/api/projects/${ids.p3}/members`)).body.members.find((m) => m.login === 'bob')?.role;
  check('a member list fetched before a role change does not put the old role back', await a.locator('.hp-people li:has-text("bob") select').inputValue() === next && srv === next, `shown ${await a.locator('.hp-people li:has-text("bob") select').inputValue()}, server ${srv}`);
  await a.unroute(`**/api/projects/${ids.p3}/members`);
  const dragOver = (sel) => a.evaluate((s) => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'a.txt')); const ev = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }); document.querySelector(s).dispatchEvent(ev); return ev.defaultPrevented; }, sel);
  check('a file dragged over the Share dialog or its backdrop is not left to the browser', await dragOver('.hp-scrim') && await dragOver('.hp-modal'));
  await a.keyboard.press('Escape'); await a.waitForSelector('.hp-modal', { state: 'detached' });
  await a.click('.hp-head-acts .btn:has-text("Join with link")'); await a.waitForSelector('.hp-modal');
  check('…nor over the Join dialog', await dragOver('.hp-scrim'));
  await a.keyboard.press('Escape'); await a.waitForSelector('.hp-modal', { state: 'detached' });
  check('…and over the bare page it still offers an upload', await dragOver('.hp-page'));
});

await step('blank thumbnail + empty trash that fails part-way', async () => {
  const mk = async (name) => (await api(ids.ta, '/api/projects/blank', { method: 'POST', json: { name } })).body.projectId;
  const s1 = await mk('Scratch one'), s2 = await mk('Scratch two');
  await a.click('.hp-head-title .hp-iconbtn'); await a.waitForSelector('.hp-item-name:has-text("Scratch one")');
  const none = await until(() => card(a, 'Scratch one').locator('.hp-thumb.none svg').count().then((c) => c === 1), 10000);
  check('a blank project shows the placeholder, not a picture of nothing', none, await card(a, 'Scratch one').locator('.hp-thumb').getAttribute('class'));
  await a.screenshot({ path: `${out}/21-blank-thumb.png` });
  await api(ids.ta, `/api/projects/${s1}`, { method: 'DELETE' }); await api(ids.ta, `/api/projects/${s2}`, { method: 'DELETE' });
  await a.goto(BASE + '/trash'); await a.waitForSelector('.hp-trash-row');
  const total = await a.locator('.hp-trash-row').count();
  await a.route(`**/api/projects/${s2}?permanent=true`, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal"}' }));
  await a.click('.hp-head-acts .btn:has-text("Empty Trash")'); await a.click('.hp-modal-f .hp-danger');
  check('Empty Trash that fails for one says how many are left', await toastText(a, new RegExp(`1 of ${total} could not be deleted`)));
  await a.waitForSelector('.hp-modal', { state: 'detached' }); await a.waitForTimeout(500);
  const left = await a.locator('.hp-trash-row .hp-item-name').allTextContents();
  check('…and lists only what is really still in Trash', left.join() === 'Scratch two' && (await api(ids.ta, '/api/trash')).body.projects.length === 1, left.join(', '));
  await a.unroute(`**/api/projects/${s2}?permanent=true`);
  await a.click('.hp-head-acts .btn:has-text("Empty Trash")'); await a.click('.hp-modal-f .hp-danger'); await a.waitForSelector('.hp-trash-row', { state: 'detached' });
  await a.goto(BASE + '/'); await a.waitForSelector('.hp-item:not(.skel)');
});

await step('session expiry', async () => {
  const x = await open(ids.ta); await x.waitForSelector('.hp-item:not(.skel)');
  await x.context().clearCookies();
  // A request still in flight (a thumbnail, the settle reload) may notice first and take the
  // page to the signed-out view before the click: then there is no Refresh left to press.
  await x.click('.hp-head-title .hp-iconbtn', { timeout: 1500 }).catch(() => {});
  let ok = true; try { await x.waitForSelector('.hp-welcome', { timeout: 5000 }); } catch { ok = false; }
  check('when the session is gone the page falls back to the signed-out home', ok && await x.locator('.hp-account').count() === 0);
  const hrefs = await x.locator('a[href^="/auth/github/login?next="]').evaluateAll((l) => l.map((e) => e.getAttribute('href')));
  check('…with a way to sign in again', hrefs.length >= 1 && await toastText(x, /signed out/), hrefs.join(' '));
  await x.screenshot({ path: `${out}/22-signed-out.png` });
  await x.context().close();
});

await step('phone', async () => {
  const m = await open(ids.ta, { ...devices['iPhone 13'] }); await m.waitForSelector('.hp-item:not(.skel)');
  check('phone: no sideways scrolling', await m.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), await m.evaluate(() => document.documentElement.scrollWidth + ' vs ' + innerWidth));
  check('phone: tab bar reaches Projects, Explore, New, Join', await m.locator('.hp-tabbar > *').count() === 4);
  await m.waitForTimeout(3000); await m.screenshot({ path: `${out}/12-phone-list.png` });
  await card(m, 'PIC programmer').locator('.hp-iconbtn').tap(); await m.waitForSelector('.hp-menu'); await m.waitForTimeout(350);
  const box = await m.locator('.hp-menu').boundingBox(); const vh = m.viewportSize().height;
  check('phone: actions open as a bottom sheet inside the screen', Math.abs(box.y + box.height - vh) < 2 && box.y >= 0, JSON.stringify(box));
  await m.screenshot({ path: `${out}/13-phone-sheet.png` });
  await m.locator('.hp-menu button', { hasText: 'Share' }).tap(); await m.waitForSelector('.hp-people li'); await m.waitForTimeout(300);
  await m.locator('.hp-combo input').fill('car'); await m.waitForSelector('.hp-suggest li'); await m.screenshot({ path: `${out}/14-phone-share.png` });
  await m.locator('.hp-suggest li').first().tap(); await m.waitForSelector('.hp-people li:has-text("carol")');
  check('phone: invite from the typeahead works by touch', true);
  await m.locator('.hp-x').tap();
  await m.locator('.hp-tabbar a >> nth=1').tap(); await m.waitForSelector('.hp-item:not(.skel)'); check('phone: Explore tab', await m.locator('.hp-head h1').textContent() === 'Explore');
  await m.locator('.hp-topbar .hp-account').tap(); await m.locator('.hp-menu button', { hasText: 'Log out' }).tap();
  // Signed out, "/" is the public home page (web/landing), not this app.
  await m.waitForFunction(() => !document.querySelector('.hp-account') && document.readyState === 'complete' && /KiCad Collaborative/.test(document.title));
  check('sign out returns to the public home page', (await m.evaluate(() => fetch('/api/me').then((r) => r.status))) === 401);
  await m.screenshot({ path: `${out}/15-phone-signed-out.png` });
  await m.context().close();
});

await browser.close();
await cleanup(); await db.end();
check('no page errors in any browser', errors.length === 0, errors.slice(0, 5).join(' ;; '));
console.log(`\n${pass} passed, ${fail} failed${fail ? ': ' + fails.join('; ') : ''}`);
process.exit(fail ? 1 : 0);
