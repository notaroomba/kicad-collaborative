// build-python.mjs — puts the Python runtime where the server embeds it (static/dist/pyodide):
// the interpreter and standard library from the pyodide package, and our shim modules
// (plugins/python: pcbnew, wx, kicad_web, …) packed into one JSON file the sandbox fetches.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import zlib from "node:zlib";
import * as esbuild from "esbuild";

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(server, "static", "dist", "pyodide");
fs.mkdirSync(out, { recursive: true });
const pkg = path.join(server, "node_modules", "pyodide");
for (const f of ["pyodide.js", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip"]) {
  const src = path.join(pkg, f), dst = path.join(out, f);
  if (!fs.existsSync(dst) || !fs.readFileSync(src).equals(fs.readFileSync(dst))) fs.copyFileSync(src, dst);
}
// OpenCascade's STEP reader compiled to WebAssembly (npm occt-import-js, LGPL-2.1): turns the STEP models of KiCad's
// 3D library and of vendor parts into triangles for the 3D viewer.  About 7.6 MB, fetched when the viewer first needs it.
for (const f of ["occt-import-js.js", "occt-import-js.wasm"]) {
  const src = path.join(server, "node_modules", "occt-import-js", "dist", f), dst = path.join(out, f);
  if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(src).size) fs.copyFileSync(src, dst);
}
// ngspice compiled to WebAssembly (npm eecircuit-engine, MIT): the circuit simulator behind the `ngspice` program and
// the libngspice stand-in (plugins/python/kicad_spice.py).  About 20 MB, so it is its own file, fetched on first use.
{
  const src = path.join(server, "node_modules", "eecircuit-engine", "dist", "eecircuit-engine.mjs"), dst = path.join(out, "ngspice.mjs");
  if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(src).size) fs.copyFileSync(src, dst);
}
const shim = path.join(server, "plugins", "python"); const files = {};
const walk = (dir, base) => { for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const rel = base ? base + "/" + e.name : e.name; if (e.isDirectory()) { if (e.name !== "__pycache__") walk(path.join(dir, e.name), rel); } else if (e.name.endsWith(".py")) files[rel] = fs.readFileSync(path.join(dir, e.name), "utf8"); } };
walk(shim, "");
// Browser-side helpers the shims load into the plugin's frame: the animation encoders (ffmpeg's stand-in) and the WebGL end of the OpenGL shim.
for (const [name, entry] of [["kicad_media.js", "web/plugins/media.ts"], ["kicad_gl.js", "web/plugins/glfixed.ts"], ["kicad_spice.js", "web/plugins/spice.ts"]]) {
  const r = esbuild.buildSync({ entryPoints: [path.join(server, entry)], bundle: true, format: "iife", target: "es2020", minify: true, write: false, legalComments: "none" });
  files[name] = Buffer.from(r.outputFiles[0].contents).toString("utf8");
}
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
// A package PyPI has only as source (no wheel) and that is plain Python: its modules are taken out of the checked
// source archive and packed as a wheel here, byte for byte the same on every build (stored, sorted, fixed dates).
const untar = (gz) => {
  const buf = zlib.gunzipSync(gz); const files = {}; let long = null;
  for (let at = 0; at + 512 <= buf.length;) {
    const head = buf.subarray(at, at + 512); if (head.every((b) => b === 0)) break;
    const str = (a, n) => { const s = head.subarray(a, a + n); const z = s.indexOf(0); return s.subarray(0, z < 0 ? n : z).toString("utf8"); };
    const size = parseInt(str(124, 12).trim() || "0", 8); const type = String.fromCharCode(head[156] || 48);
    let name = long || ((str(345, 155) ? str(345, 155) + "/" : "") + str(0, 100)); long = null;
    const body = buf.subarray(at + 512, at + 512 + size);
    if (type === "L") long = body.toString("utf8").replace(/\0+$/, ""); else if (type === "0" || type === "\0") files[name] = Buffer.from(body);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
};
const zipStored = (entries) => {
  const parts = [], central = []; let at = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name, "utf8"); const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26); local.writeUInt16LE(0, 28);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(0, 10); cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(n.length, 28); cen.writeUInt32LE(at, 42);
    parts.push(local, n, data); central.push(cen, n); at += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(at, 16);
  return Buffer.concat([...parts, cd, end]);
};
/** {name, version, source: "x.tar.gz", sha256 (of the source), file: wheel name, modules: ["pkg", "mod.py"]} */
const wheelFromSource = async (p) => {
  const meta = JSON.parse((await get(`https://pypi.org/pypi/${p.name}/${p.version}/json`)).toString("utf8"));
  const hit = (meta.urls || []).find((u) => u.filename === p.source); if (!hit) throw new Error(`PyPI has no ${p.source}`);
  const gz = await get(hit.url); if (sha(gz) !== p.sha256) throw new Error(`${p.source} does not match the pinned SHA-256`);
  const all = untar(gz); const entries = [];
  for (const [full, data] of Object.entries(all)) {
    const rel = full.split("/").slice(1).join("/").replace(/^src\//, "");
    if (p.modules.some((m) => rel === m || rel.startsWith(m + "/")) && !/(^|\/)(tests?|__pycache__)\//.test(rel)) entries.push([rel, data]);
  }
  if (!entries.length) throw new Error(`${p.source} holds none of ${p.modules.join(", ")}`);
  const info = `${p.name.replace(/[-.]+/g, "_")}-${p.version}.dist-info`;
  entries.push([`${info}/METADATA`, Buffer.from(`Metadata-Version: 2.1\nName: ${p.name}\nVersion: ${p.version}\n`)]);
  entries.push([`${info}/WHEEL`, Buffer.from("Wheel-Version: 1.0\nGenerator: kicad-collab build-python\nRoot-Is-Purelib: true\nTag: py3-none-any\n")]);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  entries.push([`${info}/RECORD`, Buffer.from(entries.map(([n, d]) => `${n},sha256=${crypto.createHash("sha256").update(d).digest("base64url")},${d.length}`).join("\n") + `\n${info}/RECORD,,\n`)]);
  return zipStored(entries);
};
const packages = {}; const missing = [];
// The lock file is not consistent about a name's spelling (jsonschema depends on "jsonschema_specifications",
// which it lists as "jsonschema-specifications"): names are compared the way pip compares them.
const norm = (n) => n.toLowerCase().replace(/[-_.]+/g, "-");
const lockName = new Map(Object.keys(lock.packages).map((k) => [norm(k), k]));
const fromLock = async (asked) => {
  const name = lockName.get(norm(asked)) || asked;
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
  let hash = p.sha256;
  if (p.source) {
    // built from source: the pinned hash is the source archive's; the wheel's own hash is remembered beside it
    const key = `${p.file}<${p.sha256}`;
    if (!have(p.file, readPin(key))) {
      try { const buf = await wheelFromSource(p); fs.writeFileSync(path.join(out, p.file), buf); pin(key, sha(buf)); }
      catch (err) { console.warn(`python runtime: ${p.name} is not available (${String(err && err.message || err).slice(0, 120)})`); missing.push(p.name); continue; }
    }
    hash = readPin(key);
  } else if (!have(p.file, p.sha256)) {
    try { const buf = await pypiWheel(p.name, p.version, p.file); if (sha(buf) !== p.sha256) throw new Error(`${p.file} does not match the pinned SHA-256`); fs.writeFileSync(path.join(out, p.file), buf); }
    catch (err) { console.warn(`python runtime: ${p.name} is not available (${String(err && err.message || err).slice(0, 120)})`); missing.push(p.name); continue; }
  }
  packages[p.name] = { depends: p.depends, file_name: p.file, imports: p.imports, install_dir: "site", name: p.name, package_type: "package", sha256: hash, tool: {}, unvendored_tests: false, version: p.version };
}
for (const name of want.pyodide) if (!want.pypi.some((q) => q.name === name)) await fromLock(name);
for (const name of Object.keys(packages)) packages[name] = { ...packages[name], depends: packages[name].depends.map((d) => lockName.get(norm(d)) || d).filter((d) => packages[d]) };
fs.writeFileSync(path.join(out, "pyodide-lock.json"), JSON.stringify({ info: lock.info, packages }));
console.log(`python runtime: ${Object.keys(packages).length} packages a plugin can import` + (missing.length ? `; not downloaded: ${[...new Set(missing)].join(", ")}` : ""));
console.log(`python runtime: ${Object.keys(files).length} shim modules, pyodide ${JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).version}`);
