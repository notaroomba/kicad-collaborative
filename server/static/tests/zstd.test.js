// zstd.test.js — the Zstandard frame decoder (web/dialogs/zstd.ts) the Simulation Model dialog uses for the
// embedded files KiCad writes (base64 of a zstd frame), checked against node's zstd where node has one, a fixed
// frame, and a real embedded file from KiCad's QA boards.
// Run: node server/static/tests/zstd.test.js
"use strict";
const path = require("path"), fs = require("fs"), assert = require("assert/strict"), zlib = require("zlib");
const esbuild = require("esbuild");
function load(file) {
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const Z = load("dialogs/zstd.ts"), F = load("dialogs/sim-files.ts");
let passed = 0, failed = 0; const pending = [];
function test(name, fn) { pending.push(Promise.resolve().then(fn).then(() => { passed++; console.log("  ok   " + name); }, (e) => { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 6).join("\n       ")); })); }
console.log("zstd: frame decoder for embedded files");
const MODEL = "* KiCad test model\n.model D1N4148 D(Is=2.52n Rs=0.568 N=1.752 Cjo=4p M=0.4 tt=20n Iave=200m Vpk=75)\n.subckt OPAMP 1 2 3 4 5\nE1 5 0 1 2 100k\n.ends\n";
const FIXED = "KLUv/WS2AP0DAFKIGxhQdw5TqsqL/DJl7ZFErIPF3TnQGlXDqDARW93VUZNyyttPJdrXD6efh5oDep61igJxx8AWV/ukc/IKp+WdpDfn15a3+VevlyGntuh5nRuEbXlx9I7aphcvQHKjzurM5B23y/K4Z3zlWxOCMRcCBAAhFaN8aAqlWWDTVe6mZuWp";

test("a fixed level-19 frame with a checksum: Huffman literals, FSE sequences and repeat offsets", () => {
  assert.equal(Buffer.from(Z.zstdDecompress(new Uint8Array(Buffer.from(FIXED, "base64")))).toString(), MODEL.repeat(3));
});
test("raw, RLE and empty frames; skippable frames are skipped; garbage throws", () => {
  const raw = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0x20, 3, 0x19, 0, 0, 0x61, 0x62, 0x63);   // single segment, size 3, last raw block "abc"
  assert.equal(Buffer.from(Z.zstdDecompress(raw)).toString(), "abc");
  const rle = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0x20, 5, 0x2b, 0, 0, 0x7a);                 // last RLE block, 5 x "z"
  assert.equal(Buffer.from(Z.zstdDecompress(rle)).toString(), "zzzzz");
  const skip = Uint8Array.of(0x50, 0x2a, 0x4d, 0x18, 2, 0, 0, 0, 9, 9);
  assert.equal(Buffer.from(Z.zstdDecompress(Uint8Array.from([...skip, ...raw]))).toString(), "abc");
  assert.throws(() => Z.zstdDecompress(Uint8Array.of(1, 2, 3, 4, 5)));
});
test("round trips through node's zstd at several levels (text, repetitive, random data)", () => {
  if (typeof zlib.zstdCompressSync !== "function") return;   // node without zstd: the fixed frames above still run
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const inputs = [Buffer.alloc(0), Buffer.from("a"), Buffer.from(MODEL.repeat(40)), Buffer.alloc(200000, 7)];
  for (let i = 0; i < 8; i++) { const n = Math.floor(rnd() * 150000); const b = Buffer.alloc(n); const alpha = 1 + Math.floor(rnd() * 255); for (let j = 0; j < n; j++) b[j] = rnd() < 0.3 && j > 10 ? b[j - 1 - Math.floor(rnd() * 10)] : Math.floor(rnd() * alpha); inputs.push(b); }
  for (const inp of inputs) for (const level of [1, 3, 9, 19, -5]) {
    const c = zlib.zstdCompressSync(inp, { params: { [zlib.constants.ZSTD_c_compressionLevel]: level, [zlib.constants.ZSTD_c_checksumFlag]: 1 } });
    assert.ok(Buffer.from(Z.zstdDecompress(new Uint8Array(c))).equals(inp), `length ${inp.length} level ${level}`);
  }
});
test("KiCad's own embedded worksheet (qa issue22102) and an embedded SPICE model through embeddedModelFiles", async () => {
  const qa = path.join(__dirname, "..", "..", "..", "qa", "data", "pcbnew", "issue22102.kicad_pcb");
  if (fs.existsSync(qa)) {
    const t = fs.readFileSync(qa, "utf8"); const m = /\(name "SchematicTemplate\.kicad_wks"\)[\s\S]*?\(data\s+([\s\S]*?)\)\s*\(checksum/.exec(t);
    const text = await F.unzstd(new Uint8Array(Buffer.from(m[1].replace(/[|\s]/g, ""), "base64")));
    assert.match(text, /^\(kicad_wks/); assert.equal(text.length, 1977);
  }
  const owner = ["symbol", ["embedded_files", ["file", ["name", "diodes.lib"], ["type", "model"], ["data", "|" + FIXED.slice(0, 60), FIXED.slice(60) + "|"]]]];
  const files = F.embeddedModelFiles([owner]);
  assert.equal(files.length, 1); assert.equal(files[0].path, "kicad-embed://diodes.lib");
  assert.equal(await files[0].load(), MODEL.repeat(3));
});
Promise.all(pending).then(() => { console.log(`${passed} passed, ${failed} failed`); if (failed) process.exit(1); });
