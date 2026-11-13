// Fonts between the desktop schematic editor and a browser, without a screen.
//
// One real eeschema (Xvfb) and one headless browser share a project whose text is set in a
// Google Font and in a font that only the desktop computer has.  Needs what the README
// lists, plus `npm install --no-save pg` in server/scripts.
//
//   node fonts.mjs setup          project on the server, a linked local copy, fresh caches
//   node fonts.mjs launch         eeschema on display :93 (first run: click the wizard away)
//   node fonts.mjs opened         what the desktop fetched and uploaded by itself
//   node fonts.mjs web-sets       the browser sets a text in Lobster; the desktop follows
//   node fonts.mjs desktop-set    after choosing a font in the desktop dialog: the browser follows
//   node fonts.mjs shot <name>    a picture of the desktop
//   node fonts.mjs alone          no project at all: a Google Font straight from Google
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const require = createRequire(new URL('../package.json', import.meta.url));
const RIG = process.env.RIG || '/tmp/claude-0/fontrig';
const BUILD = process.env.RIG_BUILD || '/home/claude/build';
const BASE = 'http://127.0.0.1:8099', SECRET = 'testsecret';
const PG_URL = 'postgres://postgres:test@127.0.0.1:5432/collabtest';
const DISP = ':93', NAME = 'fontrig';
const SHOTS = process.env.SHOTS || `${RIG}/shots`;
const LOCAL_FACE = process.env.RIG_LOCAL_FACE || 'DejaVu Serif';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t = Date.now(); for (;;) { if (await fn()) return true; if (Date.now() - t > ms) return false; await sleep(300); } };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintJwt(sub, login) {
  const now = Math.floor(Date.now() / 1000), head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, login, iat: now, exp: now + 86400 })}`;
  return `${head}.${crypto.createHmac('sha256', SECRET).update(head).digest('base64url')}`;
}
const api = async (tok, url, o = {}) => {
  const r = await fetch(BASE + url, { method: o.method || (o.json ? 'POST' : 'GET'), headers: { Authorization: `Bearer ${tok}`, ...(o.json ? { 'Content-Type': 'application/json' } : {}) }, body: o.json ? JSON.stringify(o.json) : o.body });
  const buf = Buffer.from(await r.arrayBuffer()); let j = null; try { j = JSON.parse(buf.toString('utf8')); } catch { /* not JSON */ }
  return { status: r.status, j, buf, headers: r.headers };
};
const rig = () => JSON.parse(fs.readFileSync(`${RIG}/rig.json`, 'utf8'));
const log = () => { try { return fs.readFileSync(`${RIG}/eeschema.log`, 'utf8'); } catch { return ''; } };
const fetched = () => { try { return fs.readdirSync(`${RIG}/cache/kicad/10.99/fonts`).sort(); } catch { return []; } };
const xenv = { ...process.env, DISPLAY: DISP };
const shot = (name) => { fs.mkdirSync(SHOTS, { recursive: true }); execFileSync('import', ['-window', 'root', `${SHOTS}/${name}.png`], { env: xenv }); };

const text = (s, y, face, id) => `  (text "${s}" (exclude_from_sim no) (at 30 ${y} 0) (effects (font ${face ? `(face "${face}") ` : ''}(size 9 9)) (justify left bottom)) (uuid "6c2d2e7f-0000-4000-8000-00000000000${id}"))\n`;
const SCH = `(kicad_sch (version 20250114) (generator "eeschema") (generator_version "9.0") (uuid "6c2d2e7f-0000-4000-8000-000000000001") (paper "A4")
  (lib_symbols)
${text('Pacifico, a Google Font', 45, 'Pacifico', 2)}${text('Set by the browser', 75, '', 3)}${text('A font from this computer', 105, LOCAL_FACE, 4)}${text('Chosen in the desktop dialog', 135, '', 5)}  (sheet_instances (path "/" (page "1")))
  (embedded_fonts no)
)
`;

async function browserAs(jwt, docId) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage(); page.setDefaultTimeout(15000);
  await page.goto(`${BASE}/auth/dev?jwt=${jwt}&next=${encodeURIComponent(`/p/${rig().pid}/edit?doc=${docId}`)}`);
  await page.waitForFunction(() => { const E = window.CollabEditor; return E && E.kdoc && E.kdoc.items.size > 1 && E.ws && E.ws.readyState === 1; }, null, { timeout: 60000 });
  await page.waitForTimeout(700);
  return { browser, page };
}
const faceOn = (page, face) => page.evaluate((face) => document.fonts.check(`20px "${face}"`) && [...document.fonts].some((f) => f.family.replace(/"/g, '') === face && f.status === 'loaded') && window.KiCadCanvas.faceAvailable(face), face);
const textItem = (page, re) => page.evaluate((src) => {
  const re = new RegExp(src);
  for (const it of window.CollabEditor.kdoc.items.values()) if (it.kind === 'text' && re.test(String(it.node[1]))) return { id: it.id, bbox: it.bbox, node: JSON.stringify(it.node) };
  return null;
}, re.source);
const scr = (page, x, y) => page.evaluate(([x, y]) => {
  const E = window.CollabEditor, r = document.querySelector('#world').getBoundingClientRect();
  const w = E.vb[2] / E.vbPerMm, h = E.vb[3] / E.vbPerMm;
  return [r.left + (x - E.vb[0] / E.vbPerMm) / w * r.width, r.top + (y - E.vb[1] / E.vbPerMm) / h * r.height];
}, [x, y]);

const cmd = process.argv[2];

if (cmd === 'setup') {
  const pg = require('pg'); pg.types.setTypeParser(20, (v) => parseInt(v, 10)); const db = new pg.Client({ connectionString: PG_URL, ssl: false }); await db.connect();
  const mkUser = async (gh, login) => (await db.query(`INSERT INTO users (github_id, login, name) VALUES ($1, $2, $2) ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [gh, login])).rows[0].id;
  await db.query(`DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE github_id IN (-9401, -9402))`);
  const alice = mintJwt(await mkUser(-9401, 'font-alice'), 'font-alice'), bob = mintJwt(await mkUser(-9402, 'font-bob'), 'font-bob');
  await db.end();
  for (const d of ['a', 'cache', 'shots']) fs.rmSync(`${RIG}/${d}`, { recursive: true, force: true });
  const dir = `${RIG}/a/${NAME}`; fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(`${RIG}/cache`, { recursive: true });
  fs.writeFileSync(`${dir}/${NAME}.kicad_sch`, SCH);
  fs.writeFileSync(`${dir}/${NAME}.kicad_pro`, JSON.stringify({ meta: { filename: `${NAME}.kicad_pro`, version: 3 } }, null, 2));
  execFileSync('zip', ['-q', '-j', `${RIG}/p.zip`, `${dir}/${NAME}.kicad_sch`, `${dir}/${NAME}.kicad_pro`]);
  const form = new FormData(); form.append('name', NAME); form.append('archive', new Blob([fs.readFileSync(`${RIG}/p.zip`)]), 'p.zip');
  const created = await api(alice, '/api/projects', { method: 'POST', body: form });
  const pid = created.j.projectId, sch = created.j.docs.find((d) => d.docType === 'kicad_sch');
  const link = await api(alice, `/api/projects/${pid}/links`, { json: { role: 'editor' } });
  await api(bob, `/api/join/${link.j.token}`, { method: 'POST' });
  fs.mkdirSync(`${dir}/${NAME}.collab`, { recursive: true });
  fs.writeFileSync(`${dir}/${NAME}.collab/link.json`, JSON.stringify({ server: BASE, projectId: pid }));
  fs.writeFileSync(`${RIG}/rig.json`, JSON.stringify({ alice, bob, pid, docId: sch.docId }, null, 1));
  console.log(pid, sch.docId);
} else if (cmd === 'launch' || cmd === 'alone') {
  try { execFileSync('pgrep', ['-f', `Xvfb ${DISP}`]); } catch {
    spawn('Xvfb', [DISP, '-screen', '0', '1600x1000x24'], { detached: true, stdio: 'ignore' }).unref(); await sleep(1000);
    spawn('openbox', [], { detached: true, stdio: 'ignore', env: xenv }).unref(); await sleep(500);
  }
  let file = `${RIG}/a/${NAME}/${NAME}.kicad_sch`;
  const env = { ...xenv, KICAD_CONFIG_HOME: `${RIG}/cfg`, KICAD_CACHE_HOME: `${RIG}/cache`, KICAD_RUN_FROM_BUILD_DIR: '1', KICAD_LOG_TO_STDERR: '1', WXTRACE: 'COLLAB_FONTS', KICAD_COLLAB_SERVER: BASE };
  if (cmd === 'alone') {
    // Not an online project, and no token to reach one with.
    fs.rmSync(`${RIG}/alone`, { recursive: true, force: true }); fs.mkdirSync(`${RIG}/alone`, { recursive: true });
    fs.rmSync(`${RIG}/cache/kicad/10.99/fonts`, { recursive: true, force: true });
    file = `${RIG}/alone/alone.kicad_sch`;
    fs.writeFileSync(file, SCH.replace('Pacifico, a Google Font', 'Lobster Two, no project').replace('"Pacifico"', '"Lobster Two"'));
    fs.writeFileSync(`${RIG}/alone/alone.kicad_pro`, JSON.stringify({ meta: { filename: 'alone.kicad_pro', version: 3 } }));
  } else {
    env.KICAD_COLLAB_TOKEN = rig().alice;
  }
  for (const f of fs.readdirSync(path.dirname(file))) if (/\.lck$/.test(f)) fs.rmSync(path.join(path.dirname(file), f));
  const out = fs.openSync(`${RIG}/eeschema.log`, 'w');
  spawn(`${BUILD}/eeschema/eeschema`, [file], { cwd: BUILD, env, detached: true, stdio: ['ignore', out, out] }).unref();
  console.log('started', file);
} else if (cmd === 'shot') {
  shot(process.argv[3] || 'desktop');
} else if (cmd === 'opened') {
  const { alice, bob, pid, docId } = rig();
  check('the desktop fetched Pacifico, which is not on this computer', await until(() => fetched().includes('Pacifico-Regular.ttf')), fetched().join(', '));
  const list = async () => ((await api(bob, `/api/projects/${pid}/fonts`)).j.fonts || []);
  check(`and uploaded ${LOCAL_FACE}, which only this computer has`, await until(async () => (await list()).some((f) => f.family === LOCAL_FACE)), JSON.stringify(await list()));
  const mine = (await list()).find((f) => f.family === LOCAL_FACE);
  check('with its bold and italic cuts', mine && mine.styles.length >= 2, JSON.stringify(mine));
  check('Pacifico is not stored a second time with the project', !(await list()).some((f) => f.family === 'Pacifico'));
  check('nothing it downloaded is offered back as an upload', !(await list()).some((f) => /Pacifico|Lobster/.test(f.family)));
  await sleep(1500); shot('10-desktop-opened');
  const { browser, page } = await browserAs(bob, docId);
  check('the browser draws the Google Font', await until(() => faceOn(page, 'Pacifico')));
  check(`and the font from the desktop computer (${LOCAL_FACE})`, await until(() => faceOn(page, LOCAL_FACE)));
  await page.waitForTimeout(500); await page.screenshot({ path: `${SHOTS}/11-browser-sees-the-desktop-font.png` });
  await browser.close();
  void alice;
} else if (cmd === 'web-sets') {
  const { bob, docId } = rig();
  const { browser, page } = await browserAs(bob, docId);
  const t = await textItem(page, /^Set by the browser$/);
  const [x, y] = await scr(page, (t.bbox[0] + t.bbox[2]) / 2, (t.bbox[1] + t.bbox[3]) / 2);
  await page.mouse.dblclick(x, y); await page.waitForSelector('.kd-dialog');
  await page.click('#kd-txt-font'); await page.waitForSelector('.kd-font-pop');
  await page.keyboard.type('lobster');
  await page.waitForFunction(() => { const r = document.querySelector('.kd-font-row.active'); return r && r.textContent === 'Lobster'; });
  await page.keyboard.press('Enter');
  await page.locator('.kd-foot button', { hasText: /^OK$/ }).click();
  await page.waitForFunction(() => !document.querySelector('.kd-dialog'));
  check('the browser set the text in Lobster', /\["face","Lobster"\]/.test((await textItem(page, /^Set by the browser$/)).node));
  check('the desktop, which did not have Lobster, fetched it', await until(() => fetched().includes('Lobster-Regular.ttf')), fetched().join(', '));
  await sleep(2500); shot('12-desktop-after-the-browser-chose-lobster');
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/13-browser-chose-lobster.png` });
  await browser.close();
} else if (cmd === 'desktop-set') {
  const face = process.argv[3] || 'Orbitron';
  const { bob, docId } = rig();
  const { browser, page } = await browserAs(bob, docId);
  check(`the browser has the text the desktop set in ${face}`, await until(async () => new RegExp(`\\["face","${face}"\\]`).test((await textItem(page, /^Chosen in the desktop dialog$/)).node)));
  check('and draws it in that font', await until(() => faceOn(page, face)));
  check('the desktop downloaded it when it was picked', fetched().some((f) => f.startsWith(face)), fetched().join(', '));
  await page.waitForTimeout(500); await page.screenshot({ path: `${SHOTS}/15-browser-after-the-desktop-chose-${face.toLowerCase()}.png` });
  await browser.close();
} else {
  console.log('setup | launch | opened | web-sets | desktop-set [face] | shot <name> | alone');
}
if (pass + fail) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
