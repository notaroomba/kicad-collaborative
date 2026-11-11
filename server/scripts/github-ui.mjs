// Browser test of the GitHub page: drives the real page in Chromium through connect,
// import, push, pull, merge and link, at a desktop and a phone size, and saves a
// screenshot of each step.  Same setup as github-e2e.mjs (local server with
// KC_DEV_LOGIN=1, throwaway database, fake-github.mjs), plus Playwright.
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… [SHOTS=/some/dir] node github-ui.mjs
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';

const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const GH = (process.env.E2E_FAKE_GH || 'http://127.0.0.1:8098').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
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
const ctl = async (what, body) => (await fetch(`${GH}/__ctl/${what}`, body
  ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();

// ---------------------------------------------------------------- fixtures
const fp = (ref, uuid, x, y, value) => `\t(footprint "Resistor_SMD:R_0603"\n\t\t(layer "F.Cu")\n\t\t(uuid "${uuid}")\n\t\t(at ${x} ${y})\n\t\t(property "Reference" "${ref}"\n\t\t\t(at 0 -1.4 0)\n\t\t)\n\t\t(property "Value" "${value}"\n\t\t\t(at 0 1.4 0)\n\t\t)\n\t)\n`;
const board = (items) => `(kicad_pcb\n\t(version 20241229)\n\t(generator "pcbnew")\n\t(generator_version "9.0")\n\t(paper "A4")\n${items.join('')})\n`;
const R1 = '11111111-0000-4000-8000-000000001111', R2 = '22222222-0000-4000-8000-000000002222';
const PCB0 = board([fp('R1', R1, 100, 50, '10k'), fp('R2', R2, 110, 50, '4k7')]);
const SCH0 = `(kicad_sch\n\t(version 20250114)\n\t(generator "eeschema")\n\t(uuid "aaaaaaaa-0000-4000-8000-00000000aaaa")\n\t(paper "A4")\n)\n`;
const PRO0 = '{\n  "meta": { "filename": "preamp.kicad_pro", "version": 3 }\n}\n';

await ctl('reset', {});
const GH_ID = 9201;
const userId = (await db.query(
  `INSERT INTO users (github_id, login, name) VALUES ($1, 'ui-dana', 'Dana')
   ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [GH_ID])).rows[0].id;
await db.query('DELETE FROM github_tokens WHERE user_id = $1', [userId]);
await db.query('DELETE FROM projects WHERE owner_id = $1', [userId]);
const jwt = mintJwt(userId, 'ui-dana');
await ctl('user', { login: 'ui-dana', id: GH_ID });
await ctl('browser', { login: 'ui-dana' });
await ctl('repo', { fullName: 'ui-dana/preamp', isPrivate: true, files: {
  'README.md': '# preamp\n', 'hardware/preamp.kicad_pro': PRO0, 'hardware/preamp.kicad_pcb': PCB0,
  'hardware/preamp.kicad_sch': SCH0, 'hardware/power.kicad_sch': SCH0, 'firmware/main.c': 'int main(){}',
  'panel/panel.kicad_pro': '{}', 'panel/panel.kicad_pcb': board([]) } });
await ctl('repo', { fullName: 'ui-dana/dotfiles', files: { 'README.md': 'x' } });
await ctl('repo', { fullName: 'ui-dana/led-matrix', files: { 'led.kicad_pro': '{}', 'led.kicad_pcb': board([]) } });

const saveOnline = async (docId, content) => {
  const { rows } = await db.query(
    `SELECT GREATEST(COALESCE((SELECT MAX(seq) FROM ops WHERE doc_id = $1), 0),
                     COALESCE((SELECT MAX(seq) FROM snapshots WHERE doc_id = $1), 0)) AS head`, [docId]);
  await db.query('INSERT INTO snapshots (doc_id, seq, content) VALUES ($1, $2, $3)', [docId, rows[0].head + 1, Buffer.from(content)]);
};

// ---------------------------------------------------------------- browser
const browser = await chromium.launch();
const errors = [];
async function open(viewport, scale) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: scale, colorScheme: 'light' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|fonts\.g|ERR_|40[0-9]|status of 4/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.goto(`${BASE}/auth/dev?jwt=${jwt}&next=/github`);
  return page;
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };
/** No element may poke out of the viewport sideways (the phone layout must not scroll horizontally). */
const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

try {
  const page = await open({ width: 1180, height: 820 }, 2);

  // ---- connect
  await page.waitForSelector('#ghConnect');
  check('signed in but not connected: the page offers to connect', await page.isVisible('#ghConnectPublic'));
  await shot(page, '01-connect');
  await page.click('#ghConnect');
  await page.waitForSelector('#ghDisconnect');
  check('connect round trip lands back on the page, connected', page.url() === `${BASE}/github`);

  // ---- pick a repository, scan, import
  await page.waitForSelector('[data-repo="ui-dana/preamp"]');
  check('repositories are listed', await page.locator('#repoList .it').count() === 3);
  await page.fill('#repoQ', 'pre');
  check('typing filters the list', await page.locator('#repoList .it').count() === 1);
  await page.click('[data-repo="ui-dana/preamp"]');
  await page.waitForSelector('[data-import]');
  check('scan lists the two KiCad projects in the repository', await page.locator('[data-import]').count() === 2);
  await shot(page, '02-import');
  await page.click('[data-import="0"]');
  await page.waitForURL(/\/p\/[0-9a-f-]{36}\/github$/);
  await page.waitForSelector('table.files');
  const pid = page.url().match(/\/p\/([0-9a-f-]{36})/)[1];
  check('import opens the project\'s sync page, all in sync', (await page.textContent('.chip.synced b')) === '4' && await page.isDisabled('#push') && await page.isDisabled('#pull'));
  await shot(page, '03-in-sync');

  // ---- changes on both sides
  const docs = Object.fromEntries((await db.query('SELECT path, id FROM documents WHERE project_id = $1', [pid])).rows.map((r) => [r.path, r.id]));
  await saveOnline(docs['preamp.kicad_sch'], SCH0.replace('"A4"', '"A3"'));                           // online only
  await saveOnline(docs['preamp.kicad_pcb'], PCB0.replace('"4k7"', '"5k1"').replace('(at 100 50)', '(at 1 1)'));   // online: R2 value, R1 moved
  await ctl('commit', { fullName: 'ui-dana/preamp', author: 'sam', message: 'Move R1 and R2, add the amp stage', files: {
    'hardware/preamp.kicad_pcb': PCB0.replace('(at 110 50)', '(at 120 60)').replace('(at 100 50)', '(at 2 2)'),  // GitHub: R2 moved, R1 moved elsewhere
    'hardware/power.kicad_sch': SCH0.replace('"A4"', '"A2"'),                                                 // GitHub only
    'hardware/amp.kicad_sch': SCH0 } });                                                                     // new on GitHub
  await page.click('#refresh');
  await page.waitForSelector('.chip.conflict b');
  await page.waitForFunction(() => document.querySelector('.chip.pull b')?.textContent === '2');
  const chips = await page.$$eval('.chip b', (els) => els.map((e) => e.textContent).join(','));
  check('the page shows what differs: 1 to push, 2 to pull, 1 changed on both, 1 in sync', chips === '1,2,1,1', chips);
  check('the file changed on both sides offers a choice, defaulting to merge', (await page.inputValue('[data-resolve="preamp.kicad_pcb"]')) === 'merge');
  await page.click('[data-diff="preamp.kicad_pcb"]');
  await page.waitForSelector('ul.changes');
  const sides = await page.$$eval('.diffrow .side', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  check('"Changes" lists what each side did to the file', sides.length === 2 && /Changed online \(2\).*footprint R1 — at.*footprint R2 — property Value/.test(sides[0]) && /Changed on GitHub \(2\).*footprint R1 — at.*footprint R2 — at/.test(sides[1]), sides.join(' || '));
  await shot(page, '04-changes');

  // ---- pull (with a merge)
  await page.click('#pull');
  await page.waitForSelector('#result .note.ok');
  const result = await page.textContent('#result');
  check('pull reports the merge and the one item both sides changed', /preamp\.kicad_pcb — merged/.test(result) && /footprint R1 › at — kept the online version/.test(result) && /amp\.kicad_sch — added/.test(result), result);
  check('…and says where the previous versions went', /kept in History/.test(result));
  await page.waitForFunction(() => document.querySelector('.chip.push b')?.textContent === '2');
  await shot(page, '05-pulled');
  const merged = (await db.query('SELECT content FROM snapshots WHERE doc_id = $1 ORDER BY seq DESC LIMIT 1', [docs['preamp.kicad_pcb']])).rows[0].content.toString();
  check('the merged board has both sides\' changes', merged === PCB0.replace('"4k7"', '"5k1"').replace('(at 100 50)', '(at 1 1)').replace('(at 110 50)', '(at 120 60)'), merged);

  // ---- push
  await page.fill('#msg', 'Merge online edits');
  await page.click('#push');
  await page.waitForSelector('#result .note.ok');
  await page.waitForFunction(() => document.querySelector('.chip.synced b')?.textContent === '5');
  check('push reports the commit and everything is in sync', /Pushed 2 files to main/.test(await page.textContent('#result')));
  const gh = await ctl('files?repo=ui-dana/preamp');
  check('GitHub holds the merged board under our commit message', gh.files['hardware/preamp.kicad_pcb'] === merged && gh.message === 'Merge online edits');
  check('the commit shows in the recent commits', (await page.textContent('.commit .msg')) === 'Merge online edits');
  await shot(page, '06-pushed');

  // ---- pull request
  await saveOnline(docs['preamp.kicad_sch'], SCH0.replace('"A4"', '"A1"'));
  await page.click('#refresh');
  await page.waitForFunction(() => document.querySelector('.chip.push b')?.textContent === '1');
  await page.check('#asPr');
  await page.click('#push');
  await page.waitForSelector('#result a[href*="/pull/"]');
  check('push as a pull request links to it', /pull request #1/.test(await page.textContent('#result')));
  await shot(page, '07-pull-request');

  // ---- phone
  const phone = await open({ width: 390, height: 844 }, 2);
  await phone.goto(`${BASE}/p/${pid}/github`);
  await phone.waitForSelector('table.files');
  check('phone: the sync page fits the screen width', await fits(phone));
  check('phone: buttons are finger-sized', (await phone.locator('#push').boundingBox()).height >= 40);
  await phone.click('[data-diff="preamp.kicad_sch"]');
  await phone.waitForSelector('ul.changes');
  check('phone: an open change list still fits the screen width', await fits(phone));
  await shot(phone, '08-phone-sync');
  await phone.goto(`${BASE}/github`);
  await phone.waitForSelector('[data-repo="ui-dana/preamp"]');
  await phone.click('[data-repo="ui-dana/preamp"]');
  await phone.waitForSelector('[data-import]');
  check('phone: the import page fits the screen width', await fits(phone));
  await shot(phone, '09-phone-import');

  // ---- dark theme: the editor's saved choice (kui.theme) and the OS preference both apply
  const lum = (pg) => pg.evaluate(() => {
    const rgb = (el) => getComputedStyle(el).backgroundColor.match(/\d+/g).slice(0, 3).map(Number).reduce((a, b) => a + b, 0) / 3;
    return { page: rgb(document.body), box: rgb(document.querySelector('.box')), ink: getComputedStyle(document.body).color.match(/\d+/g).slice(0, 3).map(Number).reduce((a, b) => a + b, 0) / 3 };
  });
  const light = await lum(page);
  check('light theme: light surfaces, dark text', light.page > 200 && light.box > 200 && light.ink < 80, JSON.stringify(light));
  await page.evaluate(() => localStorage.setItem('kui.theme', 'dark'));
  await page.reload();
  await page.waitForSelector('table.files');
  await page.click('[data-diff="preamp.kicad_sch"]');
  await page.waitForSelector('ul.changes');
  const dark = await lum(page);
  check('the editor\'s dark theme choice carries over to this page', dark.page < 60 && dark.box < 60 && dark.ink > 180, JSON.stringify(dark));
  await shot(page, '08b-dark');
  await page.evaluate(() => localStorage.removeItem('kui.theme'));
  await page.reload();
  await page.waitForSelector('table.files');
  const osDark = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const dp = await osDark.newPage();
  await dp.goto(`${BASE}/auth/dev?jwt=${jwt}&next=/p/${pid}/github`);
  await dp.waitForSelector('table.files');
  const od = await lum(dp);
  check('an OS in dark mode gets the dark theme without choosing', od.page < 60 && od.ink > 180, JSON.stringify(od));
  await shot(dp, '08c-phone-dark');
  await osDark.close();

  // ---- linking a project that is not linked yet; unlink
  await page.click('#unlink');
  await page.waitForSelector('#doLink');
  check('unlink returns to the link form', await page.isDisabled('#doLink'));
  await page.click('#mode [data-v="new"]');
  check('a new repository is named after the project', (await page.inputValue('#newName')) === 'preamp');
  await page.fill('#newName', 'preamp-rev-b');
  await page.fill('#lPath', 'hardware');
  await shot(page, '10-link-form');
  await phone.goto(`${BASE}/p/${pid}/github`);
  await phone.waitForSelector('#doLink');
  check('phone: the link form fits the screen width', await fits(phone));
  await shot(phone, '11-phone-link');
  await page.click('#doLink');
  await page.waitForSelector('table.files');
  check('linking to a new repository shows everything waiting to be pushed', (await page.textContent('.chip.push b')) === '5');
  check('…and the repository now exists on GitHub, private', (await ctl('state?repo=ui-dana/preamp-rev-b')).branches.main !== undefined);
  await page.click('#push');
  await page.waitForFunction(() => document.querySelector('.chip.synced b')?.textContent === '5');
  check('first push fills the new repository', Object.keys((await ctl('files?repo=ui-dana/preamp-rev-b')).files).filter((p) => p.startsWith('hardware/')).length === 5);

  // ---- push on every checkpoint
  await page.check('#autoPush');
  await page.waitForFunction(() => document.querySelector('#autoPush')?.checked && !document.querySelector('#autoPush').disabled);
  const pcbDoc = (await db.query(`SELECT id FROM documents WHERE project_id = $1 AND path LIKE '%.kicad_pcb' LIMIT 1`, [pid])).rows[0].id;
  const curPcb = (await db.query('SELECT content, seq FROM snapshots WHERE doc_id = $1 ORDER BY seq DESC LIMIT 1', [pcbDoc])).rows[0];
  await db.query('INSERT INTO snapshots (doc_id, seq, content) VALUES ($1, $2, $3)', [pcbDoc, curPcb.seq + 1, Buffer.from(curPcb.content.toString().replace('"10k"', '"12k"'))]);
  const cp = await page.evaluate(async (id) => (await fetch(`/api/projects/${id}/checkpoints`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Rev B release' }) })).json(), pid);
  check('saving a checkpoint starts a push to GitHub', cp.githubPush === true, JSON.stringify(cp));
  await page.waitForTimeout(800);
  await page.click('#refresh');
  await page.waitForSelector('#lastAuto');
  check('the sync page says what the checkpoint pushed', /Rev B release/.test(await page.textContent('#lastAuto')) && /Pushed 1 file/.test(await page.textContent('#lastAuto')), await page.textContent('#lastAuto'));
  check('…and the commit is on GitHub under the checkpoint\'s name', (await ctl('files?repo=ui-dana/preamp-rev-b')).message === 'Checkpoint: Rev B release');
  await shot(page, '14-auto-push');

  // ---- the project list shows which projects are linked
  await page.goto(`${BASE}/`);
  await page.waitForSelector('.hp-item-gh');
  check('the project list names the linked repository', /preamp-rev-b/.test(await page.textContent('.hp-item-gh')));
  await shot(page, '15-home-badge');
  await page.goto(`${BASE}/p/${pid}/github`);
  await page.waitForSelector('#refresh');

  // ---- error surfaces
  await ctl('revoke', { login: 'ui-dana' });
  await page.click('#refresh');
  await page.waitForSelector('.note.err');
  check('a revoked connection is explained on the page', /Connect your repositories again/.test(await page.textContent('.note.err')));
  await shot(page, '12-revoked');

  // ---- the editor's File menu leads here
  await page.goto(`${BASE}/p/${pid}/edit`);
  await page.waitForSelector('#ui-menubar');
  await page.getByText('File', { exact: true }).first().click();
  const item = page.getByText('GitHub Sync…', { exact: true }).first();
  check('the editor\'s File menu has "GitHub Sync…"', await item.isVisible().catch(() => false));
  await shot(page, '13-editor-menu');
  await item.click();
  await page.waitForURL(/\/github$/).catch(() => {});
  check('…which opens the project\'s sync page', page.url() === `${BASE}/p/${pid}/github`, page.url());

  check('no script errors on any page', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('browser run completed', false, e.stack || String(e));
} finally {
  await browser.close();
  await db.query('DELETE FROM projects WHERE owner_id = $1', [userId]).catch(() => {});
  await db.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
  await db.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
