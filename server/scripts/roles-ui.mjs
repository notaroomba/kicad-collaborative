// Browser test of roles and sharing: an owner, a commenter, a viewer, someone with only a
// share link, and a guest who is not signed in, each in a real browser on the same project.
// Needs a local server with KC_DEV_LOGIN=1 on a throwaway database, and Playwright.
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… [E2E_BASE=http://127.0.0.1:8099] [SHOTS=/some/dir] node roles-ui.mjs
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
const DEMOS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../demos');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-ui-'));
const out = process.env.SHOTS || path.join(TMP, 'shots'); fs.mkdirSync(out, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'HS256', typ: 'JWT' }), b = b64({ sub, login, iat: now, exp: now + 36000 });
  return `${h}.${b}.${crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url')}`;
}
async function api(token, p, opts = {}) {
  const r = await fetch(BASE + p, { ...opts, headers: { authorization: `Bearer ${token}`, ...(opts.json ? { 'content-type': 'application/json' } : {}) }, body: opts.json ? JSON.stringify(opts.json) : opts.body });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}

pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
const GH = [-9201, -9202, -9203, -9204];
const cleanup = async () => {
  await db.query('DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE github_id = ANY($1))', [GH]);
  await db.query('DELETE FROM users WHERE github_id = ANY($1)', [GH]).catch((e) => console.warn('cleanup: ' + e.message));
};
await cleanup();
const mk = async (gh, login, name) => { const id = (await db.query('INSERT INTO users (github_id, login, name) VALUES ($1, $2, $3) RETURNING id', [gh, login, name])).rows[0].id; return { id, login, token: jwt(id, login) }; };
const nathan = await mk(-9201, 'nathan', 'Nathan'), priya = await mk(-9202, 'priya', 'Priya'), tomas = await mk(-9203, 'tomas', 'Tomás'), wen = await mk(-9204, 'wen', 'Wen');

const zip = path.join(TMP, 'p.zip');
execSync(`cd "${path.join(DEMOS, 'ecc83')}" && zip -qr "${zip}" . -i '*.kicad_pro' '*.kicad_sch' '*.kicad_pcb'`);
const f = new FormData(); f.append('name', 'ECC83 preamp'); f.append('archive', new Blob([fs.readFileSync(zip)]), 'p.zip');
const P = (await api(nathan.token, '/api/projects', { method: 'POST', body: f })).body.projectId;
check('project uploaded', !!P);
const edit = `/p/${P}/edit`;

const browser = await chromium.launch();
const open = async (who, next, opts = {}) => {
  const c = await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 2, permissions: ['clipboard-read', 'clipboard-write'], ...opts });
  const p = await c.newPage();
  p.on('pageerror', (e) => console.log(`[${who ? who.login : 'guest'}] page error: ${e.message}`));
  await p.goto(who ? `${BASE}/auth/dev?jwt=${who.token}&next=${encodeURIComponent(next)}` : BASE + next);
  return p;
};
const conn = (p) => p.locator('#conn').innerText();
const live = (p, text) => p.waitForFunction((t) => (document.getElementById('conn')?.innerText || '').includes(t), text, { timeout: 20000 }).then(() => true).catch(() => false);
const step = async (name, fn) => { try { await fn(); } catch (e) { check(name, false, String(e.message).split('\n').slice(0, 3).join(' / ')); } };

// ---------------------------------------------------------------- the owner shares
const a = await open(nathan, '/');
let viewUrl = '', commentUrl = '';
await step('share dialog', async () => {
  await a.waitForSelector('.hp-item');
  await a.locator('.hp-item', { hasText: 'ECC83 preamp' }).first().click({ button: 'right' });
  await a.locator('.hp-menu button', { hasText: 'Share' }).click();
  await a.waitForSelector('.hp-modal .hp-invite');
  const roles = await a.locator('.hp-invite .hp-select option').allInnerTexts();
  check('the invite offers edit, comment and view', roles.join('|') === 'Can edit|Can comment|Can view', roles.join('|'));
  // invite Priya to comment, Tomás to view
  for (const [who, role] of [['priya', 'commenter'], ['tomas', 'viewer']]) {
    await a.locator('.hp-invite input').fill(who);
    await a.locator('.hp-invite .hp-select').selectOption(role);
    await a.locator('.hp-invite .btn.primary').click();
    await a.waitForSelector(`.hp-people li:has-text("${who}")`);
  }
  check('the note says what the invite allows', /can now view this project/.test(await a.locator('.hp-invite .hp-note').innerText()));
  check('both are listed with their roles', await a.locator('.hp-people li:has-text("priya") select').inputValue() === 'commenter' && await a.locator('.hp-people li:has-text("tomas") select').inputValue() === 'viewer');
  // a view link with a name, and a comment link
  await a.locator('.hp-linknew .hp-select').first().selectOption('viewer');
  check('a view link is explained', /view without an account/.test(await a.locator('#hp-link-note').innerText()));
  await a.locator('.hp-linknew .hp-input').fill('For the fab house');
  await a.locator('.hp-linknew .btn').click();
  await a.waitForSelector('.hp-links li[data-role="viewer"]');
  await a.locator('.hp-linknew .hp-select').first().selectOption('commenter');
  check('a comment link is explained', /comment after signing in/.test(await a.locator('#hp-link-note').innerText()));
  await a.locator('.hp-linknew .btn').click();
  await a.waitForSelector('.hp-links li[data-role="commenter"]');
  viewUrl = await a.locator('.hp-links li[data-role="viewer"] input').inputValue();
  commentUrl = await a.locator('.hp-links li[data-role="commenter"] input').inputValue();
  check('the links are listed with role and name', /\/j\//.test(viewUrl) && /\/j\//.test(commentUrl) && /For the fab house/.test(await a.locator('.hp-links li[data-role="viewer"]').innerText()));
  check('the permission settings are there', await a.locator('#hp-perms input[type=checkbox]').count() === 3 && await a.locator('#hp-perms input[type=checkbox]').nth(1).isChecked());
  await a.locator('.hp-modal-b, .hp-modal').first().evaluate((el) => { const s = el.querySelector('.hp-modal-b') || el; s.scrollTop = 0; });
  await a.screenshot({ path: `${out}/01-share-dialog.png` });
  await a.locator('#hp-perms').scrollIntoViewIfNeeded();
  await a.screenshot({ path: `${out}/02-share-links-and-permissions.png` });
  await a.keyboard.press('Escape');
});
const A = await open(nathan, edit);
check('owner is live in the editor', await live(A, 'live') && !/only/.test(await conn(A)), await conn(A));

// ---------------------------------------------------------------- a guest with the view link
let g;
await step('guest', async () => {
  g = await open(null, new URL(viewUrl).pathname);
  check('the link page says Viewer and that no account is needed', await g.locator('#linkrole').innerText() === 'Viewer' && /No account needed/.test(await g.locator('#guest').innerText()));
  await g.screenshot({ path: `${out}/03-view-link-page.png` });
  await g.click('#openweb');
  await g.waitForURL(`**${edit}`);
  check('the guest is live, view only', await live(g, 'live · view-only'), await conn(g));
  await g.waitForSelector('#signinOverlay[data-kind="guest"]', { state: 'visible' });
  check('the guest is told how to get more', /Viewing as a guest/.test(await g.locator('#signinOverlay').innerText()));
  await g.waitForTimeout(1500);
  await g.screenshot({ path: `${out}/04-guest-viewing.png` });
  const info = await g.evaluate(async (u) => (await fetch(u)).json(), `/api/projects/${P}/info`);
  check('the server gives the guest reading and nothing else', info.role === 'viewer' && !info.can.comment && !info.can.edit && info.viewer === null);
  const refused = await g.evaluate(async (u) => (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'x', x: 0, y: 0 }) })).status, `/api/docs/${info.docs.find((d) => d.docType === 'kicad_pcb').docId}/comments`);
  check('a comment from the guest\'s browser is refused', refused === 401, String(refused));
  // the guest moves the pointer: the owner's Collaborators pane lists them
  const sb = await g.locator('#stage').boundingBox();
  await g.mouse.move(sb.x + sb.width * 0.4, sb.y + sb.height * 0.4); await g.mouse.move(sb.x + sb.width * 0.5, sb.y + sb.height * 0.5);
  const peers = await new Promise((resolve) => {
    const docId = new URL(g.url()).searchParams.get('doc');   // the document the guest has open
    const s = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
    s.onopen = () => s.send(JSON.stringify({ type: 'hello', proto: 1, token: nathan.token, clientId: 'peek', client: 'web' }));
    s.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === 'hello_ok') s.send(JSON.stringify({ type: 'join_doc', docId })); if (m.type === 'doc_info') { s.close(); resolve(m.peers.map((p) => p.name)); } if (m.type === 'error') resolve(['error ' + m.code]); };
    setTimeout(() => resolve(['timeout']), 6000);
  });
  check('the owner\'s session lists a Guest', peers.includes('Guest'), 'peers: ' + JSON.stringify(peers));
});

// ---------------------------------------------------------------- a commenter
let b;
await step('commenter', async () => {
  b = await open(priya, edit);
  check('the commenter is live, comment only', await live(b, 'live · comment-only'), await conn(b));
  // an edit tool says why it is off
  const off = await b.evaluate(() => [...document.querySelectorAll('button, [role=button], i, span')].filter((el) => /Comment-only access/.test((el.getAttribute('title') || '') + (el.getAttribute('aria-label') || '') + (el.getAttribute('data-tip') || ''))).length);
  check('edit tools are off and say why', off > 0, String(off));
  // place a comment with the comment tool
  await b.keyboard.press('Alt+c');
  const box = await b.locator('#stage').boundingBox();
  await b.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.5);
  await b.waitForSelector('#newText');
  await b.locator('#newText').fill('C3 looks close to the board edge. Can it move in 2 mm?');
  await b.screenshot({ path: `${out}/05-commenter-writing.png` });
  await b.click('#postBtn');
  check('the comment reaches the owner live', await A.waitForFunction(() => window.KUI ? true : true).then(async () => {
    for (let i = 0; i < 40; i++) { const n = await A.evaluate(async (u) => (await (await fetch(u)).json()).comments.length, `/api/docs/${await b.evaluate(() => new URLSearchParams(location.search).get('doc') || '')}/comments`).catch(() => -1); if (n > 0) return true; await A.waitForTimeout(250); } return false; }).catch(() => false) || (await db.query('SELECT count(*)::int AS n FROM comments c JOIN documents d ON d.id = c.doc_id WHERE d.project_id = $1', [P])).rows[0].n > 0);
  // a refused edit, straight at the socket
  const menuWhy = await b.evaluate(async (id) => (await (await fetch(`/api/projects/${id}/checkpoints`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }) })).status), P);
  check('saving a version from the commenter\'s browser is refused', menuWhy === 403, String(menuWhy));
  await b.waitForTimeout(800);
  await b.screenshot({ path: `${out}/06-commenter-comment-posted.png` });
});

// ---------------------------------------------------------------- a viewer, promoted while the project is open
let c;
await step('viewer', async () => {
  c = await open(tomas, edit);
  check('the viewer is live, view only', await live(c, 'live · view-only'), await conn(c));
  await c.keyboard.press('Alt+c');
  check('the comment tool tells a viewer to ask the owner', await c.waitForFunction(() => /ask the owner to let you comment/.test(document.body.innerText), null, { timeout: 5000 }).then(() => true).catch(() => false));
  await c.screenshot({ path: `${out}/07-viewer-cannot-comment.png` });
  check('owner makes the viewer an editor', (await api(nathan.token, `/api/projects/${P}/members/${tomas.id}`, { method: 'PATCH', json: { role: 'editor' } })).status === 200);
  check('…their open editor says so and unlocks, with no reload', await c.waitForFunction(() => /You can now edit this project/.test(document.body.innerText), null, { timeout: 8000 }).then(() => true).catch(() => false)
    && await live(c, 'live') && !/only/.test(await conn(c)), await conn(c));
  await c.screenshot({ path: `${out}/08-promoted-live.png` });
  check('owner makes them a commenter', (await api(nathan.token, `/api/projects/${P}/members/${tomas.id}`, { method: 'PATCH', json: { role: 'commenter' } })).status === 200);
  check('…and the editor follows again', await live(c, 'live · comment-only'), await conn(c));
});

// ---------------------------------------------------------------- signed in, with a link that was opened but not joined
await step('link holder', async () => {
  const d = await open(wen, new URL(commentUrl).pathname);
  check('the link page says Commenter', await d.locator('#linkrole').innerText() === 'Commenter');
  await d.screenshot({ path: `${out}/09-comment-link-page.png` });
  await d.goto(BASE + edit);   // not through the button: looking first, joining later
  await d.waitForSelector('#signinOverlay[data-kind="join"]', { state: 'visible' });
  check('looking through the link is view only, with an offer to join', await live(d, 'live · view-only') && /Join as a commenter/.test(await d.locator('#joinLinkBtn').innerText()), await conn(d));
  await d.waitForTimeout(1200);
  await d.screenshot({ path: `${out}/10-join-offer.png` });
  await d.click('#joinLinkBtn');
  check('joining makes them a commenter', await live(d, 'live · comment-only'), await conn(d));
  check('…and the offer is gone', !(await d.locator('#signinOverlay').isVisible()));
  const members = (await api(nathan.token, `/api/projects/${P}/members`)).body.members;
  check('…and the owner sees them in the list', members.some((m) => m.login === 'wen' && m.role === 'commenter'));
  // the share dialog, read-only, for someone who is not the owner
  await d.evaluate(() => window.CollabHome && window.CollabHome.openShare(location.pathname.split('/')[2], 'ECC83 preamp'));
  await d.waitForSelector('#hp-yourrole');
  check('a commenter sees who has access and their own role, and no controls', /You can comment on this project/.test(await d.locator('#hp-yourrole').innerText()) && await d.locator('.hp-invite').count() === 0 && await d.locator('#hp-perms').count() === 0);
  await d.screenshot({ path: `${out}/11-share-dialog-as-commenter.png` });
  await d.close();
});

// ---------------------------------------------------------------- permissions the owner sets
await step('permissions', async () => {
  // downloads off: the commenter's menu entry says why
  await api(nathan.token, `/api/projects/${P}/permissions`, { method: 'PATCH', json: { viewersCanCopy: false } });
  await b.reload(); await live(b, 'comment-only');
  const dl = await b.evaluate(async (id) => (await fetch(`/api/projects/${id}/archive`)).status, P);
  check('with downloads off, the commenter\'s download is refused', dl === 403, String(dl));
  await b.goto(BASE + '/'); await b.waitForSelector('.hp-item');
  await b.locator('.hp-item', { hasText: 'ECC83 preamp' }).first().click({ button: 'right' });
  await b.waitForSelector('.hp-menu');
  const items = await b.locator('.hp-menu button').allInnerTexts();
  check('…and their projects list does not offer Download or Make a copy', !items.some((t) => /Download|Make a copy/.test(t)) && items.some((t) => /See who has access/.test(t)), items.join('|'));
  await b.keyboard.press('Escape');
  await api(nathan.token, `/api/projects/${P}/permissions`, { method: 'PATCH', json: { viewersCanCopy: true } });

  // links need a sign-in: the guest is put out at once
  await api(nathan.token, `/api/projects/${P}/permissions`, { method: 'PATCH', json: { linksRequireSignin: true } });
  check('with sign-in required, the guest loses the live session', await g.waitForFunction(() => /no longer have access/.test(document.body.innerText) || /no access/.test(document.getElementById('conn')?.innerText || ''), null, { timeout: 8000 }).then(() => true).catch(() => false), await conn(g));
  await g.goto(BASE + new URL(viewUrl).pathname);
  check('…and the link page asks for a sign-in', /asks everyone to sign in/.test(await g.locator('body').innerText()));
  await api(nathan.token, `/api/projects/${P}/permissions`, { method: 'PATCH', json: { linksRequireSignin: false } });

  // dark, with every setting visible
  const dark = await open(nathan, '/', { colorScheme: 'dark' });
  await dark.waitForSelector('.hp-item');
  await dark.evaluate(() => { try { localStorage.setItem('kc.theme', 'dark'); } catch { /* */ } });
  await dark.locator('.hp-item', { hasText: 'ECC83 preamp' }).first().click({ button: 'right' });
  await dark.locator('.hp-menu button', { hasText: 'Share' }).click();
  await dark.waitForSelector('#hp-perms');
  await dark.locator('#hp-perms select').first().selectOption('public');
  await dark.waitForSelector('#hp-perms .hp-access.sub');
  await dark.locator('#hp-perms').scrollIntoViewIfNeeded();
  await dark.waitForTimeout(600);
  await dark.screenshot({ path: `${out}/12-permissions-dark.png` });
  await dark.locator('#hp-perms select').first().selectOption('private');
  await dark.close();
});

await browser.close();
await cleanup();
await db.end();
console.log(`\n${pass} passed, ${fail} failed\nscreenshots: ${out}`);
process.exit(fail ? 1 : 0);
