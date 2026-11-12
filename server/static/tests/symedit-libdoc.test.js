// symedit-libdoc.test.js — two LibDoc clients (web/symedit/libdoc.ts) against an in-memory copy of the server's op
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

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 5).join("\n       ")); } }
const withPin = (doc, name, n) => { const s = M.node(doc.symbolText(name)); M.addDrawItem(s, 1, 1, M.pinNode(Object.assign(M.newPinInfo(0, 7.62 + n, M.initialPinDefaults(), 1, 1), { name: "P" + n, number: String(10 + n) }))); return M.text(s); };

(async () => {
  console.log("symbol library document, two clients");
  const A = new LibDoc("lib1", "Device.kicad_sym", "Device"), B = new LibDoc("lib1", "Device.kicad_sym", "Device");
  A.connect(); B.connect(); await flush(); await Promise.all([A.whenLoaded(), B.whenLoaded()]);
  await test("both clients load the file; nothing is modified", () => {
    assert.ok(A.loaded && B.loaded && A.canEdit && B.canEdit);
    assert.strictEqual(A.fileText(), FILE); assert.strictEqual(B.fileText(), FILE);
    assert.ok(!A.isModified && !B.isModified);
  });
  const savedR = A.symbolText("R");
  await test("a live edit: applied at once locally, on the other client after the server sequences it; '*' on both", async () => {
    const p = A.commit([["R", withPin(A, "R", 1)]]);
    assert.ok(A.isSymbolModified("R") && !B.isSymbolModified("R"), "B has not heard yet");
    await flush(); await p;
    assert.strictEqual(B.symbolText("R"), A.symbolText("R")); assert.deepStrictEqual(A.modifiedNames(), ["R"]); assert.deepStrictEqual(B.modifiedNames(), ["R"]);
  });
  await test("concurrent edits on two symbols and on the same symbol converge to the server's order", async () => {
    const a = A.commit([["C", withPin(A, "C", 2)]]), b = B.commit([["D", withPin(B, "D", 3)]]);
    const a2 = A.commit([["R", withPin(A, "R", 4)]]), b2 = B.commit([["R", withPin(B, "R", 5)]]);   // B's lands last: B's R wins
    await flush(); await Promise.all([a, b, a2, b2]);
    assert.strictEqual(A.fileText(), B.fileText());
    assert.ok(A.symbolText("R").includes('"P5"') && !A.symbolText("R").includes('"P4"'), "last sequenced whole-symbol change wins");
    assert.deepStrictEqual(A.modifiedNames().sort(), ["C", "D", "R"]); assert.deepStrictEqual(B.modifiedNames().sort(), ["C", "D", "R"]);
  });
  await test("an undo (the symbol's old whole text) restores it exactly and its '*' goes on both clients", async () => {
    const p = B.commit([["D", A.symbolText("D", "saved")]]); await flush(); await p;
    assert.ok(!A.isSymbolModified("D") && !B.isSymbolModified("D"));
  });
  await test("Save: LIB_SAVED marker, the snapshot is the buffer at its sequence, '*' cleared on both", async () => {
    const before = A.fileText();
    const p = A.save(); await flush(); assert.strictEqual(await p, true); await flush();
    const up = server.uploads[server.uploads.length - 1];
    assert.strictEqual(up.file, before); assert.strictEqual(up.seq, server.seq);
    assert.ok(!A.isModified && !B.isModified, "no '*' anywhere after save");
    assert.strictEqual(M.serializeLibrary(M.parseLibrary(up.file)), up.file, "the saved file round-trips");
  });
  await test("Revert puts the saved text back on both clients", async () => {
    const savedC = A.symbolText("C");
    const p = B.commit([["C", null]]); await flush(); await p;
    assert.ok(!A.lib.symbols.has("C") && A.isModified);
    const r = A.revert(); await flush(); await r;
    assert.strictEqual(A.symbolText("C"), savedC); assert.strictEqual(B.symbolText("C"), savedC); assert.ok(!A.isModified && !B.isModified);
  });
  await test("a late joiner gets the snapshot plus the ops after it", async () => {
    const p = A.commit([["R", savedR]]); await flush(); await p;
    const Cc = new LibDoc("lib1", "Device.kicad_sym", "Device"); Cc.connect(); await flush(); await Cc.whenLoaded();
    assert.strictEqual(Cc.fileText(), A.fileText()); assert.deepStrictEqual(Cc.modifiedNames(), ["R"]);
    Cc.close();
  });
  A.close(); B.close();
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
