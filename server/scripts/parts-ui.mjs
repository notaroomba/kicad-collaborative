// Browser test of vendor parts in the web editor: two signed-in people on the same
// project, one of them searching vendors, placing a symbol and a footprint and saving
// parts to a library, the other watching the placements arrive.  Drives the real pages
// in Chromium and saves a screenshot of each step.
//
// Same setup as parts-e2e.mjs (local server with KC_DEV_LOGIN=1, throwaway database,
// fake-vendors.mjs replaying real LCSC / EasyEDA answers), plus Playwright.
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… [SHOTS=/some/dir] node parts-ui.mjs
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import pg from 'pg';

const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintJwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();

// ---------------------------------------------------------------- a project to work in
/** A stored zip of name → text files. */
function zip(files) {
  const parts = [], central = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text), nameB = Buffer.from(name), crc = zlib.crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameB.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nameB, data); central.push(ch, nameB); off += 30 + nameB.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
const demo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'demos', 'pic_programmer');
const files = Object.fromEntries(['pic_programmer.kicad_pro', 'pic_programmer.kicad_sch', 'pic_sockets.kicad_sch', 'pic_programmer.kicad_pcb'].map((f) => [f, fs.readFileSync(path.join(demo, f), 'utf8')]));

const mkUser = async (ghId, login, name) => (await db.query(
  `INSERT INTO users (github_id, login, name) VALUES ($1, $2, $3) ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [ghId, login, name])).rows[0].id;
const danaId = await mkUser(9301, 'ui-dana', 'Dana'), samId = await mkUser(9302, 'ui-sam', 'Sam');
for (const id of [danaId, samId]) { await db.query('DELETE FROM part_libraries WHERE owner_id = $1', [id]); await db.query('DELETE FROM vendor_keys WHERE user_id = $1', [id]); }
await db.query('DELETE FROM projects WHERE owner_id = $1', [danaId]);
const dana = mintJwt(danaId, 'ui-dana'), sam = mintJwt(samId, 'ui-sam');
const fd = new FormData(); fd.append('name', 'PIC programmer'); fd.append('archive', new Blob([zip(files)]), 'p.zip');
const proj = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { Authorization: `Bearer ${dana}` }, body: fd })).json();
const docId = (p) => proj.docs.find((d) => d.path === p).docId;
const SCH = docId('pic_programmer.kicad_sch'), PCB = docId('pic_programmer.kicad_pcb');
await db.query(`INSERT INTO permissions (project_id, user_id, role) VALUES ($1, $2, 'editor')`, [proj.projectId, samId]);

const browser = await chromium.launch();
const open = async (jwt, scale) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: scale, acceptDownloads: true });
  await ctx.addCookies([{ name: 'kc_session', value: jwt, url: BASE }]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log('PAGE ERROR:', e.message.slice(0, 300)); fail++; });
  return page;
};
const A = await open(dana, 2), B = await open(sam, 1);
const items = (page) => page.evaluate(() => window.CollabApp.getState().document.items.map((i) => ({ ref: i.ref, value: i.value, lib: i.lib, id: i.id })));
const goDoc = async (page, doc) => { await page.goto(`${BASE}/p/${proj.projectId}/edit?doc=${doc}`); await page.waitForFunction(() => window.CollabApp && window.CollabApp.getState().document.hasDoc && window.CollabApp.getState().document.items.length > 0); await page.waitForTimeout(800); };
const openDialog = async (page, entry = 'Add Part from Vendor…') => { await page.click('[data-menu="tools"] > button'); await page.getByText(entry, { exact: true }).click(); await page.waitForSelector('#kp-dialog .kp-tab.on'); await page.waitForTimeout(300); };
const search = async (page, q) => { await page.fill('#kp-q', q); await page.keyboard.press('Enter'); await page.waitForFunction(() => document.querySelector('#kp-results tr.kp-row') || document.querySelector('#kp-results .kp-empty b')); };
const pick = async (page, vendorId) => { await page.click(`#kp-results tr.kp-row[data-id="${vendorId}"], #kp-items tr.kp-row[data-id="${vendorId}"]`); await page.waitForFunction((id) => { const t = document.querySelector('#kp-side .kp-mono'); return t && t.textContent === id && !document.querySelector('#kp-side .kp-spin'); }, vendorId); await page.waitForTimeout(250); };
/** Does a canvas hold more than its background? */
const drawn = (page, sel) => page.evaluate((s) => { const c = document.querySelector(s); if (!c) return false; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const seen = new Set(); for (let i = 0; i < d.length; i += 16) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]); return seen.size > 2; }, sel);

// ---------------------------------------------------------------- schematic: search, look, place
await goDoc(A, SCH); await goDoc(B, SCH);
const before = (await items(A)).length;
await A.click('[data-menu="tools"] > button');
check('the Tools menu offers vendor parts and part libraries', await A.getByText('Add Part from Vendor…', { exact: true }).isVisible() && await A.getByText('Part Libraries…', { exact: true }).isVisible());
await shot(A, '01-tools-menu');
await A.getByText('Add Part from Vendor…', { exact: true }).click(); await A.waitForSelector('#kp-dialog');
await search(A, 'STM32F103C8T6');
const firstRow = await A.locator('#kp-results tr.kp-row').first().innerText();
check('searching finds the part at LCSC with stock and price', /STM32F103C8T6/.test(firstRow) && /C8734/.test(firstRow) && /\$\d/.test(firstRow) && /LQFP-48/.test(firstRow), firstRow.replace(/\s+/g, ' '));
await pick(A, 'C8734');
check('the part opens with its symbol and footprint drawn', await drawn(A, '#kp-sym') && await drawn(A, '#kp-fp'));
check('… and says what they are', /48 pins/.test(await A.locator('.kp-views').innerText()) && /48 pads/.test(await A.locator('.kp-views').innerText()));
await shot(A, '02-search-part');
await A.click('#kp-sym'); await A.waitForSelector('#kp-zoom-canvas'); await A.waitForTimeout(200);
check('a preview enlarges to read the pin names', await drawn(A, '#kp-zoom-canvas'));
await shot(A, '03-symbol-enlarged');
await A.click('.kp-zoom');
check('the button places a symbol in the schematic editor', (await A.locator('#kp-place').innerText()) === 'Place Symbol' && await A.locator('#kp-place').isEnabled());
await A.click('#kp-place');
check('placing closes the dialog', await A.locator('#kp-dialog').count() === 0);
await A.mouse.move(1180, 250); await A.waitForTimeout(150); await A.mouse.move(1215, 262); await A.waitForTimeout(300);
await shot(A, '04-symbol-on-cursor');
await A.mouse.click(1215, 262); await A.waitForTimeout(600); await A.keyboard.press('Escape'); await A.waitForTimeout(400);
const mine = (await items(A)).filter((i) => i.lib === 'LCSC:STM32F103C8T6');
check('the symbol is in the schematic', (await items(A)).length === before + 1 && mine.length === 1 && mine[0].value === 'STM32F103C8T6', JSON.stringify(mine));
await shot(A, '05-symbol-placed');
await B.waitForFunction(() => window.CollabApp.getState().document.items.some((i) => i.lib === 'LCSC:STM32F103C8T6'), null, { timeout: 8000 }).catch(() => {});
const theirs = (await items(B)).filter((i) => i.lib === 'LCSC:STM32F103C8T6');
check('the other person sees it arrive, with the same id', theirs.length === 1 && theirs[0].id === mine[0]?.id, JSON.stringify(theirs));
await shot(B, '06-symbol-on-the-other-client');
const op = (await db.query(`SELECT changes::text AS c FROM ops WHERE doc_id = $1 ORDER BY seq DESC LIMIT 1`, [SCH])).rows[0].c;
check('the op carries the library symbol and the vendor fields', op.includes('LCSC:STM32F103C8T6') && op.includes('lib_symbols') && op.includes('\\"LCSC\\" \\"C8734\\"') && op.includes('\\"MPN\\" \\"STM32F103C8T6\\"') && op.includes('LCSC:LQFP-48_L7.0-W7.0-P0.50-LS9.0-BL'));

// ---------------------------------------------------------------- save to a library
await openDialog(A); await search(A, 'C25804');
await A.waitForFunction(() => { const t = document.querySelector('#kp-side .kp-mono'); return t && t.textContent === 'C25804'; });
check('searching an LCSC number opens that part straight away', /0603WAF1002T5E/.test(await A.locator('#kp-part-title').innerText()));
await A.selectOption('#kp-add', '+'); await A.waitForSelector('#kp-ask-input'); await shot(A, '06b-new-library'); await A.fill('#kp-ask-input', 'Motor Board'); await A.click('#kp-ask-ok'); await A.waitForFunction(() => [...document.querySelectorAll('#kp-add option')].some((o) => o.textContent === 'Motor Board'));
check('the part is saved to a new library', (await db.query(`SELECT i.vendor, i.vendor_id, i.mpn FROM part_library_items i JOIN part_libraries l ON l.id = i.library_id WHERE l.owner_id = $1`, [danaId])).rows.map((r) => `${r.vendor}:${r.vendor_id}:${r.mpn}`).join() === 'lcsc:C25804:0603WAF1002T5E');
await search(A, 'C165948'); await A.waitForFunction(() => { const t = document.querySelector('#kp-side .kp-mono'); return t && t.textContent === 'C165948' && !document.querySelector('#kp-side .kp-spin'); });
const libId = (await db.query(`SELECT id FROM part_libraries WHERE owner_id = $1`, [danaId])).rows[0].id;
await A.selectOption('#kp-add', libId); await A.waitForTimeout(500);
await search(A, 'STM32F103C8T6'); await pick(A, 'C8734'); await A.selectOption('#kp-add', libId); await A.waitForTimeout(500);
await A.click('.kp-tab[data-tab="libraries"]'); await A.waitForSelector('#kp-items tr.kp-row');
check('My Libraries lists the three saved parts', await A.locator('#kp-items tr.kp-row').count() === 3 && /Motor Board/.test(await A.locator('#kp-libname').innerText()));
await pick(A, 'C165948');
check('a saved part opens with its drawings', await drawn(A, '#kp-sym') && await drawn(A, '#kp-fp'));
await shot(A, '07-library');
await A.click('#kp-share'); await A.waitForSelector('#kp-unshare');
check('the library is shared with the project', /shared with PIC programmer/.test(await A.locator('#kp-libname').innerText()));
const [download] = await Promise.all([A.waitForEvent('download'), A.click('#kp-export')]);
const zipPath = await download.path(); const zipBytes = fs.readFileSync(zipPath);
check('the library downloads as a KiCad library zip', download.suggestedFilename() === 'Motor_Board.zip' && zipBytes.includes(Buffer.from('Motor_Board.kicad_sym')) && zipBytes.includes(Buffer.from('Motor_Board.pretty/R0603.kicad_mod')) && zipBytes.includes(Buffer.from('Motor_Board.3dshapes/R0603.step')), download.suggestedFilename());
await A.keyboard.press('Escape');

// ---------------------------------------------------------------- bill of materials
await openDialog(A, 'Bill of Materials with Vendor Prices…'); await A.waitForSelector('#kp-bom tr.kp-row');
await A.waitForFunction(() => !document.querySelector('#kp-bom .kp-spin'));
const stmRow = await A.locator('#kp-bom tr.kp-row[data-id="C8734"]').innerText();
check('the BOM lists the placed vendor part with its stock and price', /STM32F103C8T6/.test(stmRow) && /212,539/.test(stmRow) && /\$1\.41/.test(stmRow), stmRow.replace(/\s+/g, ' '));
const sum1 = await A.locator('#kp-bom-sum').innerText();
check('… and totals the whole design, both sheets', /\d+ parts in \d+ lines on 2 sheets · 1 with a vendor part · \$1\.41 for one board/.test(sum1), sum1);
await A.fill('#kp-boards', '100'); await A.waitForFunction(() => /100 boards/.test(document.querySelector('#kp-bom-sum').textContent));
const stm100 = await A.locator('#kp-bom tr.kp-row[data-id="C8734"]').innerText();
check('100 boards use the price break for 100', /\$1\.09/.test(stm100) && /\$108\.54/.test(stm100), stm100.replace(/\s+/g, ' '));
await A.fill('#kp-boards', '1'); await A.waitForFunction(() => /one board/.test(document.querySelector('#kp-bom-sum').textContent));
// a line without a vendor part: find one and assign it
const line = A.locator('#kp-bom tr.kp-nopart').first(); const lineRefs = await line.locator('td').first().getAttribute('title');
await line.locator('.kp-find').click(); await A.waitForSelector('#kp-q');
await search(A, 'C25804'); await A.waitForFunction(() => { const t = document.querySelector('#kp-side .kp-mono'); return t && t.textContent === 'C25804' && !document.querySelector('#kp-side .kp-spin'); });
check('finding a part for a line offers to assign it', /^Assign to /.test(await A.locator('#kp-assign').innerText()));
await shot(A, '07b-assign');
await A.click('#kp-assign'); await A.waitForSelector('#kp-bom tr.kp-row[data-id="C25804"]'); await A.waitForFunction(() => !document.querySelector('#kp-bom .kp-spin'));
const rRow = await A.locator('#kp-bom tr.kp-row[data-id="C25804"]');
check('the assigned line now has the part', (await rRow.locator('td').first().getAttribute('title')) === lineRefs && /0603WAF1002T5E/.test(await rRow.innerText()), await rRow.innerText());
const asgOp = (await db.query(`SELECT changes::text AS c FROM ops WHERE doc_id = $1 ORDER BY seq DESC LIMIT 1`, [SCH])).rows[0].c;
check('the op writes quoted, hidden fields onto each symbol', asgOp.includes('"MODIFIED"') && asgOp.includes('(property \\"LCSC\\" \\"C25804\\"') && asgOp.includes('(property \\"MPN\\" \\"0603WAF1002T5E\\"') && asgOp.includes('(hide yes)') && (asgOp.match(/"MODIFIED"/g) || []).length === lineRefs.split(', ').length);
await B.waitForTimeout(800);
const bFields = await B.evaluate((ref) => { const K = window.KiCadCanvas, it = [...window.CollabApp.getState().document.items].find((i) => i.ref === ref); return it ? 1 : 0; }, lineRefs.split(', ')[0]);
check('the other person still has those symbols', bFields === 1);
await shot(A, '07c-bom');
const [jlc] = await Promise.all([A.waitForEvent('download'), A.click('#kp-bom-jlc')]);
const jlcText = fs.readFileSync(await jlc.path(), 'utf8');
check('the JLCPCB BOM downloads with the LCSC numbers', /-jlcpcb-bom\.csv$/.test(jlc.suggestedFilename()) && jlcText.startsWith('Comment,Designator,Footprint,LCSC Part #') && /STM32F103C8T6,U[?\d]+,[^,]*,C8734/.test(jlcText) && jlcText.includes(',C25804'), jlcText.slice(0, 200));
const [full] = await Promise.all([A.waitForEvent('download'), A.click('#kp-bom-csv')]);
check('the full BOM downloads with prices', fs.readFileSync(await full.path(), 'utf8').includes('LCSC,C8734,STM32F103C8T6'));
await A.keyboard.press('Escape');

// ---------------------------------------------------------------- board: place a footprint from the library
await goDoc(A, PCB); await goDoc(B, PCB);
const fpBefore = (await items(A)).length;
await openDialog(A, 'Part Libraries…'); await A.waitForSelector('#kp-items tr.kp-row', { timeout: 6000 }).catch(async (e) => { await A.screenshot({ path: '/tmp/uitest/dbg.png' }); console.log(await A.locator('#kp-dialog').innerText()); throw e; }); await pick(A, 'C165948');
check('on a board the button places a footprint', (await A.locator('#kp-place').innerText()) === 'Place Footprint' && await A.locator('#kp-place').isEnabled());
await A.click('#kp-fp'); await A.waitForSelector('#kp-zoom-canvas'); await A.waitForTimeout(200); await shot(A, '08-footprint-enlarged'); await A.click('.kp-zoom');
await A.click('#kp-place');
await A.mouse.move(600, 300); await A.waitForTimeout(100); await A.mouse.move(640, 330); await A.waitForTimeout(250);
check('the footprint rides on the cursor before the click', (await items(A)).length === fpBefore);
await shot(A, '09-footprint-on-cursor');
await A.mouse.click(640, 330); await A.waitForTimeout(700);
const fpMine = (await items(A)).filter((i) => i.lib === 'Motor_Board:USB-C_SMD-TYPE-C-31-M-12_1');
check('the footprint is on the board, named from the library, with KiCad\'s placeholder reference', (await items(A)).length === fpBefore + 1 && fpMine.length === 1 && fpMine[0].ref === 'REF**', JSON.stringify(fpMine));
await shot(A, '10-footprint-placed');
await B.waitForFunction(() => window.CollabApp.getState().document.items.some((i) => (i.lib || '').startsWith('Motor_Board:')), null, { timeout: 8000 }).catch(() => {});
const fpTheirs = (await items(B)).filter((i) => i.lib === 'Motor_Board:USB-C_SMD-TYPE-C-31-M-12_1');
check('the other person sees the footprint arrive', fpTheirs.length === 1 && fpTheirs[0].id === fpMine[0]?.id && fpTheirs[0].ref === fpMine[0]?.ref, JSON.stringify(fpTheirs));
await shot(B, '11-footprint-on-the-other-client');
const pcbOp = (await db.query(`SELECT changes::text AS c FROM ops WHERE doc_id = $1 ORDER BY seq DESC LIMIT 1`, [PCB])).rows[0].c;
check('the board op is a footprint with pads, slots and the vendor fields', pcbOp.includes('"ADDED"') && pcbOp.includes('(footprint \\"Motor_Board:USB-C_SMD-TYPE-C-31-M-12_1\\"') && pcbOp.includes('drill oval') && pcbOp.includes('\\"LCSC\\" \\"C165948\\"') && pcbOp.includes('(property \\"Reference\\" \\"REF**\\"'));
// escape cancels a placement
await openDialog(A, 'Part Libraries…'); await A.waitForSelector('#kp-items tr.kp-row'); await pick(A, 'C25804'); await A.click('#kp-place');
await A.mouse.move(500, 400); await A.keyboard.press('Escape'); await A.waitForTimeout(300);
check('Escape cancels a placement', await A.locator('.kp-ghost').count() === 0 && (await items(A)).length === fpBefore + 1);

// the other person, an editor of the project, finds the shared library
await openDialog(B, 'Part Libraries…'); await B.waitForSelector('#kp-items tr.kp-row');
check('the shared library shows up for the other project member', /Motor Board/.test(await B.locator('.kp-lib').first().innerText()) && /by ui-dana/.test(await B.locator('.kp-lib').first().innerText()) && await B.locator('#kp-items tr.kp-row').count() === 3);
await shot(B, '12-shared-library-other-client');
await B.keyboard.press('Escape');

// ---------------------------------------------------------------- API keys, Mouser and DigiKey
await openDialog(A); await A.click('.kp-tab[data-tab="keys"]'); await A.waitForSelector('.kp-card[data-vendor="mouser"]');
check('LCSC needs no key; Mouser and DigiKey ask for one', /No key needed/.test(await A.locator('.kp-card[data-vendor="lcsc"]').innerText()) && /No key/.test(await A.locator('.kp-card[data-vendor="mouser"]').innerText()));
await A.fill('.kp-card[data-vendor="mouser"] input', 'wrong-key'); await A.click('.kp-card[data-vendor="mouser"] .kp-btn.primary');
await A.waitForFunction(() => /did not accept/.test(document.querySelector('.kp-card[data-vendor="mouser"]').innerText));
check('a wrong key is refused with the reason', true);
await A.fill('.kp-card[data-vendor="mouser"] input', 'test-mouser-key'); await A.click('.kp-card[data-vendor="mouser"] .kp-btn.primary');
await A.waitForFunction(() => /Your key/.test(document.querySelector('.kp-card[data-vendor="mouser"]').innerText));
await A.fill('.kp-card[data-vendor="digikey"] input[data-field="client_id"]', 'test-digikey-id'); await A.fill('.kp-card[data-vendor="digikey"] input[data-field="client_secret"]', 'test-digikey-secret');
await A.click('.kp-card[data-vendor="digikey"] .kp-btn.primary');
await A.waitForFunction(() => /Your key/.test(document.querySelector('.kp-card[data-vendor="digikey"]').innerText));
await A.fill('.kp-card[data-vendor="farnell"] input[data-field="api_key"]', 'test-farnell-key'); await A.click('.kp-card[data-vendor="farnell"] .kp-btn.primary');
await A.waitForFunction(() => /Your key/.test(document.querySelector('.kp-card[data-vendor="farnell"]').innerText));
check('the right keys are saved', true);
await shot(A, '13-api-keys');
await A.click('.kp-tab[data-tab="search"]'); await search(A, 'STM32F103C8T6');
const vendorsSeen = await A.evaluate(() => [...new Set([...document.querySelectorAll('#kp-results tr.kp-row')].map((r) => r.dataset.vendor))].sort().join());
check('a search now covers all four vendors', vendorsSeen === 'digikey,farnell,lcsc,mouser', vendorsSeen);
await pick(A, '511-STM32F103C8T6');
check('a Mouser part shows LCSC\'s drawings for the same manufacturer part number', await drawn(A, '#kp-sym') && /from LCSC\s*C8734/.test(await A.locator('#kp-side').innerText()));
await shot(A, '14-mouser-part');
await A.keyboard.press('Escape');

// ---------------------------------------------------------------- links that open the dialog (what the desktop app's menu entry opens)
await A.goto(`${BASE}/p/${proj.projectId}/edit?parts=bom&doc=${SCH}`); await A.waitForSelector('#kp-bom tr.kp-row', { timeout: 20000 });
check('a link opens the editor with the BOM showing', await A.locator('.kp-tab.on').innerText() === 'BOM');
await A.goto(`${BASE}/p/${proj.projectId}/edit?parts=search&doc=${PCB}`); await A.waitForSelector('#kp-q', { timeout: 20000 });
await search(A, 'C25804'); await A.waitForFunction(() => document.querySelector('#kp-place') && !document.querySelector('#kp-side .kp-spin'));
check('… and on the board with the search ready to place a footprint', (await A.locator('#kp-place').innerText()) === 'Place Footprint' && await A.locator('#kp-place').isEnabled());
await A.goto(`${BASE}/?parts=libraries`); await A.waitForSelector('#kp-items tr.kp-row', { timeout: 20000 });
check('… and the project manager with the libraries', /Motor Board/.test(await A.locator('#kp-libname').innerText()));

// ---------------------------------------------------------------- the project manager page
await A.goto(BASE + '/'); await A.waitForSelector('#homeParts'); await A.click('#homeParts'); await A.waitForSelector('#kp-items tr.kp-row'); await pick(A, 'C8734');
check('libraries open from the project manager too, where there is nothing to place into', await A.locator('#kp-place').isDisabled());
await shot(A, '15-libraries-from-home');
await A.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await A.waitForTimeout(200);
await shot(A, '16-libraries-dark');
await A.click('.kp-tab[data-tab="search"]'); await search(A, 'STM32F103C8T6'); await pick(A, 'C8734');
const bg = await A.evaluate(() => getComputedStyle(document.querySelector('#kp-dialog')).backgroundColor.match(/\d+/g).slice(0, 3).map(Number));
check('the dialog follows the dark theme', bg.every((c) => c < 90), bg.join());
await shot(A, '17-search-dark');

await browser.close(); await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
