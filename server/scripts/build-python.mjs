// build-python.mjs — puts the Python runtime where the server embeds it (static/dist/pyodide):
// the interpreter and standard library from the pyodide package, and our shim modules
// (plugins/python: pcbnew, wx, kicad_web, …) packed into one JSON file the sandbox fetches.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(server, "static", "dist", "pyodide");
fs.mkdirSync(out, { recursive: true });
const pkg = path.join(server, "node_modules", "pyodide");
for (const f of ["pyodide.js", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"]) {
  const src = path.join(pkg, f), dst = path.join(out, f);
  if (!fs.existsSync(dst) || !fs.readFileSync(src).equals(fs.readFileSync(dst))) fs.copyFileSync(src, dst);
}
const shim = path.join(server, "plugins", "python"); const files = {};
const walk = (dir, base) => { for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const rel = base ? base + "/" + e.name : e.name; if (e.isDirectory()) { if (e.name !== "__pycache__") walk(path.join(dir, e.name), rel); } else if (e.name.endsWith(".py")) files[rel] = fs.readFileSync(path.join(dir, e.name), "utf8"); } };
walk(shim, "");
fs.writeFileSync(path.join(out, "kicad-python.json"), JSON.stringify({ version: JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).version, files }));
console.log(`python runtime: ${Object.keys(files).length} shim modules, pyodide ${JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).version}`);
