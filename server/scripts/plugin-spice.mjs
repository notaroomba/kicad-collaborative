// plugin-spice.mjs — ngspice for the headless plugin harness (plugins-python.mjs).
//
// In the browser a plugin's Python waits on the simulator in its own page.  The harness's Python cannot wait on
// anything, so each request starts this program, which replays the session so far (the files written and the
// commands given) in a fresh ngspice and answers with the result of the last step.  ngspice itself is the same
// WebAssembly build the browser loads (npm eecircuit-engine) behind the same session code (web/plugins/spice.ts).
//
//   stdin:  {"ops": [["write", path, base64] | ["remove", path] | ["exec", [commands]] | ["read", path] | ["list", dir]]}
//   stdout: {"version": "45.2", "result": <what the last op gave>}
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(here, "..");
const shim = JSON.parse(fs.readFileSync(path.join(server, "static", "dist", "pyodide", "kicad-python.json"), "utf8"));
const say = console.log; console.log = () => undefined; console.info = () => undefined; console.warn = () => undefined;
(0, eval)(shim.files["kicad_spice.js"]);
const session = await globalThis.__kcSpice.open(pathToFileURL(path.join(server, "node_modules", "eecircuit-engine", "dist", "eecircuit-engine.mjs")).href);
const { ops } = JSON.parse(fs.readFileSync(0, "utf8"));
let result = null;
for (const [kind, a, b] of ops) {
  if (kind === "write") { session.write(a, Buffer.from(b, "base64")); result = null; }
  else if (kind === "remove") { session.remove(a); result = null; }
  else if (kind === "exec") result = await session.exec(a);
  else if (kind === "read") { const d = session.read(a); result = d ? Buffer.from(d).toString("base64") : null; }
  else if (kind === "list") result = session.list(a);
}
say(JSON.stringify({ version: session.version, result }));
process.exit(0);
