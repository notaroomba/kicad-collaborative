// sweep7-ui.test.js — selection modifiers of a box drag (SELECTION_TOOL::setModifiersState, per editor), the dialog
// geometry key and restored size (DIALOG_SHIM), and the board's default grid list (APP_SETTINGS_BASE::DefaultGridSizeList).
// Run: node server/static/tests/sweep7-ui.test.js
"use strict";
const path = require("path"), assert = require("assert");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", ...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const M = load(["editor", "selmodes.ts"]), S = load(["tools", "kicad-dialogs", "shell.ts"]), L = load(["dialogs", "logic.ts"]);

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e && e.stack || e).split("\n").slice(0, 4).join("\n       ")); } }
const ev = (o) => Object.assign({ shiftKey: false, ctrlKey: false, metaKey: false, altKey: false }, o);

test("box drag on the board: SelectMultiple( area, m_subtractive, m_exclusive_or ) — Ctrl toggles, Ctrl+Shift removes, Shift adds", () => {
  assert.equal(M.dragModifier(ev({}), false), null);
  assert.equal(M.dragModifier(ev({ ctrlKey: true }), false), "toggle");
  assert.equal(M.dragModifier(ev({ metaKey: true }), false), "toggle");
  assert.equal(M.dragModifier(ev({ shiftKey: true }), false), "add");
  assert.equal(M.dragModifier(ev({ ctrlKey: true, shiftKey: true }), false), "remove");
});
test("box drag in the schematic: SelectMultiple( area, m_drag_subtractive, false ) — Ctrl adds like Shift, Alt cancels", () => {
  assert.equal(M.dragModifier(ev({}), true), null);
  assert.equal(M.dragModifier(ev({ ctrlKey: true }), true), "add");
  assert.equal(M.dragModifier(ev({ shiftKey: true }), true), "add");
  assert.equal(M.dragModifier(ev({ ctrlKey: true, shiftKey: true }), true), "remove");
  assert.equal(M.dragModifier(ev({ ctrlKey: true, altKey: true }), true), null);
});
test("click modifiers: Shift adds, Ctrl toggles, Ctrl+Shift removes", () => {
  assert.equal(M.selModifier(ev({})), null);
  assert.equal(M.selModifier(ev({ shiftKey: true })), "add");
  assert.equal(M.selModifier(ev({ ctrlKey: true })), "toggle");
  assert.equal(M.selModifier(ev({ ctrlKey: true, shiftKey: true })), "remove");
});

test("getDialogKeyFromTitle: a trailing ' (...)' and the web's ' — item' suffix are not part of the key", () => {
  assert.equal(S.dialogKeyFromTitle("Choose Symbol (1234 items loaded)"), "Choose Symbol");
  assert.equal(S.dialogKeyFromTitle("Pad Properties — R1 pad 1"), "Pad Properties");
  assert.equal(S.dialogKeyFromTitle("Pad Properties — U1 pad 14"), "Pad Properties");
  assert.equal(S.dialogKeyFromTitle("Footprint Properties"), "Footprint Properties");
  assert.equal(S.dialogKeyFromTitle("(odd)"), "(odd)");   // parenPos > 0
});
test("DIALOG_SHIM restore: a resizable dialog opens at max( calculated, saved ) size, a fixed one at its own", () => {
  assert.deepEqual(S.restoredGeometry({ left: 10, top: 20, width: 300, height: 200 }, { width: 460, height: 150 }, true), { left: 10, top: 20, width: 460, height: 200 });
  assert.deepEqual(S.restoredGeometry({ left: 10, top: 20, width: 600, height: 500 }, { width: 460, height: 150 }, true), { left: 10, top: 20, width: 600, height: 500 });
  assert.deepEqual(S.restoredGeometry({ left: 10, top: 20, width: 600, height: 500 }, { width: 460, height: 150 }, false), { left: 10, top: 20 });
  assert.deepEqual(S.restoredGeometry({ left: 10, top: 20 }, { width: 460, height: 150 }, true), { left: 10, top: 20 });
});

test("DefaultGridSizeList (pcbnew): 1000 mil … 1 mil, then 5.0 mm … 0.01 mm; default index 15 is 0.5 mm", () => {
  const g = L.PCB_DEFAULT_GRIDS;
  assert.equal(g.length, 22);
  assert.deepEqual(g.slice(0, 12), [25.4, 12.7, 6.35, 5.08, 2.54, 1.27, 0.635, 0.508, 0.254, 0.127, 0.0508, 0.0254]);
  assert.deepEqual(g.slice(12), [5, 2.5, 1, 0.5, 0.25, 0.2, 0.1, 0.05, 0.025, 0.01]);
  assert.equal(g[L.PCB_DEFAULT_GRID_IDX], 0.5);
  const o = L.PCB_GRID_OVERRIDES;   // override_*_idx 16 / 18 / 19 / 18 / 15
  assert.deepEqual([o.connectedMm, o.textMm, o.wiresMm, o.viasMm, o.graphicsMm], [g[16], g[18], g[19], g[18], g[15]]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
