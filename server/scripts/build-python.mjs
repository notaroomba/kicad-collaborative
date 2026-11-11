// build-python.mjs — puts the Python runtime where the server embeds it (static/dist/pyodide):
// the interpreter and standard library from the pyodide package, and our shim modules
// (plugins/python: pcbnew, wx, kicad_web, …) packed into one JSON file the sandbox fetches.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(server, "static", "dist", "pyodide");
fs.mkdirSync(out, { recursive: true });
const pkg = path.join(server, "node_modules", "pyodide");
for (const f of ["pyodide.js", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip"]) {
  const src = path.join(pkg, f), dst = path.join(out, f);
  if (!fs.existsSync(dst) || !fs.readFileSync(src).equals(fs.readFileSync(dst))) fs.copyFileSync(src, dst);
}
const shim = path.join(server, "plugins", "python"); const files = {};
const walk = (dir, base) => { for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const rel = base ? base + "/" + e.name : e.name; if (e.isDirectory()) { if (e.name !== "__pycache__") walk(path.join(dir, e.name), rel); } else if (e.name.endsWith(".py")) files[rel] = fs.readFileSync(path.join(dir, e.name), "utf8"); } };
walk(shim, "");
fs.writeFileSync(path.join(out, "kicad-python.json"), JSON.stringify({ version: JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).version, files }));

// ---- packages a plugin may import (plugins/python/packages.json)
// The interpreter loads a package by name from its lock file, so the lock written here lists
// exactly the packages whose files are present: a package that could not be downloaded is
// simply one a plugin is told the web editor does not have.
const version = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).version;
const lock = JSON.parse(fs.readFileSync(path.join(pkg, "pyodide-lock.json"), "utf8"));
const want = JSON.parse(fs.readFileSync(path.join(shim, "packages.json"), "utf8"));
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const get = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(120000) }); if (!r.ok) throw new Error(url + " answered " + r.status); return Buffer.from(await r.arrayBuffer()); };
const have = (file, hash) => { const f = path.join(out, file); return fs.existsSync(f) && (!hash || sha(fs.readFileSync(f)) === hash); };
const pypiWheel = async (name, ver, file) => {
  const meta = JSON.parse((await get(`https://pypi.org/pypi/${name}/${ver}/json`)).toString("utf8"));
  const hit = (meta.urls || []).find((u) => u.filename.toLowerCase() === file.toLowerCase());
  if (!hit) throw new Error(`PyPI has no ${file}`);
  const buf = await get(hit.url); if (sha(buf) !== hit.digests.sha256) throw new Error(`${file} does not match PyPI's SHA-256`);
  return buf;
};
const packages = {}; const missing = [];
const fromLock = async (name) => {
  if (packages[name] || missing.includes(name)) return !!packages[name];
  const e = lock.packages[name]; if (!e) { missing.push(name); return false; }
  for (const d of e.depends || []) if (!(await fromLock(d))) { missing.push(name); return false; }
  let entry = e;
  if (!have(e.file_name, e.sha256) && !have(e.file_name, readPin(e.file_name))) {
    let buf = null;
    try { buf = await get(`https://cdn.jsdelivr.net/pyodide/v${version}/full/${e.file_name}`); if (sha(buf) !== e.sha256) throw new Error(`${e.file_name} does not match the lock file's SHA-256`); }
    catch (err) {
      buf = null;
      // The same pure Python wheel is on PyPI; a compiled one is only in the Pyodide distribution.
      if (/-none-any\.whl$/.test(e.file_name)) { try { buf = await pypiWheel(name, e.version, e.file_name); } catch { buf = null; } }
      if (!buf) { console.warn(`python runtime: ${name} is not available (${String(err && err.message || err).slice(0, 120)})`); missing.push(name); return false; }
    }
    fs.writeFileSync(path.join(out, e.file_name), buf);
  }
  const hash = sha(fs.readFileSync(path.join(out, e.file_name)));
  if (hash !== e.sha256) { entry = { ...e, sha256: hash }; pin(e.file_name, hash); }
  packages[name] = entry; return true;
};
// A pure wheel taken from PyPI may differ byte for byte from Pyodide's repack of it: its
// checked hash is remembered so the next build does not download it again.
const pinFile = path.join(out, "wheels.json"); const pins = fs.existsSync(pinFile) ? JSON.parse(fs.readFileSync(pinFile, "utf8")) : {};
function readPin(file) { return pins[file] || null; }
function pin(file, hash) { pins[file] = hash; fs.writeFileSync(pinFile, JSON.stringify(pins)); }
for (const p of want.pypi) {
  for (const d of p.depends) if (!want.pypi.some((q) => q.name === d)) await fromLock(d);
  if (!have(p.file, p.sha256)) {
    try { const buf = await pypiWheel(p.name, p.version, p.file); if (sha(buf) !== p.sha256) throw new Error(`${p.file} does not match the pinned SHA-256`); fs.writeFileSync(path.join(out, p.file), buf); }
    catch (err) { console.warn(`python runtime: ${p.name} is not available (${String(err && err.message || err).slice(0, 120)})`); missing.push(p.name); continue; }
  }
  packages[p.name] = { depends: p.depends, file_name: p.file, imports: p.imports, install_dir: "site", name: p.name, package_type: "package", sha256: p.sha256, tool: {}, unvendored_tests: false, version: p.version };
}
for (const name of want.pyodide) if (!want.pypi.some((q) => q.name === name)) await fromLock(name);
for (const name of Object.keys(packages)) packages[name] = { ...packages[name], depends: packages[name].depends.filter((d) => packages[d]) };
fs.writeFileSync(path.join(out, "pyodide-lock.json"), JSON.stringify({ info: lock.info, packages }));
console.log(`python runtime: ${Object.keys(packages).length} packages a plugin can import` + (missing.length ? `; not downloaded: ${[...new Set(missing)].join(", ")}` : ""));
console.log(`python runtime: ${Object.keys(files).length} shim modules, pyodide ${JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).version}`);
