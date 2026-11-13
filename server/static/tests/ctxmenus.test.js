// ctxmenus.test.js — the right-click menu tables (server/web/editor/ctxmenus.ts) under node: KiCad's
// CONDITIONAL_MENU ordering and the entries each selection / tool gets, and pcb-tools' cancel().
// Run: node server/static/tests/ctxmenus.test.js
"use strict";
const path = require("path"), assert = require("assert");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", "editor", "ctxmenus.ts")], bundle: true, format: "cjs", write: false, logLevel: "silent" });
const mod = { exports: {} }; new Function("module", "exports", out.outputFiles[0].text)(mod, mod.exports);
const { CondMenu, menuFor, evaluate } = mod.exports;
const spec = require(path.join(__dirname, "..", "..", "web", "generated", "kicad-context-spec.json"));
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
const ctx = (o) => Object.assign({ editor: "sch", kinds: [], tool: "select", busy: false, drawingLine: false, routing: false, canClose: false, canUndoPoint: false, highlight: false, belowRoot: false, hasLocked: false, hasUnlocked: false, hasItems: true, checks: {} }, o);
const flat = (list) => list.map((e) => e.sep ? "-" : e.menu ? ">" + e.menu.title : e.act.split("::").pop());
const menu = (o, moduleTool) => { const c = ctx(o); return flat(evaluate(menuFor(c, !!moduleTool), c)); };
const allActs = (list, acc = []) => { for (const e of list) { if (e.act) acc.push(e.act); if (e.items) allActs(e.items, acc); } return acc; };
console.log("context menus under node");

test("CONDITIONAL_MENU order: an entry files behind every entry whose order is <= its own; no order = the list length", () => {
  const m = new CondMenu().item("a").item("b", undefined, 100).item("c", undefined, 1).item("d").sep(100).item("e", undefined, 100);
  assert.deepStrictEqual(flat(evaluate(m, ctx({}))), ["a", "c", "d", "b", "-", "e"]);
});
test("Evaluate drops entries whose condition fails, leading / doubled / trailing separators", () => {
  const no = () => false;
  const m = new CondMenu().sep().item("a", no).sep().item("b").sep().sep().item("c", no).sep();
  assert.deepStrictEqual(flat(evaluate(m, ctx({}))), ["b"]);
});
test("schematic, nothing selected: draw wire / bus, paste, select all, Zoom and Grid last", () => {
  const m = menu({});
  assert.deepStrictEqual(m.slice(0, 3), ["drawWire", "drawBus", "-"]);
  assert.deepStrictEqual(m.slice(-3), ["-", ">Zoom", ">Grid"]);
  assert.ok(!m.includes("doDelete") && !m.includes("move") && !m.includes("properties"), m.join(" "));
});
test("schematic symbol: move / drag, transform, attributes, properties, main fields, clipboard, delete", () => {
  const m = menu({ kinds: ["symbol"], hasUnlocked: true });
  for (const want of ["move", "drag", ">Transform Selection", ">Attributes", "properties", ">Edit Main Fields", "autoplaceFields", "cut", "copy", "doDelete", "duplicate", "selectAll", ">Zoom", ">Grid"]) assert.ok(m.includes(want), want + " missing: " + m.join(" "));
  assert.ok(m.indexOf("move") < m.indexOf(">Transform Selection") && m.indexOf("properties") < m.indexOf("cut") && m.indexOf("doDelete") < m.indexOf("selectAll") && m.indexOf("selectAll") < m.indexOf(">Zoom"), m.join(" "));
  assert.ok(!m.includes("drawWire") && !m.includes("breakWire") && !m.includes("enterSheet"));
});
test("schematic wire: labels, junction, break and slice; a sheet: enter sheet and its pins; a sub-sheet: leave sheet", () => {
  const w = menu({ kinds: ["wire"], hasUnlocked: true });
  for (const want of ["selectConnection", "placeJunction", "placeLabel", "placeGlobalLabel", "breakWire", "slice"]) assert.ok(w.includes(want), want);
  assert.ok(!w.includes(">Attributes") && !w.includes(">Edit Main Fields"));
  const s = menu({ kinds: ["sheet"], hasUnlocked: true });
  for (const want of ["enterSheet", "placeSheetPin", "syncSheetPins", ">Attributes"]) assert.ok(s.includes(want), want);
  assert.ok(menu({ belowRoot: true }).includes("leaveSheet") && !menu({}).includes("leaveSheet"));
});
test("a two-point graphic line is a line (break / slice), a polygon is a shape", () => {
  assert.ok(menu({ kinds: ["gline"] }).includes("slice"));
  assert.ok(!menu({ kinds: ["polyline"] }).includes("slice"));
});
test("several symbols: Align, Change Symbols; no single-symbol entries", () => {
  const m = menu({ kinds: ["symbol", "symbol", "symbol"], hasUnlocked: true });
  assert.ok(m.includes(">Align") && m.includes("changeSymbols") && !m.includes("changeSymbol") && !m.includes(">Edit Main Fields") && !m.includes("properties"), m.join(" "));
});
test("wire tool: Cancel first; finish / undo last segment while a wire is being drawn", () => {
  const idle = menu({ tool: "wire" }, true), drawing = menu({ tool: "wire", busy: true, drawingLine: true }, true);
  assert.strictEqual(idle[0], "cancelInteractive"); assert.strictEqual(drawing[0], "cancelInteractive");
  assert.ok(drawing.includes("finishInteractive") && drawing.includes("undoLastSegment") && drawing.includes("switchSegmentPosture"));
  assert.ok(!idle.includes("finishInteractive") && idle.includes("drawWire") && !drawing.includes("drawWire"));
  assert.deepStrictEqual(drawing.slice(-2), [">Zoom", ">Grid"]);
});
test("a schematic shape tool offers Close Outline / Delete Last Point only when there is an outline", () => {
  assert.ok(menu({ tool: "polygon", busy: true, canClose: true, canUndoPoint: true }, true).includes("closeOutline"));
  const m = menu({ tool: "polygon" }, true); assert.ok(!m.includes("closeOutline") && !m.includes("deleteLastPoint") && m[0] === "cancelInteractive");
});
test("board, nothing selected: select all, paste, Zoom / Grid; a footprint: move, flip, attributes, properties last", () => {
  const e = menu({ editor: "pcb" });
  assert.ok(e.includes("selectAll") && e.includes("paste") && e.includes(">Zoom") && !e.includes("doDelete") && !e.includes("properties") && !e.includes(">Select"));
  const f = menu({ editor: "pcb", kinds: ["footprint"], hasUnlocked: true });
  for (const want of [">Select", "move", "drag45Degree", "flip", ">Attributes", ">Position", ">Locking", "cut", "copy", "doDelete", ">Zoom", ">Grid", "properties"]) assert.ok(f.includes(want), want + " missing: " + f.join(" "));
  assert.strictEqual(f[0], ">Select"); assert.strictEqual(f[f.length - 1], "properties");
  assert.ok(!f.includes("dragFreeAngle") && !f.includes("breakTrack"));
});
test("board track: both drags, break track, the net tools and Mirror / Rotate", () => {
  const t = menu({ editor: "pcb", kinds: ["segment"], hasUnlocked: true });
  for (const want of ["drag45Degree", "dragFreeAngle", "breakTrack", ">Routing", ">Mirror / Rotate", ">Net Inspection Tools", ">Create from Selection"]) assert.ok(t.includes(want), want + " missing: " + t.join(" "));
});
test("router: Cancel first, via and posture entries, Zoom / Grid last; start entries only when not routing", () => {
  const idle = menu({ editor: "pcb", tool: "route" }, true), routing = menu({ editor: "pcb", tool: "route", busy: true, routing: true }, true);
  assert.strictEqual(idle[0], "cancelInteractive");
  assert.ok(idle.includes("routeSingleTrack") && !routing.includes("routeSingleTrack"));
  for (const want of ["finishInteractive", "routerUndoLastSegment", "ACT_PlaceThroughVia", "ACT_SwitchPosture", ">Track Corner Mode"]) assert.ok(routing.includes(want), want);
  assert.deepStrictEqual(routing.slice(-2), [">Zoom", ">Grid"]);
});
test("a tool without a menu of its own gets Cancel, Zoom, Grid", () => {
  assert.deepStrictEqual(menu({ tool: "measure" }, false), ["cancelInteractive", "-", ">Zoom", ">Grid"]);
});
test("every action a menu can show has a label in the generated spec", () => {
  const seen = new Set();
  for (const editor of ["sch", "pcb"]) for (const tool of ["select", "wire", "lines", "polygon", "label", "route", "zone", "gline", "garc", "measure"]) for (const kinds of [[], ["symbol"], ["wire"], ["sheet"], ["label"], ["footprint"], ["segment"], ["zone"], ["gr_line", "gr_line"], ["footprint", "footprint", "footprint"]])
    for (const busy of [false, true]) { const c = ctx({ editor, tool, kinds, busy, drawingLine: busy, routing: busy, canClose: busy, canUndoPoint: busy, highlight: true, belowRoot: true, hasLocked: true, hasUnlocked: true }); for (const a of allActs(evaluate(menuFor(c, tool !== "select" && tool !== "measure"), c))) seen.add(a); }
  assert.ok(seen.size > 100, "only " + seen.size);
  const missing = [...seen].filter((a) => !spec.actions[a] || !spec.actions[a].label);
  assert.deepStrictEqual(missing, []);
  assert.ok(spec.actions["ACTIONS::gridOrigin"], "the Grid sub-menu's first entry");
});

test("footprint editor: PAD_TOOL's pad entries; no Paste Special, Get and Move, Locking, Zones, Net Inspection, Routing (board-only tools)", () => {
  const pad = menu({ editor: "pcb", fpEditor: true, kinds: ["pad"], hasUnlocked: true });
  for (const a of ["padTable", "enumeratePads", "explodePad", "copyPadSettings", "applyPadSettings", "pushPadSettings"]) assert.ok(pad.includes(a), a);
  assert.ok(!pad.includes("recombinePad"));
  for (const a of ["pasteSpecial", "getAndPlace", ">Locking", ">Net Inspection Tools", ">Routing", "assignNetClass"]) assert.ok(!pad.includes(a), a);
  const editing = menu({ editor: "pcb", fpEditor: true, kinds: [], padEdit: true });
  assert.ok(editing.includes("recombinePad") && !editing.includes("explodePad") && editing.includes("padTable"));
  const board = menu({ editor: "pcb", kinds: [] });
  assert.ok(board.includes("getAndPlace") && board.includes("pasteSpecial") && !board.includes("padTable"));
  const two = menu({ editor: "pcb", fpEditor: true, kinds: ["pad", "pad"] });
  assert.ok(two.includes("applyPadSettings") && !two.includes("copyPadSettings") && !two.includes("pushPadSettings"));
});

// pcb-tools: cancel() puts a select-tool move back and clears what was in flight
require(path.join(__dirname, "..", "kicad-canvas.js")); require(path.join(__dirname, "..", "pcb-tools.js"));
test("pcb-tools cancel(): nothing in flight afterwards", () => {
  const pcb = globalThis.CollabTools.pcb, S = pcb.state;
  assert.strictEqual(typeof pcb.cancel, "function");
  S.pending = { item: { id: "x" }, mm: [0, 0] }; S.drag = { bySelect: true, off: 0 }; S.draw = { shape: "gline", pts: [] };
  pcb.cancel();
  assert.ok(!S.pending && !S.drag && !S.draw && !S.move && !S.route);
});
console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
