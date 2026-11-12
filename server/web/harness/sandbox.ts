// harness/sandbox — the process a run_python call's script runs in (started by web/mcp/host.ts).
//
// The script is somebody's (or some model's) Python, so it runs where it can do nothing but
// compute and ask the editor for design calls:
// - Node is started with --permission (no file writes, no child processes, no workers, reads
//   only of the Python runtime and this file), --disallow-code-generation-from-strings (so the
//   interpreter's JavaScript bridge cannot be turned into eval) and an empty environment;
// - the Python runtime (Pyodide) is given an empty object as its JavaScript globals, and the
//   network globals are deleted before it loads;
// - the only way out is `_kc_host.call(tool, json)`, a blocking request on stdout answered on
//   stdin by the editor process, which checks every call like any other tool call.
// The parent stops this process when the time limit passes.
//
// Wire format, one JSON object per line.  In, first: { code }.  Out: { call, args } answered by
// { ok, result | error }, any number of times; then { done: true, ok, output, result?, error?, notes? }.

/* eslint-disable @typescript-eslint/no-explicit-any */
import initPy from "../../harness/kicad_harness/__init__.py";
import projectPy from "../../harness/kicad_harness/project.py";
import transportPy from "../../harness/kicad_harness/transport.py";
import partsInitPy from "../../harness/kicad_harness/parts/__init__.py";
import datasheetPy from "../../harness/kicad_harness/parts/datasheet.py";
import footprintPy from "../../harness/kicad_harness/parts/footprint.py";
import searchPy from "../../harness/kicad_harness/parts/search.py";
import symbolPy from "../../harness/kicad_harness/parts/symbol.py";

declare const process: any;
declare function require(name: string): any;
declare const Buffer: any;

const fs = require("node:fs");
const G = globalThis as any;

// ---- lock down before anything of the interpreter's runs
const fsConstants = fs.constants;
process.binding = (name: string) => { if (name === "constants") return { fs: fsConstants }; throw new Error("not available"); };
for (const k of ["WebSocket", "fetch", "XMLHttpRequest", "EventSource", "navigator"]) { try { delete G[k]; } catch { /* not configurable */ } }

// ---- blocking line I/O with the parent
const decoder = new (require("node:string_decoder").StringDecoder)("utf8");
const nap = new Int32Array(new SharedArrayBuffer(4));
let held = "";
function readLine(): string {
  const buf = Buffer.alloc(1 << 16);
  for (;;) {
    const at = held.indexOf("\n");
    if (at >= 0) { const line = held.slice(0, at); held = held.slice(at + 1); return line; }
    let n = 0;
    try { n = fs.readSync(0, buf, 0, buf.length, null); }
    catch (e: any) { if (e && e.code === "EAGAIN") { Atomics.wait(nap, 0, 0, 4); continue; } if (e && e.code === "EOF") n = 0; else throw e; }
    if (!n) process.exit(0);   // the parent went away
    held += decoder.write(buf.subarray(0, n));
  }
}
function writeLine(msg: unknown): void {
  const data = Buffer.from(JSON.stringify(msg) + "\n", "utf8"); let off = 0;
  while (off < data.length) {
    try { off += fs.writeSync(1, data, off, data.length - off); }
    catch (e: any) { if (e && e.code === "EAGAIN") { Atomics.wait(nap, 0, 0, 4); continue; } throw e; }
  }
}

const FILES: [string, string][] = [
  ["kicad_harness/__init__.py", initPy], ["kicad_harness/project.py", projectPy], ["kicad_harness/transport.py", transportPy],
  ["kicad_harness/parts/__init__.py", partsInitPy], ["kicad_harness/parts/datasheet.py", datasheetPy], ["kicad_harness/parts/footprint.py", footprintPy],
  ["kicad_harness/parts/search.py", searchPy], ["kicad_harness/parts/symbol.py", symbolPy],
];

// The script runs with `kh` (the package), `project`, and `parts` already there.  What it prints is the output; a
// variable named `result` is returned as data.  A failure names the script line it happened on.
const RUNNER = `
import json, sys, traceback
sys.path.insert(0, "/kh")
import kicad_harness as kh
from kicad_harness import parts

def __kc_run(code):
    out = {"ok": True}
    project = None
    try:
        project = kh.current()
        g = {"__name__": "__main__", "kh": kh, "project": project, "parts": parts}
        exec(compile(code, "<script>", "exec"), g)
        project.commit()
        if "result" in g:
            try:
                out["result"] = json.loads(json.dumps(g["result"], default=str))
            except Exception:
                out["result"] = str(g["result"])
    except BaseException as e:
        line = None
        for f in traceback.extract_tb(e.__traceback__):
            if f.filename == "<script>":
                line = f.lineno
        if isinstance(e, SyntaxError) and e.filename == "<script>":
            line = e.lineno
        what = str(e) if isinstance(e, kh.HarnessError) else f"{type(e).__name__}: {e}"
        out = {"ok": False, "error": what, "line": line}
    if project is not None and project.log:
        out["notes"] = project.log[-60:]
    return json.dumps(out)
`;

async function main(): Promise<void> {
  const first = JSON.parse(readLine());
  const dir = String(process.argv[2] || ""); const printed: string[] = []; let size = 0;
  const keep = (s: string) => { if (size < 200000) { printed.push(s); size += s.length + 1; } };
  const { loadPyodide } = require(dir + "pyodide.js");
  const py = await loadPyodide({ indexURL: dir, jsglobals: {}, stdout: keep, stderr: keep });
  py.registerJsModule("_kc_host", { call: (tool: unknown, args: unknown) => { writeLine({ call: String(tool), args: JSON.parse(String(args || "{}")) }); return readLine(); } });
  py.FS.mkdirTree("/kh/kicad_harness/parts");
  for (const [path, text] of FILES) py.FS.writeFile("/kh/" + path, text);
  py.runPython(RUNNER);
  const run = py.globals.get("__kc_run");
  let out: any;
  try { out = JSON.parse(String(run(String(first.code || "")))); }
  catch (e: any) { out = { ok: false, error: String((e && e.message) || e).split("\n").filter(Boolean).slice(-1)[0] || "The script failed." }; }
  out.done = true; out.output = printed.join("\n");
  writeLine(out);
  process.exit(0);
}

main().catch((e) => { try { writeLine({ done: true, ok: false, error: "The Python runtime could not be started: " + String((e && e.message) || e), output: "" }); } finally { process.exit(1); } });
