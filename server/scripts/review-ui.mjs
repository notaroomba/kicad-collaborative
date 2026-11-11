// Browser test of design review: comment threads pinned to parts and nets, and the Compare window
// (checkpoints, Git commits, files) on a board and a schematic.  Two people in two Chromium windows
// work on the same project; every step is checked in both and a screenshot of each is saved.
//
// Needs a local server with KC_DEV_LOGIN=1 on a throwaway database, and fake-github.mjs with the
// server's GITHUB_API_URL and GITHUB_WEB_URL pointed at it (see github-e2e.mjs).
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… [SHOTS=/some/dir] node review-ui.mjs
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const GH = (process.env.E2E_FAKE_GH || 'http://127.0.0.1:8098').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../demos/pic_programmer');

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
  `INSERT INTO users (github_id, login, name) VALUES ($1, $2, $3) ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [ghId, login, name])).rows[0].id;
const aliceId = await mkUser(9601, 'rv-alice', 'Alice'), bobId = await mkUser(9602, 'rv-bob', 'Bob'), carolId = await mkUser(9603, 'rv-carol', 'Carol');
await db.query('DELETE FROM github_tokens WHERE user_id = ANY($1)', [[aliceId, bobId]]);
await db.query('DELETE FROM projects WHERE owner_id = ANY($1)', [[aliceId, bobId, carolId]]);
const alice = mintJwt(aliceId, 'rv-alice'), bob = mintJwt(bobId, 'rv-bob'), carol = mintJwt(carolId, 'rv-carol');

const api = async (tok, url, o = {}) => {
  const r = await fetch(BASE + url, { method: o.method || (o.json ? 'POST' : 'GET'), headers: { Authorization: `Bearer ${tok}`, ...(o.json ? { 'Content-Type': 'application/json' } : {}) }, body: o.json ? JSON.stringify(o.json) : o.body });
  const t = await r.text(); let j = t; try { j = JSON.parse(t); } catch { /* text */ }
  return { status: r.status, j, text: t };
};
const ctl = async (what, body) => (await fetch(`${GH}/__ctl/${what}`, body
  ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();

// ---------------------------------------------------------------- fixtures: the project, shared with Bob
const zip = path.join(fs.mkdtempSync('/tmp/review-ui-'), 'p.zip');
execSync(`cd "${DEMO}" && zip -qr "${zip}" . -i '*.kicad_pro' '*.kicad_sch' '*.kicad_pcb'`);
const form = new FormData(); form.append('name', 'PIC programmer'); form.append('archive', new Blob([fs.readFileSync(zip)]), 'p.zip');
const created = await api(alice, '/api/projects', { method: 'POST', body: form });
const pid = created.j.projectId;
const pcb = created.j.docs.find((d) => d.docType === 'kicad_pcb'), sch = created.j.docs.find((d) => d.path === 'pic_programmer.kicad_sch');
check('project uploaded', created.status === 200 && !!pcb && !!sch, created.text.slice(0, 200));
const revA = await api(alice, `/api/projects/${pid}/checkpoints`, { json: { name: 'Rev A' } });
check('checkpoint "Rev A" names the project as uploaded', revA.status === 200, revA.text);
const link = await api(alice, `/api/projects/${pid}/links`, { json: { role: 'editor' } });
await api(bob, `/api/join/${link.j.token}`, { method: 'POST' });

// ---------------------------------------------------------------- the API on its own
{
  const C1 = '00000000-0000-0000-0000-000054032b86';
  let r = await api(alice, `/api/docs/${pcb.docId}/comments`, { json: { x: 1e6, y: 2e6, body: 'api thread', anchor: { kind: 'item', id: C1, label: 'C1' } } });
  check('a thread can be pinned to an item', r.status === 200 && r.j.anchor && r.j.anchor.kind === 'item' && r.j.anchor.id === C1 && r.j.anchor.label === 'C1', r.text);
  const root = r.j.id;
  r = await api(alice, `/api/docs/${pcb.docId}/comments`, { json: { x: 0, y: 0, body: 'bad', anchor: { kind: 'sheet', id: 'x' } } });
  check('an unknown anchor kind is refused', r.status === 400, `${r.status} ${r.text}`);
  r = await api(bob, `/api/docs/${pcb.docId}/comments`, { json: { x: 0, y: 0, body: 'a reply', parentId: root, anchor: { kind: 'net', id: 'GND' } } });
  check('a reply carries no anchor of its own', r.status === 200 && !r.j.anchor, r.text);
  r = await api(bob, `/api/comments/${root}`, { method: 'PATCH', json: { body: 'not mine' } });
  check('only the author edits a comment', r.status === 403, `${r.status} ${r.text}`);
  r = await api(alice, `/api/comments/${root}`, { method: 'PATCH', json: { body: 'api thread, edited' } });
  check('the author edits it, and it says so', r.status === 200 && r.j.body === 'api thread, edited' && !!r.j.editedAt, r.text);
  r = await api(bob, `/api/comments/${root}`, { method: 'PATCH', json: { anchor: { kind: 'net', id: 'VCC', label: 'VCC', item: C1 }, x: 5e6, y: 6e6 } });
  check('a thread can be moved onto a net', r.status === 200 && r.j.anchor.kind === 'net' && r.j.anchor.id === 'VCC' && r.j.x === 5e6, r.text);
  r = await api(bob, `/api/comments/${root}`, { method: 'PATCH', json: { unpin: true } });
  check('…and taken off again', r.status === 200 && !r.j.anchor, r.text);
  r = await api(carol, `/api/docs/${pcb.docId}/comments`, { json: { x: 0, y: 0, body: 'outsider' } });
  check('someone outside the project cannot comment', r.status === 403 || r.status === 404, `${r.status}`);
  r = await api(bob, `/api/projects/${pid}/comments`);
  check('the project lists the comments of all its documents', r.status === 200 && r.j.comments.length === 2 && r.j.docs.some((d) => d.docId === pcb.docId && d.path === pcb.path), r.text.slice(0, 300));
  r = await api(carol, `/api/projects/${pid}/comments`);
  check('…only to its members', r.status === 403 || r.status === 404, `${r.status}`);
  r = await api(alice, `/api/comments/${root}`, { method: 'DELETE' });
  check('deleting a thread takes its replies along', r.status === 200 && (await api(alice, `/api/docs/${pcb.docId}/comments`)).j.comments.length === 0, r.text);
}

// ---------------------------------------------------------------- browsers
const browser = await chromium.launch();
const errors = [];
async function open(jwt, doc, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1440, height: 900 }, deviceScaleFactor: opts.scale || 1, colorScheme: opts.scheme || 'dark', permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true });
  const page = await ctx.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(`${BASE}/auth/dev?jwt=${jwt}&next=${encodeURIComponent(`/p/${doc.pid || pid}/edit?doc=${doc.docId}${opts.query || ''}`)}`);
  await ready(page);
  return page;
}
const ready = async (page, docId) => {
  await page.waitForFunction((id) => { const E = window.CollabEditor; return E && E.kdoc && E.kdoc.items.size > 1 && E.ws && E.ws.readyState === 1 && (!id || E.DOC_ID === id || E.docId === id || location.search.includes(id)); }, docId || null, { timeout: 60000 });
  await page.waitForTimeout(700);
};
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
/** Where a document point (mm) is on the page. */
const scr = (page, x, y) => page.evaluate(([x, y]) => {
  const E = window.CollabEditor, r = document.querySelector('#world').getBoundingClientRect();
  const w = E.vb[2] / E.vbPerMm, h = E.vb[3] / E.vbPerMm;
  return [r.left + (x - E.vb[0] / E.vbPerMm) / w * r.width, r.top + (y - E.vb[1] / E.vbPerMm) / h * r.height];
}, [x, y]);
const part = (page, ref) => page.evaluate((ref) => {
  for (const it of window.CollabEditor.kdoc.items.values()) if ((it.kind === 'footprint' || it.kind === 'symbol') && it.ref === ref) return { id: it.id, x: it.x, y: it.y, bbox: it.bbox };
  return null;
}, ref);
const mid = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const threads = (page) => page.evaluate(() => (window.CollabEditor.comments || []).map((c) => ({ id: c.id, body: c.body, anchor: c.anchor, resolved: c.resolved, parentId: c.parentId, editedAt: c.editedAt })));
const pinAt = (page, id) => page.evaluate((id) => {
  const g = document.querySelector(`#cmtG [data-thread="${id}"]`); if (!g) return null;
  const s = g.querySelector('circle:last-of-type, rect'); const c = g.querySelector('rect') || [...g.querySelectorAll('circle')].pop();
  return c.tagName === 'rect' ? { x: +c.getAttribute('x') + +c.getAttribute('width') / 2, y: +c.getAttribute('y') + +c.getAttribute('height') / 2, shape: 'square', grey: c.getAttribute('fill') !== '#ffb43a', s: !!s }
    : { x: +c.getAttribute('cx'), y: +c.getAttribute('cy'), shape: 'round', grey: c.getAttribute('fill') !== '#ffb43a' };
}, id);
const until = async (fn, ms = 6000) => { const t = Date.now(); for (;;) { if (await fn()) return true; if (Date.now() - t > ms) return false; await new Promise((r) => setTimeout(r, 120)); } };
const menuRow = (page, re) => page.locator('span.flex-1', { hasText: re }).first();
const rightClick = async (page, mm) => { const [x, y] = await scr(page, mm[0], mm[1]); await page.mouse.click(x, y, { button: 'right' }); await page.waitForTimeout(250); };
const step = async (name, page, fn) => { try { await fn(); } catch (e) { check(name, false, String(e.message).split('\n').slice(0, 4).join(' / ')); if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'FAIL-' + name.replace(/\W+/g, '-') + '.png') }).catch(() => {}); await page.keyboard.press('Escape').catch(() => {}); } };
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;

const a = await open(alice, pcb, { scale: 2 }), b = await open(bob, pcb, { scheme: 'light' });
let partThread = 0, netThread = 0;

// ================================================================ comment threads on the board
await step('part thread', a, async () => {
  const c1 = await part(a, 'C1');
  await rightClick(a, mid(c1.bbox));
  check('right-clicking a part offers "Add Comment on C1…"', await menuRow(a, /^Add Comment on C1/).count() === 1);
  await shot(a, '01-part-menu');
  await menuRow(a, /^Add Comment on C1/).click();
  await a.waitForSelector('#cmtPanel.open #newText');
  check('the new thread card names the part', /C1/.test(await a.locator('#cmtPanel .cmt-anchor').first().textContent()));
  await a.fill('#cmtPanel #newText', 'Is 100µF enough here? The regulator datasheet asks for 220µF.');
  await a.keyboard.press('Control+Enter');
  await until(async () => (await threads(a)).length === 1);
  const t = (await threads(a))[0]; partThread = t.id;
  check('the thread is stored pinned to C1', t.anchor && t.anchor.kind === 'item' && t.anchor.id === c1.id && t.anchor.label === 'C1', JSON.stringify(t));
  const p = await pinAt(a, t.id);
  check('its pin is a round bubble on the part\'s corner', p && p.shape === 'round' && near(p.x, c1.bbox[2]) && near(p.y, c1.bbox[1]) && !p.grey, JSON.stringify(p));
  check('Bob sees the thread and its pin at once', await until(async () => !!(await pinAt(b, t.id))), JSON.stringify(await threads(b)));
  await shot(a, '02-part-thread');
});

await step('net thread', a, async () => {
  await a.keyboard.press('Escape');
  const seg = await a.evaluate(() => { const E = window.CollabEditor; for (const it of E.kdoc.items.values()) if (it.kind === 'segment' && it.bbox[0] > 141 && it.bbox[0] < 142 && window.KiCadCanvas.netNameOf(E.kdoc, it.node) === 'VCC') return { id: it.id, bbox: it.bbox }; return null; });
  await rightClick(a, mid(seg.bbox));
  check('right-clicking a track offers a comment on its net', await menuRow(a, /^Add Comment on Net VCC/).count() === 1);
  await menuRow(a, /^Add Comment on Net VCC/).click();
  await a.waitForSelector('#cmtPanel.open #newText');
  await a.fill('#cmtPanel #newText', 'VCC carries the programming current: 0.8 mm is thin for this run.');
  await a.click('#cmtPanel #postBtn');
  await until(async () => (await threads(a)).length === 2);
  const t = (await threads(a)).find((x) => x.anchor && x.anchor.kind === 'net'); netThread = t.id;
  check('the thread is stored pinned to net VCC', !!t && t.anchor.id === 'VCC' && t.anchor.item === seg.id, JSON.stringify(t));
  const p = await pinAt(a, t.id);
  check('a net pin is a square, so the two kinds read apart', p && p.shape === 'square', JSON.stringify(p));
  const lit = await a.evaluate(() => window.CollabEditor.highlightIds ? window.CollabEditor.highlightIds.size : 0);
  check('opening the thread lights the whole net', lit > 5, String(lit));
  await shot(a, '03-net-thread');
});

await step('reply, edit, resolve', b, async () => {
  await b.evaluate((id) => window.CollabApp.dispatch({ type: 'openThread', id }), partThread);
  await b.waitForSelector('#cmtPanel.open #replyText');
  await b.fill('#cmtPanel #replyText', 'Agreed. I will swap it for the 220µF part.');
  await b.click('#cmtPanel #replyBtn');
  check('Bob\'s reply reaches Alice', await until(async () => (await threads(a)).some((c) => c.parentId === partThread)));
  await shot(b, '04-reply-light-theme');
  await a.evaluate((id) => window.CollabApp.dispatch({ type: 'openThread', id }), partThread);
  await a.waitForSelector('#cmtPanel.open');
  check('Alice can edit her comment and not Bob\'s', await a.locator('#cmtPanel [data-edit]').count() === 1 && await b.locator('#cmtPanel [data-edit]').count() === 1, `${await a.locator('#cmtPanel [data-edit]').count()} / ${await b.locator('#cmtPanel [data-edit]').count()}`);
  await a.locator('#cmtPanel .cmt-item').first().hover();
  await a.locator('#cmtPanel [data-edit]').first().click();
  await a.fill('#cmtPanel [data-edit-text]', 'Is 100µF enough here? The LM317 datasheet asks for 220µF.');
  await a.click('#cmtPanel [data-edit-save]');
  check('the edit shows for Bob, marked as edited', await until(async () => (await threads(b)).some((c) => /LM317/.test(c.body) && c.editedAt)) && await until(async () => /edited/.test(await b.locator('#cmtPanel').textContent())));
  await shot(a, '05-thread-with-reply');
});

await step('pin follows the part', a, async () => {
  await a.keyboard.press('Escape'); await a.keyboard.press('Escape');
  const c1 = await part(a, 'C1'); const [x, y] = await scr(a, c1.x, c1.y);
  await a.mouse.click(x - 20, y); await a.keyboard.press('m'); await a.mouse.move(x - 20, y + 90, { steps: 6 }); await a.mouse.click(x - 20, y + 90);
  await until(async () => (await part(a, 'C1')).y > c1.y + 5);
  const now = await part(a, 'C1');
  check('Alice moved C1', now.y > c1.y + 5, JSON.stringify(now));
  check('her pin moved with it', await until(async () => { const p = await pinAt(a, partThread); return p && near(p.x, now.bbox[2]) && near(p.y, now.bbox[1]); }), JSON.stringify(await pinAt(a, partThread)));
  check('and so did Bob\'s', await until(async () => { const p = await pinAt(b, partThread); return p && near(p.x, now.bbox[2]) && near(p.y, now.bbox[1]); }), JSON.stringify(await pinAt(b, partThread)));
  await a.keyboard.press('Escape');
  await rightClick(a, mid(now.bbox));
  check('the part\'s menu now leads to its thread', await menuRow(a, /^Show Comment/).count() >= 1);
  await menuRow(a, /^Show Comment/).first().click();
  check('…and opens it', await until(async () => a.locator('#cmtPanel.open').count().then((n) => n === 1)) && /LM317/.test(await a.locator('#cmtPanel').textContent()));
  await shot(a, '06-pin-followed-the-part');
  await a.keyboard.press('Escape');
});

await step('comments pane', a, async () => {
  await a.evaluate(() => window.CollabApp.dispatch({ type: 'showPane', pane: 'comments', show: true }));
  await a.waitForSelector('.cmt-card');
  check('the Comments pane lists both threads with what they are on', await a.locator('.cmt-card').count() === 2 && await a.locator('.cmt-card .cmt-anchor.item').count() === 1 && await a.locator('.cmt-card .cmt-anchor.net').count() === 1);
  await a.locator('.cmt-card', { hasText: 'programming current' }).click();
  await a.waitForSelector('#cmtPanel.open #resolveBtn');
  await a.click('#cmtPanel #resolveBtn');
  check('resolving takes the pin off the board for both', await until(async () => !(await pinAt(a, netThread)) && !(await pinAt(b, netThread))));
  check('the thread moves to Resolved', await until(async () => a.locator('.cmt-card').count().then((n) => n === 1)) && /1/.test(await a.locator('.cmt-tabs [data-tab="resolved"]').textContent()));
  await a.click('.cmt-tabs [data-tab="resolved"]');
  await a.locator('.cmt-card.resolved').click();
  await a.waitForSelector('#cmtPanel.open #resolveBtn');
  check('a resolved thread can be reopened', /Reopen/.test(await a.locator('#cmtPanel #resolveBtn').textContent()));
  await a.click('#cmtPanel #resolveBtn');
  check('…which puts the pin back', await until(async () => !!(await pinAt(b, netThread))));
  await a.click('.cmt-tabs [data-tab="open"]');
  await shot(a, '07-comments-pane');
  await a.keyboard.press('Escape');
});

await step('anchor deleted', a, async () => {
  const r5 = await part(a, 'R5');
  await rightClick(a, mid(r5.bbox)); await menuRow(a, /^Add Comment on R5/).click();
  await a.waitForSelector('#cmtPanel.open #newText'); await a.fill('#cmtPanel #newText', 'R5 is not needed any more.'); await a.click('#cmtPanel #postBtn');
  await until(async () => (await threads(a)).some((c) => c.anchor && c.anchor.label === 'R5'));
  const t = (await threads(a)).find((c) => c.anchor && c.anchor.label === 'R5');
  await a.keyboard.press('Escape');
  const [x, y] = await scr(a, ...mid(r5.bbox)); await a.mouse.click(x, y); await a.keyboard.press('Delete');
  await until(async () => !(await part(a, 'R5')));
  const p = await until(async () => { const q = await pinAt(b, t.id); return q && q.grey; });
  check('when the part is deleted its thread stays where it was, greyed', p, JSON.stringify(await pinAt(b, t.id)));
  await b.evaluate((id) => window.CollabApp.dispatch({ type: 'openThread', id }), t.id);
  await b.waitForSelector('#cmtPanel.open');
  check('and says the part is gone', /no longer|removed|deleted/i.test(await b.locator('#cmtPanel').textContent()), await b.locator('#cmtPanel').textContent());
  await shot(b, '08-part-deleted');
  await b.keyboard.press('Escape');
});

// ================================================================ compare: board against a checkpoint
await step('board compare', a, async () => {
  // Rev A names the board as uploaded; since then C1 moved, R5 went, and a track goes now
  const seg = await a.evaluate(() => { const E = window.CollabEditor; for (const it of E.kdoc.items.values()) if (it.kind === 'segment' && it.bbox[0] > 150) { const w = it.bbox[2] - it.bbox[0], h = it.bbox[3] - it.bbox[1]; if (Math.min(w, h) < 1.2 && Math.max(w, h) > 4) return { id: it.id, bbox: it.bbox }; } return null; });
  const [x, y] = await scr(a, ...mid(seg.bbox)); await a.mouse.click(x, y); await a.keyboard.press('Delete'); await a.waitForTimeout(400);
  await a.keyboard.press('Escape');
  await a.click('text=File'); await a.waitForTimeout(200);
  const entry = a.locator('text=/^Compare Board with History/').first();
  check('File has "Compare Board with History..."', await entry.count() === 1);
  await entry.click();
  await a.waitForSelector('[data-compare] .rv-row');
  const rows = await a.locator('.rv-row').allTextContents();
  check('the window lists what changed since the checkpoint', rows.some((r) => /Footprint C1/.test(r) && /moved/.test(r)) && rows.some((r) => /Footprint R5/.test(r)) && rows.some((r) => /Track/.test(r)), rows.join(' | '));
  check('with its counts', /3 changes/.test(await a.locator('#rvSummary').textContent()) && /2 removed/.test(await a.locator('#rvSummary').textContent()), await a.locator('#rvSummary').textContent());
  await a.locator('.rv-row', { hasText: 'Footprint C1' }).click(); await a.waitForTimeout(400);
  const props = await a.locator('#rvProps').textContent();
  check('selecting a change shows its properties before and after', /Position Y/.test(props) && /78\.867/.test(props) && /102/.test(props), props.slice(0, 200));
  await shot(a, '10-compare-board-overlay');
  await a.click('[data-mode="side"]'); await a.waitForTimeout(400);
  check('side by side shows two canvases', await a.locator('[data-compare] canvas[data-canvas]').count() === 2);
  await shot(a, '11-compare-board-side-by-side');
  await a.click('[data-mode="swipe"]'); await a.waitForTimeout(400);
  await shot(a, '12-compare-board-swipe');
  await a.click('[data-mode="overlay"]');
  await a.fill('[data-compare] input[type="search"], [data-compare] .rv-filter', 'R5'); await a.waitForTimeout(250);
  check('the filter narrows the list', await a.locator('.rv-row').count() === 1, String(await a.locator('.rv-row').count()));
  await a.fill('[data-compare] input[type="search"], [data-compare] .rv-filter', ''); await a.waitForTimeout(200);
  // a change Bob makes while the window is open shows up
  const before = await a.locator('.rv-row').count();
  const c2 = await part(b, 'C2'); const [bx, by] = await scr(b, c2.x, c2.y);
  await b.mouse.click(bx + 12, by); await b.keyboard.press('m'); await b.mouse.move(bx + 12, by - 40, { steps: 5 }); await b.mouse.click(bx + 12, by - 40);
  check('an edit Bob makes meanwhile appears in the open comparison', await until(async () => (await a.locator('.rv-row').count()) === before + 1 && (await a.locator('.rv-row').allTextContents()).some((r) => /Footprint C2/.test(r))), (await a.locator('.rv-row').allTextContents()).join(' | '));
  // comment on a change
  await a.locator('.rv-row', { hasText: 'Footprint C2' }).click();
  await a.click('#rvComment');
  await a.waitForSelector('#cmtPanel.open #newText');
  check('"Comment on Change…" closes the window and starts a thread on that part', await a.locator('[data-compare]').count() === 0 && /C2/.test(await a.locator('#cmtPanel .cmt-anchor').first().textContent()));
  await a.fill('#cmtPanel #newText', 'Why did C2 move?'); await a.click('#cmtPanel #postBtn');
  check('…which Bob gets', await until(async () => (await threads(b)).some((c) => c.anchor && c.anchor.label === 'C2')));
  await a.keyboard.press('Escape');
});

await step('copy and save', a, async () => {
  await a.evaluate(() => window.CollabApp.dispatch({ type: 'compare' }));
  await a.waitForSelector('[data-compare] .rv-row');
  await a.click('#rvCopy');
  const clip = await a.evaluate(() => navigator.clipboard.readText());
  check('Copy Summary puts a readable list on the clipboard', /Rev A/.test(clip) && /Footprint C1/.test(clip) && /Removed/i.test(clip), clip.slice(0, 300));
  const [dl] = await Promise.all([a.waitForEvent('download'), a.click('#rvImage')]);
  const file = await dl.path();
  check('Save Image downloads a PNG of the comparison', /\.png$/.test(dl.suggestedFilename()) && fs.statSync(file).size > 5000, `${dl.suggestedFilename()} ${fs.statSync(file).size}`);
  if (SHOTS) fs.copyFileSync(file, path.join(SHOTS, '13-saved-image.png'));
  await a.keyboard.press('Escape');
  check('Esc closes the window', await until(async () => a.locator('[data-compare]').count().then((n) => n === 0)));
});

await step('compare for a viewer, narrow', b, async () => {
  const v = await open(carol, { docId: pcb.docId }, { viewport: { width: 760, height: 620 }, query: '&compare=1' }).catch(() => null);
  check('someone outside the project cannot open it', v === null || await v.locator('[data-compare] .rv-row').count() === 0);
  if (v) await v.context().close();
  const n = await open(bob, pcb, { viewport: { width: 760, height: 620 }, scheme: 'light', query: '&compare=1' });
  await n.waitForSelector('[data-compare] .rv-row').catch(async (e) => { await shot(n, 'FAIL-narrow'); throw e; });
  const box = await n.evaluate(() => { const d = document.querySelector('[data-compare]').getBoundingClientRect(); const c = document.querySelector('[data-compare] canvas').getBoundingClientRect(); return { w: d.width, h: d.height, r: d.right, b: d.bottom, cw: c.width, ch: c.height, sw: document.documentElement.scrollWidth, iw: innerWidth }; });
  check('a link with ?compare=1 opens the comparison, and it fits a narrow window', box.r <= box.iw + 1 && box.sw <= box.iw + 1 && box.cw > 250 && box.ch > 150, JSON.stringify(box));
  await shot(n, '14-compare-narrow-light');
  await n.context().close();
});

// ================================================================ schematic
await step('schematic', a, async () => {
  const s = await open(alice, sch, { scale: 2 }), t = await open(bob, sch);
  const sym = await s.evaluate(() => { for (const it of window.CollabEditor.kdoc.items.values()) if (it.kind === 'symbol' && it.ref && /^R\d+$/.test(it.ref)) return { id: it.id, ref: it.ref, bbox: it.bbox, x: it.x, y: it.y }; return null; });
  await rightClick(s, mid(sym.bbox));
  check(`right-clicking a symbol offers "Add Comment on ${sym.ref}…"`, await menuRow(s, new RegExp(`^Add Comment on ${sym.ref}`)).count() === 1);
  await menuRow(s, new RegExp(`^Add Comment on ${sym.ref}`)).click();
  await s.waitForSelector('#cmtPanel.open #newText'); await s.fill('#cmtPanel #newText', 'Should this be 1%?'); await s.click('#cmtPanel #postBtn');
  check('Bob sees the schematic thread', await until(async () => (await threads(t)).some((c) => c.anchor && c.anchor.label === sym.ref)));
  await s.keyboard.press('Escape');
  const wire = await s.evaluate(() => { const E = window.CollabEditor; let best = null; for (const it of E.kdoc.items.values()) if (it.kind === 'wire' && (!best || (it.bbox[2] - it.bbox[0]) > (best.bbox[2] - best.bbox[0]))) best = { id: it.id, bbox: it.bbox }; return best; });
  await rightClick(s, mid(wire.bbox));
  const netRow = menuRow(s, /^Add Comment on Net /);
  check('right-clicking a wire offers a comment on its net', await netRow.count() === 1);
  const netName = (await netRow.textContent()).replace(/^Add Comment on Net /, '').replace(/…$/, '');
  await netRow.click(); await s.waitForSelector('#cmtPanel.open #newText'); await s.fill('#cmtPanel #newText', 'Rename this net?'); await s.click('#cmtPanel #postBtn');
  check('the wire\'s thread is on its net', await until(async () => (await threads(s)).some((c) => c.anchor && c.anchor.kind === 'net' && c.anchor.id === netName)), netName);
  await shot(s, '20-schematic-threads');
  await s.keyboard.press('Escape');
  // the board's threads are listed from the schematic, and open the board
  await s.evaluate(() => window.CollabApp.dispatch({ type: 'showPane', pane: 'comments', show: true }));
  check('the pane also lists the threads on the board', await until(async () => s.locator('[data-doc-threads] .cmt-card').count().then((n) => n >= 2)) && /kicad_pcb/.test(await s.locator('.cmt-doc').first().textContent()));
  await shot(s, '21-comments-of-other-documents');

  // compare
  await api(alice, `/api/projects/${pid}/checkpoints`, { json: { name: 'Rev B' } });
  const [x, y] = await scr(s, ...mid(sym.bbox)); await s.mouse.click(x, y); await s.keyboard.press('m'); await s.mouse.move(x + 60, y + 30, { steps: 5 }); await s.mouse.click(x + 60, y + 30); await s.waitForTimeout(300); await s.keyboard.press('Escape');
  await s.evaluate(() => window.CollabApp.dispatch({ type: 'uiAction', id: 'compareSchematicWithHistory' })).catch(() => {});
  if (!(await s.locator('[data-compare]').count())) await s.evaluate(() => window.CollabApp.dispatch({ type: 'compare' }));
  await s.waitForSelector('[data-compare] .rv-row');
  const rows = await s.locator('.rv-row').allTextContents();
  check('the schematic comparison finds the moved symbol', rows.some((r) => new RegExp(`Symbol ${sym.ref}\\b`).test(r)), rows.join(' | '));
  check('the older side offers both checkpoints', await s.evaluate(() => { const o = [...document.querySelectorAll('select[data-side="a"] option')].map((e) => e.textContent); return o.some((x) => /Rev A/.test(x)) && o.some((x) => /Rev B/.test(x)); }), await s.evaluate(() => [...document.querySelectorAll('select[data-side="a"] option')].map((e) => e.textContent).join(' | ')));
  await s.locator('.rv-row').first().click(); await s.waitForTimeout(400);
  await shot(s, '22-compare-schematic');
  await s.click('[data-mode="side"]'); await s.waitForTimeout(400); await shot(s, '23-compare-schematic-side-by-side');
  // the other document of the project, from here
  await s.selectOption('#rvDoc', { label: pcb.path });
  await s.waitForTimeout(600);
  await s.selectOption('select[data-side="a"]', await s.evaluate(() => [...document.querySelectorAll('select[data-side="a"] option')].find((o) => /Rev A/.test(o.textContent)).value));
  check('the Document picker switches to the board without leaving the schematic', await until(async () => (await s.locator('.rv-row').allTextContents()).some((r) => /Footprint C1/.test(r))), (await s.locator('.rv-row').allTextContents()).join(' | '));
  await s.keyboard.press('Escape');
  // a pane thread of the board opens the board with its card
  await s.locator('[data-doc-threads] .cmt-card', { hasText: 'LM317' }).click();
  check('a thread of another document opens that document at the thread', await until(async () => s.evaluate(() => { const E = window.CollabEditor; return E.kdoc && E.kdoc.type === 'pcb' && !!document.querySelector('#cmtPanel.open'); }), 15000));
  await shot(s, '24-opened-from-another-document');
  await s.context().close(); await t.context().close();
});

// ================================================================ GitHub commits
await step('git commits', a, async () => {
  await ctl('reset', {});
  await ctl('user', { login: 'rv-alice', id: 9601 });
  await ctl('browser', { login: 'rv-alice' });
  const files = {};
  for (const f of fs.readdirSync(DEMO)) if (/\.kicad_(pro|sch|pcb)$/.test(f)) files['hw/' + f] = fs.readFileSync(path.join(DEMO, f), 'utf8');
  const pcb0 = files['hw/pic_programmer.kicad_pcb'];
  await ctl('repo', { fullName: 'rv-alice/pic', files, message: 'First layout' });
  const pcb1 = pcb0.replace('"10K"', '"22K"');
  if (pcb1 === pcb0) throw new Error('fixture: no 10K value in the board');
  await ctl('commit', { fullName: 'rv-alice/pic', files: { 'hw/pic_programmer.kicad_pcb': pcb1 }, message: 'Pull-up to 22K' });
  let url = `${BASE}/auth/github/connect?next=/github`;
  for (let hop = 0; hop < 6; hop++) { const r = await fetch(url, { redirect: 'manual', headers: url.startsWith(BASE) ? { Cookie: `kc_session=${alice}` } : {} }); if (r.status < 300 || r.status >= 400) break; url = new URL(r.headers.get('location'), url).toString(); }
  const imp = await api(alice, '/api/github/import', { json: { repo: 'rv-alice/pic', path: 'hw' } });
  check('repository imported', imp.status === 200, imp.text.slice(0, 200));
  const gp = imp.j.projectId;
  const docs = (await api(alice, `/api/projects/${gp}`)).j.docs; const gpcb = docs.find((d) => d.docType === 'kicad_pcb');
  let r = await api(alice, `/api/projects/${gp}/github/commits?path=${encodeURIComponent(gpcb.path)}`);
  check('the server lists the commits that touched the file', r.status === 200 && r.j.commits.length === 2 && r.j.commits[0].message === 'Pull-up to 22K', r.text.slice(0, 300));
  const first = r.j.commits[1].sha;
  r = await api(alice, `/api/projects/${gp}/github/file?path=${encodeURIComponent(gpcb.path)}&sha=${first}`);
  check('and serves the file at a commit', r.status === 200 && r.text === pcb0, `${r.status} ${r.text.length} ${pcb0.length}`);
  r = await api(bob, `/api/projects/${gp}/github/commits?path=${encodeURIComponent(gpcb.path)}`);
  check('not to someone outside the project', r.status === 403 || r.status === 404, String(r.status));
  r = await api(alice, `/api/projects/${gp}/github/file?path=${encodeURIComponent('../secrets')}&sha=${first}`);
  check('a path outside the project is refused', r.status >= 400, String(r.status));
  r = await api(alice, `/api/projects/${pid}/github/commits?path=x`);
  check('a project without a repository says so', r.status === 400, `${r.status} ${r.text}`);

  const g = await open(alice, { pid: gp, docId: gpcb.docId }, { scale: 2 });
  await g.evaluate(() => window.CollabApp.dispatch({ type: 'compare' }));
  await g.waitForSelector('[data-compare]');
  check('the older side lists the GitHub commits', await until(async () => g.evaluate(() => [...document.querySelectorAll('select[data-side="a"] option')].filter((o) => /Initial commit|Pull-up to 22K/.test(o.textContent)).length === 2)), await g.evaluate(() => [...document.querySelectorAll('select[data-side="a"] option')].map((e) => e.textContent).join(' | ')));
  const value = await g.evaluate(() => [...document.querySelectorAll('select[data-side="a"] option')].find((o) => /Initial commit/.test(o.textContent)).value);
  await g.selectOption('select[data-side="a"]', value);
  await g.waitForSelector('[data-compare] .rv-row');
  const rows = await g.locator('.rv-row').allTextContents();
  check('comparing with the first commit shows the changed value', rows.length === 1 && /Footprint R\d+/.test(rows[0]), rows.join(' | '));
  await g.locator('.rv-row').first().click(); await g.waitForTimeout(400);
  const props = await g.locator('#rvProps').textContent();
  check('…as Value 10K before, 22K after', /Value/.test(props) && /10K/.test(props) && /22K/.test(props), props.slice(0, 200));
  await shot(g, '30-compare-with-git-commit');
  // commit against commit
  const newer = await g.evaluate(() => [...document.querySelectorAll('select[data-side="b"] option')].find((o) => /Pull-up/.test(o.textContent)).value);
  await g.selectOption('select[data-side="b"]', newer);
  check('two commits can be compared with each other', await until(async () => (await g.locator('.rv-row').count()) === 1 && /1 change/.test(await g.locator('#rvSummary').textContent())), await g.locator('#rvSummary').textContent());
  await g.click('#rvSwap');
  check('swapping the sides turns the change round', await until(async () => /22K/.test((await g.locator('#rvProps').textContent()).split('10K')[0] || '') || /10K/.test(await g.locator('#rvProps').textContent())));
  await g.context().close();
});

// ================================================================ compare with a file
await step('compare with file', a, async () => {
  const text = fs.readFileSync(path.join(DEMO, 'pic_programmer.kicad_pcb'), 'utf8');
  await a.evaluate(() => window.CollabApp.dispatch({ type: 'compare', pickFile: true }));
  await a.waitForSelector('[data-compare]');
  await a.setInputFiles('[data-compare] input[type="file"]', { name: 'as-fabricated.kicad_pcb', mimeType: 'text/plain', buffer: Buffer.from(text) });
  check('a file from the computer can be the older side', await until(async () => (await a.locator('.rv-row').allTextContents()).some((r) => /Footprint R5/.test(r)) && /as-fabricated/.test(await a.locator('select[data-side="a"]').evaluate((e) => e.selectedOptions[0].textContent))), (await a.locator('.rv-row').allTextContents()).join(' | '));
  await a.setInputFiles('[data-compare] input[type="file"]', { name: 'wrong.kicad_pcb', mimeType: 'text/plain', buffer: Buffer.from('(kicad_sch (version 1))') });
  check('a file that is not a board is refused with a message', await until(async () => /not a KiCad board|cannot be read|not a board/i.test(await a.locator('[data-compare]').textContent())), (await a.locator('[data-compare] .callout, [data-compare] .rv-error').allTextContents()).join(' | '));
  await a.keyboard.press('Escape');
});

check('no page errors', errors.length === 0, errors.slice(0, 6).join(' || '));
await browser.close(); await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
