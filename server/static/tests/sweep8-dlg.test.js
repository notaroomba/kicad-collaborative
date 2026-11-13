// sweep8-dlg.test.js — DIALOG_SHIM's Tab wrap, the mandatory-field message, the hotkey editor's store
// (HOTKEY_STORE conflicts, user.hotkeys import, the " *" mark) and Track & Via Properties' file model
// (annular rings, IPC-4761 presets, backdrills, post-machining, teardrops, padstacks, track solder mask).
// Run: node server/static/tests/sweep8-dlg.test.js
"use strict";
const path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", ...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const K = globalThis.KiCadCanvas;
const S = load(["tools", "kicad-dialogs", "shell.ts"]), L = load(["dialogs", "sch-items-logic.ts"]);
const M = load(["editor", "pcbdialogs", "track-via-model.ts"]);
const HK = load(["dialogs", "hotkeys-panel.ts"]);

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e && e.stack || e).split("\n").slice(0, 4).join("\n       ")); } }
const parse = (t) => K.parse(t);
const ser = (n) => K.serialize(n);
const VIA = `(via (at 1 2) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "GND") (uuid "u"))`;

test("Tab wraps inside the dialog: last -> first, Shift+Tab first -> last, otherwise the browser moves on", () => {
  const a = { n: "a" }, b = { n: "b" }, c = { n: "c" };
  assert.equal(S.wrapTab([a, b, c], c, false), a);
  assert.equal(S.wrapTab([a, b, c], a, true), c);
  assert.equal(S.wrapTab([a, b, c], b, false), null);
  assert.equal(S.wrapTab([a, b, c], null, false), a);
  assert.equal(S.wrapTab([a, b, c], { n: "outside" }, true), c);
  assert.equal(S.wrapTab([], a, false), null);
});
test("DIALOG_FIELD_PROPERTIES: the mandatory-field message (DisplayError)", () => {
  assert.equal(L.mandatoryFieldsMessage(1), "The first field is mandatory.");
  assert.equal(L.mandatoryFieldsMessage(5), "The first 5 fields are mandatory.");
});

if (HK) {
  const entry = (name, section, key, alt = "") => ({ name, section, label: name, tip: "", key, alt, origKey: key, origAlt: alt, defKey: key, defAlt: alt, toolName: name });
  test("HOTKEY_STORE::CheckKeyConflicts: same section or Common, never itself", () => {
    const a = entry("A", "PCB Editor", "X"), b = entry("B", "PCB Editor", "Ctrl+S"), c = entry("C", "Common", "F1"), d = entry("D", "Schematic Editor", "Y");
    const secs = [{ name: "Common", rows: [c] }, { name: "Schematic Editor", rows: [d] }, { name: "PCB Editor", rows: [a, b] }];
    assert.equal(HK.keyConflict(secs, a, "Ctrl+S"), b);
    assert.equal(HK.keyConflict(secs, a, "F1"), c);
    assert.equal(HK.keyConflict(secs, a, "Y"), null);
    assert.equal(HK.keyConflict(secs, a, "X"), null);
  });
  test("user.hotkeys: name<TAB>primary<TAB>secondary lines", () => {
    const m = HK.parseHotkeyFile("pcbnew.Foo\tCtrl+K\t\r\ncommon.Bar\tF5\tShift+F5\n\n");
    assert.deepEqual(m.get("pcbnew.Foo"), ["Ctrl+K", ""]);
    assert.deepEqual(m.get("common.Bar"), ["F5", "Shift+F5"]);
    assert.equal(m.size, 2);
  });
  test("the command column drops the ellipsis and marks a changed hotkey with ' *'", () => {
    const e = entry("Zoom to Fit...", "Common", "Home"); e.label = "Zoom to Fit...";
    assert.equal(HK.commandText(e), "Zoom to Fit");
    e.key = "Shift+F9"; assert.equal(HK.commandText(e), "Zoom to Fit *");
  });
  test("HOTKEY_STORE::GetSectionName from the action's application prefix", () => {
    assert.equal(HK.sectionName("pcbnew.EditorControl.foo"), "PCB Editor");
    assert.equal(HK.sectionName("eeschema.X"), "Schematic Editor");
    assert.equal(HK.sectionName("common.Control.x"), "Common");
  });
  test("reserved keys", () => { assert.ok(HK.RESERVED.includes("Ctrl+Tab") && HK.RESERVED.includes("Ctrl+Shift+Tab")); });
}

test("annular rings: the four UNCONNECTED_LAYER_MODE choices round-trip", () => {
  for (const mode of [1, 2, 3, 0]) { const v = parse(VIA); M.setAnnularMode(v, mode, parse); assert.equal(M.annularMode(v), mode, ser(v)); }
  const v = parse(VIA); M.setAnnularMode(v, 1, parse);
  assert.match(ser(v), /\(layers "F\.Cu" "B\.Cu"\) \(remove_unused_layers yes\) \(keep_end_layers yes\) \(zone_layer_connections\)/);
  M.setAnnularMode(v, 0, parse); assert.equal(ser(v), ser(parse(VIA)));
});
test("IPC-4761: presets write the five features; a via with none is 'From rules'", () => {
  const v = parse(VIA);
  assert.equal(M.protectionPreset(v), 0);
  const i = M.IPC4761.findIndex(([n]) => n === "Type VII (filled & capped)");
  M.setProtectionPreset(v, i, parse);
  assert.equal(M.protectionPreset(v), i);
  assert.match(ser(v), /\(capping yes\)/); assert.match(ser(v), /\(filling yes\)/);
  const t = M.IPC4761.findIndex(([n]) => n === "Type I-b (tented both sides)");
  M.setProtectionPreset(v, t, parse); assert.equal(M.protectionPreset(v), t);
  assert.match(ser(v), /\(tenting \(front yes\) \(back yes\)\)/);
  M.setProtectionPreset(v, 0, parse); assert.equal(M.protectionPreset(v), 0);
  // a mixed set of features is CUSTOM, and CUSTOM leaves the via alone
  const c = parse(`(via (at 0 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (capping no) (covering (front no) (back no)) (filling no) (uuid "u"))`);
  assert.equal(M.protectionPreset(c), M.IPC4761_CUSTOM);
  const before = ser(c); M.setProtectionPreset(c, M.IPC4761_CUSTOM, parse); assert.equal(ser(c), before);
});
test("backdrills: the top one from F.Cu as (backdrill), the bottom one from B.Cu as (tertiary_drill), before (layers)", () => {
  const v = parse(VIA);
  M.setBackdrills(v, { size: 0.4, end: "In1.Cu" }, { size: 0.45, end: "In2.Cu" }, parse);
  assert.equal(M.backdrillMode(v), 3);
  assert.match(ser(v), /\(drill 0\.3\) \(backdrill \(size 0\.4\) \(layers "F\.Cu" "In1\.Cu"\)\) \(tertiary_drill \(size 0\.45\) \(layers "B\.Cu" "In2\.Cu"\)\) \(layers/);
  M.setBackdrills(v, null, { size: 0.45, end: "In2.Cu" }, parse); assert.equal(M.backdrillMode(v), 1);
  M.setBackdrills(v, null, null, parse); assert.equal(ser(v), ser(parse(VIA)));
});
test("post-machining: countersink with size and angle, removed by None", () => {
  const v = parse(VIA);
  M.setPostMachining(v, true, { mode: "countersink", size: 0.9, depth: 0, angle: 82 }, parse);
  assert.deepEqual(M.postMachining(v, true), { mode: "countersink", size: 0.9, depth: 0, angle: 82 });
  assert.equal(M.postMachining(v, false).mode, "none");
  M.setPostMachining(v, true, { mode: "none", size: 0, depth: 0, angle: 0 }, parse); assert.equal(ser(v), ser(parse(VIA)));
});
test("teardrops: default parameters write nothing, others the whole node", () => {
  const v = parse(VIA);
  M.setTeardrops(v, { ...M.TEARDROP_DEFAULTS }, M.VIA_ORDER, parse); assert.equal(ser(v), ser(parse(VIA)));
  M.setTeardrops(v, { ...M.TEARDROP_DEFAULTS, enabled: true }, M.VIA_ORDER, parse);
  assert.equal(M.teardrops(v).enabled, true);
  assert.match(ser(v), /\(teardrops .*\(enabled yes\).*\) \(net "GND"\)/);
});
test("padstack: a Front/Inner/Back stack keeps (size) for the front and per-layer sizes", () => {
  const v = parse(VIA);
  assert.equal(M.padstack(v).mode, "normal");
  M.setPadstack(v, { mode: "front_inner_back", sizes: { "F.Cu": 0.6, Inner: 0.5, "B.Cu": 0.7 } }, ["F.Cu", "In1.Cu", "B.Cu"], parse);
  const ps = M.padstack(v);
  assert.equal(ps.mode, "front_inner_back"); assert.equal(M.padstackSize(ps, "Inner"), 0.5); assert.equal(M.padstackSize(ps, "B.Cu"), 0.7);
  M.setPadstack(v, { mode: "normal", sizes: { "F.Cu": 0.6 } }, ["F.Cu", "In1.Cu", "B.Cu"], parse); assert.equal(ser(v), ser(parse(VIA)));
});
test("track solder mask: (layers F.Cu F.Mask) and a margin on the outer layers only", () => {
  const T = `(segment (start 0 0) (end 1 0) (width 0.25) (layer "F.Cu") (net "GND") (uuid "t"))`;
  const t = parse(T);
  M.setTrackLayerAndMask(t, "F.Cu", true, 0.05, parse);
  assert.ok(M.trackHasMask(t)); assert.equal(M.trackLayer(t), "F.Cu"); assert.equal(M.trackMaskMargin(t), 0.05);
  assert.match(ser(t), /\(layers "F\.Cu" "F\.Mask"\) \(solder_mask_margin 0\.05\) \(net/);
  M.setTrackLayerAndMask(t, "In1.Cu", true, 0.05, parse);   // no mask on an inner layer
  assert.ok(!M.trackHasMask(t)); assert.equal(M.trackMaskMargin(t), null);
  M.setTrackLayerAndMask(t, "F.Cu", false, null, parse); assert.equal(ser(t), ser(parse(T)));
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
