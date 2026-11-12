// symedit-symdir.test.js — a KiCad 10 directory symbol library (X.kicad_symdir, one file per symbol) as one buffer
// (web/symedit/symdir.ts) over an in-memory copy of the op protocol with several documents: the files' symbols merge,
// an edit goes to the symbol's own file, a new symbol gets a new file named EscapeString( name, CTX_FILENAME ), Save
// writes the modified files, Revert puts them back.
// Run: node server/static/tests/symedit-symdir.test.js
"use strict";
const path = require("path"), fs = require("fs"), assert = require("assert");
const esbuild = require("esbuild");
function load(file) {
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const DEVICE = fs.readFileSync(path.join(__dirname, "..", "..", "..", "qa", "data", "libraries", "test_project", "Device.kicad_sym"), "utf8");
const docs = new Map();   // docId -> { seq, snapshot: {seq, file}, ops: [] }
const queue = [];
function deliver(sock, msg) { queue.push(() => { if (sock.onmessage) sock.onmessage({ data: JSON.stringify(msg) }); }); }
async function flush() { for (let i = 0; i < 400; i++) { await new Promise((r) => setImmediate(r)); if (!queue.length) { await new Promise((r) => setImmediate(r)); if (!queue.length) return; } while (queue.length) queue.shift()(); } }
const socks = new Set();
class FakeSocket {
  constructor() { this.readyState = 0; this.joined = new Set(); socks.add(this); setImmediate(() => { this.readyState = 1; this.onopen && this.onopen(); }); }
  send(text) {
    const m = JSON.parse(text);
    if (m.type === "hello") deliver(this, { type: "hello_ok", clientId: m.clientId });
    else if (m.type === "join_doc") { const d = docs.get(m.docId); this.joined.add(m.docId); deliver(this, { type: "doc_info", docId: m.docId, role: "editor" }); deliver(this, { type: "snapshot", docId: m.docId, seq: d.snapshot.seq, file: d.snapshot.file, thenOps: d.ops.filter((o) => o.seq > d.snapshot.seq) }); }
    else if (m.type === "op") {
      const d = docs.get(m.docId); const seq = ++d.seq; d.ops.push({ seq, changes: m.changes });
      queue.push(() => { if (this.onmessage) this.onmessage({ data: JSON.stringify({ type: "ack", docId: m.docId, clientOpId: m.clientOpId, seq }) }); });
    }
  }
  close() { socks.delete(this); }
}
globalThis.WebSocket = FakeSocket;
globalThis.location = { protocol: "http:", host: "test" };
globalThis.fetch = async (url, opts) => {
  if (url === "/api/ws-ticket") return { ok: true, json: async () => ({ token: "t" }) };
  const m = /\/api\/docs\/([^/]+)\/snapshots\?seq=(\d+)/.exec(url);
  if (m) { const d = docs.get(m[1]); d.snapshot = { seq: Number(m[2]), file: String(opts.body) }; return { ok: true }; }
  return { ok: false, status: 404 };
};
const M = load("symedit/model.ts");
const { SymDirDoc, escapeFileName, symdirOf } = load("symedit/symdir.ts");
// split Device.kicad_sym into one file per symbol, as KiCad 10 lays a .kicad_symdir out
const whole = M.parseLibrary(DEVICE);
const files = [];
for (const [name, sym] of whole.symbols) {
  const one = M.serializeLibrary({ head: whole.head, version: whole.version, symbols: new Map([[name, sym]]) });
  const docId = "f-" + name; docs.set(docId, { seq: 0, snapshot: { seq: 0, file: one }, ops: [] });
  files.push({ docId, path: `Dev.kicad_symdir/${name}.kicad_sym` });
}
const made = [];
const maker = async (p, first) => { const docId = "new-" + made.length; docs.set(docId, { seq: 0, snapshot: { seq: 0, file: "" }, ops: [] }); made.push({ p, first }); docs.get(docId).snapshot = { seq: 0, file: first }; return { docId, path: p }; };

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 5).join("\n       ")); } }
(async () => {
  console.log("directory symbol library");
  await test("file names: CTX_FILENAME escape; which files belong to a directory", () => {
    assert.strictEqual(escapeFileName('a/b:c<d>|"e'), "a{slash}b{colon}c{lt}d{gt}{bar}{dblquote}e");
    assert.strictEqual(symdirOf("libs/X.kicad_symdir/R.kicad_sym"), "libs/X.kicad_symdir"); assert.strictEqual(symdirOf("X.kicad_sym"), null);
  });
  const D = new SymDirDoc("Dev.kicad_symdir", "Dev", files, maker); D.connect(); await flush(); await D.whenLoaded();
  await test("the files' symbols merge into one library; nothing is modified", () => {
    assert.deepStrictEqual([...D.lib.symbols.keys()].sort(), [...whole.symbols.keys()].sort());
    assert.ok(!D.isModified && D.canEdit);
  });
  await test("an edit goes to the symbol's own file only", async () => {
    const before = D.symbolText("R"); const s = M.node(before); M.setFieldValue(s, "Value", "10k");
    const p = D.commit([["R", M.text(s), before]]); await flush(); await p;
    assert.ok(D.isSymbolModified("R")); assert.deepStrictEqual(D.modifiedNames(), ["R"]);
    assert.strictEqual(docs.get("f-R").ops.length, 1); assert.strictEqual(docs.get("f-C").ops.length, 0);
  });
  await test("a new symbol is in the buffer at once and gets its own file", async () => {
    const s = M.createSymbol(Object.assign(M.defaultNewSymbolProps(), { name: "N{colon}1" }));
    const p = D.commit([["N{colon}1", M.text(s)]]);
    assert.ok(D.lib.symbols.has("N{colon}1"), "staged before the file exists");
    await flush(); await p; await flush();
    assert.strictEqual(made.length, 1); assert.strictEqual(made[0].p, "Dev.kicad_symdir/N{colon}1.kicad_sym");
    assert.ok(/\(version \d+\)/.test(made[0].first) && !made[0].first.includes("(symbol"), "an empty library in the directory's format version");
    assert.ok(D.lib.symbols.has("N{colon}1")); assert.strictEqual(docs.get("new-0").ops.length, 1);
  });
  await test("Save writes each modified file; nothing is modified after", async () => {
    const p = D.save(); await flush(); assert.strictEqual(await p, true); await flush();
    assert.ok(!D.isModified, D.modifiedNames().join(","));
    assert.ok(docs.get("f-R").snapshot.file.includes('"10k"')); assert.ok(docs.get("new-0").snapshot.file.includes('(symbol "N{colon}1"'));
    assert.strictEqual(docs.get("f-C").snapshot.seq, 0, "an untouched file is not rewritten");
  });
  await test("Revert puts a removed symbol back in its file", async () => {
    const p = D.commit([["C", null]]); await flush(); await p; assert.ok(!D.lib.symbols.has("C") && D.isModified);
    const r = D.revert(); await flush(); await r; assert.ok(D.lib.symbols.has("C") && !D.isModified);
  });
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
