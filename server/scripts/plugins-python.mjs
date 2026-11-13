// plugins-python.mjs — how many of KiCad's official Python plugins the web runtime carries.
//
// Runs the same Python the browser runs (Pyodide) with the same shim modules
// (server/plugins/python), but without a browser: every plugin package under PCM_SRC is
// imported, its registered actions are listed and each is run against a demo board with every
// dialog answered "OK".  What comes back is a table: loads / registers / runs / what it lacks.
//
//   PCM_SRC=<folder of unpacked PCM packages> node plugins-python.mjs            # all of them
//   BOARD=<a .kicad_pcb> runs the sweep on that board instead of each plugin's usual one (a bare board with a few
//   tracks and no nets finds what a demo board hides).
//   node plugins-python.mjs --one <package folder> [--board file.kicad_pcb]      # one, as JSON
//   OUT=compat.json  writes the table as JSON too.  ONLY=substring narrows the run.
//
// Each package folder is an unpacked PCM zip: metadata.json, plugins/, resources/.
//
// Pressing a window's main button proves little for a plugin whose work starts only after a person has
// chosen nets, layers or files.  For those, scripts/plugin-drives/<identifier>.py plays the person: it may
// name its own board in a first line "# board: <path from the repository root>", and defines
// after_run(action_name), which works the plugin's window and raises if the plugin did not do its job.
// A plugin whose window is a modal dialog is worked from modal(dialog), called while the dialog is open.
// What after_run returns is reported as the action's "drive".  NO_DRIVE=1 runs without them.

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import zlib from "node:zlib";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(here, "..");
const shimDir = path.join(server, "plugins", "python");
// The file names inside a ZIP a plugin handed over (its central directory), so a result says what was actually made.
function zipNames(b64) {
  const out = []; let buf; try { buf = Buffer.from(b64 || "", "base64"); } catch { return out; }
  for (let i = buf.indexOf("PK\x01\x02", 0, "latin1"); i >= 0 && out.length < 60; i = buf.indexOf("PK\x01\x02", i + 46, "latin1")) {
    if (i + 46 > buf.length) break;
    const n = buf.readUInt16LE(i + 28); out.push(buf.toString("utf8", i + 46, i + 46 + n));
  }
  return out;
}
// The files inside a ZIP, as { name, base64 } (stored or deflated entries; that is all the runtime writes).
function unzip(b64) {
  const out = []; let buf; try { buf = Buffer.from(b64 || "", "base64"); } catch { return out; }
  for (let i = buf.indexOf("PK\x01\x02", 0, "latin1"); i >= 0 && i + 46 <= buf.length; i = buf.indexOf("PK\x01\x02", i + 46, "latin1")) {
    const method = buf.readUInt16LE(i + 10), size = buf.readUInt32LE(i + 20), n = buf.readUInt16LE(i + 28), at = buf.readUInt32LE(i + 42);
    const name = buf.toString("utf8", i + 46, i + 46 + n);
    if (name.endsWith("/") || at + 30 > buf.length) continue;
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    try { const raw = buf.subarray(start, start + size); out.push({ name: path.basename(name), base64: (method === 8 ? zlib.inflateRawSync(raw) : raw).toString("base64") }); } catch { /* not readable: not offered */ }
  }
  return out;
}
const defaultBoard = path.resolve(server, "..", "demos", "ecc83", "ecc83-pp.kicad_pcb");
const TEXT = /\.(py|pyi|json|txt|md|rst|csv|tsv|xml|xrc|html?|css|js|ya?ml|toml|ini|cfg|conf|fbp|kicad_[a-z]+|svg|po|pot|lua|sh|bat|in|tpl|template|dru|net|cmp|pro|lib|mod|dcm)$/i;
const MAX_FILE = 4 * 1024 * 1024;

function walk(dir, base = "") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) { if (e.name !== "__pycache__" && e.name !== ".git" && !(base === "" && e.name === "wheels" && dir === shimDir)) out.push(...walk(path.join(dir, e.name), rel)); }
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/** The files of an unpacked package as the server would store them: text as is, the rest base64. */
export function readPackage(dir) {
  const files = {};
  for (const rel of walk(dir)) {
    if (!(rel === "metadata.json" || rel.startsWith("plugins/") || rel.startsWith("resources/"))) continue;
    const buf = fs.readFileSync(path.join(dir, rel)); if (buf.length > MAX_FILE) continue;
    files[rel] = TEXT.test(rel) && !buf.includes(0) ? buf.toString("utf8") : "base64:" + buf.toString("base64");
  }
  return files;
}

/**
 * What the editor answers for kicad.libs.*: KC_FOOTPRINTS names a folder laid out like kicad-footprints; without it each
 * file asked for is downloaded once from the official repository (the ref src/libs.rs pins) into node_modules/.cache.
 */
const LIBS_REF = process.env.KC_LIBS_REF || "10.0.8";
function library(what, a) {
  const cache = process.env.KC_FOOTPRINTS || path.join(server, "node_modules", ".cache", "kicad-footprints-" + LIBS_REF);
  const safe = (t) => /^[A-Za-z0-9_.+\- ]{1,120}$/.test(String(t || "")) && !String(t).includes("..");
  const curl = (url) => { const r = spawnSync("curl", ["-sS", "-f", "-L", "-m", "60", url], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }); return r.status === 0 ? r.stdout : null; };
  const api = "https://gitlab.com/api/v4/projects/kicad%2Flibraries%2Fkicad-footprints/repository";
  try {
    if (what === "footprint") {
      if (!safe(a.lib) || !safe(a.name)) return { error: "not a footprint name" };
      const f = path.join(cache, a.lib + ".pretty", a.name + ".kicad_mod");
      if (!fs.existsSync(f)) {
        if (process.env.KC_FOOTPRINTS) return {};
        const buf = curl(`${api}/files/${encodeURIComponent(`${a.lib}.pretty/${a.name}.kicad_mod`)}/raw?ref=${encodeURIComponent(LIBS_REF)}`); if (!buf) return {};
        fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf);
      }
      return { library: a.lib, name: a.name, fpid: `${a.lib}:${a.name}`, footprint: fs.readFileSync(f, "utf8") };
    }
    if (what === "model") {      // KiCad's 3D model library (kicad-packages3D publishes STEP only), kept beside the footprints
      if (!safe(a.lib) || !safe(a.name)) return { error: "not a model name" };
      const f = path.join(process.env.KC_MODELS || path.join(server, "node_modules", ".cache", "kicad-packages3D"), a.lib + ".3dshapes", a.name + ".step");
      if (!fs.existsSync(f)) {
        if (process.env.KC_MODELS || fs.existsSync(f + ".missing")) return {};
        const buf = curl(`https://gitlab.com/api/v4/projects/kicad%2Flibraries%2Fkicad-packages3D/repository/files/${encodeURIComponent(`${a.lib}.3dshapes/${a.name}.step`)}/raw?ref=master`);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        if (!buf || !buf.subarray(0, 12).toString("latin1").startsWith("ISO-10303-21")) { fs.writeFileSync(f + ".missing", ""); return {}; }
        fs.writeFileSync(f, buf);
      }
      return { library: a.lib, name: a.name, step: fs.readFileSync(f, "utf8") };
    }
    const list = (p) => {
      const f = path.join(cache, ".index", (p || "root") + ".json"); if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
      if (process.env.KC_FOOTPRINTS) return fs.readdirSync(p ? path.join(cache, p) : cache);
      const names = []; for (let page = 1; page < 40; page++) { const buf = curl(`${api}/tree?ref=${encodeURIComponent(LIBS_REF)}&per_page=100&page=${page}${p ? "&path=" + encodeURIComponent(p) : ""}`); const rows = buf ? JSON.parse(buf.toString("utf8")) : []; for (const r of rows) names.push(r.name); if (rows.length < 100) break; }
      fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(names)); return names;
    };
    if (what === "footprints") { if (!safe(a.lib)) return { error: "not a library name" }; return { library: a.lib, footprints: list(a.lib + ".pretty").filter((n) => n.endsWith(".kicad_mod")).map((n) => n.slice(0, -10)) }; }
    if (what === "libraries") return { libraries: list("").filter((n) => n.endsWith(".pretty")).map((n) => n.slice(0, -7)) };
  } catch (e) { return { error: String(e && e.message || e) }; }
  return { error: "no such library call" };
}

/** What a commit creates, counted by kind of item ("segment", "via", "zone", …). */
function kindsOf(create) {
  const n = {};
  for (const c of create || []) { const t = typeof c === "string" ? c : c && (c.sexpr || c.text || c.fragment || JSON.stringify(c)); const m = /^\s*\(\s*(?:kicad_pcb\s*\(\s*)?([a-z_0-9]+)/.exec(String(t || "")); const k = m ? m[1] : "other"; n[k] = (n[k] || 0) + 1; }
  if (process.env.DUMP_CREATE) fs.writeFileSync(process.env.DUMP_CREATE, JSON.stringify(create, null, 1));
  return n;
}

/** The ids of a board file's top-level items of the wanted kinds (all, tracks, footprints). */
function topLevelIds(text, what) {
  const kinds = what === "tracks" ? ["segment", "arc", "via"] : what === "footprints" ? ["footprint"] : ["segment", "arc", "via", "footprint", "zone", "gr_line", "gr_rect", "gr_circle", "gr_arc", "gr_poly", "gr_text"];
  const ids = []; let depth = 0, inStr = false, item = null, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; i++; continue; }
    if (c === '"') { inStr = true; i++; continue; }
    if (c === "(") {
      depth++;
      const m = /^\(([A-Za-z_0-9.]+)/.exec(text.slice(i, i + 40)); const name = m ? m[1] : "";
      if (depth === 2) item = kinds.includes(name) ? { id: null } : null;
      else if (depth === 3 && item && !item.id && (name === "uuid" || name === "tstamp")) { const u = /^\((?:uuid|tstamp)\s+"?([0-9a-fA-F-]{8,})"?\)/.exec(text.slice(i, i + 80)); if (u) item.id = u[1]; }
    } else if (c === ")") { if (depth === 2 && item && item.id) ids.push(item.id); if (depth === 2) item = null; depth--; }
    i++;
  }
  return ids;
}

async function one(dir, boardPath, boardGiven) {
  const require = createRequire(path.join(server, "package.json"));
  let driveSrc = null;
  { let id = path.basename(dir); try { id = JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf8")).identifier || id; } catch { /* none */ }
    const f = process.env.DRIVE ? path.resolve(process.env.DRIVE) : path.join(here, "plugin-drives", id + ".py");   // DRIVE=<file>: one drive for whatever runs (a probe)
    if (!process.env.NO_DRIVE && fs.existsSync(f)) { driveSrc = fs.readFileSync(f, "utf8"); const m = /^# board: (\S+)/m.exec(driveSrc); if (m && !boardGiven) boardPath = path.resolve(server, "..", m[1]); } }
  const { loadPyodide } = require("pyodide");
  // the STEP reader, for a plugin that exports the board with its parts' models (it starts up asynchronously, so before the run)
  let occt = null;
  if (process.env.KC_OCCT !== "0" && fs.readdirSync(dir, { recursive: true }).some((f) => String(f).endsWith(".py") && /ExportVRML/.test(fs.readFileSync(path.join(dir, String(f)), "utf8")))) {
    try { occt = await require(path.join(server, "node_modules", "occt-import-js", "dist", "occt-import-js.js"))(); } catch { occt = null; }
  }
  const logs = []; if (process.env.KICAD_WEB_DEBUG) { /* set below, inside Python */ }
  // the packages the build put beside the interpreter (static/dist/pyodide), loaded when the plugin imports them
  const dist = path.join(server, "static", "dist", "pyodide"); const lockPath = path.join(dist, "pyodide-lock.json"); const built = fs.existsSync(lockPath);
  const py = await loadPyodide({ stdout: (t) => logs.push(t), stderr: (t) => logs.push(t), ...(built ? { lockFileURL: lockPath, packageBaseUrl: dist + "/" } : {}) });
  py.FS.mkdirTree("/kicad/lib");
  for (const rel of walk(shimDir)) { const dst = "/kicad/lib/" + rel; py.FS.mkdirTree(path.posix.dirname(dst)); py.FS.writeFile(dst, fs.readFileSync(path.join(shimDir, rel))); }
  let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf8")); } catch { /* none */ }
  const identifier = meta.identifier || path.basename(dir);
  let board = fs.readFileSync(boardPath, "utf8");
  // a drive may put something on the board and select it before the plugin starts, as a person would have:
  //   "# insert: <one board item as KiCad text>"   "# select: <uuid>[,<uuid>…]"
  const startSelection = [];
  if (driveSrc) {
    for (const m of driveSrc.matchAll(/^# insert: (.+)$/gm)) board = board.slice(0, board.lastIndexOf(")")) + "\t" + m[1].trim() + "\n)\n";
    for (const m of driveSrc.matchAll(/^# select: (.+)$/gm)) startSelection.push(...m[1].split(",").map((x) => x.trim()).filter(Boolean));
  }
  // SELECT=all|tracks|footprints: start with those items selected, as a person who selects before running a plugin
  // (many plugins only say "select something first" otherwise).  A drive's own "# select:" wins.
  if (process.env.SELECT && !startSelection.length) startSelection.push(...topLevelIds(board, process.env.SELECT));
  // the project file and schematics beside the board, as the editor hands them over
  const siblings = fs.readdirSync(path.dirname(boardPath)).filter((f) => /\.kicad_(sch|pro|sym)$|^(sym|fp)-lib-table$/.test(f)).map((f) => ({ path: f, text: fs.readFileSync(path.join(path.dirname(boardPath), f), "utf8") }));
  const calls = []; const said = []; let edited = false;
  // "# again": the drive is run a second time in a fresh interpreter that has only the plugin's storage from the first
  // run, as when the person comes back the next day (kc_run.RUN says which run it is).
  const again = !!driveSrc && /^# again$/m.test(driveSrc);
  if (again && !process.env.KC_AGAIN) { process.env.STATE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kc-state-")), "state.json"); }
  const store = process.env.STATE && fs.existsSync(process.env.STATE) ? JSON.parse(fs.readFileSync(process.env.STATE, "utf8")) : {};
  // "# file: <path from the repository root>": a fixture the drive reads from /kicad/drive/files/<name>
  // "# sibling: <path from the repository root>": another file of the project, beside the board (a board to panelize, …)
  if (driveSrc) for (const m of driveSrc.matchAll(/^# sibling: (\S+)$/gm)) { const f = path.resolve(server, "..", m[1]); siblings.push({ path: path.basename(f), text: fs.readFileSync(f, "utf8") }); }
  // The stand-in editor: hands out the board, accepts every dialog, records what the plugin asked for.
  let copied = ""; { const m = driveSrc && /^# copied: (\S+)$/m.exec(driveSrc); if (m) copied = fs.readFileSync(path.resolve(server, "..", m[1]), "utf8"); }
  const libraryFiles = []; const moving = []; const handedOver = []; const rewritten = [];
  const bridge = (method, json) => {
    const a = JSON.parse(json || "{}");
    calls.push({ method, summary: method === "design.commit" ? { create: a.create.length, update: a.update.length, transform: a.transform.length, remove: a.remove.length, kinds: kindsOf(a.create) } : method === "files.save" ? { filename: a.filename, bytes: Math.floor((a.base64 || "").length * 0.75), ...(/\.zip$/i.test(a.filename || "") ? { holds: zipNames(a.base64) } : {}) } : undefined });
    // After a commit the stand-in editor's board is what the plugin's own copy now says, as the real editor's would be,
    // and what was selected stays selected while it is still on the board.
    if (method === "design.commit") edited = true;
    // a plugin selecting its result, or a drive clicking an item, moves the selection
    if (method === "view.select" && Array.isArray(a.ids)) startSelection.splice(0, startSelection.length, ...a.ids);
    // Move (M) started for these items: the stand-in editor selects them and remembers that they follow the cursor.
    if (method === "view.move" && Array.isArray(a.ids)) { startSelection.splice(0, startSelection.length, ...a.ids); moving.push(a.ids); return JSON.stringify({ moving: true }); }
    if (method === "design.board") {
      let text = board;
      if (edited) { try { text = py.runPython("import pcbnew as _p\n_p._Host.board._text() if _p._Host.board is not None else ''") || board; } catch { /* keep the file */ } }
      return JSON.stringify({ path: path.basename(boardPath), text, selection: edited ? startSelection.filter((id) => text.includes(id)) : startSelection, version: "10.0.0", files: siblings });
    }
    // Library files offered to the project: the stand-in editor takes what a project takes and remembers it.
    // A schematic the plugin rewrote as a file: the stand-in project takes it when it is a KiCad file that differs.
    if (method === "project.rewriteDocument") {
      const ok = typeof a.text === "string" && a.text.trim().startsWith("(kicad_") && a.text !== a.base && siblings.some((f) => f.path === a.path);
      if (!ok) return JSON.stringify({ error: "not a document of this project" });
      const sib = siblings.find((f) => f.path === a.path); sib.text = a.text; rewritten.push(a.path); if (process.env.KC_DUMP) fs.writeFileSync(path.join(process.env.KC_DUMP, path.basename(a.path)), a.text);   // KC_DUMP=<folder>: keep the rewritten file to look at
      said.push(`Change the schematic: ${a.path}`);
      return JSON.stringify({ applied: true, changes: [{ kind: "changed", item: a.path }] });
    }
    if (method === "project.addLibraryFiles") { const added = (a.files || []).filter((f) => typeof f.text === "string" && f.text.trim().startsWith("(") || /\.(step|stp|wrl)$/i.test(f.path)).map((f) => f.path); libraryFiles.push(...(a.files || []).filter((f) => added.includes(f.path))); return JSON.stringify({ added, updated: [], failed: (a.files || []).map((f) => f.path).filter((x) => !added.includes(x)) }); }
    // The editors' copy buffer.  "# copied: <path from the repository root>" in a drive: what Copy took before the run.
    if (method === "design.copied") return JSON.stringify({ text: copied });
    if (method === "design.copy") { copied = String(a.text || ""); return JSON.stringify({ copied: copied.length }); }
    if (method === "ui.confirm") { said.push(`${a.title || ""}: ${String(a.message || "").slice(0, 300)}`); return "true"; }
    if (method === "ui.prompt") { const v = {}; for (const f of a.fields || []) v[f.name] = f.default ?? ""; return JSON.stringify(v); }
    // "# pick: saved" in a drive: asked for a file, the person picks the one this plugin handed over last (a layout it
    // saved, an export it made) that fits what the dialog accepts.  Without it nothing is picked.
    if (method === "files.save" && typeof a.base64 === "string") handedOver.push({ name: a.filename, base64: a.base64 });
    if (method === "files.pick") {
      // "# pick: <path from the repository root>": the person picks that file from their computer
      const given = driveSrc && /^# pick: (?!saved$)(\S+)$/m.exec(driveSrc);
      if (given) { const f = path.resolve(server, "..", given[1]); return JSON.stringify({ name: path.basename(f), base64: fs.readFileSync(f).toString("base64") }); }
      if (!driveSrc || !/^# pick: saved$/m.test(driveSrc)) return "null";
      const exts = (a.accept || []).map((e) => String(e).toLowerCase());
      // several files come as one ZIP: the person unpacks it and picks the file inside
      const loose = handedOver.flatMap((h) => (/\.zip$/i.test(h.name) ? unzip(h.base64) : [h]));
      const hit = loose.reverse().find((h) => !exts.length || exts.some((e) => h.name.toLowerCase().endsWith(e)));
      // a drive with picked(name, data) is the person changing that file in another program before choosing it
      if (hit && /^def picked\(/m.test(driveSrc)) {
        py.globals.set("_kc_picked", JSON.stringify(hit));
        hit.base64 = py.runPython(`
import json as _kj, base64 as _kb, sys as _ks
if "/kicad/drive" not in _ks.path: _ks.path.insert(0, "/kicad/drive")
import kc_drive as _kd
_kp = _kj.loads(_kc_picked)
_kb.b64encode(bytes(_kd.picked(_kp["name"], _kb.b64decode(_kp["base64"])))).decode("ascii")
`);
      }
      return hit ? JSON.stringify(hit) : "null";
    }
    // A plugin's storage in the editor.  STATE=<json file> keeps it between runs of this script, as the browser does.
    if (method === "storage.get") return JSON.stringify(store[a.key] ?? null);
    if (method === "storage.set") { store[a.key] = a.value ?? null; if (process.env.STATE) fs.writeFileSync(process.env.STATE, JSON.stringify(store)); return "null"; }
    if (method === "storage.remove") { delete store[a.key]; if (process.env.STATE) fs.writeFileSync(process.env.STATE, JSON.stringify(store)); return "null"; }
    if (method === "storage.keys") return JSON.stringify(Object.keys(store));
    // the network: there is none here, except one made-up host that answers with what it was sent (the runtime's own tests use it)
    if (method === "net.fetch") {
      let host = ""; try { host = new URL(a.url).hostname; } catch { /* not an address */ }
      // A drive that defines net(method, url, headers, body) plays the web service the plugin talks to: it checks what
      // arrived and answers (status, body) or (status, body, headers); None is "no such host".  Nothing leaves this machine.
      if (driveSrc && /^def net\(/m.test(driveSrc) && host !== "echo.kicad-web.test") {
        py.globals.set("_kc_net_req", JSON.stringify({ method: a.method, url: a.url, headers: a.headers || [], body: a.body || "" }));
        const out = py.runPython(`
import json as _kj, base64 as _kb, sys as _ks
if "/kicad/drive" not in _ks.path: _ks.path.insert(0, "/kicad/drive")
import kc_drive as _kd
_kr = _kj.loads(_kc_net_req)
_ka = _kd.net(_kr["method"], _kr["url"], {str(k).lower(): v for k, v in _kr["headers"]}, _kb.b64decode(_kr["body"]))
if _ka is None:
    _ko = {"error": "the drive's stand-in service has no such address: " + _kr["url"]}
else:
    _kst, _kbody = _ka[0], _ka[1]
    _kh = dict(_ka[2]) if len(_ka) > 2 else {}
    if isinstance(_kbody, (dict, list)):
        _kbody = _kj.dumps(_kbody); _kh.setdefault("Content-Type", "application/json")
    if isinstance(_kbody, str): _kbody = _kbody.encode("utf-8")
    _ko = {"status": int(_kst), "reason": "OK" if int(_kst) < 400 else "Error", "headers": [[k, v] for k, v in _kh.items()], "body": _kb.b64encode(_kbody).decode("ascii"), "url": _kr["url"]}
_kj.dumps(_ko)
`);
        return out;
      }
      if (host !== "echo.kicad-web.test") return JSON.stringify({ error: "the test harness has no network" });
      const sent = Buffer.from(a.body || "", "base64");
      const answer = JSON.stringify({ method: a.method, url: a.url, headers: a.headers, bytes: sent.length, text: sent.toString("utf8").slice(0, 2000) });
      return JSON.stringify({ status: a.url.includes("/missing") ? 404 : 200, reason: a.url.includes("/missing") ? "Not Found" : "OK", headers: [["Content-Type", "application/json"], ["X-Echo", "1"]], body: Buffer.from(answer).toString("base64"), url: a.url });
    }
    // fabrication: a stand-in for the editor's writers, enough for a plugin to carry on with what it does with the files
    const stem = path.basename(boardPath).replace(/\.kicad_pcb$/, "");
    // Gerbers, drill files, placements and the BOM are the editor's own writers too (static/dist/fab.js, as web/plugins/api.ts
    // calls them), so a drive can open what a fabrication plugin packs and find the board in it
    if (/^fab\.(gerbers|drill|positions|bom|layers)$/.test(method) && process.env.KC_FAB_STANDIN !== "1") {
      if (!globalThis.KiCadFab || !globalThis.KiCadFab.plotGerbers) { require(path.join(server, "static", "kicad-canvas.js")); require(path.join(server, "static", "dist", "fab.js")); }
      let text = board;
      if (edited) { try { text = py.runPython("import pcbnew as _p\n_p._Host.board._text() if _p._Host.board is not None else ''") || board; } catch { /* keep the file */ } }
      const K = globalThis.KiCadCanvas, F = globalThis.KiCadFab, ctx = { doc: K.parseDoc(text, "kicad_pcb"), setup: text, projectName: stem };
      const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 80) : undefined);
      if (method === "fab.layers") return JSON.stringify({ layers: F.plottableLayers(ctx.doc) });
      if (method === "fab.gerbers") {
        const all = F.plottableLayers(ctx.doc), want = strs(a.layers);
        const r = F.plotGerbers(ctx, { layers: want ? want.filter((l) => all.includes(l)) : undefined, useProtelExtensions: !!a.useProtelExtensions, useGerberX2: a.useGerberX2 !== false, useAuxOrigin: !!a.useAuxOrigin,
          precision: a.precision === 5 ? 5 : 6, plotReference: a.plotReference !== false, plotValue: a.plotValue !== false, subtractMaskFromSilk: !!a.subtractMaskFromSilk, commonLayers: strs(a.commonLayers),
          sketchDnpOnFab: a.sketchDnpOnFab, hideDnpOnFab: a.hideDnpOnFab, crossoutDnpOnFab: a.crossoutDnpOnFab });
        return JSON.stringify({ files: r.files.map((f) => ({ name: f.name, text: f.text, layer: f.layer })), warnings: r.warnings, missing: want ? want.filter((l) => !all.includes(l)) : [] });
      }
      if (method === "fab.drill") {
        const zeros = ["decimal", "suppress_leading", "suppress_trailing", "keep"].includes(a.zeros) ? a.zeros : "decimal";
        const files = F.drillFiles(ctx, { metric: a.metric !== false, zeros, merge: !!a.merge, minimalHeader: !!a.minimalHeader, mirrorY: !!a.mirrorY, ovalMode: a.ovalMode === "g85" ? "g85" : "route", useAuxOrigin: !!a.useAuxOrigin,
          extension: typeof a.extension === "string" && /^[A-Za-z0-9]{1,8}$/.test(a.extension) ? a.extension : undefined });
        return JSON.stringify({ files: files.map((f) => ({ name: f.name, text: f.text, holes: f.holes, tools: f.tools })) });
      }
      if (method === "fab.positions") {
        const side = a.side === "front" || a.side === "back" ? a.side : "both";
        const rows = F.positions(ctx, { side, smdOnly: !!a.smdOnly, excludeThroughHole: !!a.excludeThroughHole, excludeDnp: !!a.excludeDnp, useAuxOrigin: !!a.useAuxOrigin, negateBottomX: !!a.negateBottomX });
        return JSON.stringify({ rows: rows.map((r) => ({ ref: r.ref, value: r.value, package: r.pkg, x: r.x, y: r.y, rotation: r.rot, side: r.side })), csv: F.placementCsv(rows), ascii: F.placementAscii(rows, side, "2026-01-01 00:00:00", "KiCad") });
      }
      const lines = F.bom(ctx, { excludeDnp: !!a.excludeDnp }); return JSON.stringify({ csv: F.bomCsv(lines), lines: lines.length });
    }
    if (method === "fab.gerbers") return JSON.stringify({ files: (a.layers || []).map((l) => ({ name: `${stem}-${l.replace(/\./g, "_")}.gbr`, text: "G04 stand-in*\nM02*\n", layer: l })), warnings: [], missing: [] });
    if (method === "fab.drill") return JSON.stringify({ files: [{ name: `${stem}-PTH.drl`, text: "M48\nM30\n", holes: 0, tools: [] }, { name: `${stem}-NPTH.drl`, text: "M48\nM30\n", holes: 0, tools: [] }] });
    if (method === "fab.positions") return JSON.stringify({ rows: [], csv: "Ref,Val,Package,PosX,PosY,Rot,Side\n", ascii: "" });
    if (method === "fab.layers") return JSON.stringify({ layers: ["F.Cu", "B.Cu", "F.SilkS", "B.SilkS", "F.Mask", "B.Mask", "Edge.Cuts"] });
    if (method === "fab.bom") return JSON.stringify({ csv: "", lines: 0 });
    if (method === "fab.svg") { const ls = a.single ? [(a.layers || []).join("+")] : (a.layers || []); return JSON.stringify({ files: ls.map((l) => ({ name: a.single ? `${stem}.svg` : `${stem}-${l.replace(/\./g, "_")}.svg`, layer: l, text: '<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm" viewBox="0 0 10 10"></svg>\n' })), warnings: [], missing: [], box: [0, 0, 10, 10], page: [297, 210] }); }
    // PostScript, DXF, PDF and SVG plots are the editor's own writers (static/dist/fab.js) over the board as it stands,
    // so what a plugin goes on to do with the file (merge, recolour, measure) is done to the real thing
    if (method === "fab.plot") {
      if (!globalThis.KiCadFab || !globalThis.KiCadFab.pluginPlot) { require(path.join(server, "static", "kicad-canvas.js")); require(path.join(server, "static", "dist", "fab.js")); }
      let text = board;
      if (edited) { try { text = py.runPython("import pcbnew as _p\n_p._Host.board._text() if _p._Host.board is not None else ''") || board; } catch { /* keep the file */ } }
      const K = globalThis.KiCadCanvas, doc = K.parseDoc(text, "kicad_pcb");
      return JSON.stringify(globalThis.KiCadFab.pluginPlot({ doc, setup: text, projectName: stem }, a, (l) => String(K.pcbColor(l))));
    }
    // pcbnew.ExportVRML: the editor's own writer (static/dist/fab.js) over the board as it stands; the parts' models are
    // KiCad's STEP files tessellated by the same OpenCascade build the 3D viewer runs in the page (occt-import-js)
    if (method === "fab.vrml") {
      if (!globalThis.KiCadFab || !globalThis.KiCadFab.writeVrml) { require(path.join(server, "static", "kicad-canvas.js")); require(path.join(server, "static", "dist", "fab.js")); }
      if (!globalThis.KiCadViewer3D) require(path.join(server, "static", "dist", "viewer3d.js"));
      let text = board;
      if (edited) { try { text = py.runPython("import pcbnew as _p\n_p._Host.board._text() if _p._Host.board is not None else ''") || board; } catch { /* keep the file */ } }
      const K = globalThis.KiCadCanvas, doc = K.parseDoc(text, "kicad_pcb"); const have = new Map();
      const meshOf = (url) => {
        if (have.has(url)) return have.get(url);
        let mesh = null; const q = new URL(url, "http://editor.test").searchParams;
        if (occt && q.get("lib") && q.get("name")) {
          const got = library("model", { lib: q.get("lib"), name: q.get("name") });
          if (got && got.step) mesh = globalThis.KiCadViewer3D.geometry.flattenOcct(occt.ReadStepFile(new Uint8Array(Buffer.from(got.step, "utf8")), { linearUnit: "millimeter", linearDeflectionType: "absolute_value", linearDeflection: 0.02, angularDeflection: 0.5 }));
        }
        have.set(url, mesh); return mesh;
      };
      const r = globalThis.KiCadFab.writeVrml({ doc, setup: text, projectName: stem }, { unit: a.unit, separateModels: !!a.separateModels, relativePaths: !!a.relativePaths, subdir: String(a.subdir || ""), xref: a.xref || 0, yref: a.yref || 0,
        includeUnspecified: a.includeUnspecified !== false, includeDnp: a.includeDnp !== false, fileName: String(a.fileName || "board.wrl") }, meshOf);
      return JSON.stringify({ text: r.text, models: r.models, stats: r.stats });
    }
    if (method === "fab.drc") return JSON.stringify({ markers: [], parityError: "", note: "stand-in design rule check" });
    if (method === "fab.netlist") return JSON.stringify({ root: `${stem}.kicad_sch`, warnings: [], components: [], nets: [] });
    // KiCad's footprint libraries: the real files of the official repository at the server's pinned ref, fetched once and kept
    if (method.startsWith("libs.")) return JSON.stringify(library(method.slice(5), a));
    if (method === "project.versions") return JSON.stringify({ branch: null, versions: [] });
    if (method === "project.saveVersion") return JSON.stringify({ saved: !!a.name, dialog: !a.name });
    return "null";
  };
  if (driveSrc) { py.FS.mkdirTree("/kicad/drive"); py.FS.writeFile("/kicad/drive/kc_drive.py", driveSrc); for (const m of driveSrc.matchAll(/^# file: (\S+)$/gm)) { py.FS.mkdirTree("/kicad/drive/files"); py.FS.writeFile("/kicad/drive/files/" + path.basename(m[1]), fs.readFileSync(path.resolve(server, "..", m[1]))); } py.FS.writeFile("/kicad/drive/kc_run.py", `RUN = ${process.env.KC_AGAIN ? 2 : 1}\n`); py.FS.writeFile("/kicad/drive/drive_util.py", fs.readFileSync(path.join(here, "plugin-drives", "drive_util.py"))); }
  py.globals.set("_kc_files", py.toPy(readPackage(dir)));
  // cairosvg.svg2png is drawn by the browser the plugin runs in; without one, a real browser is started for the picture.
  globalThis.__kcSvgPng = (svg, w, h, background, negate) => {
    const r = spawnSync(process.execPath, [path.join(here, "plugin-svg-raster.mjs")], { input: JSON.stringify({ svg, w, h, background, negate }), encoding: "utf8", maxBuffer: 1 << 30, timeout: 120000 });
    if (r.status !== 0) throw new Error("SVG drawing failed: " + String(r.stderr || r.error || "").slice(-400));
    return r.stdout;
  };
  // ngspice: the browser's Python waits on the simulator in its page; here each request replays the session in a new one.
  globalThis.__kcSpiceSync = (request) => {
    const r = spawnSync(process.execPath, [path.join(here, "plugin-spice.mjs")], { input: String(request), encoding: "utf8", maxBuffer: 1 << 30, timeout: 120000 });
    if (r.status !== 0) throw new Error("ngspice failed: " + String(r.stderr || r.error || "").slice(-400));
    return r.stdout;
  };
  py.globals.set("_kc_bridge", bridge);
  const loaded = [];
  if (built) {
    py.globals.set("_kc_lock", fs.readFileSync(lockPath, "utf8"));
    const need = JSON.parse(await py.runPythonAsync(`import sys\nsys.path.insert(0, "/kicad/lib")\nimport kicad_web\nkicad_web.needed_packages(_kc_files, _kc_lock)`));
    for (const name of need) { try { await py.loadPackage(name, { messageCallback: () => {}, errorCallback: (t) => logs.push(t) }); loaded.push(name); } catch (e) { logs.push(`package ${name}: ${String(e).split("\n").pop()}`); } }
  }
  const t0 = Date.now();
  const info = JSON.parse(await py.runPythonAsync(`
import sys, os
os.environ["KICAD_WEB_DEBUG"] = "1"
sys.path.insert(0, "/kicad/lib")
import wx, kicad_web
wx._headless_modal = lambda dlg: wx.ID_OK
_kc_drove = []
_kc_modal_failed = []
_kc_modal_said = []
def _kc_main():
    import json
    if ${driveSrc ? "True" : "False"}:
        # the plugin is its own program with a main loop: the person acts while that loop runs
        if "/kicad/drive" not in sys.path: sys.path.append("/kicad/drive")
        import kc_drive
        _kc_drove.append(kc_drive.after_run(None))
        return
    r = json.loads(kicad_web.press_default())
    if r.get("error"):
        raise RuntimeError(r["error"])
wx._headless_main = _kc_main
if ${driveSrc ? "True" : "False"}:
    sys.path.append("/kicad/drive")
    import drive_util          # listens to what the plugin says from the start
    import kc_drive
    def _kc_modal(dlg):
        # a dialog the plugin waits on: the drive works it while it is open (modal(dialog)), then it closes with OK
        # (a plugin may catch what its dialog raises: what the drive found wrong is kept and fails the run all the same)
        try:
            r = kc_drive.modal(dlg) if hasattr(kc_drive, "modal") else None
        except BaseException as e:
            _kc_modal_failed.append("%s: %s" % (type(e).__name__, e))
            raise
        if isinstance(r, dict):
            _kc_modal_said.append(r)
            return wx.ID_OK
        return wx.ID_OK if r is None else r
    wx._headless_modal = _kc_modal
else:
    import wx, kicad_web
    # nobody is there to click: a dialog the plugin waits on gets its main button pressed, so its work runs
    wx._headless_modal = kicad_web.press_modal
# WATCHDOG=<seconds>: a plugin that never returns is stopped where it stands, so the table says where it waits
_kc_limit = ${Number(process.env.WATCHDOG || 0)}
if _kc_limit:
    import time, threading
    _kc_t0 = [time.time()]
    def _kc_trace(frame, event, arg):
        if event == "call" and time.time() - _kc_t0[0] > _kc_limit:
            _kc_t0[0] = time.time() + 1e9
            sys.settrace(None)
            raise TimeoutError("still running after %d seconds, in %s (%s line %d)" % (_kc_limit, frame.f_code.co_name, frame.f_code.co_filename.split("/")[-1], frame.f_lineno))
        return None
    sys.settrace(_kc_trace)
kicad_web.boot(${JSON.stringify(identifier)}, _kc_files, _kc_bridge, ${JSON.stringify(meta.name || identifier)})
`));
  const result = { identifier, name: meta.name || identifier, loadMs: Date.now() - t0, loadError: info.error, actions: [], missing: info.missing, calls: [], log: [], packages: loaded };
  for (const a of info.actions) {
    const before = calls.length; const t1 = Date.now();
    let out; try { out = JSON.parse(await py.runPythonAsync(`kicad_web.run_action(${a.index})`)); } catch (e) { out = { ok: false, error: String(e).split("\n").slice(-2).join(" ").slice(0, 300) }; }
    // A plugin that opened a window and returned has done nothing yet: press the window's main button, as a person would.
    let pressed = []; let drive;
    if (out.ok && driveSrc) {
      py.globals.set("_kc_action", a.name);
      try { const d = JSON.parse(await py.runPythonAsync(`
import sys, json, traceback
if "/kicad/drive" not in sys.path: sys.path.append("/kicad/drive")
import kc_drive, kicad_web
kicad_web._running[0] += 1
try:
    if _kc_modal_failed:
        raise AssertionError(_kc_modal_failed.pop(0).split(": ", 1)[-1])
    _kc_r = {"result": _kc_drove.pop() if _kc_drove else (kc_drive.after_run(_kc_action) if hasattr(kc_drive, "after_run") else (_kc_modal_said[-1] if _kc_modal_said else None))}
    kicad_web.flush(); kicad_web._export_outputs()
except BaseException as e:
    traceback.print_exc()
    _kc_r = {"error": "%s: %s" % (type(e).__name__, e)}
finally:
    kicad_web._running[0] -= 1
json.dumps(_kc_r, default=str)`)); if (d.error) out = { ok: false, error: "driven as a person would: " + d.error }; else drive = d.result; } catch (e) { out = { ok: false, error: String(e).split("\n").slice(-2).join(" ").slice(0, 300) }; }
    } else if (out.ok) { try { const p = JSON.parse(await py.runPythonAsync("kicad_web.press_default()")); pressed = p.pressed; if (p.error) out = { ok: false, error: `after pressing ${JSON.stringify(p.pressed[p.pressed.length - 1] || "")}: ${p.error}` }; } catch (e) { out = { ok: false, error: String(e).split("\n").slice(-2).join(" ").slice(0, 300) }; } }
    const mine = calls.slice(before);
    result.actions.push({ name: a.name, ok: !!out.ok, error: out.error || null, ms: Date.now() - t1, commits: mine.filter((c) => c.method === "design.commit").map((c) => c.summary), saved: mine.filter((c) => c.method === "files.save").map((c) => c.summary), dialogs: mine.filter((c) => c.method.startsWith("ui.") && c.method !== "ui.status").length, pressed, fab: mine.filter((c) => c.method.startsWith("fab.")).length, ...(drive !== undefined ? { drive } : {}) });
  }
  const after = JSON.parse(py.runPython("import json, kicad_web; json.dumps(kicad_web.describe()['missing'])"));
  result.missing = after; result.messages = py.runPython("import json, wx; json.dumps(wx._messages[-6:])");
  result.libraries = libraryFiles.map((f) => f.path);
  if (moving.length) result.moving = moving;
  if (rewritten.length) result.rewritten = rewritten;
  result.log = logs.slice(-40); result.said = said.slice(-12); result.net = calls.filter((c) => c.method === "net.fetch").length;
  if (again && !process.env.KC_AGAIN && result.actions.every((x) => x.ok)) {
    const r = spawnSync(process.execPath, process.argv.slice(1), { env: { ...process.env, KC_AGAIN: "1" }, encoding: "utf8", maxBuffer: 1 << 28, timeout: 600000 });
    let second = null; try { second = JSON.parse(String(r.stdout || "").trim().split("\n").pop()); } catch { /* reported below */ }
    result.actions.forEach((x, i) => {
      const y = second && second.actions[i];
      if (!y) { x.ok = false; x.error = "the second run did not finish: " + String(r.stderr || "").slice(-300); }
      else if (!y.ok) { x.ok = false; x.error = "on the second run: " + y.error; }
      else x.again = y.drive;
    });
  }
  return result;
}

const verdict = (r) => {
  if (!r) return "crashed";
  if (r.timeout) return "timeout";
  if (r.loadError && !r.actions.length) return "load-error";
  if (!r.actions.length) return "no-actions";
  if (r.actions.every((a) => a.ok)) return "runs";
  if (r.actions.some((a) => a.ok)) return "partly";
  return "run-error";
};

async function all() {
  const src = process.env.PCM_SRC; if (!src) { console.error("set PCM_SRC to a folder of unpacked PCM packages"); process.exit(2); }
  const dirs = fs.readdirSync(src).filter((d) => fs.existsSync(path.join(src, d, "plugins")) && (!process.env.ONLY || d.includes(process.env.ONLY))).sort();
  const results = {}; let next = 0;
  const runOne = (d) => new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--one", path.join(src, d), ...(process.env.BOARD ? ["--board", path.resolve(process.env.BOARD)] : [])], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; child.stdout.on("data", (b) => { out += b; }); child.stderr.on("data", (b) => { err += b; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); results[d] = { identifier: d, timeout: true, actions: [] }; }, Number(process.env.TIMEOUT || 120000));
    child.on("close", () => { clearTimeout(timer); if (!results[d]) { try { results[d] = JSON.parse(out.slice(out.indexOf("\n{\"identifier\"") + 1)); } catch { results[d] = null; if (process.env.VERBOSE) console.error(d, err.slice(-600), out.slice(-300)); } } resolve(); });
  });
  const worker = async () => { while (next < dirs.length) { const d = dirs[next++]; await runOne(d); const r = results[d]; console.log(`${verdict(r).padEnd(11)} ${d}${r && r.loadError ? "  — " + r.loadError.slice(0, 110) : ""}${r && r.actions ? r.actions.filter((a) => !a.ok).map((a) => `  — ${a.name}: ${String(a.error).slice(0, 110)}`).join("") : ""}`); } };
  await Promise.all(Array.from({ length: Number(process.env.JOBS || 4) }, worker));
  const tally = {}; for (const d of dirs) { const v = verdict(results[d]); tally[v] = (tally[v] || 0) + 1; }
  console.log("\n" + dirs.length + " plugins: " + Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(", "));
  // COMPAT=<file> writes what the Plugin Manager shows beside each plugin (plugins/python/compat.json).
  if (process.env.COMPAT) {
    const clean = (t) => String(t || "").replace(/\s+/g, " ").replace(/^after pressing "[^"]*": /, "").trim().slice(0, 220);
    // Compiled packages the build fetches from the Pyodide CDN (plugins/python/packages.json).  Where the build could not
    // reach it (this run), a plugin that stops for want of one is "untested", not "does not run".
    const want = JSON.parse(fs.readFileSync(path.join(shimDir, "packages.json"), "utf8"));
    const lockAll = JSON.parse(fs.readFileSync(path.join(server, "node_modules", "pyodide", "pyodide-lock.json"), "utf8")).packages;
    const compiled = new Map(); for (const name of want.pyodide) { const walk1 = (n) => { const e = lockAll[n]; if (!e) return; for (const imp of e.imports || []) compiled.set(imp.split(".")[0], n); for (const dep of e.depends || []) walk1(dep); }; walk1(name); }
    const needsCompiled = (text) => { const m = /Python module “([^”]+)”/.exec(String(text || "")); const top = m ? m[1].split(".")[0] : ""; return top && compiled.has(top) ? compiled.get(top) : ""; };
    const untested = (pkg) => ({ status: "untested", note: `It needs the ${pkg} package, which is compiled code the test machine could not download. A server that can reach the Pyodide package CDN when it is built has it.` });
    // "Runs here" is only said of a plugin that was seen doing its work: it changed the board, wrote a file, made a
    // fabrication output, or its drive (scripts/plugin-drives) checked the result.  EVIDENCE=<OUT files, comma
    // separated> adds earlier runs of the same sweep on other boards or with other selections.
    const did = (x) => !!x && x.verdict !== "run-error" && (x.actions || []).some((a) => a.ok && ((a.commits || []).length || (a.saved || []).length || a.fab || a.drive !== undefined));
    const earlier = (process.env.EVIDENCE || "").split(",").filter(Boolean).map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
    const worked = (d, r) => did(r) || earlier.some((e) => did(e[d]));
    const lastSaid = (r) => clean(((r && r.said) || []).slice(-1)[0] || "").slice(0, 160);
    const notes = JSON.parse(fs.readFileSync(path.join(shimDir, "compat-notes.json"), "utf8")).plugins || {};
    const table = {};
    for (const d of dirs) {
      const r = results[d], v = verdict(r);
      const firstError = r && (r.loadError || (r.actions.find((x) => !x.ok) || {}).error);
      const pkg = needsCompiled(firstError);
      const net = r && r.net > 0;
      if (notes[d]) table[d] = notes[d];
      else if (pkg) table[d] = untested(pkg);
      else if (v === "runs" && !net && !worked(d, r)) table[d] = { status: "opens", note: `It opens, but the test run did not see it do its work${lastSaid(r) ? ` (it said: "${lastSaid(r)}")` : ""}. Nobody has checked its result here yet.` };
      else if (v === "runs") table[d] = net ? { status: "partly", note: "It runs. What it sends to a web service goes through this server once you grant it network access; the test machine has no network, so that part is untested." } : { status: "works" };
      else if (v === "partly") table[d] = { status: "partly", note: `${r.actions.filter((x) => x.ok).length} of its ${r.actions.length} commands run. ${r.actions.filter((x) => !x.ok).map((x) => `${x.name.replace(/\s+/g, " ").trim()}: ${clean(x.error)}`).join("; ")}`.slice(0, 600) };
      else if (v === "no-actions") table[d] = { status: "unsupported", note: r.loadError ? `It does not load: ${clean(r.loadError)}` : "It adds no board editor command." };
      else if (v === "load-error") table[d] = { status: "unsupported", note: `It does not load: ${clean(r.loadError)}` };
      else if (v === "run-error") table[d] = net ? { status: "partly", note: "It opens and prepares its work. What it sends to a web service goes through this server once you grant it network access; the test machine has no network, so that part is untested." } : { status: "unsupported", note: `It loads, but fails when run: ${clean(r.actions.find((x) => !x.ok).error)}` };
      else table[d] = { status: "unsupported", note: v === "timeout" ? "It did not finish within the test's time limit." : "The interpreter stopped while loading it." };
    }
    const count = {}; for (const d of dirs) count[table[d].status] = (count[table[d].status] || 0) + 1;
    console.log("labels: " + Object.entries(count).map(([k, n]) => `${n} ${k}`).join(", "));
    fs.writeFileSync(process.env.COMPAT, JSON.stringify(table, null, 1) + "\n");
  }
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(Object.fromEntries(dirs.map((d) => [d, results[d] ? Object.assign({ verdict: verdict(results[d]) }, results[d]) : { verdict: "crashed" }])), null, 1));
}

const i = process.argv.indexOf("--one");
if (i > 0) {
  const b = process.argv.indexOf("--board");
  one(process.argv[i + 1], b > 0 ? process.argv[b + 1] : defaultBoard, b > 0).then((r) => { process.stdout.write("\n" + JSON.stringify(r) + "\n"); process.exit(0); }, (e) => { console.error(e); process.exit(1); });
} else await all();
