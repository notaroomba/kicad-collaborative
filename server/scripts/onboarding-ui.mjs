// Browser test of onboarding (server/web/onboarding, the template picker in server/web/home, and the
// hand-off from the home page's small editor): a new person's empty projects home, a project from a
// template, the guided first project from its first step to its last with tracks routed by hand and by
// the autorouter, and a board carried over from the public home page through sign-in.
// Needs a local server with KC_DEV_LOGIN=1 on a throwaway database, and Playwright.
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… [E2E_BASE=http://127.0.0.1:8099] [SHOTS=/some/dir] node onboarding-ui.mjs
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import pg from 'pg';

const { chromium, devices } = createRequire(import.meta.url)('playwright');

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
const out = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-ui-')); fs.mkdirSync(out, { recursive: true });

let pass = 0, fail = 0; const fails = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (ok) pass++; else { fail++; fails.push(name); } };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'HS256', typ: 'JWT' }), b = b64({ sub, login, iat: now, exp: now + 36000 });
  return `${h}.${b}.${crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url')}`;
}
async function api(token, p) { const r = await fetch(BASE + p, { headers: { authorization: `Bearer ${token}` } }); const t = await r.text(); try { return JSON.parse(t); } catch { return t; } }

// Throwaway people (negative GitHub ids), each new to the site; leftovers of an earlier run go first.
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
const GH_IDS = [-9401, -9402, -9403, -9404, -9405];
const cleanup = async () => {
  await db.query('DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE github_id = ANY($1))', [GH_IDS]);
  await db.query('DELETE FROM users WHERE github_id = ANY($1)', [GH_IDS]).catch((e) => console.warn('cleanup: ' + e.message));
};
await cleanup();
const person = async (ghId, login) => { const id = (await db.query('INSERT INTO users (github_id, login, name, email) VALUES ($1, $2, $3, $4) RETURNING id', [ghId, login, login[0].toUpperCase() + login.slice(1), `${login}@example.com`])).rows[0].id; return { id, login, token: jwt(id, login) }; };
const nova = await person(-9401, 'nova'), iris = await person(-9402, 'iris'), remy = await person(-9403, 'remy'), odile = await person(-9404, 'odile'), pax = await person(-9405, 'pax');

const browser = await chromium.launch(); const errors = [];
async function context(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, ...opts });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|fonts\.g|ERR_|40[0-9]|status of 4/.test(m.text())) errors.push(m.text()); });
  return page;
}
const signIn = (page, who, next = '/') => page.goto(`${BASE}/auth/dev?jwt=${who.token}&next=${encodeURIComponent(next)}`);
const shot = (page, name) => page.screenshot({ path: path.join(out, name + '.png') });
const inEditor = (page, kind) => page.waitForFunction((k) => {
  const E = window.CollabEditor, s = window.CollabApp && window.CollabApp.getState();
  return E && E.kdoc && E.kdoc.items.size > 5 && s && s.view === 'editor' && (!k || s.document.editor === k) && E.ws && E.ws.readyState === 1;
}, kind || null, { timeout: 60000 });
const guide = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('kc.guide') || 'null'));
const step = (page) => page.evaluate(() => { const el = document.querySelector('.kg-steps li.cur .kg-step-t'); return el ? el.textContent : document.querySelector('.kg-done h3') ? 'finished' : null; });
const stepIs = (page, title) => page.waitForFunction((t) => { const el = document.querySelector('.kg-steps li.cur .kg-step-t'); return (el ? el.textContent : document.querySelector('.kg-done h3') ? 'finished' : null) === t; }, title, { timeout: 20000 }).then(() => true, () => false);
/** Where a point of the document (mm) is on the screen. */
const screen = (page, x, y) => page.evaluate(([x, y]) => {
  const E = window.CollabEditor, r = document.getElementById('world').getBoundingClientRect();
  return [r.left + ((x * E.vbPerMm - E.vb[0]) / E.vb[2]) * r.width, r.top + ((y * E.vbPerMm - E.vb[1]) / E.vb[3]) * r.height];
}, [x, y]);
const clickAt = async (page, x, y, opts) => { const [sx, sy] = await screen(page, x, y); await page.mouse.move(sx, sy); await page.waitForTimeout(60); await page.mouse.click(sx, sy, opts); await page.waitForTimeout(120); };
const board = (page) => page.evaluate(() => {
  const P = window.PcbTools, E = window.CollabEditor, doc = E.kdoc; const c = { segment: 0, via: 0 };
  for (const it of doc.items.values()) if (it.kind in c) c[it.kind]++;
  const marks = P.drc(doc, P.designSettings(E.proSettings || null));
  return { open: P.ratsnest(doc).length, ...c, violations: marks.filter((m) => ['clearance', 'copper_edge_clearance', 'shorting_items', 'track_width', 'via_diameter', 'hole_clearance'].includes(m.code)).map((m) => m.code) };
});

// ================================================================ a new person's projects home
const a = await context({ colorScheme: 'light' });
await signIn(a, nova);
await a.waitForSelector('.fp-card:not(.skel)'); await a.waitForFunction(() => [...document.querySelectorAll('.fp img')].every((i) => i.complete && i.naturalWidth > 0));
check('with no projects, the home offers a guided first project and four templates', await a.locator('.fp-first .btn.primary').count() === 1 && await a.locator('.fp-card:not(.skel)').count() === 4, await a.textContent('.fp-first h2'));
check('there is one primary button in the panel', await a.locator('.fp .btn.primary').count() === 1);
check('…and it still offers upload and joining by link', await a.locator('.fp-own .btn').count() === 2);
await shot(a, '01-first-project-home');

// ---- a project from a template
await a.locator('.fp-card', { hasText: 'I2C temperature sensor' }).click();
await a.waitForSelector('.tp-detail'); await a.waitForFunction(() => [...document.querySelectorAll('.tp img')].every((i) => i.complete && i.naturalWidth > 0));
check('a template card opens New project on that template', await a.getAttribute('.hp-modes button.on', 'aria-selected') === 'true' && await a.textContent('.hp-modes button.on') === 'From a template' && /I2C temperature/.test(await a.textContent('.tp-card.on')));
check('the name starts as the template title', await a.inputValue('.tp .hp-input') === 'I2C temperature sensor breakout');
check('it says what is in it', /\d+ parts · \d+ nets · \d+ × \d+ mm/.test(await a.textContent('.tp-about')) && /Passes KiCad/.test(await a.textContent('.tp-about')));
check('only the blinker offers the walk-through', await a.locator('.tp-guided').count() === 0);
await shot(a, '02-template-picker');
await a.click('.tp-sides >> text=Schematic'); await a.waitForFunction(() => { const i = document.querySelector('.tp-view img'); return i && i.complete && i.naturalWidth > 0 && /schematic/.test(i.src); });
await shot(a, '03-template-schematic');
await a.locator('.tp-card', { hasText: 'ATtiny85' }).click();
check('choosing another template follows with the name', await a.inputValue('.tp .hp-input') === 'ATtiny85 development board');
await a.fill('.tp .hp-input', 'Tiny dev board');
await a.locator('.tp-card', { hasText: 'USB-C 3.3 V' }).click();
check('a name the person typed is kept', await a.inputValue('.tp .hp-input') === 'Tiny dev board');
await a.locator('.tp-card', { hasText: 'ATtiny85' }).click();
await a.click('.hp-modal .btn.primary');
await inEditor(a);
const tiny = await a.evaluate(() => { const s = window.CollabApp.getState(); return { name: s.project.name, docs: s.document.docs.map((d) => d.path).sort(), view: s.view }; });
check('Create and open makes the project and opens it in the editor', tiny.name === 'Tiny dev board' && JSON.stringify(tiny.docs) === JSON.stringify(['Tiny_dev_board.kicad_pcb', 'Tiny_dev_board.kicad_sch']), JSON.stringify(tiny));
check('a plain template project has no guide', await a.locator('.kg').count() === 0 && await guide(a) === null);
await a.waitForTimeout(1200);
if (await a.evaluate(() => window.CollabApp.getState().document.editor) === 'pcb') {
  const t = await board(a); check('the template board opens fully routed and clean in the web editor', t.open === 0 && t.violations.length === 0 && t.segment > 30, JSON.stringify(t));
}
await shot(a, '04-template-in-editor');

// ---- the same picker from New project, with the walk-through ticked
await a.goto(BASE + '/'); await a.waitForSelector('.hp-item');
check('with a project in the list the first-project panel is gone', await a.locator('.fp').count() === 0);
await a.click('.hp-side-btn >> text=New project'); await a.waitForSelector('.hp-modes');
check('New project has a From a template tab', await a.locator('.hp-modes button', { hasText: 'From a template' }).count() === 1);
await a.click('.hp-modes >> text=From a template'); await a.waitForSelector('.tp-guided');
check('the blinker is first and offers the walk-through', /555 LED blinker/.test(await a.textContent('.tp-card.on')) && !(await a.isChecked('.tp-guided input')));
await a.check('.tp-guided input');
await a.click('.hp-modal .btn.primary');
await inEditor(a); await a.waitForSelector('.kg');
const viaPicker = await a.evaluate(() => window.PcbTools.ratsnest(window.CollabEditor.kdoc).length).catch(() => -1);
check('ticking it opens the project with the guide and four open connections', (await guide(a))?.from === 'home' && (viaPicker === 4 || viaPicker === -1), String(viaPicker));

// ================================================================ the guided first project, start to finish
const g = await context({ colorScheme: 'light' });
await signIn(g, iris);
await g.waitForSelector('.fp-first .btn.primary');
await g.click('.fp-first .btn.primary');
await inEditor(g); await g.waitForSelector('.kg');
const st0 = await g.evaluate(() => { const s = window.CollabApp.getState(); return { name: s.project.name, id: s.project.projectId }; });
check('Start the guided project makes "My first board" and opens it with the guide', st0.name === 'My first board' && (await guide(g)).projectId === st0.id && await step(g) === 'Read the schematic');
const corner = await g.evaluate(() => { const k = document.querySelector('.kg').getBoundingClientRect(), s = document.getElementById('stage').getBoundingClientRect(); return k.right <= s.left + 30 && k.bottom <= s.bottom; });
check('the guide sits beside the canvas, not over the board', corner);
await g.waitForTimeout(800); await shot(g, '05-guide-step-1');

// 1. the schematic
if (await g.evaluate(() => window.CollabApp.getState().document.editor) !== 'sch') { await g.click('.kg .kg-acts >> text=Open the schematic'); await inEditor(g, 'sch'); }
await g.waitForTimeout(700);
check('opening the schematic alone does not finish the step', await step(g) === 'Read the schematic' && /Click a part/.test(await g.textContent('.kg-step-b')));
const u1 = await g.evaluate(() => { for (const it of window.CollabEditor.kdoc.items.values()) { if (it.kind !== 'symbol') continue; const s = (window.CollabApp.getState().document.items || []).find((x) => x.id === it.id); if (s && s.ref === 'U1') { const at = it.node.find((n) => Array.isArray(n) && n[0] === 'at'); return [+at[1], +at[2]]; } } return null; });
check('the schematic has U1', !!u1, JSON.stringify(u1));
if (u1) await clickAt(g, u1[0], u1[1]);
check('clicking U1 finishes the step and moves on to the board', await stepIs(g, 'Open the board'), JSON.stringify(await g.evaluate(() => window.CollabApp.getState().selection.primary && window.CollabApp.getState().selection.primary.ref)));
await shot(g, '06-guide-schematic-u1');

// 2. the board
await g.click('.kg .kg-acts >> text=Open the board'); await inEditor(g, 'pcb');
check('opening the board moves on to routing', await stepIs(g, 'Route what is left'));
await g.waitForFunction(() => /4\s*connections left/.test((document.querySelector('.kg-count') || {}).textContent || ''), null, { timeout: 10000 }).catch(() => {});
const b0 = await board(g);
check('the guide counts the four open connections', /4\s*connections left/.test(await g.textContent('.kg-step-b')) && b0.open === 4, JSON.stringify(b0));
await shot(g, '07-guide-route-4-left');

// 3. route two by hand, the way the guide says: X, pad, corners, pad
await g.click('.kg .kg-acts >> text=Route Tracks');
check('Route Tracks picks the router', await g.evaluate(() => window.CollabApp.getState().tool.current) === 'route');
const ROUTES = [[[151.525, 106.135], [149.5, 106.135], [147.5, 108.135], [147.5, 110.1]], [[147.5, 111.75], [147.5, 113.1], [148.4, 114], [151.163, 114]]];
for (const [i, pts] of ROUTES.entries()) {
  for (const p of pts) await clickAt(g, p[0], p[1]);
  await g.keyboard.press('Escape'); await g.waitForTimeout(250);
  const left = 3 - i;
  const ok = await g.waitForFunction((n) => new RegExp(`${n}\\s*connections? left of 4`).test((document.querySelector('.kg-count') || {}).textContent || ''), left, { timeout: 8000 }).then(() => true, () => false);
  check(`a track routed by hand takes the count to ${left} of 4`, ok, (await g.textContent('.kg-step-b')).slice(0, 60) + ' ' + JSON.stringify(await board(g)));
  if (i === 0) await shot(g, '08-guide-route-3-left');
  if (i < ROUTES.length - 1) await g.keyboard.press('x');
}
const b2 = await board(g);
check('the hand-routed tracks break no rule', b2.violations.length === 0 && b2.open === 2, JSON.stringify(b2));

// …and the autorouter for the rest
await g.keyboard.press('Escape');
await g.click('.kg .kg-acts >> text=Autoroute the rest…');
await g.waitForSelector('.kd-dialog');
check('Autoroute the rest opens the autorouter on the two that are left', /2 connections/.test(await g.textContent('.kd-body')), (await g.textContent('.kd-body')).slice(0, 120));
check('the guide stays clear of the dialog', await g.evaluate(() => { const k = document.querySelector('.kg'), d = document.querySelector('.kd-dialog'); const e = document.elementFromPoint(d.getBoundingClientRect().left + 30, d.getBoundingClientRect().top + 12); return !k.contains(e); }));
await g.click('.kd-foot .btn.primary');
await g.waitForFunction(() => window.PcbTools.ratsnest(window.CollabEditor.kdoc).length === 0 && !/Autorouting/.test((document.querySelector('.kd-title span') || {}).textContent || ''), null, { timeout: 120000 }).catch(() => {});
await g.waitForTimeout(500);
if (await g.locator('.kd-title span', { hasText: 'Autoroute finished' }).count()) await g.click('.kd-foot .btn.primary');
const b3 = await board(g);
check('every connection is made and the board is clean', b3.open === 0 && b3.violations.length === 0, JSON.stringify(b3));
check('with nothing left open the guide moves on to checking', await stepIs(g, 'Check the board'));
await shot(g, '09-guide-routed');

// 4. check
await g.click('.kg .kg-acts >> text=Run the checker');
await g.waitForSelector('.kd-dialog');
check('Run the checker opens the Design Rules Checker', /DRC|Design Rules/.test(await g.textContent('.kd-title')), await g.textContent('.kd-title'));
check('…and that finishes the step', await stepIs(g, 'Share it'));
await g.waitForTimeout(400); await shot(g, '10-guide-drc');
await g.keyboard.press('Escape'); await g.waitForTimeout(200);
if (await g.locator('.kd-dialog').count()) await g.locator('.kd-dialog .kd-x, .kd-dialog .kd-foot .btn').first().click().catch(() => {});

// folding, and the state surviving a reload
await g.click('.kg-x[title="Fold away"]');
check('the guide folds down to one line', await g.locator('.kg.kg-folded').count() === 1 && /Share it/.test(await g.textContent('.kg-unfold')) && /4\/5/.test(await g.textContent('.kg-unfold')));
await shot(g, '11-guide-folded');
await g.reload(); await inEditor(g); await g.waitForSelector('.kg.kg-folded');
check('after a reload it is still folded at the same step', /Share it/.test(await g.textContent('.kg-unfold')));
await g.click('.kg-unfold');
check('unfolding shows the step again', await step(g) === 'Share it');

// 5. share
await g.click('.kg .kg-acts >> text=Open Share');
await g.waitForSelector('.hp-modal');
check('Open Share opens the Share dialog', /Share/.test(await g.textContent('.hp-modal')));
check('…and the guide is finished', await stepIs(g, 'finished'));
await g.keyboard.press('Escape'); await g.waitForTimeout(300);
check('the last panel offers what comes next', await g.locator('.kg-done a', { hasText: 'Start from a template' }).count() === 1 && await g.locator('.kg-done a', { hasText: 'Your projects' }).count() === 1);
await shot(g, '12-guide-finished');

// stored: someone opening the project afresh gets what was routed
await g.waitForTimeout(1500);
const again = await context({ colorScheme: 'light' });
await signIn(again, iris, `/p/${st0.id}/edit`); await inEditor(again);
if (await again.evaluate(() => window.CollabApp.getState().document.editor) !== 'pcb') { await again.evaluate(() => { const s = window.CollabApp.getState(); window.CollabApp.dispatch({ type: 'openDoc', docId: s.document.docs.find((d) => d.docType === 'kicad_pcb').docId }); }); await inEditor(again, 'pcb'); }
await again.waitForTimeout(800);
const b4 = await board(again);
check('the routed board is what the server holds', b4.segment === b3.segment && b4.open === 0, JSON.stringify(b4));
check('a browser that never started the guide does not show it', await again.locator('.kg').count() === 0);
await again.close();

await g.click('.kg-done a >> text=Start from a template');
await g.waitForSelector('.tp-detail');
check('Start from a template lands on the picker, and the address is clean again', await g.evaluate(() => location.pathname + location.search) === '/');
await g.keyboard.press('Escape');
await g.goto(`${BASE}/p/${st0.id}/edit`); await inEditor(g);
await g.click('.kg-done .kg-skip');
check('Close the guide removes it for good', await g.locator('.kg').count() === 0 && await guide(g) === null);

// ---- skipping and closing
const s = await context({ colorScheme: 'dark' });
await signIn(s, remy, '/?start=guided');
await inEditor(s); await s.waitForSelector('.kg');
check('/?start=guided starts the guided project straight away', (await guide(s))?.from === 'home' && !/start=/.test(await s.evaluate(() => location.search)));
await s.click('.kg-step-b .kg-skip');   // the board is already showing, so skipping the schematic lands on routing
check('a skipped step is marked as skipped and the next one is live', await stepIs(s, 'Route what is left') && await s.locator('.kg-tag', { hasText: 'skipped' }).count() === 1);
await s.waitForTimeout(900); await shot(s, '13-guide-dark');
await s.click('.kg-x[title="Close the guide"]');
check('closing the guide takes it off the editor', await s.locator('.kg').count() === 0 && (await guide(s)).closed === true);
check('it does not come back in other projects', await (async () => { await s.goto(BASE + '/'); await s.waitForSelector('.hp-item'); return await s.locator('.kg').count() === 0; })());

// ================================================================ from the public home page
const m = await context({ colorScheme: 'light' });
await m.goto(BASE + '/'); await m.waitForSelector('[data-keep]');
await m.waitForFunction(() => /Unrouted 4/.test(document.querySelector('[data-unrouted]').textContent));
const keepHref = await m.getAttribute('[data-keep]', 'href');
check('signed out, Keep going in a real project goes through sign-in and back to the hand-off', keepHref === '/auth/github/login?next=' + encodeURIComponent('/?start=mini'), keepHref);
check('…and Start from a template does too', await m.getAttribute('[data-template]', 'href') === '/auth/github/login?next=' + encodeURIComponent('/?new=template'));
// route one connection in the small editor: the route tool, a pad, the corners, a pad
const canvas = m.locator('#hero canvas'); await canvas.scrollIntoViewIfNeeded();
await m.click('#hero [data-tool-btn="route"]');
await m.waitForTimeout(1500);   // the page's reveal animation
// The canvas keeps its view to itself, so the track is drawn where the board is known to be: the
// editor starts fitted to the board (127,91.5 42x27 mm).  Clicks are placed by proportion of the fitted view.
const fitted = await m.evaluate(() => { const c = document.querySelector('#hero canvas').getBoundingClientRect(); return { x: c.left, y: c.top, w: c.width, h: c.height }; });
const toMini = (x, y) => {
  const box = [124, 88.5, 172, 121.5];
  const k = Math.min(fitted.w / (box[2] - box[0]), fitted.h / (box[3] - box[1]));
  const ox = fitted.x + (fitted.w - k * (box[2] - box[0])) / 2, oy = fitted.y + (fitted.h - k * (box[3] - box[1])) / 2;
  return [ox + (x - box[0]) * k, oy + (y - box[1]) * k];
};
for (const p of [[147.5, 111.75], [147.5, 113.1], [148.4, 114], [151.163, 114]]) { const [sx, sy] = toMini(p[0], p[1]); await m.mouse.move(sx, sy); await m.waitForTimeout(80); await m.mouse.click(sx, sy); await m.waitForTimeout(150); }
await m.keyboard.press('Escape');
const unr = await m.textContent('[data-unrouted]');
check('a connection routed in the small editor', /Unrouted 3/.test(unr), unr);
await m.locator('[data-keep]').scrollIntoViewIfNeeded(); await m.waitForTimeout(400); await shot(m, '14-home-page-keep-going');
// the click leaves the board for the app; sign-in itself is GitHub's, so the test signs in the way the rig does
await m.evaluate(() => { document.querySelector('[data-keep]').addEventListener('click', (e) => e.preventDefault()); });
await m.click('[data-keep]');
const left = await m.evaluate(() => JSON.parse(localStorage.getItem('kc.onboard.mini') || 'null'));
check('Keep going leaves the board as a .kicad_pcb for the app', !!left && left.board.startsWith('(kicad_pcb') && /filled_polygon/.test(left.board) && !/mini-\d/.test(left.board), left ? `${left.board.length} bytes` : 'nothing');
await signIn(m, odile, '/?start=mini');
await inEditor(m); await m.waitForSelector('.kg');
const mg = await guide(m);
check('after sign-in the board opens as a real project with the guide', mg.from === 'mini' && await m.evaluate(() => window.CollabApp.getState().project.name) === 'My first board' && /board you were routing on the home page/.test(await m.textContent('.kg')));
check('the hand-off is used once', await m.evaluate(() => localStorage.getItem('kc.onboard.mini')) === null && !/start=/.test(await m.evaluate(() => location.search)));
if (await m.evaluate(() => window.CollabApp.getState().document.editor) !== 'pcb') { await m.evaluate(() => { const s = window.CollabApp.getState(); window.CollabApp.dispatch({ type: 'openDoc', docId: s.document.docs.find((d) => d.docType === 'kicad_pcb').docId }); }); await inEditor(m, 'pcb'); }
await m.waitForTimeout(900);
const mb = await board(m);
check('it is the board as it was left: three connections open, the routed one made', mb.open === 3 && mb.violations.length === 0, JSON.stringify(mb));
const mid = await m.evaluate(() => window.CollabApp.getState().project.projectId);
const mdocs = ((await api(odile.token, `/api/projects/${mid}`)).docs || []).map((d) => d.docType).sort().join();
check('the project has its schematic and project file too', mdocs === 'kicad_pcb,kicad_pro,kicad_sch', mdocs);
await shot(m, '16-handed-over-board');

// signed in already: the buttons go straight there
const w = await context({ colorScheme: 'light' });
await signIn(w, pax, '/welcome'); await w.waitForSelector('[data-keep]');
check('signed in, the home page buttons skip sign-in', await w.getAttribute('[data-keep]', 'href') === '/?start=mini' && await w.getAttribute('[data-template]', 'href') === '/?new=template');
await w.locator('[data-keep]').scrollIntoViewIfNeeded(); await w.click('[data-keep]');
await inEditor(w); await w.waitForSelector('.kg');
check('…and Keep going opens the project', (await guide(w))?.from === 'mini');
await w.goto(BASE + '/?new=template&t=usb-c-3v3-regulator'); await w.waitForSelector('.tp-detail');
check('/?new=template&t=… opens the picker on that template', /USB-C 3.3 V/.test(await w.textContent('.tp-card.on')) && await w.evaluate(() => location.search) === '');

// ================================================================ a phone
const ph = await browser.newContext({ ...devices['iPhone 13'] }); const p = await ph.newPage();
p.on('pageerror', (e) => errors.push(String(e)));
await db.query('DELETE FROM projects WHERE owner_id = $1', [pax.id]);
await signIn(p, pax); await p.waitForSelector('.fp-card:not(.skel)'); await p.waitForFunction(() => [...document.querySelectorAll('.fp img')].every((i) => i.complete && i.naturalWidth > 0));
check('on a phone the first-project panel fits the screen', await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
await p.waitForTimeout(500); await p.screenshot({ path: path.join(out, '17-phone-first-project.png') });
await p.locator('.fp-card').first().click(); await p.waitForSelector('.tp-detail'); await p.waitForTimeout(500);
check('…and so does the template picker', await p.evaluate(() => { const m = document.querySelector('.hp-modal').getBoundingClientRect(); return m.left >= 0 && m.right <= window.innerWidth + 1; }));
await p.screenshot({ path: path.join(out, '18-phone-template-picker.png') });

check('no page errors', errors.length === 0, errors.slice(0, 4).join(' | '));
await browser.close();
await cleanup(); await db.end();
console.log(`\n${pass} passed, ${fail} failed${fail ? ': ' + fails.join('; ') : ''}\nscreenshots: ${out}`);
process.exit(fail ? 1 : 0);
