// harness/cli — the design engine for KiCad files on disk, driven by the Python harness.
//
// `node static/dist/harness-engine.js` reads one JSON object per line on stdin and answers each on
// stdout.  It is the same code the web editor, the assistant and the MCP endpoint run (parsing,
// pins and nets, ERC and DRC, placement, the autorouter), working on a project folder instead of an
// online project, so a script behaves the same against a local file and a live document.
//
//   { id, op: "open", name, files: [absolute paths], libs?: [dirs], server?, token? }
//   { id, op: "call", tool, args }       the tools of workspace.ts
//   { id, op: "save" }                   write the changed files back
//
// KiCad's libraries are looked for in the project folder (Name.kicad_sym, Name.pretty), then in
// the given library folders and a KiCad installation on this computer, then on a KiCad
// Collaborative server when one is given, and last on gitlab.com/kicad/libraries (kept in a cache
// folder).  Nothing here talks to a model.

/* eslint-disable @typescript-eslint/no-explicit-any */
import "../mcp/env";
import "../canvas/index";
import "../../static/sch-tools.js";
import "../../static/pcb-tools.js";
import "../router/index";
import { Workspace, ToolError, type Fetched } from "./workspace";

declare const process: any;
declare function require(name: string): any;
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), cp = require("node:child_process");
const W = globalThis as any;
const K = (): any => W.KiCadCanvas;

interface Opened { ws: Workspace; root: string; libs: string[]; server: string; token: string }
let cur: Opened | null = null;

const SYM_ENV = ["KICAD_SYMBOL_DIR", "KICAD10_SYMBOL_DIR", "KICAD9_SYMBOL_DIR", "KICAD8_SYMBOL_DIR"], FP_ENV = ["KICAD_FOOTPRINT_DIR", "KICAD10_FOOTPRINT_DIR", "KICAD9_FOOTPRINT_DIR", "KICAD8_FOOTPRINT_DIR"];
const INSTALLS = ["/Applications/KiCad/KiCad.app/Contents/SharedSupport", "/usr/share/kicad", "/usr/local/share/kicad", "C:/Program Files/KiCad/10.0/share/kicad", "C:/Program Files/KiCad/9.0/share/kicad"];
function libDirs(kind: string): string[] {
  const out: string[] = []; if (cur) { out.push(cur.root); out.push(...cur.libs); }
  for (const e of kind === "symbol" ? SYM_ENV : FP_ENV) if (process.env[e]) out.push(process.env[e]);
  for (const d of INSTALLS) out.push(path.join(d, kind === "symbol" ? "symbols" : "footprints"));
  return out.filter((d, i) => out.indexOf(d) === i && fs.existsSync(d));
}
const cacheDir = () => { const d = process.env.KC_HARNESS_CACHE || path.join(os.homedir(), ".cache", "kicad-harness"); fs.mkdirSync(d, { recursive: true }); return d; };
const enc = (s: string) => encodeURIComponent(s);
const ok = (o: unknown): Fetched => ({ ok: true, status: 200, body: JSON.stringify(o) });
const miss = (message: string, status = 404): Fetched => ({ ok: false, status, body: JSON.stringify({ message }) });

/** GET through curl, so that the machine's proxy settings apply (Node's own fetch ignores them). */
function curl(url: string, headers: string[] = [], body?: string): Promise<{ status: number; body: string }> {
  const args = ["-sS", "-L", "-m", "60", "-w", "\n%{http_code}"]; for (const h of headers) args.push("-H", h);
  if (body !== undefined) args.push("-H", "content-type: application/json", "--data-binary", "@-");
  args.push(url);
  return new Promise((done) => {
    const p = cp.execFile("curl", args, { maxBuffer: 64 << 20 }, (err: any, out: string) => {
      if (err) return done({ status: 502, body: "" });
      const cut = out.lastIndexOf("\n"); done({ status: +out.slice(cut + 1) || 502, body: out.slice(0, cut) });
    });
    if (body !== undefined) { p.stdin.write(body); p.stdin.end(); }
  });
}

/** One symbol of a single-file library, as a library holding only it. */
function symbolFromFile(file: string, name: string): string | null {
  const k = K(); let root: any; try { root = k.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  const node = root && k.kids(root, "symbol").find((s: any) => k.str(s[1]) === name);
  return node ? k.serialize(["kicad_symbol_lib", ["version", 20241209], ["generator", "kicad_harness"], node]) : null;
}
function localItem(kind: string, lib: string, name: string): string | null {
  for (const d of libDirs(kind)) {
    if (kind === "symbol") {
      const dir = path.join(d, lib + ".kicad_symdir", name + ".kicad_sym"); if (fs.existsSync(dir)) return fs.readFileSync(dir, "utf8");
      const file = path.join(d, lib + ".kicad_sym"); if (fs.existsSync(file) && fs.statSync(file).isFile()) { const s = symbolFromFile(file, name); if (s) return s; }
    } else { const f = path.join(d, lib + ".pretty", name + ".kicad_mod"); if (fs.existsSync(f)) return fs.readFileSync(f, "utf8"); }
  }
  return null;
}
function localList(kind: string, lib?: string): string[] | null {
  const out = new Set<string>(); let any = false;
  for (const d of libDirs(kind)) {
    let names: string[]; try { names = fs.readdirSync(d); } catch { continue; }
    if (!lib) { for (const n of names) { const m = kind === "symbol" ? /^(.*)\.kicad_sym(dir)?$/.exec(n) : /^(.*)\.pretty$/.exec(n); if (m) { out.add(m[1]); any = true; } } continue; }
    if (kind === "symbol") {
      const dir = path.join(d, lib + ".kicad_symdir"), file = path.join(d, lib + ".kicad_sym");
      if (fs.existsSync(dir)) { any = true; for (const n of fs.readdirSync(dir)) if (n.endsWith(".kicad_sym")) out.add(n.slice(0, -10)); }
      else if (fs.existsSync(file)) { any = true; const re = /^\s*\(symbol\s+"((?:[^"\\]|\\.)*)"/gm; const text = fs.readFileSync(file, "utf8"); let m; while ((m = re.exec(text))) if (!/_\d+_\d+$/.test(m[1])) out.add(m[1]); }
    } else { const dir = path.join(d, lib + ".pretty"); if (fs.existsSync(dir)) { any = true; for (const n of fs.readdirSync(dir)) if (n.endsWith(".kicad_mod")) out.add(n.slice(0, -10)); } }
  }
  return any ? Array.from(out).sort() : null;
}

async function gitlab(kind: string, lib: string, name: string): Promise<string | null> {
  const repo = kind === "symbol" ? "kicad-symbols" : "kicad-footprints";
  const rel = kind === "symbol" ? `${lib}.kicad_symdir/${name}.kicad_sym` : `${lib}.pretty/${name}.kicad_mod`;
  const file = path.join(cacheDir(), repo, rel);
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  if (process.env.KC_HARNESS_OFFLINE === "1") return null;
  const base = (process.env.KICAD_LIBS_URL || "https://gitlab.com").replace(/\/$/, "");
  const r = await curl(`${base}/kicad/libraries/${repo}/-/raw/${enc(process.env.KICAD_LIBS_REF || "master")}/${rel.split("/").map(enc).join("/")}`);
  if (r.status !== 200 || !/^\s*\((kicad_symbol_lib|footprint|module)/.test(r.body)) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, r.body);
  return r.body;
}

async function server(url: string, init?: { method?: string; body?: string }): Promise<Fetched | null> {
  if (!cur || !cur.server) return null;
  const r = await curl(cur.server.replace(/\/$/, "") + url, cur.token ? [`authorization: Bearer ${cur.token}`] : [], init && init.method === "POST" ? init.body || "{}" : undefined);
  return { ok: r.status >= 200 && r.status < 300, status: r.status, body: r.body || "{}" };
}

async function backend(url: string, init?: { method?: string; body?: string }): Promise<Fetched> {
  const u = new URL(url, "http://local"); const q = u.searchParams;
  if (u.pathname === "/api/kicad-lib/item") {
    const kind = q.get("kind") || "symbol", lib = q.get("lib") || "", name = q.get("name") || "";
    const here = localItem(kind, lib, name); if (here) return ok({ kind, library: lib, name, id: `${lib}:${name}`, sexpr: here });
    const s = await server(url); if (s && s.ok) return s;
    const g = await gitlab(kind, lib, name); if (g) return ok({ kind, library: lib, name, id: `${lib}:${name}`, sexpr: g });
    return miss(`${kind} ${lib}:${name} was not found in the project folder, a KiCad installation or KiCad's libraries.`);
  }
  if (u.pathname === "/api/kicad-lib/list") {
    const kind = q.get("kind") || "symbol", lib = q.get("lib") || undefined;
    const here = localList(kind, lib); if (here) return ok(lib ? { kind, library: lib, items: here } : { kind, libraries: here });
    const s = await server(url); if (s) return s;
    return miss("Listing KiCad's libraries needs a KiCad installation on this computer (set KICAD_SYMBOL_DIR and KICAD_FOOTPRINT_DIR) or a server.");
  }
  if (u.pathname === "/api/kicad-lib/search") {
    const kind = q.get("kind") || "symbol"; const ws = (q.get("q") || "").toLowerCase().split(/\s+/).filter(Boolean);
    const libs = localList(kind);
    if (libs) { const items: string[] = []; for (const l of libs) for (const n of localList(kind, l) || []) { const id = `${l}:${n}`; if (ws.every((w) => id.toLowerCase().includes(w))) items.push(id); }
      return ok({ kind, items: items.slice(0, 60), total: items.length }); }
    const s = await server(url); if (s) return s;
    return miss("Searching KiCad's libraries needs a KiCad installation on this computer or a server.");
  }
  const s = await server(url, init); if (s) return s;
  return miss(u.pathname.startsWith("/api/ai/datasheet") ? "Reading a datasheet by address needs a server; give the harness the PDF file instead." : "This needs a KiCad Collaborative server (pass server= and token=).", 502);
}

async function handle(req: any): Promise<unknown> {
  if (req.op === "open") {
    const files: string[] = req.files || []; if (!files.length) throw new ToolError("No files to open.");
    const root = path.dirname(files[0]);
    cur = { ws: null as any, root, libs: req.libs || [], server: req.server || "", token: req.token || "" };
    cur.ws = new Workspace(req.name || path.basename(files[0]).replace(/\.kicad_\w+$/, ""), files.map((f) => ({ path: path.basename(f), text: fs.readFileSync(f, "utf8") })), backend);
    return cur.ws.call("documents", {});
  }
  if (!cur) throw new ToolError("No project is open.");
  if (req.op === "call") return cur.ws.call(req.tool, req.args);
  if (req.op === "save") { const out = cur.ws.files(); for (const f of out) fs.writeFileSync(path.join(cur.root, f.path), f.text); return { written: out.map((f) => f.path) }; }
  throw new ToolError(`Unknown op ${req.op}.`);
}

let queue: Promise<void> = Promise.resolve();
const rl = require("node:readline").createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line: string) => {
  if (!line.trim()) return;
  let req: any; try { req = JSON.parse(line); } catch { return; }
  queue = queue.then(() => handle(req)).then((result) => { process.stdout.write(JSON.stringify({ id: req.id, ok: true, result }) + "\n"); },
    (e) => { if (!(e instanceof ToolError)) console.error("harness engine:", e); process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) }) + "\n"); });
});
rl.on("close", () => process.exit(0));
process.stdout.write(JSON.stringify({ ready: true }) + "\n");
