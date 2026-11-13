// Fonts: the Google Fonts list, font files kept with a project, and the font choice of the web editor.
// Two people in two Chromium windows work on the same project; every step is checked in both.
//
// Needs a local server with KC_DEV_LOGIN=1 on a throwaway database, able to reach fonts.googleapis.com
// (behind a proxy with its own certificate authority: KC_EXTRA_CA_FILE=<bundle> on the server).
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… [SHOTS=/some/dir] node fonts-ui.mjs
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import pg from 'pg';

const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '';
// a font on this machine to stand for "a font from somebody's computer"
const LOCAL_FONT = process.env.E2E_LOCAL_FONT || '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf';
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
const mkUser = async (ghId, login, name) => (await db.query(
  `INSERT INTO users (github_id, login, name) VALUES ($1, $2, $3) ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [ghId, login, name])).rows[0].id;
const aliceId = await mkUser(9701, 'ft-alice', 'Alice'), bobId = await mkUser(9702, 'ft-bob', 'Bob'), carolId = await mkUser(9703, 'ft-carol', 'Carol');
await db.query('DELETE FROM projects WHERE owner_id = ANY($1)', [[aliceId, bobId, carolId]]);
const alice = mintJwt(aliceId, 'ft-alice'), bob = mintJwt(bobId, 'ft-bob'), carol = mintJwt(carolId, 'ft-carol');

const api = async (tok, url, o = {}) => {
  const r = await fetch(BASE + url, { method: o.method || (o.json ? 'POST' : 'GET'), headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...(o.json ? { 'Content-Type': 'application/json' } : {}), ...(o.headers || {}) }, body: o.json ? JSON.stringify(o.json) : o.body });
  const buf = Buffer.from(await r.arrayBuffer()); const t = buf.toString('utf8'); let j = t; try { j = JSON.parse(t); } catch { /* not JSON */ }
  return { status: r.status, j, text: t, buf, headers: r.headers };
};

// ---------------------------------------------------------------- fixtures
const SCH = `(kicad_sch (version 20250114) (generator "eeschema") (generator_version "9.0") (uuid "5b1c1d6e-0000-4000-8000-000000000001") (paper "A4")
  (lib_symbols)
  (text "Hello fonts" (exclude_from_sim no) (at 60 60 0) (effects (font (size 8 8)) (justify left bottom)) (uuid "5b1c1d6e-0000-4000-8000-000000000002"))
  (text "From my computer" (exclude_from_sim no) (at 60 85 0) (effects (font (face "Corp Serif Pro") (size 8 8)) (justify left bottom)) (uuid "5b1c1d6e-0000-4000-8000-000000000003"))
  (text "Bold italic Roboto" (exclude_from_sim no) (at 60 110 0) (effects (font (face "Roboto") (size 8 8) (bold yes) (italic yes)) (justify left bottom)) (uuid "5b1c1d6e-0000-4000-8000-000000000004"))
  (sheet_instances (path "/" (page "1")))
  (embedded_fonts no)
)
`;
const PCB = `(kicad_pcb (version 20241229) (generator "pcbnew") (generator_version "9.0")
  (general (thickness 1.6) (legacy_teardrops no))
  (paper "A4")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user "F.Silkscreen") (25 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "")
  (gr_rect (start 100 80) (end 160 120) (stroke (width 0.1) (type default)) (fill no) (layer "Edge.Cuts") (uuid "6c2d2e7f-0000-4000-8000-000000000001"))
  (gr_text "REV A" (at 130 100 0) (layer "F.SilkS") (uuid "6c2d2e7f-0000-4000-8000-000000000002") (effects (font (size 5 5) (thickness 0.6))))
  (embedded_fonts no)
)
`;
const dir = fs.mkdtempSync('/tmp/fonts-ui-');
fs.writeFileSync(path.join(dir, 'fonts.kicad_pro'), JSON.stringify({ meta: { filename: 'fonts.kicad_pro', version: 3 } }));
fs.writeFileSync(path.join(dir, 'fonts.kicad_sch'), SCH); fs.writeFileSync(path.join(dir, 'fonts.kicad_pcb'), PCB);
execSync(`cd "${dir}" && zip -qr p.zip fonts.kicad_pro fonts.kicad_sch fonts.kicad_pcb`);
const form = new FormData(); form.append('name', 'Fonts'); form.append('archive', new Blob([fs.readFileSync(path.join(dir, 'p.zip'))]), 'p.zip');
const created = await api(alice, '/api/projects', { method: 'POST', body: form });
const pid = created.j.projectId;
const sch = created.j.docs && created.j.docs.find((d) => d.docType === 'kicad_sch'), pcb = created.j.docs && created.j.docs.find((d) => d.docType === 'kicad_pcb');
check('project uploaded', created.status === 200 && !!sch && !!pcb, created.text.slice(0, 200));
const link = await api(alice, `/api/projects/${pid}/links`, { json: { role: 'editor' } });
await api(bob, `/api/join/${link.j.token}`, { method: 'POST' });
const fontUrl = (family, o = {}) => `/api/projects/${pid}/fonts/file?family=${encodeURIComponent(family)}&bold=${o.bold ? 1 : 0}&italic=${o.italic ? 1 : 0}${o.index !== undefined ? '&index=' + o.index : ''}${o.name ? '&name=' + encodeURIComponent(o.name) : ''}`;
const isFont = (buf) => buf.length > 1000 && (buf.readUInt32BE(0) === 0x00010000 || buf.subarray(0, 4).toString() === 'OTTO');
const tableOf = (buf, tag) => { const n = buf.readUInt16BE(4); for (let i = 0; i < n; i++) { const r = 12 + 16 * i; if (buf.subarray(r, r + 4).toString('latin1') === tag) return buf.readUInt32BE(r + 8); } return -1; };

// ---------------------------------------------------------------- the API on its own
{
  let r = await api(null, '/api/fonts/catalog');
  const fonts = r.j.fonts || [];
  check('the Google Fonts list is public and complete', r.status === 200 && fonts.length > 1800 && fonts.some((f) => f[0] === 'Roboto') && fonts.some((f) => f[0] === 'Noto Sans JP'), `${r.status} ${fonts.length}`);
  check('every family in it is under an open licence', fonts.every((f) => ['OFL-1.1', 'Apache-2.0', 'UFL-1.0', ''].includes(f[2])));

  r = await api(alice, fontUrl('Roboto', { bold: true, italic: true }));
  check('a Google Font is fetched by name, in the style asked for', r.status === 200 && isFont(r.buf) && r.headers.get('x-font-bold') === '1' && r.headers.get('x-font-italic') === '1' && r.headers.get('x-font-source') === 'google', `${r.status} ${r.text.slice(0, 120)}`);
  check('it is a static font file, not a variable one', tableOf(r.buf, 'fvar') < 0);
  const etag = r.headers.get('etag');
  const kept = (await db.query(`SELECT count(*)::int AS n FROM google_font_files WHERE family = 'Roboto' AND bold AND italic`)).rows[0].n;
  check('and kept on the server', kept === 1, String(kept));
  r = await api(alice, fontUrl('roboto', { bold: true, italic: true }), { headers: { 'If-None-Match': etag } });
  check('asking again with its tag costs nothing', r.status === 304, String(r.status));
  r = await api(alice, fontUrl('Lobster', { bold: true }));
  check('a family without a bold answers with its regular and says so', r.status === 200 && isFont(r.buf) && r.headers.get('x-font-bold') === '0', `${r.status} ${r.headers.get('x-font-bold')}`);
  r = await api(alice, fontUrl('Lobster', { bold: true }) + '&exact=1');
  check('asked for exactly that style (the desktop app), it is 404 instead', r.status === 404, String(r.status));
  r = await api(alice, fontUrl('Lobster') + '&exact=1');
  check('and the regular is still there', r.status === 200 && isFont(r.buf), String(r.status));
  r = await api(alice, fontUrl('Corp Serif Pro'));
  check('a font nobody has uploaded is 404', r.status === 404, String(r.status));
  r = await api(carol, fontUrl('Roboto'));
  check('a stranger gets no fonts through somebody else\'s project', r.status === 403 || r.status === 404, String(r.status));
  r = await api(null, '/api/fonts/preview?family=Lobster');
  check('a family\'s name can be drawn in itself (a few glyphs)', r.status === 200 && isFont(r.buf) && r.buf.length < 60000, `${r.status} ${r.buf.length}`);
  r = await api(null, '/api/fonts/preview?family=Not%20A%20Font');
  check('only for families on the list', r.status === 404, String(r.status));

  // uploads
  const local = fs.readFileSync(LOCAL_FONT);
  const restricted = Buffer.from(local); restricted.writeUInt16BE(0x0002, tableOf(restricted, 'OS/2') + 8);
  r = await api(alice, fontUrl('Locked Sans'), { method: 'PUT', body: restricted });
  check('a font whose licence forbids embedding is refused', r.status === 403 && r.j.error === 'font_restricted', `${r.status} ${r.text}`);
  r = await api(alice, fontUrl('Junk'), { method: 'PUT', body: Buffer.from('this is not a font file at all, just text') });
  check('a file that is not a font is refused', r.status === 415, `${r.status} ${r.text}`);
  r = await api(carol, fontUrl('Corp Serif Pro'), { method: 'PUT', body: local });
  check('a stranger cannot upload', r.status === 403 || r.status === 404, String(r.status));
  r = await api(alice, fontUrl('Roboto'), { method: 'PUT', body: local });
  check('a Google family is not stored a second time', r.status === 200 && r.j.stored === false && r.j.source === 'google', r.text);
  r = await api(alice, `/api/projects/${pid}/fonts`);
  check('nothing is stored with the project yet', r.status === 200 && r.j.fonts.length === 0, r.text);
}

// ---------------------------------------------------------------- browsers
const browser = await chromium.launch();
const errors = [];
async function open(jwt, doc, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: opts.scale || 1, colorScheme: opts.scheme || 'dark' });
  const page = await ctx.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(`${BASE}/auth/dev?jwt=${jwt}&next=${encodeURIComponent(`/p/${pid}/edit?doc=${doc.docId}`)}`);
  await ready(page);
  return page;
}
const ready = async (page) => {
  await page.waitForFunction(() => { const E = window.CollabEditor; return E && E.kdoc && E.kdoc.items.size > 1 && E.ws && E.ws.readyState === 1; }, null, { timeout: 60000 });
  await page.waitForTimeout(700);
};
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
const scr = (page, x, y) => page.evaluate(([x, y]) => {
  const E = window.CollabEditor, r = document.querySelector('#world').getBoundingClientRect();
  const w = E.vb[2] / E.vbPerMm, h = E.vb[3] / E.vbPerMm;
  return [r.left + (x - E.vb[0] / E.vbPerMm) / w * r.width, r.top + (y - E.vb[1] / E.vbPerMm) / h * r.height];
}, [x, y]);
const until = async (fn, ms = 8000) => { const t = Date.now(); for (;;) { if (await fn()) return true; if (Date.now() - t > ms) return false; await new Promise((r) => setTimeout(r, 120)); } };
const step = async (name, page, fn) => { try { await fn(); } catch (e) { check(name, false, String(e.message).split('\n').slice(0, 4).join(' / ')); if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'FAIL-' + name.replace(/\W+/g, '-') + '.png') }).catch(() => {}); } };
const textItem = (page, re) => page.evaluate((src) => {
  const re = new RegExp(src);
  for (const it of window.CollabEditor.kdoc.items.values()) if ((it.kind === 'text' || it.kind === 'gr_text') && re.test(String(it.node[1]))) return { id: it.id, bbox: it.bbox, node: JSON.stringify(it.node) };
  return null;
}, re.source);
const faceOn = (page, face, style = '') => page.evaluate(([face, style]) => document.fonts.check(`${style} 20px "${face}"`) && [...document.fonts].some((f) => f.family.replace(/"/g, '') === face && f.status === 'loaded') && window.KiCadCanvas.faceAvailable(face), [face, style]);
const openProps = async (page, re) => {
  const t = await textItem(page, re); const [x, y] = await scr(page, (t.bbox[0] + t.bbox[2]) / 2, (t.bbox[1] + t.bbox[3]) / 2);
  await page.mouse.dblclick(x, y); await page.waitForSelector('.kd-dialog');
};
const pickFont = async (page, sel, type, name) => {
  await page.click(sel); await page.waitForSelector('.kd-font-pop');
  await page.keyboard.type(type);
  await page.waitForFunction((name) => { const r = document.querySelector('.kd-font-row.active'); return r && r.textContent === name; }, name);
};

const a = await open(alice, sch, { scale: 2 }), b = await open(bob, sch, { scheme: 'light' });

await step('a Google Font already in the design', a, async () => {
  check('Alice sees the Roboto text in Roboto, bold italic', await until(() => faceOn(a, 'Roboto', 'italic bold')));
  check('so does Bob', await until(() => faceOn(b, 'Roboto', 'italic bold')));
  const styles = await a.evaluate(() => [...document.fonts].filter((f) => f.family.replace(/"/g, '') === 'Roboto').map((f) => f.weight + ' ' + f.style));
  check('the bold italic file itself is loaded, not a slanted regular', styles.includes('700 italic'), styles.join(', '));
});

await step('a font from somebody\'s computer', a, async () => {
  check('before it is uploaded nobody can draw it', !(await faceOn(a, 'Corp Serif Pro')) && !(await faceOn(b, 'Corp Serif Pro')));
  await shot(b, '01-missing-font-falls-back');
  const r = await api(alice, fontUrl('Corp Serif Pro', { name: path.basename(LOCAL_FONT) }), { method: 'PUT', body: fs.readFileSync(LOCAL_FONT) });
  check('an editor uploads it into the project', r.status === 200 && r.j.stored === true, r.text);
  const list = await api(bob, `/api/projects/${pid}/fonts`);
  check('the project lists it', list.j.fonts.length === 1 && list.j.fonts[0].family === 'Corp Serif Pro' && list.j.fonts[0].styles.length === 1, list.text);
  const got = await api(bob, fontUrl('corp serif pro', { bold: true }));
  check('a collaborator downloads the same file', got.status === 200 && got.headers.get('x-font-source') === 'upload' && got.buf.equals(fs.readFileSync(LOCAL_FONT)), `${got.status}`);
  check('Alice\'s open editor picks it up by itself', await until(() => faceOn(a, 'Corp Serif Pro'), 12000));
  check('and Bob\'s, who does not have the font', await until(() => faceOn(b, 'Corp Serif Pro'), 12000));
  await b.waitForTimeout(400); await shot(b, '02-font-arrived-from-the-project');
});

await step('choosing a Google Font for schematic text', a, async () => {
  await openProps(a, /^Hello fonts$/);
  check('the dialog has the font choice, on KiCad Font', (await a.locator('#kd-txt-font .kd-font-name').textContent()) === 'KiCad Font');
  await a.click('#kd-txt-font'); await a.waitForSelector('.kd-font-pop');
  await a.waitForFunction(() => /Google Fonts \(\d{4}\)/.test(document.querySelector('.kd-font-pop').textContent));
  const heads = await a.locator('.kd-font-head').allTextContents();
  check('it lists the project\'s fonts, then every Google Font', heads[0] === 'In this project' && /^Google Fonts \(19\d\d\)$/.test(heads[1] || ''), heads.join(' | '));
  const mine = await a.evaluate(() => [...document.querySelectorAll('.kd-font-row')].map((r) => r.textContent).slice(0, 4));
  check('the project\'s own are KiCad Font, the uploaded font and Roboto', mine.join('|') === 'KiCad Font|Corp Serif Pro|Roboto|ABeeZee', mine.join('|'));
  await a.keyboard.type('lobst');
  await a.waitForFunction(() => { const r = document.querySelector('.kd-font-row.active'); return r && r.textContent === 'Lobster'; });
  check('typing filters the list', (await a.locator('.kd-font-row').count()) <= 3, String(await a.locator('.kd-font-row').count()));
  check('the foot of the list names the licence', /SIL Open Font License/.test(await a.locator('.kd-font-foot').textContent()));
  check('names are drawn in their own font', await until(() => a.evaluate(() => { const n = document.querySelector('.kd-font-row.active .kd-font-row-name'); return /jfp Lobster/.test(n.style.fontFamily) && document.fonts.check('14px "jfp Lobster"'); })));
  await shot(a, '03-font-picker-search');
  await a.keyboard.press('Enter');
  check('Enter chooses it and the dialog stays open', (await a.locator('.kd-font-pop').count()) === 0 && (await a.locator('.kd-dialog').count()) === 1 && (await a.locator('#kd-txt-font .kd-font-name').textContent()) === 'Lobster');
  await a.click('#kd-txt-font'); await a.waitForSelector('.kd-font-pop'); await a.keyboard.press('Escape');
  check('Escape closes the list only', (await a.locator('.kd-font-pop').count()) === 0 && (await a.locator('.kd-dialog').count()) === 1);
  await shot(a, '04-text-properties');
  await a.locator('.kd-foot button', { hasText: /^OK$/ }).click();
  await a.waitForFunction(() => !document.querySelector('.kd-dialog'));
  const t = await textItem(a, /^Hello fonts$/);
  check('the text names the face', /\["face","Lobster"\]/.test(t.node), t.node);
  check('Bob\'s copy does too', await until(async () => /\["face","Lobster"\]/.test((await textItem(b, /^Hello fonts$/)).node)));
  check('Alice sees it in Lobster', await until(() => faceOn(a, 'Lobster')));
  check('Bob sees it in Lobster without doing anything', await until(() => faceOn(b, 'Lobster')));
  await a.keyboard.press('Escape'); await a.waitForTimeout(500);
  await shot(a, '05-schematic-alice'); await shot(b, '06-schematic-bob');
});

await step('back to KiCad Font', a, async () => {
  await openProps(a, /^Bold italic Roboto$/);
  check('the dialog shows the face the text has', (await a.locator('#kd-txt-font .kd-font-name').textContent()) === 'Roboto');
  await pickFont(a, '#kd-txt-font', 'kicad', 'KiCad Font'); await a.keyboard.press('Enter');
  await a.locator('.kd-foot button', { hasText: /^OK$/ }).click();
  await a.waitForFunction(() => !document.querySelector('.kd-dialog'));
  const t = await textItem(a, /^Bold italic Roboto$/);
  check('choosing KiCad Font removes the face', !/"face"/.test(t.node), t.node);
});

await step('board text', a, async () => {
  await a.goto(`${BASE}/p/${pid}/edit?doc=${pcb.docId}`); await ready(a);
  await b.goto(`${BASE}/p/${pid}/edit?doc=${pcb.docId}`); await ready(b);
  await openProps(a, /^REV A$/);
  check('the board text dialog has the font choice', (await a.locator('.kd-font[data-k="face"] .kd-font-name').textContent()) === 'KiCad Font');
  await pickFont(a, '.kd-font[data-k="face"]', 'roboto mono', 'Roboto Mono');
  await shot(a, '07-board-font-picker');
  await a.keyboard.press('Enter');
  await a.locator('.kd-foot button', { hasText: /^OK$/ }).click();
  await a.waitForFunction(() => !document.querySelector('.kd-dialog'));
  const t = await textItem(a, /^REV A$/);
  check('the face is written first in the font, as KiCad writes it', /\["font",\["face","Roboto Mono"\],\["size"/.test(t.node), t.node);
  check('Bob\'s board has it', await until(async () => /\["face","Roboto Mono"\]/.test((await textItem(b, /^REV A$/)).node)));
  check('and both draw it in Roboto Mono', (await until(() => faceOn(a, 'Roboto Mono'))) && (await until(() => faceOn(b, 'Roboto Mono'))));
  await a.keyboard.press('Escape'); await a.waitForTimeout(500);
  await shot(a, '08-board-alice'); await shot(b, '09-board-bob');
});

check('no page errors', errors.length === 0, errors.slice(0, 5).join(' || '));
await browser.close(); await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
