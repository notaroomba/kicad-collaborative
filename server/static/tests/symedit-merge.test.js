// symedit-merge.test.js — item-level merge of library symbol edits (web/symedit/merge.ts) and two LibDoc clients (web/symedit/libdoc.ts) against an in-memory copy of the server's op
// protocol (hello / join_doc / snapshot / op / ack, the doc actor's single sequence): a live edit reaches the other
// client, both show the same '*', concurrent edits converge, Save uploads the buffer at the marker's sequence and
// clears '*' everywhere, Revert and an undo (the old whole-symbol text) restore the file exactly.
// Run: node server/static/tests/symedit-libdoc.test.js
"use strict";
const path = require("path"), fs = require("fs"), assert = require("assert");
const esbuild = require("esbuild");
function load(file) {
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
// ---- an in-memory server: one document, a sequence, snapshots; messages delivered on flush()
const FILE = fs.readFileSync(path.join(__dirname, "..", "..", "..", "qa", "data", "libraries", "test_project", "Device.kicad_sym"), "utf8");
const server = { seq: 0, snapshot: { seq: 0, file: FILE }, ops: [], socks: new Set(), queue: [], uploads: [] };
function deliver(sock, msg) { server.queue.push(() => { if (sock.onmessage) sock.onmessage({ data: JSON.stringify(msg) }); }); }
async function flush() { for (let i = 0; i < 200; i++) { await new Promise((r) => setImmediate(r)); if (!server.queue.length) { await new Promise((r) => setImmediate(r)); if (!server.queue.length) return; } while (server.queue.length) server.queue.shift()(); } }
class FakeSocket {
  constructor() { this.readyState = 0; server.socks.add(this); setImmediate(() => { this.readyState = 1; this.onopen && this.onopen(); }); }
  send(text) {
    const m = JSON.parse(text);
    if (m.type === "hello") deliver(this, { type: "hello_ok", clientId: m.clientId });
    else if (m.type === "join_doc") { this.joined = true; deliver(this, { type: "doc_info", docId: "lib1", role: "editor" }); deliver(this, { type: "snapshot", docId: "lib1", seq: server.snapshot.seq, file: server.snapshot.file, thenOps: server.ops.filter((o) => o.seq > server.snapshot.seq) }); }
    else if (m.type === "op") {
      const seq = ++server.seq; const op = { seq, changes: m.changes }; server.ops.push(op);
      server.queue.push(() => {
        if (this.onmessage) this.onmessage({ data: JSON.stringify({ type: "ack", docId: "lib1", clientOpId: m.clientOpId, seq }) });
        for (const o of server.socks) if (o !== this && o.joined && o.onmessage) o.onmessage({ data: JSON.stringify({ type: "op", docId: "lib1", seq, changes: m.changes }) });
      });
    }
  }
  close() { server.socks.delete(this); }
}
globalThis.WebSocket = FakeSocket;
globalThis.location = { protocol: "http:", host: "test" };
globalThis.fetch = async (url, opts) => {
  if (url === "/api/ws-ticket") return { ok: true, json: async () => ({ token: "t" }) };
  const m = /\/api\/docs\/lib1\/snapshots\?seq=(\d+)/.exec(url);
  if (m) { server.snapshot = { seq: Number(m[1]), file: String(opts.body) }; server.uploads.push(server.snapshot); return { ok: true }; }
  return { ok: false, status: 404 };
};
const { LibDoc } = load("symedit/libdoc.ts");
const M = load("symedit/model.ts");

const { merge3, mergeSymbolText } = load("symedit/merge.ts");
let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 5).join("\n       ")); } }
const rect = (x) => `(rectangle (start ${x} 0) (end ${x + 1} 1) (stroke (width 0) (type default)) (fill (type none)))`;
const addRect = (t, x) => { const s = M.node(t); M.addDrawItem(s, 1, 1, M.node(rect(x))); return M.text(s); };
const has = (t, x) => t.includes(`(start ${x} 0)`);
const mrg = (b, m, c) => mergeSymbolText(b, m, c, M.node);

(async () => {
  console.log("symbol merge");
  const R0 = M.text(M.parseLibrary(FILE).symbols.get("R"));
  await test("both users' added items survive; edit order kept", () => {
    const a = addRect(R0, 10), b = addRect(R0, 20);
    const r = mrg(R0, b, a); assert.ok(has(r, 10) && has(r, 20));
    assert.ok(r.indexOf("(start 10 0)") < r.indexOf("(start 20 0)"));
  });
  await test("undo takes back only its own item, a later user's item stays", () => {
    const a = addRect(R0, 10), ab = addRect(a, 20);
    const undone = mrg(a, R0, ab); assert.ok(!has(undone, 10) && has(undone, 20));
    const re = mrg(R0, a, undone); assert.ok(has(re, 10) && has(re, 20) && re.length === ab.length, "redo brings it back");
    assert.strictEqual(mrg(ab, a, ab), a, "with nobody else's change in between, undo restores exactly");
  });
  await test("property values: different fields merge, same field takes the later edit, quoting kept", () => {
    const set = (t, f, v) => { const s = M.node(t); M.setFieldValue(s, f, v); return M.text(s); };
    const a = set(R0, "Value", "10k"), b = set(R0, "Footprint", "R_0603");
    const r = mrg(R0, b, a); assert.ok(r.includes('(property "Value" "10k"') && r.includes('(property "Footprint" "R_0603"'), r.slice(0, 300));
    const c = set(R0, "Value", "22k"); assert.ok(mrg(R0, c, a).includes('(property "Value" "22k"'));
    assert.ok(M.node(r)[1] === "R" && r.startsWith('(symbol "R"'));
  });
  await test("a pin changed by both: the later version replaces it (no duplicate)", () => {
    const s = M.node(R0); const pins = M.allPins(s); const p = pins[0].node;
    const pa = M.node(R0), pb = M.node(R0);
    M.setPin(M.allPins(pa)[0].node, Object.assign(M.pinInfo(p), { name: "A" }));
    M.setPin(M.allPins(pb)[0].node, Object.assign(M.pinInfo(p), { name: "B" }));
    const r = M.node(mrg(R0, M.text(pb), M.text(pa)));
    assert.strictEqual(M.allPins(r).length, pins.length); assert.ok(M.text(r).includes('(name "B"'));
  });
  await test("identical inputs: the fast paths", () => {
    const a = addRect(R0, 5); assert.strictEqual(mrg(R0, a, R0), a); assert.strictEqual(mrg(R0, R0, a), a);
    assert.deepStrictEqual(merge3(["x", 1], ["x", 2], ["x", 1]), ["x", 2]);
  });

  console.log("two clients on one symbol");
  const A = new LibDoc("lib1", "Device.kicad_sym", "Device"), B = new LibDoc("lib1", "Device.kicad_sym", "Device");
  A.connect(); B.connect(); await flush(); await Promise.all([A.whenLoaded(), B.whenLoaded()]);
  // the editor's edit(): whole symbol + the text it was made against
  const edit = (D, fn) => { const before = D.symbolText("R"); const after = fn(before); return { p: D.commit([["R", after, before]]), before, after }; };
  await test("Alice adds, Bob adds, Alice undoes: Bob's rectangle stays on both", async () => {
    const a = edit(A, (t) => addRect(t, 10)); await flush(); await a.p;
    assert.ok(has(B.symbolText("R"), 10));
    const b = edit(B, (t) => addRect(t, 20)); await flush(); await b.p;
    assert.ok(has(A.symbolText("R"), 20));
    // Alice's undo: her step (before → after) laid back over the current symbol
    const cur = A.symbolText("R"); const u = A.commit([["R", mrg(a.after, a.before, cur), cur]]); await flush(); await u;
    for (const D of [A, B]) { assert.ok(!has(D.symbolText("R"), 10), "Alice's rect gone"); assert.ok(has(D.symbolText("R"), 20), "Bob's rect stays"); }
  });
  await test("two edits within the latency both survive and the clients converge", async () => {
    const a = edit(A, (t) => addRect(t, 30)), b = edit(B, (t) => addRect(t, 40));
    await flush(); await Promise.all([a.p, b.p]);
    for (const D of [A, B]) assert.ok(has(D.symbolText("R"), 30) && has(D.symbolText("R"), 40));
    assert.strictEqual(A.fileText(), B.fileText());
  });
  await test("an edit without a base (revert, paste) still replaces the whole symbol", async () => {
    const p = A.commit([["R", R0]]); await flush(); await p;
    assert.strictEqual(B.symbolText("R"), R0);
  });
  A.close(); B.close();
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
