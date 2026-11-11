// plugins-python.mjs — how many of KiCad's official Python plugins the web runtime carries.
//
// Runs the same Python the browser runs (Pyodide) with the same shim modules
// (server/plugins/python), but without a browser: every plugin package under PCM_SRC is
// imported, its registered actions are listed and each is run against a demo board with every
// dialog answered "OK".  What comes back is a table: loads / registers / runs / what it lacks.
//
//   PCM_SRC=<folder of unpacked PCM packages> node plugins-python.mjs            # all of them
//   node plugins-python.mjs --one <package folder> [--board file.kicad_pcb]      # one, as JSON
//   OUT=compat.json  writes the table as JSON too.  ONLY=substring narrows the run.
//
// Each package folder is an unpacked PCM zip: metadata.json, plugins/, resources/.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(here, "..");
const shimDir = path.join(server, "plugins", "python");
const defaultBoard = path.resolve(server, "..", "demos", "ecc83", "ecc83-pp.kicad_pcb");
const TEXT = /\.(py|pyi|json|txt|md|rst|csv|tsv|xml|xrc|html?|css|js|ya?ml|toml|ini|cfg|conf|fbp|kicad_[a-z]+|svg|po|pot|lua|sh|bat|in|tpl|template|dru|net|cmp|pro|lib|mod|dcm)$/i;
const MAX_FILE = 3 * 1024 * 1024;

function walk(dir, base = "") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) { if (e.name !== "__pycache__" && e.name !== ".git") out.push(...walk(path.join(dir, e.name), rel)); }
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

async function one(dir, boardPath) {
  const require = createRequire(path.join(server, "package.json"));
  const { loadPyodide } = require("pyodide");
  const logs = []; if (process.env.KICAD_WEB_DEBUG) { /* set below, inside Python */ }
  const py = await loadPyodide({ stdout: (t) => logs.push(t), stderr: (t) => logs.push(t) });
  py.FS.mkdirTree("/kicad/lib");
  for (const rel of walk(shimDir)) { const dst = "/kicad/lib/" + rel; py.FS.mkdirTree(path.posix.dirname(dst)); py.FS.writeFile(dst, fs.readFileSync(path.join(shimDir, rel))); }
  let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf8")); } catch { /* none */ }
  const identifier = meta.identifier || path.basename(dir);
  const board = fs.readFileSync(boardPath, "utf8");
  // the project file and schematics beside the board, as the editor hands them over
  const siblings = fs.readdirSync(path.dirname(boardPath)).filter((f) => /\.kicad_(sch|pro)$/.test(f)).map((f) => ({ path: f, text: fs.readFileSync(path.join(path.dirname(boardPath), f), "utf8") }));
  const calls = []; const said = [];
  // The stand-in editor: hands out the board, accepts every dialog, records what the plugin asked for.
  const bridge = (method, json) => {
    const a = JSON.parse(json || "{}");
    calls.push({ method, summary: method === "design.commit" ? { create: a.create.length, update: a.update.length, transform: a.transform.length, remove: a.remove.length } : method === "files.save" ? { filename: a.filename, bytes: Math.floor((a.base64 || "").length * 0.75) } : undefined });
    if (method === "design.board") return JSON.stringify({ path: path.basename(boardPath), text: board, selection: [], version: "10.0.0", files: siblings });
    if (method === "ui.confirm") { said.push(`${a.title || ""}: ${String(a.message || "").slice(0, 300)}`); return "true"; }
    if (method === "ui.prompt") { const v = {}; for (const f of a.fields || []) v[f.name] = f.default ?? ""; return JSON.stringify(v); }
    if (method === "files.pick") return "null";
    // fabrication: a stand-in for the editor's writers, enough for a plugin to carry on with what it does with the files
    const stem = path.basename(boardPath).replace(/\.kicad_pcb$/, "");
    if (method === "fab.gerbers") return JSON.stringify({ files: (a.layers || []).map((l) => ({ name: `${stem}-${l.replace(/\./g, "_")}.gbr`, text: "G04 stand-in*\nM02*\n", layer: l })), warnings: [], missing: [] });
    if (method === "fab.drill") return JSON.stringify({ files: [{ name: `${stem}-PTH.drl`, text: "M48\nM30\n", holes: 0, tools: [] }, { name: `${stem}-NPTH.drl`, text: "M48\nM30\n", holes: 0, tools: [] }] });
    if (method === "fab.positions") return JSON.stringify({ rows: [], csv: "Ref,Val,Package,PosX,PosY,Rot,Side\n", ascii: "" });
    if (method === "fab.layers") return JSON.stringify({ layers: ["F.Cu", "B.Cu", "F.SilkS", "B.SilkS", "F.Mask", "B.Mask", "Edge.Cuts"] });
    if (method === "fab.bom") return JSON.stringify({ csv: "", lines: 0 });
    return "null";
  };
  py.globals.set("_kc_files", py.toPy(readPackage(dir)));
  py.globals.set("_kc_bridge", bridge);
  const t0 = Date.now();
  const info = JSON.parse(await py.runPythonAsync(`
import sys, os
os.environ["KICAD_WEB_DEBUG"] = "1"
sys.path.insert(0, "/kicad/lib")
import wx, kicad_web
wx._headless_modal = lambda dlg: wx.ID_OK
kicad_web.boot(${JSON.stringify(identifier)}, _kc_files, _kc_bridge, ${JSON.stringify(meta.name || identifier)})
`));
  const result = { identifier, name: meta.name || identifier, loadMs: Date.now() - t0, loadError: info.error, actions: [], missing: info.missing, calls: [], log: [] };
  for (const a of info.actions) {
    const before = calls.length; const t1 = Date.now();
    let out; try { out = JSON.parse(await py.runPythonAsync(`kicad_web.run_action(${a.index})`)); } catch (e) { out = { ok: false, error: String(e).split("\n").slice(-2).join(" ").slice(0, 300) }; }
    // A plugin that opened a window and returned has done nothing yet: press the window's main button, as a person would.
    let pressed = []; if (out.ok) { try { const p = JSON.parse(await py.runPythonAsync("kicad_web.press_default()")); pressed = p.pressed; if (p.error) out = { ok: false, error: `after pressing ${JSON.stringify(p.pressed[p.pressed.length - 1] || "")}: ${p.error}` }; } catch (e) { out = { ok: false, error: String(e).split("\n").slice(-2).join(" ").slice(0, 300) }; } }
    const mine = calls.slice(before);
    result.actions.push({ name: a.name, ok: !!out.ok, error: out.error || null, ms: Date.now() - t1, commits: mine.filter((c) => c.method === "design.commit").map((c) => c.summary), saved: mine.filter((c) => c.method === "files.save").map((c) => c.summary), dialogs: mine.filter((c) => c.method.startsWith("ui.") && c.method !== "ui.status").length, pressed, fab: mine.filter((c) => c.method.startsWith("fab.")).length });
  }
  const after = JSON.parse(py.runPython("import json, kicad_web; json.dumps(kicad_web.describe()['missing'])"));
  result.missing = after; result.messages = py.runPython("import json, wx; json.dumps(wx._messages[-6:])");
  result.log = logs.slice(-40); result.said = said.slice(-12);
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
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--one", path.join(src, d)], { stdio: ["ignore", "pipe", "pipe"] });
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
    const table = {};
    for (const d of dirs) {
      const r = results[d], v = verdict(r);
      if (v === "runs") table[d] = { status: "works" };
      else if (v === "partly") table[d] = { status: "partly", note: `${r.actions.filter((x) => x.ok).length} of its ${r.actions.length} commands run. ${r.actions.filter((x) => !x.ok).map((x) => `${x.name.replace(/\s+/g, " ").trim()}: ${clean(x.error)}`).join("; ")}`.slice(0, 600) };
      else if (v === "no-actions") table[d] = { status: "unsupported", note: r.loadError ? `It does not load: ${clean(r.loadError)}` : "It adds no board editor command: it is a footprint wizard, a library, or a plugin for KiCad's IPC interface, which the web editor does not have yet." };
      else if (v === "load-error") table[d] = { status: "unsupported", note: `It does not load: ${clean(r.loadError)}` };
      else if (v === "run-error") table[d] = { status: "unsupported", note: `It loads, but fails when run: ${clean(r.actions.find((x) => !x.ok).error)}` };
      else table[d] = { status: "unsupported", note: v === "timeout" ? "It did not finish within the test's time limit." : "The interpreter stopped while loading it." };
    }
    fs.writeFileSync(process.env.COMPAT, JSON.stringify(table, null, 1) + "\n");
  }
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(Object.fromEntries(dirs.map((d) => [d, results[d] ? Object.assign({ verdict: verdict(results[d]) }, results[d]) : { verdict: "crashed" }])), null, 1));
}

const i = process.argv.indexOf("--one");
if (i > 0) {
  const b = process.argv.indexOf("--board");
  one(process.argv[i + 1], b > 0 ? process.argv[b + 1] : defaultBoard).then((r) => { process.stdout.write("\n" + JSON.stringify(r) + "\n"); process.exit(0); }, (e) => { console.error(e); process.exit(1); });
} else await all();
