// sch-tools.test.js — drives the schematic tool module under node against a small
// embedded sheet (and the StickHub sample when present).  Run:
//   node server/static/tests/sch-tools.test.js
"use strict";
const fs = require("fs"), path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
const K = globalThis.KiCadCanvas, sch = globalThis.CollabTools.sch, _ = sch._, IU = 1e4;
const { kid, kids, str, num, atOf, ptsOf } = K;

const SHEET = `(kicad_sch (version 20250114) (generator "eeschema") (generator_version "9.0") (uuid "root-uuid") (paper "A4")
  (lib_symbols
    (symbol "Device:R" (pin_numbers (hide yes)) (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
      (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
      (property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
      (property "Footprint" "" (at -1.778 0 90) (hide yes) (effects (font (size 1.27 1.27))))
      (property "Datasheet" "~" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
      (property "Description" "Resistor" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
      (property "ki_keywords" "R res" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
      (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none))))
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))))
  )
  (junction (at 63.5 63.5) (diameter 0) (color 0 0 0 0) (uuid "j1"))
  (wire (pts (xy 50.8 63.5) (xy 63.5 63.5)) (stroke (width 0) (type default)) (uuid "w1"))
  (wire (pts (xy 63.5 63.5) (xy 76.2 63.5)) (stroke (width 0) (type default)) (uuid "w2"))
  (wire (pts (xy 63.5 63.5) (xy 63.5 76.2)) (stroke (width 0) (type default)) (uuid "w3"))
  (wire (pts (xy 101.6 50.8) (xy 101.6 76.2)) (stroke (width 0) (type default)) (uuid "w4"))
  (wire (pts (xy 127 50.8) (xy 139.7 50.8)) (stroke (width 0) (type default)) (uuid "w5"))
  (wire (pts (xy 139.7 50.8) (xy 139.7 63.5)) (stroke (width 0) (type default)) (uuid "w6"))
  (label "NETA" (at 55.88 63.5 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "l1"))
  (symbol (lib_id "Device:R") (at 25.4 100.33 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "s1")
    (property "Reference" "R1" (at 27.432 99.06 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Value" "10k" (at 27.432 101.6 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Footprint" "" (at 23.622 100.33 90) (hide yes) (effects (font (size 1.27 1.27))))
    (property "Datasheet" "~" (at 25.4 100.33 0) (hide yes) (effects (font (size 1.27 1.27))))
    (property "Description" "Resistor" (at 25.4 100.33 0) (hide yes) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "p1")) (pin "2" (uuid "p2"))
    (instances (project "t" (path "/root-uuid" (reference "R1") (unit 1)))))
)`;

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
const near = (a, b, tol) => Math.abs(a - b) <= (tol || 1e-6);
const allSexprs = [];   // every fragment produced, checked for the desktop format at the end

// A stand-in for app.js's toolCtx(): commit applies through the same applyChange the app uses.
function makeCtx(doc) {
  const ctx = {
    K, doc, IU, isSch: true, zoom: 1, pxPerMm: 4, gridPitch: 1.27, snapOn: true, selected: null, items: [], viewOnly: false, live: true, stage: null,
    snap: (mm) => [K.snap(mm[0], 1.27), K.snap(mm[1], 1.27)], log: [], toasts: [],
    setSelected(s) { ctx.selected = s ? { id: s.id } : null; },
    // the ctx additions the command map relies on: a multi-selection Set, setSelection, a clipboard object and the cursor (mm)
    selection: new Set(), cursor: null, clip: "", clipboard: { get: () => ctx.clip, set: (t) => { ctx.clip = t; } },
    setSelection(ids) { ctx.selection.clear(); for (const id of ids) ctx.selection.add(id); ctx.lastSelection = Array.from(ids); const prim = ctx.lastSelection.map((id) => doc.items.get(id)).find((it) => it && (it.kind === "symbol" || it.kind === "sheet")); ctx.selected = prim ? { id: prim.id } : null; },
    commit(changes, label) {
      // like app.js: the pre-change item must still be the original when commit is called
      const before = changes.map((c) => { const it = doc.items.get(c.id); return it ? K.serializeItem(doc, it) : null; });
      ctx.log.push({ changes, label, before });
      for (const c of changes) { if (c.sexpr) allSexprs.push(c); assert.ok(K.applyChange(doc, c, IU), "applyChange accepted " + c.kind + " " + c.id); }
      if (ctx.notify) sch.onDocChanged(ctx);                     // app.js's applyChanges tells the module about every change
    },
    applyLocal(changes) { for (const c of changes) K.applyChange(doc, c, IU); },
    requestRender() {}, toast(m) { ctx.toasts.push(m); }, enterSheet() {}, setTool(t) { sch.onActivate(t, ctx); },
  };
  return ctx;
}
const ev = (x, y) => ({ button: 0, clientX: x || 0, clientY: y || 0 });
// every top-level token ParseSchematic accepts in copyable-only mode (sch_io_kicad_sexpr_parser.cpp)
const SCH_ITEM_TOKENS = new Set(["arc", "bezier", "bitmap", "bus", "bus_entry", "circle", "directive_label", "label", "ellipse", "ellipse_arc",
  "global_label", "hierarchical_label", "image", "junction", "netclass_flag", "no_connect", "polyline", "rectangle", "rule_area",
  "sheet", "symbol", "table", "text", "text_box", "wire"]);
const lastCommit = (ctx) => ctx.log[ctx.log.length - 1];
const byKind = (changes, kind) => changes.filter((c) => c.kind === kind);
function fragRoot(sexpr) { const trees = K.parseAll(sexpr); assert.strictEqual(trees.length, 1, "one root"); return trees[0]; }
// a rule area's uuid lives inside its polyline (formatPoly writes it there)
const idOf = (n) => K.uuidOf(n) || (n[0] === "rule_area" && kid(n, "polyline") ? K.uuidOf(kid(n, "polyline")) : "");
// The desktop applies a schematic fragment with SCH_IO_KICAD_SEXPR::LoadContent, i.e.
// ParseSchematic(aIsCopyableOnly = true) — the clipboard grammar: bare top-level item roots,
// optionally preceded by (lib_symbols …).  That switch has no case for kicad_sch, so a wrapped
// fragment is rejected and the op is silently dropped.
function fragItems(sexpr) { return K.parseAll(sexpr).filter((t) => t[0] !== "lib_symbols"); }
function fragItem(change) { const items = fragItems(change.sexpr); assert.strictEqual(items.length, 1, "one item root"); assert.strictEqual(idOf(items[0]), change.id, "fragment carries item " + change.id); return items[0]; }

console.log("sch-tools under node");
const doc = K.parseDoc(SHEET);
const ctx = makeCtx(doc);
sch.onDocChanged(ctx);

test("module registers tools with KiCad-style hotkeys", () => {
  assert.strictEqual(sch.id, "sch");
  assert.deepStrictEqual(Object.fromEntries(sch.tools.map((t) => [t.id, t.key])), { wire: "W", bus: "B", busentry: "Z", junction: "J", noconnect: "Q", label: "L", glabel: "Ctrl+L", hlabel: "H", text: "T", place: "A",
    power: "P", classlabel: "", lines: "I", rect: "", circle: "", arc: "", textbox: "", delete: "",
    sheet: "", sheetpin: "", table: "", bezier: "", polygon: "", rulearea: "", image: "", highlight: "" });
  for (const t of sch.tools) assert.ok(t.icon.includes("<") && t.label && t.id && t.cursor);
  assert.ok(sch.tools.find((t) => t.id === "delete").cursor.startsWith("url("), "the delete tool carries KiCad's delete cursor");
});

test("a click on the start point of a wire in progress is ignored (the segment is still null)", () => {
  sch.onActivate("wire", ctx); const n0 = ctx.log.length;
  sch.onPointerDown(ev(), [177.8, 177.8], ctx); assert.ok(sch.state.wire, "first click starts the wire");
  sch.onPointerDown(ev(), [177.8, 177.8], ctx); assert.ok(sch.state.wire, "a second click on the same point keeps drawing");
  assert.strictEqual(ctx.log.length, n0, "nothing committed");
  // KiCad refuses another tool while a wire is in progress (doDrawSegments: "Press <ESC> to cancel drawing.")
  ctx.toasts.length = 0; sch.onActivate("select", ctx);
  assert.ok(sch.state.wire, "the wire survives the refused tool change"); assert.deepStrictEqual(ctx.toasts, ["Press <ESC> to cancel drawing."]);
  _.cancelWire(ctx); assert.strictEqual(sch.state.wire, null, "Esc drops it"); sch.onActivate("select", ctx); assert.strictEqual(sch.state.tool, "select");
});

test("wire ending on the middle of another wire gets a junction (T)", () => {
  sch.onActivate("wire", ctx);
  assert.ok(sch.onPointerDown(ev(), [88.9, 63.5], ctx));
  sch.onPointerMove(ev(), [101.5, 63.6], ctx);                    // snaps onto w4 at (101.6, 63.5) and auto-finishes
  sch.onPointerDown(ev(), [101.5, 63.6], ctx);
  assert.strictEqual(sch.state.wire, null, "wire finished on connection");
  const c = lastCommit(ctx); assert.strictEqual(c.label, "Draw Wires");
  const wires = byKind(c.changes, "ADDED").filter((x) => x.typeName === "SCH_LINE"), js = c.changes.filter((x) => x.typeName === "SCH_JUNCTION");
  // KiCad's AddJunction breaks the wire the new one lands on: w4 now ends on the junction, its other half is a new wire
  assert.strictEqual(wires.length, 2); assert.strictEqual(js.length, 1);
  const cut = byKind(c.changes, "MODIFIED"); assert.strictEqual(cut.length, 1);
  const tail = fragItem(wires[1]), head = fragItem(cut[0]);
  assert.ok(ptsOf(head).some((p) => p[0] === 101.6 && p[1] === 63.5) && ptsOf(tail).some((p) => p[0] === 101.6 && p[1] === 63.5), "both halves end on the junction");
  assert.deepStrictEqual(kid(tail, "stroke"), kid(head, "stroke"), "the new half keeps the wire's stroke");
  const wn = fragItem(wires[0]); assert.strictEqual(wn[0], "wire");
  assert.deepStrictEqual(ptsOf(wn), [[88.9, 63.5], [101.6, 63.5]]);
  assert.deepStrictEqual(kid(wn, "stroke"), ["stroke", ["width", 0], ["type", "default"]]);
  const jn = fragItem(js[0]); assert.strictEqual(jn[0], "junction");
  assert.deepStrictEqual(jn.slice(0, 4), ["junction", ["at", 101.6, 63.5], ["diameter", 0], ["color", 0, 0, 0, 0]]);
  assert.ok(doc.items.get(wires[0].id) && doc.items.get(js[0].id), "items applied to the document");
  ctx.tWire = wires[0].id; ctx.tJunction = js[0].id;
});

test("90-degree routing: two segments per leg, '/' flips the posture, Enter finishes", () => {
  sch.onActivate("wire", ctx);
  sch.onPointerDown(ev(), [152.4, 88.9], ctx);
  sch.onPointerMove(ev(), [165.1, 101.6], ctx);
  sch.onPointerDown(ev(), [165.1, 101.6], ctx);                  // |dx| == |dy| -> horizontal first (computeBreakPoint)
  assert.deepStrictEqual(_.wirePoints(sch.state.wire), [[152.4, 88.9], [165.1, 88.9], [165.1, 101.6]]);
  assert.strictEqual(sch.state.wire.segs.length, 3, "90°: the click fixes one segment, the second stays live with a fresh one");
  assert.ok(sch.onKey("/", {}, ctx));                             // swaps the two live legs
  sch.onPointerMove(ev(), [177.8, 114.3], ctx);
  sch.onPointerDown(ev(), [177.8, 114.3], ctx);                  // the vertical leg keeps stretching from the corner
  assert.deepStrictEqual(_.wirePoints(sch.state.wire), [[152.4, 88.9], [165.1, 88.9], [165.1, 114.3], [177.8, 114.3]]);
  assert.ok(sch.onKey("Backspace", {}, ctx)); assert.strictEqual(sch.state.wire.segs.length, 3, "Backspace drops the last segment");
  assert.ok(sch.onKey("Backspace", {}, ctx)); assert.strictEqual(sch.state.wire.segs.length, 2);
  assert.deepStrictEqual(_.wirePoints(sch.state.wire), [[152.4, 88.9], [165.1, 88.9], [165.1, 114.3]], "the bend is recomputed to the new end");
  const n0 = ctx.log.length; assert.ok(sch.onKey("Delete", {}, ctx)); assert.strictEqual(sch.state.wire.segs.length, 2, "two segments left: Del does nothing more");
  assert.strictEqual(_.wireKey(ctx, "Ctrl+Z"), false, "Ctrl+Z falls through to the document's undo"); assert.strictEqual(_.wireKey(ctx, "Ctrl+Y"), true, "redo is swallowed");
  assert.strictEqual(ctx.log.length, n0);
  sch.onPointerMove(ev(), [177.8, 114.3], ctx);
  assert.ok(sch.onKey("Enter", {}, ctx)); assert.strictEqual(sch.state.wire, null);
  const c = lastCommit(ctx);
  const segsMade = c.changes.filter((x) => x.typeName === "SCH_LINE").map((x) => ptsOf(fragItem(x)));
  assert.deepStrictEqual(segsMade, [[[152.4, 88.9], [177.8, 88.9]], [[177.8, 88.9], [177.8, 114.3]]], "with the corner taken back the first leg stretches again");
  assert.strictEqual(c.changes.filter((x) => x.typeName === "SCH_JUNCTION").length, 0);
});

test("three wire ends meeting get a junction; a corner of two does not", () => {
  assert.strictEqual(_.needsJunction(doc, 139.7, 50.8, "wire"), false);
  sch.onActivate("wire", ctx);
  sch.onPointerDown(ev(), [139.7, 38.1], ctx);
  sch.onPointerMove(ev(), [139.7, 50.8], ctx);
  sch.onPointerDown(ev(), [139.7, 50.8], ctx);                   // lands on the w5/w6 corner -> auto finish
  assert.strictEqual(sch.state.wire, null);
  const js = lastCommit(ctx).changes.filter((x) => x.typeName === "SCH_JUNCTION");
  assert.strictEqual(js.length, 1); assert.deepStrictEqual(atOf(fragItem(js[0])).slice(0, 2), [139.7, 50.8]);
});

test("pins: one wire on a pin needs no junction, an L of two does", () => {
  sch.onActivate("wire", ctx);
  sch.onPointerDown(ev(), [38.1, 96.52], ctx);
  sch.onPointerDown(ev(), [25.4, 96.52], ctx);                   // pin 1 of R1 -> finish
  assert.strictEqual(sch.state.wire, null);
  assert.strictEqual(lastCommit(ctx).changes.filter((x) => x.typeName === "SCH_JUNCTION").length, 0);
  sch.onPointerDown(ev(), [25.4, 88.9], ctx);
  sch.onPointerDown(ev(), [25.4, 96.52], ctx);
  assert.strictEqual(lastCommit(ctx).changes.filter((x) => x.typeName === "SCH_JUNCTION").length, 1);
  assert.ok(_.junctionAt(doc, 25.4, 96.52));
});

test("labels: prompt text lands as KiCad's (label …) shape; global/hierarchical carry their extras", () => {
  sch.setPrompt((title, initial, client, done) => { assert.strictEqual(title, "Net label"); done("NET_X"); });
  sch.onActivate("label", ctx);
  assert.ok(sch.onPointerDown(ev(10, 10), [88.95, 76.1], ctx));
  const c = lastCommit(ctx); assert.strictEqual(c.label, "label");
  const n = fragItem(c.changes[0]);
  assert.deepStrictEqual(n.slice(0, 4), ["label", "NET_X", ["at", 88.9, 76.2, 0], ["effects", ["font", ["size", 1.27, 1.27]], ["justify", "left", "bottom"]]]);
  assert.strictEqual(n[4][0], "uuid");
  assert.ok(/^\(label "NET_X" \(at 88\.9 76\.2 0\) \(effects \(font \(size 1\.27 1\.27\)\) \(justify left bottom\)\) \(uuid "[^"]+"\)\)$/.test(c.changes[0].sexpr), c.changes[0].sexpr);
  assert.strictEqual(sch.state.sel, c.changes[0].id, "new label becomes the module selection");
  const g = _.labelNode("global_label", "GL", [1.27, 2.54], 0);
  assert.strictEqual(g[0], "global_label"); assert.deepStrictEqual(kid(g, "shape"), ["shape", "input"]); assert.deepStrictEqual(kid(g, "fields_autoplaced"), ["fields_autoplaced", "yes"]);
  assert.deepStrictEqual(kid(kid(g, "effects"), "justify"), ["justify", "left"]);
  const isr = kids(g, "property")[0]; assert.strictEqual(isr[1], "Intersheetrefs"); assert.strictEqual(isr[2], "${INTERSHEET_REFS}"); assert.deepStrictEqual(kid(isr, "hide"), ["hide", "yes"]);
  assert.ok(g.findIndex((x) => x[0] === "uuid") < g.findIndex((x) => x[0] === "property"), "uuid precedes the field like KiCad writes it");
  const h = _.labelNode("hierarchical_label", "HL", [0, 0], 180); assert.deepStrictEqual(kid(kid(h, "effects"), "justify"), ["justify", "right"]);
  const t = _.labelNode("text", "hello world", [0, 0], 0); assert.deepStrictEqual(t.slice(0, 3), ["text", "hello world", ["exclude_from_sim", "no"]]);
  const round = K.parse(K.serialize(g)); assert.strictEqual(round[1], "GL"); assert.strictEqual(K.parse(K.serialize(t))[1], "hello world");
});

test("junction / no-connect / bus entry tools place KiCad-shaped items", () => {
  ctx.notify = true;                                             // the app re-ghosts the carry on every change: the placed flag must stay
  sch.onActivate("noconnect", ctx); assert.ok(sch.state.carry && sch.state.carry.kind === "no_connect");
  sch.onPointerDown(ev(), [76.2, 88.9], ctx);
  let n = fragItem(lastCommit(ctx).changes[0]); assert.deepStrictEqual(n.slice(0, 2), ["no_connect", ["at", 76.2, 88.9]]);
  assert.ok(Array.from(doc.items.values()).some((it) => it.kind === "no_connect" && atOf(it.node)[0] === 76.2 && atOf(it.node)[1] === 88.9), "the flag survives the re-ghost");
  sch.onActivate("busentry", ctx);
  assert.ok(sch.onKey("r", {}, ctx), "R rotates the carried entry");
  sch.onPointerDown(ev(), [190.5, 63.5], ctx);
  n = fragItem(lastCommit(ctx).changes[0]); assert.deepStrictEqual(n.slice(0, 4), ["bus_entry", ["at", 190.5, 63.5], ["size", 2.54, -2.54], ["stroke", ["width", 0], ["type", "default"]]]);
  sch.onActivate("noconnect", ctx); let n0 = ctx.log.length;
  sch.onPointerDown(ev(), [76.2, 88.9], ctx);                    // a click on the flag toggles it off (SingleClickPlace)
  assert.strictEqual(lastCommit(ctx).label, "Remove No Connect Flag"); assert.strictEqual(byKind(lastCommit(ctx).changes, "REMOVED").length, 1);
  assert.ok(!Array.from(doc.items.values()).some((it) => it.kind === "no_connect" && atOf(it.node)[0] === 76.2 && atOf(it.node)[1] === 88.9));
  sch.onActivate("junction", ctx); n0 = ctx.log.length; ctx.toasts.length = 0;
  sch.onPointerDown(ev(), [63.5, 63.5], ctx);                    // already one there: nothing happens
  assert.strictEqual(ctx.log.length, n0); assert.deepStrictEqual(ctx.toasts, []);
  sch.onPointerDown(ev(), [177.8, 152.4], ctx);                  // nothing to join on empty paper
  assert.strictEqual(ctx.log.length, n0); assert.deepStrictEqual(ctx.toasts, ["Junction location contains no joinable wires and/or pins."]);
  sch.onPointerDown(ev(), [101.6, 55.88], ctx);                  // the middle of one wire is not a junction either
  assert.strictEqual(ctx.log.length, n0);
  assert.strictEqual(_.explicitJunctionAllowed(doc, [63.5, 63.5]), true, "the T at the existing junction is joinable");
  assert.strictEqual(sch.state.tool, "junction", "the tool stays armed");
  sch.onPointerDown(Object.assign(ev(), { detail: 2 }), [63.5, 63.5], ctx);
  assert.strictEqual(sch.state.tool, "select", "a double click ends the tool");
  sch.onActivate("bus", ctx);
  sch.onPointerDown(ev(), [203.2, 25.4], ctx); sch.onPointerDown(ev(), [215.9, 25.4], ctx); sch.onKey("Enter", {}, ctx);
  n = fragItem(lastCommit(ctx).changes[0]); assert.strictEqual(n[0], "bus"); assert.strictEqual(lastCommit(ctx).changes[0].typeName, "SCH_LINE");
  ctx.notify = false;
});

test("rotate (R) steps 0→90→180→270 and carries fields around the anchor; the fragment round-trips", () => {
  sch.onActivate("select", ctx);
  ctx.selected = { id: "s1" };
  const refAt = () => atOf(kids(doc.items.get("s1").node, "property")[0]).slice(0, 2);
  assert.deepStrictEqual(refAt(), [27.432, 99.06]);
  assert.ok(sch.onKey("r", {}, ctx));
  let c = lastCommit(ctx); assert.strictEqual(c.label, "rotate"); assert.strictEqual(c.changes[0].kind, "MODIFIED"); assert.strictEqual(c.changes[0].typeName, "SCH_SYMBOL");
  assert.ok(/\(at 25\.4 100\.33 0\)/.test(c.before[0]), "commit still sees the unrotated original for its undo record");
  const n = fragItem(c.changes[0]); assert.deepStrictEqual(atOf(n), [25.4, 100.33, 90]); assert.strictEqual(kid(n, "mirror"), null);
  assert.deepStrictEqual(refAt(), [24.13, 98.298], "reference offset (2.032,-1.27) rotated CCW on screen -> (-1.27,-2.032)");
  const rots = [];
  for (let i = 0; i < 3; i++) { sch.onKey("r", {}, ctx); rots.push(doc.items.get("s1").rot); }
  assert.deepStrictEqual(rots, [180, 270, 0]);
  assert.deepStrictEqual(refAt(), [27.432, 99.06], "four turns bring the field home");
  assert.ok(sch.onKey("R", { shiftKey: true }, ctx)); assert.strictEqual(doc.items.get("s1").rot, 270, "Shift+R turns clockwise");
  sch.onKey("r", {}, ctx); assert.strictEqual(doc.items.get("s1").rot, 0);
});

test("mirror: KiCad's Y (Mirror Vertically) writes (mirror x), X (Mirror Horizontally) writes (mirror y); toggles off again and composes with rotation", () => {
  ctx.selected = { id: "s1" };
  assert.ok(sch.onKey("y", {}, ctx));
  let n = fragItem(lastCommit(ctx).changes[0]); assert.deepStrictEqual(kid(n, "mirror"), ["mirror", "x"]); assert.strictEqual(atOf(n)[2], 0);
  assert.strictEqual(n.findIndex((x) => Array.isArray(x) && x[0] === "mirror"), n.findIndex((x) => Array.isArray(x) && x[0] === "at") + 1, "(mirror) follows (at)");
  sch.onKey("y", {}, ctx); n = fragItem(lastCommit(ctx).changes[0]); assert.strictEqual(kid(n, "mirror"), null);
  sch.onKey("x", {}, ctx); n = fragItem(lastCommit(ctx).changes[0]); assert.deepStrictEqual(kid(n, "mirror"), ["mirror", "y"]);
  assert.strictEqual(doc.items.get("s1").geom.some((g) => g.t === "text" && g.text === "R1" && g.x < 25.4), true, "Mirror Horizontally flips the symbol about its Y axis: the reference now reads on the left");
  sch.onKey("r", {}, ctx); n = fragItem(lastCommit(ctx).changes[0]);
  assert.deepStrictEqual([atOf(n)[2], str(kid(n, "mirror")[1])], [90, "x"], "CCW turn of a (mirror y) symbol is (at … 90) (mirror x), as KiCad stores it");
  const T = _.tFrom(90, "x"); assert.deepStrictEqual(T, _.mul(_.RCCW, _.tFrom(0, "y")), "transform algebra agrees");
  // every orientation × every op survives the (rot, mirror) search
  for (const rot of [0, 90, 180, 270]) for (const m of ["", "x", "y"]) for (const op of ["ccw", "cw", "x", "y"]) {
    const node = ["symbol", ["lib_id", "Device:R"], ["at", 0, 0, rot]]; if (m) node.push(["mirror", m]);
    const want = _.mul({ ccw: _.RCCW, cw: [0, -1, 1, 0], x: _.MX, y: _.MY }[op], _.tFrom(rot, m));
    const o = _.orientSymbol(node, op); assert.deepStrictEqual(_.tFrom(o.rot, o.mirror), want, `${rot}/${m || "-"} ${op}`);
    assert.deepStrictEqual(_.tFrom(atOf(node)[2], kid(node, "mirror") ? str(kid(node, "mirror")[1]) : ""), want);
  }
  sch.onKey("y", {}, ctx); sch.onKey("r", {}, ctx); sch.onKey("r", {}, ctx); sch.onKey("r", {}, ctx);   // (90,x) -Y-> 90 -> 180 -> 270 -> 0
  n = fragItem(lastCommit(ctx).changes[0]); assert.deepStrictEqual([atOf(n)[2], kid(n, "mirror")], [0, null]);
  assert.deepStrictEqual(atOf(kids(n, "property")[0]).slice(0, 2), [27.432, 99.06], "the field offsets follow the same group action home");
  assert.strictEqual(K.uuidOf(fragItem(lastCommit(ctx).changes[0])), "s1", "the fragment is the bare item root, keyed by its uuid");
});

test("labels rotate through 0/90/180/270 with matching justify", () => {
  const id = ctx.log.find((c) => c.label === "label").changes[0].id;
  ctx.selected = null; sch.select(id);
  const seen = [];
  for (let i = 0; i < 4; i++) { assert.ok(sch.onKey("r", {}, ctx)); const n = fragItem(lastCommit(ctx).changes[0]); seen.push([atOf(n)[2], kid(kid(n, "effects"), "justify").slice(1).join(" ")]); }
  assert.deepStrictEqual(seen, [[90, "left bottom"], [180, "right bottom"], [270, "right bottom"], [0, "left bottom"]]);
});

test("place symbol (A): node from the library with R?/Value/pins, junctions at pins, selection follows", () => {
  const n = _.symbolNode(doc, "Device:R", [50.8, 25.4], 0, "");
  const props = kids(n, "property").map((p) => [p[1], p[2]]);
  assert.deepStrictEqual(props, [["Reference", "R?"], ["Value", "R"], ["Footprint", ""], ["Datasheet", "~"], ["Description", "Resistor"]], "ki_* fields are not copied");
  assert.deepStrictEqual(atOf(kids(n, "property")[0]), [52.832, 25.4, 90], "field offsets come through the orientation transform");
  assert.deepStrictEqual(kid(kids(n, "property")[2], "hide"), ["hide", "yes"]);
  assert.deepStrictEqual(kids(n, "pin").map((p) => p[1]), ["1", "2"]); assert.ok(kids(n, "pin").every((p) => K.uuidOf(p).length > 10));
  assert.deepStrictEqual(n.slice(0, 3), ["symbol", ["lib_id", "Device:R"], ["at", 50.8, 25.4, 0]]);
  assert.strictEqual(kid(n, "instances"), null);
  sch.onActivate("place", ctx);
  _.startCarry(ctx, "symbol", n, [50.8, 25.4]);
  assert.ok(sch.state.carry.item && sch.state.carry.item.geom.length, "ghost geometry built off-document");
  assert.strictEqual(doc.items.has(K.uuidOf(n)), false);
  sch.onPointerMove(ev(), [63.4, 25.5], ctx);                    // ghost follows and snaps
  assert.deepStrictEqual(atOf(sch.state.carry.node).slice(0, 2), [63.5, 25.4]);
  sch.onPointerDown(ev(), [63.4, 25.5], ctx);
  const c = lastCommit(ctx); assert.strictEqual(c.changes[0].kind, "ADDED"); assert.strictEqual(c.changes[0].typeName, "SCH_SYMBOL");
  assert.ok(c.changes[0].sexpr.includes("(lib_symbols (symbol \"Device:R"), "fragment embeds the library symbol");
  const it = doc.items.get(c.changes[0].id); assert.ok(it); assert.strictEqual(it.ref, "R?"); assert.strictEqual(it.value, "R");
  const pp = K.pinPoints(doc, it); assert.strictEqual(pp.length, 2);
  assert.ok(near(pp[0].x, 63.5) && near(pp[0].y, 21.59) && near(pp[1].x, 63.5) && near(pp[1].y, 29.21), JSON.stringify(pp));
  assert.deepStrictEqual(ctx.selected, { id: it.id });
  assert.strictEqual(sch.state.carry, null);
  const fresh = K.parseDoc(SHEET); assert.ok(K.applyChange(fresh, c.changes[0], IU)); assert.strictEqual(fresh.items.get(it.id).ref, "R?");
  // a pin dropped onto the middle of a wire needs a junction
  _.startCarry(ctx, "symbol", _.symbolNode(doc, "Device:R", [0, 0], 0, ""), [101.6, 73.66]);
  _.placeCarry(ctx, [101.6, 73.66]); _.dropCarry(ctx);
  assert.strictEqual(lastCommit(ctx).changes.filter((x) => x.typeName === "SCH_JUNCTION").length, 1);
});

test("duplicate (D): fresh uuids, no instance data, offset 2.54 and carried until the click", () => {
  sch.onActivate("select", ctx);
  ctx.selected = { id: "s1" };
  const s1 = doc.items.get("s1"), refOff = atOf(kids(s1.node, "property")[0]).slice(0, 2).map((v, i) => v - atOf(s1.node)[i]);
  assert.ok(sch.onKey("d", {}, ctx));
  const cr = sch.state.carry; assert.ok(cr && cr.kind === "symbol"); assert.strictEqual(sch.state.tool, "place");
  assert.notStrictEqual(K.uuidOf(cr.node), "s1"); assert.ok(kids(cr.node, "pin").every((p) => !["p1", "p2"].includes(K.uuidOf(p))));
  assert.strictEqual(kid(cr.node, "instances"), null);
  assert.deepStrictEqual(atOf(cr.node).slice(0, 2), [27.94, 102.87]);
  sch.onPointerMove(ev(), [63.5, 114.3], ctx);
  sch.onPointerDown(ev(), [63.5, 114.3], ctx);
  const c = lastCommit(ctx); const n = fragItem(c.changes[0]);
  assert.deepStrictEqual(atOf(n).slice(0, 2), [63.5, 114.3]); assert.strictEqual(kids(n, "property")[0][2], "R1", "reference kept; the desktop annotates");
  const fa = atOf(kids(n, "property")[0]); assert.ok(near(fa[0], 63.5 + refOff[0], 1e-3) && near(fa[1], 114.3 + refOff[1], 1e-3), "fields moved with the body: " + fa);
  assert.ok(doc.items.get(c.changes[0].id));
});

test("hit testing picks wires, labels and junctions; symbols stay with app.js", () => {
  assert.strictEqual(_.hitNonSymbol(doc, 70, 63.55, 0.3).id, "w2");
  assert.strictEqual(_.hitNonSymbol(doc, 57.15, 63.3, 0.3).id, "l1", "label beats the wire it sits on");
  assert.strictEqual(_.hitNonSymbol(doc, 25.4, 100.33, 0.3), null, "nothing but the symbol body here");
  assert.strictEqual(_.pickNonSymbol(ctx, [25.4, 100.33]), null);
  assert.strictEqual(_.pickNonSymbol(ctx, [25.4, 96.52]).kind, "junction", "junction on a pin beats the symbol's box");
  assert.strictEqual(_.hitNonSymbol(doc, 101.6, 63.5, 0.3).id, ctx.tJunction);
  const b = _.textRect(doc.items.get("l1")); assert.ok(b[0] <= 55.88 && b[2] > 59 && b[1] < 63.5 && b[3] >= 63.5);
});

test("delete removes the selected wire and the junction it alone justified", () => {
  ctx.selected = null; sch.select(ctx.tWire);
  assert.ok(sch.onKey("Delete", {}, ctx));
  const c = lastCommit(ctx); assert.strictEqual(c.label, "delete");
  assert.deepStrictEqual(c.changes.map((x) => [x.kind, x.id]).sort(), [["REMOVED", ctx.tJunction], ["REMOVED", ctx.tWire]].sort());
  assert.ok(!doc.items.has(ctx.tWire) && !doc.items.has(ctx.tJunction));
  assert.strictEqual(sch.state.sel, null);
  assert.strictEqual(sch.onKey("Delete", {}, ctx), false, "nothing selected -> app.js keeps the key");
});

// ---- graphic shapes, power symbols, directive labels, the delete tool, render options ----
const STROKE0 = ["stroke", ["width", 0], ["type", "default"]], FILL_NONE = ["fill", ["type", "none"]];
/** Recording 2D-context stub, as in render.test.js. */
function stubCtx(w, h) {
  const calls = {}; const rec = (n) => { calls[n] = (calls[n] || 0) + 1; };
  const c = { canvas: { width: w, height: h }, calls, font: "", textAlign: "", textBaseline: "", fillStyle: "", strokeStyle: "", lineWidth: 1, lineCap: "", lineJoin: "", globalAlpha: 1 };
  for (const n of ["setTransform", "fillRect", "strokeRect", "beginPath", "moveTo", "lineTo", "closePath", "arc", "rect", "fill", "stroke", "save", "restore", "translate", "rotate", "scale", "fillText", "strokeText", "setLineDash"]) c[n] = () => rec(n);
  c.measureText = (t) => ({ width: t.length * 0.7 });
  return c;
}
const LIB_SYM = (name, ref, extra) => `(symbol "${name}" ${extra || ""} (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
  (property "Reference" "${ref}" (at 0 -6.35 0) (hide yes) (effects (font (size 1.27 1.27)))) (property "Value" "${name.split(":")[1]}" (at 0 -3.81 0) (effects (font (size 1.27 1.27))))
  (symbol "${name.split(":")[1]}_0_1" (polyline (pts (xy 0 0) (xy 0 -1.27) (xy 1.27 -1.27) (xy 0 -2.54) (xy -1.27 -1.27) (xy 0 -1.27)) (stroke (width 0) (type default)) (fill (type none))))
  (symbol "${name.split(":")[1]}_1_1" (pin power_in line (at 0 0 270) (length 0) (hide yes) (name "${name.split(":")[1]}" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))`;

test("power (P): the picker offers power symbols only; with none in the sheet the tool stays armed with a hint", () => {
  assert.deepStrictEqual(_.powerSymbols(doc), []);
  ctx.toasts.length = 0;
  assert.ok(sch.onKey("p", {}, ctx)); assert.strictEqual(sch.state.tool, "power");
  assert.ok(ctx.toasts.some((m) => /power symbols/.test(m)), "told there is nothing to place");
  const n0 = ctx.log.length; assert.ok(sch.onPointerDown(ev(), [10, 10], ctx)); assert.strictEqual(ctx.log.length, n0, "a click without a carry places nothing");
  doc.lib.set("power:GND", K.parse(LIB_SYM("power:GND", "#PWR", "(power)")));       // the (power) flag
  doc.lib.set("Mine:VCC", K.parse(LIB_SYM("Mine:VCC", "#PWR")));                    // a #PWR reference
  doc.lib.set("Mine:PWR_FLAG", K.parse(LIB_SYM("Mine:PWR_FLAG", "#FLG")));          // a #FLG reference
  doc.lib.set("Mine:Thing", K.parse(LIB_SYM("Mine:Thing", "U")));                   // an ordinary part
  doc.lib.set("power:+5V", K.parse('(symbol "power:+5V" (extends "GND") (property "Value" "+5V" (at 0 0 0) (effects (font (size 1.27 1.27)))))'));   // inherits (power)
  assert.deepStrictEqual(_.powerSymbols(doc), ["Mine:PWR_FLAG", "Mine:VCC", "power:+5V", "power:GND"]);
  assert.strictEqual(_.isPowerSymbol(doc, "Device:R"), false);
  _.pickSymbol(ctx, "power:GND");
  assert.ok(sch.state.carry && sch.state.carry.kind === "symbol", "picked symbol rides on the cursor");
  sch.onPointerMove(ev(), [88.95, 114.25], ctx); sch.onPointerDown(ev(), [88.95, 114.25], ctx);
  const c = lastCommit(ctx); assert.strictEqual(c.label, "place #PWR?"); assert.strictEqual(c.changes[0].typeName, "SCH_SYMBOL");
  const n = fragItem(c.changes[0]); assert.deepStrictEqual(atOf(n), [88.9, 114.3, 0]);
  assert.deepStrictEqual(kids(n, "property").slice(0, 2).map((p) => [p[1], p[2]]), [["Reference", "#PWR?"], ["Value", "GND"]]);
  assert.ok(c.changes[0].sexpr.includes("(lib_symbols (symbol \"power:GND"), "fragment embeds the power symbol");
  assert.strictEqual(sch.state.carry, null); assert.strictEqual(sch.state.tool, "power", "ready for the next one");
  ctx.tPower = c.changes[0].id;
});

test("render option showHiddenPins: hidden pins are kept beside the geometry and drawn only on request", () => {
  const it = doc.items.get(ctx.tPower);
  assert.ok(it.hiddenGeom && it.hiddenGeom.length >= 2, "hidden pin name and number kept aside");
  assert.ok(!it.geom.some((g) => g.layer === "Pin names" || g.layer === "Pin numbers"), "…and not in the item's own geometry");
  assert.ok(it.hiddenGeom.some((g) => g.t === "text" && g.text === "GND" && g.color === K.SCH.hidden), "drawn in the hidden-item grey");
  const view = { ppm: 1600 / doc.page[0], zoom: 1, panX: 0, panY: 0, x0: 0, y0: 0, dpr: 1 };
  const plain = stubCtx(1600, 1200); K.render(doc, plain, view, {});
  const shown = stubCtx(1600, 1200); K.render(doc, shown, view, { showHiddenPins: true });
  assert.strictEqual((shown.calls.fillText || 0) - (plain.calls.fillText || 0), 2, "the hidden pin's name and number are drawn");
  const none = stubCtx(1600, 1200); K.render(doc, none, view, { showHiddenPins: true, hidden: new Set(["Pin names", "Pin numbers"]) });
  assert.strictEqual(none.calls.fillText, plain.calls.fillText, "hidden layers still apply");
});

test("rectangle: two corners give KiCad's (rectangle (start) (end) (stroke) (fill) (uuid)), corners normalised", () => {
  sch.onActivate("rect", ctx);
  assert.ok(sch.onPointerDown(ev(), [30.5, 30.4], ctx)); assert.deepStrictEqual(sch.state.draw.pts, [[30.48, 30.48]]);
  sch.onPointerMove(ev(), [20.3, 40.7], ctx); assert.deepStrictEqual(sch.state.draw.cur, [20.32, 40.64], "preview corner follows the snapped cursor");
  sch.onPointerDown(ev(), [20.3, 40.7], ctx);
  const c = lastCommit(ctx); assert.strictEqual(c.label, "rectangle"); assert.strictEqual(c.changes[0].kind, "ADDED"); assert.strictEqual(c.changes[0].typeName, "SCH_SHAPE");
  const n = fragItem(c.changes[0]);
  assert.deepStrictEqual(n.slice(0, 5), ["rectangle", ["start", 20.32, 30.48], ["end", 30.48, 40.64], STROKE0, FILL_NONE]);
  assert.strictEqual(n[5][0], "uuid"); assert.strictEqual(n.length, 6);
  const it = doc.items.get(c.changes[0].id); assert.strictEqual(it.kind, "rectangle"); assert.ok(it.geom.some((g) => g.t === "poly" && g.close && g.pts.length === 4));
  assert.strictEqual(sch.state.draw, null); assert.strictEqual(sch.state.tool, "rect", "tool stays armed"); assert.strictEqual(sch.state.sel, it.id);
  assert.deepStrictEqual(_.anchorOf("rectangle", it.node), [20.32, 30.48]);
  ctx.tRect = it.id;
});

test("circle: centre then a radius point; a zero radius is not a circle", () => {
  sch.onActivate("circle", ctx);
  sch.onPointerDown(ev(), [50.8, 50.8], ctx); sch.onPointerDown(ev(), [50.8, 50.8], ctx);
  assert.ok(sch.state.draw && sch.state.draw.pts.length === 1); assert.strictEqual(lastCommit(ctx).label, "rectangle");
  sch.onPointerDown(ev(), [55.88, 50.8], ctx);
  const c = lastCommit(ctx); assert.strictEqual(c.label, "circle");
  const n = fragItem(c.changes[0]);
  assert.deepStrictEqual(n.slice(0, 5), ["circle", ["center", 50.8, 50.8], ["radius", 5.08], STROKE0, FILL_NONE]); assert.strictEqual(n[5][0], "uuid");
  assert.strictEqual(doc.items.get(c.changes[0].id).geom.find((g) => g.t === "circle").r, 5.08);
  assert.strictEqual(sch.state.draw, null);
});

test("arc: KiCad 10's five drawing modes (EE_GRAPHIC_TOOL::DrawArc with ARC_MODE_SESSION); start, end, midpoint refuses a point on the chord", () => {
  const groups = []; ctx.setGroupCurrent = (g, id) => groups.push([g, id]);
  // Start, End, Midpoint: the third point is projected onto the chord's bisector
  assert.ok(sch.actions.drawArcStartEndMid.run(ctx)); assert.strictEqual(sch.state.tool, "arc");
  assert.deepStrictEqual(groups[groups.length - 1], ["Arc", "drawArcStartEndMid"], "the Arc group shows the mode");
  sch.onPointerDown(ev(), [76.2, 101.6], ctx); sch.onPointerDown(ev(), [86.36, 101.6], ctx);
  assert.deepStrictEqual(sch.state.draw.pts, [[76.2, 101.6]]); assert.strictEqual(sch.state.draw.arc.getStep(), 2);
  const n0 = ctx.log.length; sch.onPointerDown(ev(), [81.28, 101.6], ctx);
  assert.ok(sch.state.draw && sch.state.draw.arc.getStep() === 2 && ctx.log.length === n0, "a point on the chord makes no arc");
  sch.onPointerDown(ev(), [81.28, 96.52], ctx);
  const c = lastCommit(ctx); assert.strictEqual(c.label, "arc"); assert.strictEqual(c.changes[0].typeName, "SCH_SHAPE");
  const n = fragItem(c.changes[0]);
  assert.deepStrictEqual(n.slice(0, 6), ["arc", ["start", 76.2, 101.6], ["mid", 81.28, 96.52], ["end", 86.36, 101.6], STROKE0, FILL_NONE]); assert.strictEqual(n[6][0], "uuid");
  const g = doc.items.get(c.changes[0].id).geom.find((x) => x.t === "arc"); assert.ok(g); assert.ok(near(g.r, 5.08) && near(g.x, 81.28) && near(g.y, 101.6));
  assert.ok(sch.state.draw && sch.state.draw.arc && sch.state.draw.arc.isReset(), "the tool goes on with the next arc");
  // Center, Start, End: a quarter turn about (50.8, 15.24); Backspace takes back the last point
  assert.ok(sch.actions.drawArcCenter.run(ctx)); assert.deepStrictEqual(groups[groups.length - 1], ["Arc", "drawArcCenter"]);
  sch.onPointerDown(ev(), [50.8, 15.24], ctx); sch.onPointerDown(ev(), [55.88, 20.32], ctx);
  assert.ok(sch.onKey("Backspace", {}, ctx)); assert.strictEqual(sch.state.draw.arc.getStep(), 1);
  sch.onPointerDown(ev(), [60.96, 15.24], ctx); sch.onPointerMove(ev(), [50.8, 5.08], ctx);
  sch.onPointerDown(ev(), [50.8, 5.08], ctx);
  const a = fragItem(lastCommit(ctx).changes[0]); assert.strictEqual(a[0], "arc");
  const ga = K.arcFrom3(a[1].slice(1), a[2].slice(1), a[3].slice(1)); assert.ok(near(ga.x, 50.8, 1e-3) && near(ga.y, 15.24, 1e-3) && near(ga.r, 10.16, 1e-3), JSON.stringify(a.slice(1, 4)));
  // Cycle Arc Drawing Mode (Alt+/) walks the modes and is remembered
  sch.onKey("/", { altKey: true }, ctx); assert.deepStrictEqual(groups[groups.length - 1], ["Arc", "drawArcStartEndMid"]);
  assert.strictEqual(sch.state.draw.arc.mode, 1);
  // Tangent: a click on a graphic line's end leaves along it; Enter keeps the arc and ends the tool
  // Tangent: a click on the end of a graphic seeds the arc from it; the next click ends it, on the same circle here
  sch.actions.drawArcTangent.run(ctx); assert.strictEqual(sch.state.draw.arc.mode, 3);
  const n1 = ctx.log.length;
  sch.onPointerDown(ev(), [50.8, 5.08], ctx); assert.ok(sch.state.draw.clickSeeded && ctx.log.length === n1, "the click seeds, nothing is committed");
  sch.onPointerMove(ev(), [40.64, 15.24], ctx); sch.onPointerDown(ev(), [40.64, 15.24], ctx);
  const t = fragItem(lastCommit(ctx).changes[0]), gt = K.arcFrom3(t[1].slice(1), t[2].slice(1), t[3].slice(1));
  assert.ok(near(gt.x, 50.8, 1e-3) && near(gt.y, 15.24, 1e-3) && near(gt.r, 10.16, 1e-3), JSON.stringify([t.slice(1, 4), gt]));
  assert.ok(sch.state.draw && sch.state.draw.chainSeeded, "the next arc leaves from where this one ended");
  // Enter (finishInteractive) with no arc yet commits nothing and ends the tool
  const n2 = ctx.log.length; assert.ok(sch.onKey("Enter", {}, ctx)); assert.strictEqual(ctx.log.length, n2); assert.strictEqual(sch.state.tool, "select");
  sch.actions.drawArcCenter.run(ctx); sch.onActivate("select", ctx);   // leave the remembered mode at its default
});

test("lines (I): KiCad's drawLines — one SCH_LINE per segment on the notes layer, a double click finishes, Enter too, a lone point is dropped", () => {
  sch.setLineMode(ctx, "90");
  assert.ok(sch.onKey("i", {}, ctx)); assert.strictEqual(sch.state.tool, "lines"); _.cancelWire(ctx);
  for (const p of [[25.4, 25.4], [38.1, 25.4], [38.1, 38.1], [50.8, 38.1]]) sch.onPointerDown(ev(), p, ctx);
  assert.strictEqual(sch.state.wire.kind, "polyline");
  sch.onPointerDown(ev(), [50.8, 38.1], ctx); assert.ok(sch.state.wire, "a second click on the last point does not end it (KiCad needs a double click)");
  sch.onPointerDown(Object.assign(ev(), { detail: 2 }), [50.8, 38.1], ctx);
  let c = lastCommit(ctx); assert.strictEqual(c.label, "Draw Wires", "doDrawSegments pushes Draw Wires for lines too");
  assert.deepStrictEqual(c.changes.map((x) => x.typeName), ["SCH_LINE", "SCH_LINE", "SCH_LINE"]);
  assert.deepStrictEqual(c.changes.map((x) => ptsOf(fragItem(x))), [[[25.4, 25.4], [38.1, 25.4]], [[38.1, 25.4], [38.1, 38.1]], [[38.1, 38.1], [50.8, 38.1]]]);
  let n = fragItem(c.changes[0]); assert.deepStrictEqual(n.slice(0, 3), ["polyline", ["pts", ["xy", 25.4, 25.4], ["xy", 38.1, 25.4]], STROKE0]);
  assert.strictEqual(sch.state.wire, null); assert.strictEqual(sch.state.tool, "lines");
  sch.onPointerDown(ev(), [63.5, 25.4], ctx); sch.onPointerDown(ev(), [76.2, 25.4], ctx); assert.ok(sch.onKey("Enter", {}, ctx));
  c = lastCommit(ctx); n = fragItem(c.changes[0]); assert.deepStrictEqual(ptsOf(n), [[63.5, 25.4], [76.2, 25.4]], "Enter finishes a two-point line");
  sch.onPointerDown(ev(), [88.9, 25.4], ctx); sch.onPointerDown(ev(), [88.9, 30], ctx); sch.onPointerDown(ev(), [76.2, 25.4], ctx);
  assert.strictEqual(sch.state.wire, null, "a line ends by itself on another graphic line (IsTerminalPoint, LAYER_NOTES)");
  const before = ctx.log.length; sch.onPointerDown(ev(), [101.6, 25.4], ctx); assert.ok(sch.onKey("Enter", {}, ctx));
  assert.strictEqual(ctx.log.length, before); assert.strictEqual(sch.state.wire, null);
});

test("text box: two corners then the inline prompt; KiCad's (text_box …) with margins and left/top justify", () => {
  let title = null; sch.setPrompt((t, initial, client, done) => { title = t; done("Note\nline 2"); });
  sch.onActivate("textbox", ctx);
  sch.onPointerDown(ev(), [101.6, 114.3], ctx); sch.onPointerDown(ev(), [127, 127], ctx);
  assert.strictEqual(title, "Text box");
  const c = lastCommit(ctx); assert.strictEqual(c.label, "text box"); assert.strictEqual(c.changes[0].typeName, "SCH_TEXTBOX");
  const n = fragItem(c.changes[0]); assert.strictEqual(n[1], "Note\nline 2");
  assert.deepStrictEqual(n.slice(2, 9), [["exclude_from_sim", "no"], ["at", 101.6, 114.3, 0], ["size", 25.4, 12.7], ["margins", 0.9525, 0.9525, 0.9525, 0.9525], STROKE0, FILL_NONE, ["effects", ["font", ["size", 1.27, 1.27]], ["justify", "left", "top"]]]);
  assert.strictEqual(n[9][0], "uuid"); assert.strictEqual(n.length, 10);
  const it = doc.items.get(c.changes[0].id); assert.strictEqual(it.kind, "text_box"); assert.strictEqual(it.geom.filter((g) => g.t === "text").length, 2);
  assert.strictEqual(sch.state.draw, null);
  sch.setPrompt((t, i, cl, done) => done(null));                    // Escape in the prompt drops the box
  const before = ctx.log.length; sch.onPointerDown(ev(), [10.16, 10.16], ctx); sch.onPointerDown(ev(), [20.32, 20.32], ctx);
  assert.strictEqual(ctx.log.length, before); assert.strictEqual(sch.state.draw, null);
});

test("directive label: the netclass name from the prompt lands as (netclass_flag …) with its autoplaced Netclass field", () => {
  sch.setPrompt((t, initial, client, done) => { assert.strictEqual(t, "Netclass"); done("Power"); });
  sch.onActivate("classlabel", ctx);
  assert.ok(sch.onPointerDown(ev(), [152.4, 139.7], ctx));
  const c = lastCommit(ctx); assert.strictEqual(c.label, "directive label"); assert.strictEqual(c.changes[0].typeName, "SCH_DIRECTIVE_LABEL");
  const n = fragItem(c.changes[0]);
  assert.deepStrictEqual(n.slice(0, 7), ["netclass_flag", "", ["length", 2.54], ["shape", "round"], ["at", 152.4, 139.7, 0], ["fields_autoplaced", "yes"], ["effects", ["font", ["size", 1.27, 1.27]], ["justify", "left", "bottom"]]]);
  assert.strictEqual(n[7][0], "uuid");
  assert.deepStrictEqual(n[8], ["property", "Netclass", "Power", ["at", 153.0985, 137.16, 0], ["effects", ["font", ["size", 1.27, 1.27]], ["justify", "left", "bottom"]]]);
  assert.strictEqual(n.length, 9);
  const it = doc.items.get(c.changes[0].id); assert.ok(it.geom.some((g) => g.t === "text" && g.text === "Power")); assert.ok(it.geom.some((g) => g.t === "circle"));
  assert.strictEqual(sch.state.sel, it.id);
  // the field follows SCH_DIRECTIVE_LABEL::AutoplaceFields for every spin style
  assert.deepStrictEqual(atOf(kids(_.classLabelNode("X", [0, 0], 90), "property")[0]), [-2.54, -0.6985, 90]);
  assert.deepStrictEqual(atOf(kids(_.classLabelNode("X", [0, 0], 180), "property")[0]), [0.6985, 2.54, 0]);
  assert.deepStrictEqual(atOf(kids(_.classLabelNode("X", [0, 0], 270), "property")[0]), [2.54, -0.6985, 90]);
  ctx.tFlag = it.id;
});

test("delete tool: clicks remove wires (with the junction they alone justified), shapes, flags and symbols; the tool stays armed", () => {
  sch.onActivate("delete", ctx); assert.strictEqual(sch.state.tool, "delete");
  sch.onPointerMove(ev(), [70, 63.55], ctx); assert.strictEqual(sch.state.hover, "w2", "hover shows what the click removes");
  assert.ok(sch.onPointerDown(ev(), [70, 63.55], ctx));
  let c = lastCommit(ctx); assert.strictEqual(c.label, "delete");
  assert.deepStrictEqual(c.changes.map((x) => [x.kind, x.id]).sort(), [["REMOVED", "j1"], ["REMOVED", "w2"]], "j1 only joined w1/w2/w3 at a T");
  assert.ok(/\(wire \(pts \(xy 63\.5 63\.5\) \(xy 76\.2 63\.5\)\)/.test(c.before[c.changes.findIndex((x) => x.id === "w2")]), "commit saw the untouched original for its undo record");
  assert.ok(!doc.items.has("w2") && !doc.items.has("j1"));
  assert.ok(sch.onPointerDown(ev(), [20.32, 35], ctx));            // the rectangle, by its left edge
  c = lastCommit(ctx); assert.deepStrictEqual(c.changes.map((x) => [x.kind, x.id, x.typeName]), [["REMOVED", ctx.tRect, "SCH_SHAPE"]]);
  assert.ok(sch.onPointerDown(ev(), [152.4, 138.5], ctx));         // the directive label, by its box
  c = lastCommit(ctx); assert.strictEqual(c.changes[0].id, ctx.tFlag);
  ctx.selected = { id: "s1" };
  assert.ok(sch.onPointerDown(ev(), [25.4, 100.33], ctx));         // R1's body: a symbol through K.hitTest
  c = lastCommit(ctx); assert.strictEqual(c.changes[0].typeName, "SCH_SYMBOL"); assert.strictEqual(c.changes[0].id, "s1");
  assert.ok(c.changes.some((x) => x.typeName === "SCH_JUNCTION"), "the junction that only marked the wire corner on its pin goes too");
  assert.strictEqual(ctx.selected, null, "app.js's selection is dropped with the item"); assert.ok(!doc.items.has("s1"));
  const before = ctx.log.length; assert.ok(sch.onPointerDown(ev(), [200, 200], ctx), "an empty click is still the tool's"); assert.strictEqual(ctx.log.length, before);
  assert.strictEqual(sch.state.tool, "delete");
  sch.onActivate("select", ctx);
});

// ---- connected drag (KiCad's sch_move_tool DRAG semantics) ----
function fresh() { const d = K.parseDoc(SHEET), c = makeCtx(d); sch.onDocChanged(c); sch.setDragMode(c, "drag"); sch.setLineMode(c, "90"); return { d, c }; }
function addR(doc, at) { return K.createItem(doc, _.symbolNode(doc, "Device:R", at, 0, "")); }
function addWire(doc, a, b) { return K.createItem(doc, _.lineNode("wire", a, b)); }
function dragItem(c, item, from, to) { assert.ok(_.beginDrag(c, item, from, true), "drag started"); _.moveDrag(c, to); _.endDrag(c, true); return lastCommit(c); }
const ofType = (c, t) => c.changes.filter((x) => x.typeName === t);
const linesOf = (c, kind) => ofType(c, "SCH_LINE").filter((x) => x.kind === kind).map((x) => ptsOf(fragItem(x)));

test("bendPath: 90° keeps the wire on its axis and adds the perpendicular bend; free stretches", () => {
  assert.deepStrictEqual(_.bendPath([0, 0], [10, 0], [10, 5], "90"), [[0, 0], [10, 0], [10, 5]]);
  assert.deepStrictEqual(_.bendPath([0, 0], [10, 0], [15, 5], "90"), [[0, 0], [15, 0], [15, 5]]);
  assert.deepStrictEqual(_.bendPath([0, 0], [10, 0], [0, 5], "90"), [[0, 0], [0, 5]], "collapsed run leaves just the bend");
  assert.deepStrictEqual(_.bendPath([0, 0], [10, 0], [12, 0], "90"), [[0, 0], [12, 0]], "on-axis drag just stretches");
  assert.deepStrictEqual(_.bendPath([0, 0], [0, 10], [5, 15], "90"), [[0, 0], [0, 15], [5, 15]]);
  assert.deepStrictEqual(_.bendPath([0, 0], [10, 0], [15, 5], "free"), [[0, 0], [15, 5]]);
  assert.deepStrictEqual(_.bendPath([0, 0], [10, 10], [15, 5], "90"), [[0, 0], [15, 5]], "a diagonal wire stretches");
  assert.deepStrictEqual(_.bendPath([0, 0], [10, 0], [15, 5], "45"), [[0, 0], [10, 0], [15, 5]], "45°: the jog leaves at 45°");
});

test("pin on pin (the GND case): dragging the symbol away spawns a wire between the two pins", () => {
  const { d, c } = fresh();
  const r2 = addR(d, [25.4, 107.95]);                              // pin 1 lands on R1's pin 2 at (25.4, 104.14)
  assert.ok(_.connPoints(d, r2).some((p) => p[0] === 25.4 && p[1] === 104.14));
  assert.ok(_.beginDrag(c, r2, [25.4, 107.95], true));
  _.moveDrag(c, [25.4, 115.57]);
  assert.deepStrictEqual(sch.state.drag.preview, [{ kind: "wire", pts: [[25.4, 104.14], [25.4, 111.76]] }], "the stub is previewed while dragging");
  assert.deepStrictEqual(atOf(r2.node).slice(0, 2), [25.4, 115.57], "live preview moves the symbol");
  _.endDrag(c, true);
  const cm = lastCommit(c); assert.strictEqual(cm.label, "drag");
  assert.ok(/\(at 25\.4 107\.95 0\)/.test(cm.before[cm.changes.findIndex((x) => x.id === r2.id)]), "original restored before commit (undo)");
  assert.deepStrictEqual(atOf(fragItem(cm.changes.find((x) => x.id === r2.id))).slice(0, 2), [25.4, 115.57]);
  assert.deepStrictEqual(linesOf(cm, "ADDED"), [[[25.4, 104.14], [25.4, 111.76]]]);
  assert.strictEqual(ofType(cm, "SCH_JUNCTION").length, 0);
  assert.ok(Array.from(d.items.values()).some((it) => it.kind === "wire" && ptsOf(it.node)[1][1] === 111.76), "wire applied to the document");
});

test("an unmoved press/release on a selected symbol leaves the next double click alone (opens properties)", () => {
  const { d, c } = fresh();
  const r2 = addR(d, [25.4, 107.95]);
  sch.state.dragEndedAt = 0;
  assert.ok(_.beginDrag(c, r2, [25.4, 107.95], true)); _.endDrag(c, true);
  assert.ok(!sch.state.dragEndedAt, "no drag-ended stamp without movement");
  assert.ok(_.beginDrag(c, r2, [25.4, 107.95], true)); _.moveDrag(c, [25.4, 115.57]); _.endDrag(c, true);
  assert.ok(sch.state.dragEndedAt > 0, "a real drag still swallows the dblclick that ends it");
  sch.state.dragEndedAt = 0;
  assert.ok(_.beginDrag(c, r2, [25.4, 115.57], false)); _.endDrag(c, true);
  assert.ok(sch.state.dragEndedAt > 0, "a key-started move (M) is still stamped");
  sch.state.dragEndedAt = 0;
});

test("move (M) is KiCad's plain move: the symbol goes, the connection is left behind", () => {
  const { d, c } = fresh();
  const r2 = addR(d, [25.4, 107.95]);
  sch.setDragMode(c, "move");
  assert.ok(_.beginDrag(c, r2, [25.4, 107.95], true)); _.moveDrag(c, [25.4, 115.57]);
  assert.deepStrictEqual(sch.state.drag.preview, []);
  _.endDrag(c, true);
  const cm = lastCommit(c); assert.strictEqual(cm.label, "move");
  assert.deepStrictEqual(cm.changes.map((x) => [x.kind, x.id]), [["MODIFIED", r2.id]]);
  assert.strictEqual(sch.state.dragMode, "move");
});

test("attached wire: 90° bends (wire stays on its axis + new bend segment), 45° jogs, free stretches diagonally", () => {
  let { d, c } = fresh();
  let w = addWire(d, [12.7, 96.52], [25.4, 96.52]);               // horizontal wire into R1 pin 1
  let cm = dragItem(c, d.items.get("s1"), [25.4, 100.33], [38.1, 113.03]);
  assert.deepStrictEqual(ptsOf(fragItem(cm.changes.find((x) => x.id === w.id))), [[12.7, 96.52], [38.1, 96.52]]);
  assert.deepStrictEqual(linesOf(cm, "ADDED"), [[[38.1, 96.52], [38.1, 109.22]]]);
  assert.strictEqual(ofType(cm, "SCH_JUNCTION").length, 0, "a corner needs no junction");
  ({ d, c } = fresh()); w = addWire(d, [12.7, 96.52], [25.4, 96.52]);
  sch.setLineMode(c, "45");
  cm = dragItem(c, d.items.get("s1"), [25.4, 100.33], [38.1, 113.03]);
  assert.deepStrictEqual(ptsOf(fragItem(cm.changes.find((x) => x.id === w.id))), [[12.7, 96.52], [25.4, 96.52]]);
  assert.deepStrictEqual(linesOf(cm, "ADDED"), [[[25.4, 96.52], [38.1, 109.22]]]);
  ({ d, c } = fresh()); w = addWire(d, [12.7, 96.52], [25.4, 96.52]);
  sch.setLineMode(c, "free");
  cm = dragItem(c, d.items.get("s1"), [25.4, 100.33], [38.1, 113.03]);
  assert.deepStrictEqual(ptsOf(fragItem(cm.changes.find((x) => x.id === w.id))), [[12.7, 96.52], [38.1, 109.22]]);
  assert.strictEqual(linesOf(cm, "ADDED").length, 0);
  assert.strictEqual(sch.cycleLineMode(c), "90");
});

test("junction under a pin: the wires stay put and the junction gets the stub wire", () => {
  const { d, c } = fresh();
  const r3 = addR(d, [63.5, 59.69]);                               // pin 2 on junction j1 (63.5, 63.5)
  const cm = dragItem(c, r3, [63.5, 59.69], [76.2, 46.99]);
  for (const id of ["w1", "w2", "w3", "j1"]) assert.ok(!cm.changes.some((x) => x.id === id), id + " untouched");
  assert.deepStrictEqual(linesOf(cm, "ADDED"), [[[63.5, 63.5], [76.2, 50.8]]]);
});

test("dragging the stem off a T drops the junction and merges the bar into one wire", () => {
  const { d, c } = fresh();
  const cm = dragItem(c, d.items.get("w3"), [63.5, 70], [76.2, 70]);
  const kinds = Object.fromEntries(cm.changes.map((x) => [x.id, x.kind]));
  assert.deepStrictEqual(kinds, { w3: "MODIFIED", j1: "REMOVED", w1: "MODIFIED", w2: "REMOVED" });
  assert.deepStrictEqual(ptsOf(fragItem(cm.changes.find((x) => x.id === "w3"))), [[76.2, 63.5], [76.2, 76.2]]);
  assert.deepStrictEqual(ptsOf(fragItem(cm.changes.find((x) => x.id === "w1"))), [[50.8, 63.5], [76.2, 63.5]]);
  assert.ok(!d.items.has("j1") && !d.items.has("w2"));
});

test("dropping a pin on the middle of a wire adds the junction KiCad would", () => {
  const { d, c } = fresh();
  const cm = dragItem(c, d.items.get("s1"), [25.4, 100.33], [133.35, 54.61]);   // pin 1 -> (133.35, 50.8) on w5
  const js = ofType(cm, "SCH_JUNCTION");
  assert.strictEqual(js.length, 1); assert.strictEqual(js[0].kind, "ADDED");
  assert.deepStrictEqual(atOf(fragItem(js[0])).slice(0, 2), [133.35, 50.8]);
});

test("a label dragged off a wire's middle splits the wire, takes a stub and gets a junction", () => {
  const { d, c } = fresh();
  const cm = dragItem(c, d.items.get("l1"), [55.88, 63.5], [55.88, 66.04]);
  assert.deepStrictEqual(atOf(fragItem(cm.changes.find((x) => x.id === "l1"))).slice(0, 2), [55.88, 66.04]);
  assert.deepStrictEqual(ptsOf(fragItem(cm.changes.find((x) => x.id === "w1"))), [[50.8, 63.5], [55.88, 63.5]]);
  assert.deepStrictEqual(linesOf(cm, "ADDED").sort(), [[[55.88, 63.5], [55.88, 66.04]], [[55.88, 63.5], [63.5, 63.5]]].sort());
  const js = ofType(cm, "SCH_JUNCTION").filter((x) => x.kind === "ADDED");
  assert.strictEqual(js.length, 1); assert.deepStrictEqual(atOf(fragItem(js[0])).slice(0, 2), [55.88, 63.5]);
});

test("no-connect flags follow the pin they sit on", () => {
  const { d, c } = fresh();
  const nc = K.createItem(d, _.noConnectNode([25.4, 104.14]));
  const cm = dragItem(c, d.items.get("s1"), [25.4, 100.33], [38.1, 100.33]);
  assert.deepStrictEqual(atOf(fragItem(cm.changes.find((x) => x.id === nc.id))).slice(0, 2), [38.1, 104.14]);
});

test("drag (G) of a wire segment: attached ends stretch, riders come along, Escape restores", () => {
  const d2 = K.parseDoc(SHEET), c2 = makeCtx(d2); sch.onDocChanged(c2);
  sch.select("w5"); sch.state.cursor = [130, 50.8];
  assert.ok(sch.onKey("g", {}, c2)); assert.ok(sch.state.drag && sch.state.dragMode === "drag");
  _.moveDrag(c2, [130, 53.4]);
  assert.deepStrictEqual(ptsOf(d2.items.get("w5").node), [[127, 53.34], [139.7, 53.34]], "live preview");
  assert.deepStrictEqual(ptsOf(d2.items.get("w6").node), [[139.7, 53.34], [139.7, 63.5]], "attached end follows, far end stays");
  assert.ok(sch.onKey("m", {}, c2), "M mid-drag switches to a plain move");
  assert.deepStrictEqual(ptsOf(d2.items.get("w6").node), [[139.7, 50.8], [139.7, 63.5]], "…and the attached end springs back");
  assert.ok(sch.onKey("g", {}, c2));
  _.endDrag(c2, true);
  const c = lastCommit(c2); assert.strictEqual(c.label, "drag");
  assert.ok(/\(xy 127 50\.8\)/.test(c.before[c.changes.findIndex((x) => x.id === "w5")]), "originals restored before commit, so undo is right");
  const w5 = fragItem(c.changes.find((x) => x.id === "w5")), w6 = fragItem(c.changes.find((x) => x.id === "w6"));
  assert.deepStrictEqual(ptsOf(w5), [[127, 53.34], [139.7, 53.34]]); assert.deepStrictEqual(ptsOf(w6), [[139.7, 53.34], [139.7, 63.5]]);
  // a label on the segment rides along; escape cancels cleanly
  sch.select("w1"); sch.state.cursor = [55, 63.5]; sch.onKey("g", {}, c2); _.moveDrag(c2, [55, 66.04]);
  assert.deepStrictEqual(atOf(d2.items.get("l1").node).slice(0, 2), [55.88, 66.04]);
  assert.deepStrictEqual(sch.state.drag.preview, [{ kind: "wire", pts: [[63.5, 63.5], [63.5, 66.04]] }], "the end junction stays and offers a stub");
  _.endDrag(c2, false); assert.deepStrictEqual(atOf(d2.items.get("l1").node).slice(0, 2), [55.88, 63.5]);
  assert.deepStrictEqual(ptsOf(d2.items.get("w1").node), [[50.8, 63.5], [63.5, 63.5]]);
});

test("wire tool honours the line mode: free draws straight legs, 45° adds the diagonal", () => {
  const { c } = fresh();
  sch.setLineMode(c, "free");
  sch.state.posture = false;
  sch.onActivate("wire", c); sch.onPointerDown(ev(), [152.4, 88.9], c); sch.onPointerMove(ev(), [165.1, 101.6], c); sch.onPointerDown(ev(), [165.1, 101.6], c);
  assert.deepStrictEqual(_.wirePoints(sch.state.wire), [[152.4, 88.9], [165.1, 101.6]]); assert.strictEqual(sch.state.wire.segs.length, 2, "free: one live segment");
  sch.setLineMode(c, "90");                                         // a mode change mid-draw adds the second live segment
  assert.strictEqual(sch.state.wire.segs.length, 3);
  sch.onPointerMove(ev(), [177.8, 114.3], c);
  assert.deepStrictEqual(_.wirePoints(sch.state.wire), [[152.4, 88.9], [165.1, 101.6], [177.8, 101.6], [177.8, 114.3]]);
  sch.setLineMode(c, "free"); assert.strictEqual(sch.state.wire.segs.length, 2, "and back to free drops it");
  _.cancelWire(c); sch.onActivate("select", c);
  sch.setLineMode(c, "45");
  sch.onActivate("wire", c); sch.onPointerDown(ev(), [152.4, 88.9], c); sch.onPointerMove(ev(), [177.8, 101.6], c); sch.onPointerDown(ev(), [177.8, 101.6], c);
  assert.deepStrictEqual(_.wirePoints(sch.state.wire), [[152.4, 88.9], [165.1, 88.9], [177.8, 101.6]], "straight run then 45°");
  assert.strictEqual(sch.state.wire.segs.length, 4, "45°: a click fixes both segments");
  assert.ok(sch.onKey("/", {}, c)); sch.onPointerMove(ev(), [203.2, 114.3], c);   // posture: diagonal first
  assert.deepStrictEqual(_.wirePoints(sch.state.wire).slice(2), [[177.8, 101.6], [190.5, 114.3], [203.2, 114.3]]);
  sch.state.posture = false; _.cancelWire(c); sch.onActivate("select", c);
  sch.setLineMode(c, "90");
});

test("leaving the tool keeps the fixed segments; view-only ignores editing keys", () => {
  const d3 = K.parseDoc(SHEET), c3 = makeCtx(d3); sch.onDocChanged(c3);
  sch.onActivate("wire", c3); sch.onPointerDown(ev(), [10.16, 10.16], c3); sch.onPointerDown(ev(), [20.32, 10.16], c3);
  c3.toasts.length = 0; assert.ok(sch.onKey("l", {}, c3)); assert.deepStrictEqual(c3.toasts, ["Press <ESC> to cancel drawing."], "another tool's hotkey is refused");
  assert.strictEqual(sch.state.tool, "wire"); assert.strictEqual(c3.log.length, 0);
  sch.onPointerMove(ev(), [20.32, 20.32], c3); assert.ok(sch.onKey("w", {}, c3), "the tool's own hotkey is a click at the cursor");
  assert.strictEqual(sch.state.wire.segs.length, 4); assert.ok(sch.onKey("End", {}, c3));
  assert.strictEqual(c3.log.length, 1); assert.strictEqual(sch.state.wire, null);
  sch.onActivate("select", c3);
  c3.viewOnly = true; assert.strictEqual(sch.onKey("w", {}, c3), false);
});

// ---- sheets, sheet pins, tables, curves, polygons, rule areas, images, net highlighting, multi-item drag ----
test("sheet pin: a click near a sheet border prompts for the name; the pin lands on the nearest edge with KiCad's side rotation/justify, as a MODIFIED sheet", () => {
  const { d, c } = fresh();
  const sheet = K.createItem(d, _.sheetNode([101.6, 88.9], [127, 101.6], "Power", "Power.kicad_sch"));
  sheet.node.push(["instances", ["project", "t", ["path", "/root-uuid", ["page", "2"]]]]);
  sch.onActivate("sheetpin", c);
  sch.onPointerMove(ev(), [102, 95.3], c); assert.strictEqual(sch.state.hover, sheet.id, "hover shows the sheet whose border is near");
  c.toasts.length = 0; assert.ok(sch.onPointerDown(ev(), [60, 60], c)); assert.ok(c.toasts.some((m) => /border of a sheet/.test(m)));
  sch.setPrompt((title, initial, client, done) => { assert.strictEqual(title, "Sheet pin"); done("VBUS"); });
  assert.ok(sch.onPointerDown(ev(), [102.2, 95.1], c));              // left edge; y snaps to the grid
  const cm = lastCommit(c); assert.strictEqual(cm.label, "sheet pin"); assert.deepStrictEqual(cm.changes.map((x) => [x.kind, x.id, x.typeName]), [["MODIFIED", sheet.id, "SCH_SHEET"]]);
  assert.ok(!/\(pin /.test(cm.before[0]), "commit saw the sheet without the pin (its undo record)");
  const n = fragItem(cm.changes[0]), pins = kids(n, "pin"); assert.strictEqual(pins.length, 1);
  assert.deepStrictEqual(pins[0].slice(0, 4), ["pin", "VBUS", "input", ["at", 101.6, 95.25, 180]]); assert.strictEqual(pins[0][4][0], "uuid");
  assert.deepStrictEqual(pins[0][5], ["effects", ["font", ["size", 1.27, 1.27]], ["justify", "left"]]); assert.strictEqual(pins[0].length, 6);
  const at = (k) => n.findIndex((x) => Array.isArray(x) && x[0] === k);
  assert.ok(at("property") < at("pin") && at("pin") < at("instances"), "fields, then pins, then instance data — saveSheet's order");
  assert.ok(/\(page "2"\)/.test(cm.changes[0].sexpr), "page numbers stay quoted (the desktop parser wants a symbol)");
  assert.strictEqual(kids(d.items.get(sheet.id).node, "pin").length, 1, "applied");
  assert.deepStrictEqual(_.connPoints(d, d.items.get(sheet.id)), [[101.6, 95.25]], "the pin is a connection point");
  // every side: right 0/right, top 90/right, left 180/left, bottom 270/left; the free coordinate is clamped to the edge
  const edge = (p) => _.sheetEdgeAt(d, p, 2);
  assert.strictEqual(edge([127.2, 95]).side, "right"); assert.deepStrictEqual(_.sheetPinPoint(c, edge([127.2, 95]), [127.2, 95]), [127, 95.25]);
  assert.strictEqual(edge([110, 88.7]).side, "top"); assert.deepStrictEqual(_.sheetPinPoint(c, edge([110, 88.7]), [110, 88.7]), [110.49, 88.9]);
  assert.strictEqual(edge([110, 101.8]).side, "bottom"); assert.deepStrictEqual(_.sheetPinPoint(c, edge([110, 101.8]), [110, 140]), [110.49, 101.6]);
  assert.deepStrictEqual(_.sheetPinPoint(c, edge([101.5, 90]), [101.5, 10]), [101.6, 88.9], "clamped to the edge");
  assert.strictEqual(edge([114, 95]), null, "the middle of the sheet is not its border");
  for (const [side, rot, just] of [["right", 0, "right"], ["top", 90, "right"], ["left", 180, "left"], ["bottom", 270, "left"]]) {
    const p = _.sheetPinNode("A", [1, 2], side); assert.deepStrictEqual([atOf(p)[2], kid(kid(p, "effects"), "justify")[1]], [rot, just], side);
  }
});

test("table: SCH_DRAWING_TOOLS::DrawTable sizes rows and columns from the drag; KiCad's (table …) with border/separator strokes, widths, heights, uuid, then the cells", () => {
  const { d, c } = fresh();
  sch.onActivate("table", c);
  sch.onPointerDown(ev(), [25.4, 25.4], c); sch.onPointerMove(ev(), [40, 30], c); assert.deepStrictEqual(sch.state.draw.cur, [39.37, 30.48]);
  // a 38.1 x 10.16 drag: one column per 15 text heights (19.05), one row per 2 (2.54)
  sch.onPointerDown(ev(), [63.5, 35.56], c);
  const cm = lastCommit(c); assert.strictEqual(cm.label, "Draw Table"); assert.strictEqual(cm.changes[0].typeName, "SCH_TABLE"); assert.strictEqual(cm.changes[0].kind, "ADDED");
  const n = fragItem(cm.changes[0]);
  assert.deepStrictEqual(n.slice(0, 6), ["table", ["column_count", 2], ["border", ["external", "yes"], ["header", "yes"], STROKE0], ["separators", ["rows", "yes"], ["cols", "yes"], STROKE0], ["column_widths", 19.05, 19.05], ["row_heights", 2.54, 2.54, 2.54, 2.54]]);
  assert.strictEqual(n[6][0], "uuid"); assert.strictEqual(n[7][0], "cells"); assert.strictEqual(n.length, 8);
  const cells = kids(n[7], "table_cell"); assert.strictEqual(cells.length, 8);
  assert.deepStrictEqual(cells[3].slice(0, 9), ["table_cell", "", ["exclude_from_sim", "no"], ["at", 44.45, 27.94, 0], ["size", 19.05, 2.54], ["margins", 0.9525, 0.9525, 0.9525, 0.9525], ["span", 1, 1], FILL_NONE, ["effects", ["font", ["size", 1.27, 1.27]], ["justify", "left", "top"]]]);
  assert.strictEqual(cells[3][9][0], "uuid"); assert.strictEqual(cells[3].length, 10);
  assert.ok(/\(table_cell "" /.test(cm.changes[0].sexpr), "empty cell text is a quoted string");
  assert.ok(d.items.get(cm.changes[0].id)); assert.strictEqual(sch.state.draw, null); assert.strictEqual(sch.state.tool, "table");
  const t2 = _.tableNode([0, 0], [1, 1], 1, 1, 1.27); assert.deepStrictEqual([kid(t2, "column_widths")[1], kid(t2, "row_heights")[1]], [6.35, 2.54], "5 × 2 grid steps minimum");
  // a click on the first point, or a drag up / left, is still one minimum cell from the first click
  assert.deepStrictEqual(_.drawTableSize([10, 10], [10, 10], 1.27), { rows: 1, cols: 1, cw: 6.35, ch: 2.54 });
  assert.deepStrictEqual(_.drawTableSize([10, 10], [0, 0], 1.27), { rows: 1, cols: 1, cw: 6.35, ch: 2.54 });
  assert.deepStrictEqual(_.drawTableSize([0, 0], [60, 8], 1.27), { rows: 3, cols: 3, cw: 20.32, ch: 2.54 });
  assert.deepStrictEqual(kid(_.drawTableNode([0, 0], [60, 8], 1.27), "column_widths"), ["column_widths", 20.32, 20.32, 20.32]);
  // the dialog decides when the editor provides it: Cancel adds nothing
  const before = c.log.length; globalThis.CollabTableCells = { newSchTableDialog(ctx, node, done) { assert.strictEqual(node[0], "table"); done(null); return true; } };
  try { sch.onPointerDown(ev(), [10.16, 10.16], c); sch.onPointerDown(ev(), [20.32, 20.32], c); } finally { delete globalThis.CollabTableCells; }
  assert.strictEqual(c.log.length, before, "Cancel places nothing"); assert.strictEqual(sch.state.draw, null);
});

test("table rotate: SCH_TABLE::Rotate turns every cell about the pivot, swaps the text angle, then Normalize; mirror leaves it alone", () => {
  const t = _.tableNode([10.16, 20.32], [50.8, 25.4], 2, 2, 1.27);   // 2 x 2, columns 20.32, rows 2.54
  const at = (n, i) => kid(kids(kid(n, "cells"), "table_cell")[i], "at").slice(1), size = (n, i) => kid(kids(kid(n, "cells"), "table_cell")[i], "size").slice(1);
  const n = JSON.parse(JSON.stringify(t)); const C = [30.48, 22.86];
  assert.ok(_.transformNode("table", n, "ccw", C) !== false);
  // cell 0 starts at (10.16, 20.32): turned 90° CCW about C it starts at (C.x + dy, C.y - dx) = (27.94, 43.18), text vertical
  assert.deepStrictEqual(at(n, 0), [27.94, 43.18, 90]);
  assert.deepStrictEqual(size(n, 0), [2.54, -20.32], "end - start: the row height across, the column width up");
  assert.deepStrictEqual(at(n, 1), [27.94, 22.86, 90], "the next column goes up the sheet");
  assert.deepStrictEqual(at(n, 2), [30.48, 43.18, 90], "the next row goes right");
  assert.deepStrictEqual(kid(n, "column_widths").slice(1), [20.32, 20.32]); assert.deepStrictEqual(kid(n, "row_heights").slice(1), [2.54, 2.54]);
  const back = JSON.parse(JSON.stringify(n)); assert.ok(_.transformNode("table", back, "cw", C) !== false);
  assert.deepStrictEqual(back, t, "CW undoes CCW exactly");
  const m = JSON.parse(JSON.stringify(t)); assert.strictEqual(_.transformNode("table", m, "y", C), false); assert.deepStrictEqual(m, t, "mirror: nothing changes");
});

test("bezier: start, control 1, end, then the far handle (BEZIER_GEOM_MANAGER); control 2 is the handle reflected over the end", () => {
  const { d, c } = fresh();
  sch.onActivate("bezier", c);
  sch.onPointerDown(ev(), [25.4, 50.8], c); sch.onPointerDown(ev(), [30.48, 38.1], c);
  c.toasts.length = 0; sch.onPointerDown(ev(), [25.4, 50.8], c); assert.ok(c.toasts.length && sch.state.draw.pts.length === 2, "the end may not coincide with the start");
  sch.onPointerDown(ev(), [50.8, 50.8], c); assert.strictEqual(sch.state.draw.pts.length, 3);
  sch.onPointerDown(ev(), [55.88, 63.5], c);
  const cm = lastCommit(c); assert.strictEqual(cm.label, "bezier"); assert.strictEqual(cm.changes[0].typeName, "SCH_SHAPE");
  const n = fragItem(cm.changes[0]);
  assert.deepStrictEqual(n.slice(0, 4), ["bezier", ["pts", ["xy", 25.4, 50.8], ["xy", 30.48, 38.1], ["xy", 45.72, 38.1], ["xy", 50.8, 50.8]], STROKE0, FILL_NONE]);
  assert.strictEqual(n[4][0], "uuid"); assert.strictEqual(n.length, 5);
  const it = d.items.get(cm.changes[0].id); assert.strictEqual(it.kind, "bezier"); assert.ok(it.geom[0].t === "poly" && it.geom[0].pts.length > 4, "the canvas flattens the curve");
  assert.strictEqual(sch.state.draw, null); assert.strictEqual(sch.state.tool, "bezier");
  assert.strictEqual(_.hitNonSymbol(d, 38.1, 41.275, 0.3).id, it.id, "picked along the curve (its midpoint)");
  const dm = dragItem(c, it, [25.4, 50.8], [38.1, 50.8]); assert.deepStrictEqual(ptsOf(fragItem(dm.changes[0]))[0], [38.1, 50.8], "drags by its points");
});

test("polygon: points close back onto the first one (the file repeats it); Enter closes too; fewer than three points is nothing", () => {
  const { d, c } = fresh();
  sch.onActivate("polygon", c);
  for (const p of [[25.4, 25.4], [38.1, 25.4], [38.1, 38.1]]) sch.onPointerDown(ev(), p, c);
  sch.onPointerDown(ev(), [25.4, 25.4], c);                          // back on the first point
  let cm = lastCommit(c); assert.strictEqual(cm.label, "polygon");
  let n = fragItem(cm.changes[0]);
  assert.deepStrictEqual(n.slice(0, 4), ["polyline", ["pts", ["xy", 25.4, 25.4], ["xy", 38.1, 25.4], ["xy", 38.1, 38.1], ["xy", 25.4, 25.4]], STROKE0, FILL_NONE]); assert.strictEqual(n[4][0], "uuid");
  assert.strictEqual(d.items.get(cm.changes[0].id).kind, "polyline"); assert.strictEqual(sch.state.draw, null); assert.strictEqual(sch.state.tool, "polygon");
  for (const p of [[50.8, 25.4], [63.5, 25.4], [63.5, 38.1], [50.8, 38.1]]) sch.onPointerDown(ev(), p, c);
  assert.ok(sch.onKey("Enter", {}, c)); n = fragItem(lastCommit(c).changes[0]); assert.strictEqual(ptsOf(n).length, 5); assert.deepStrictEqual(ptsOf(n)[4], [50.8, 25.4]);
  const before = c.log.length; sch.onPointerDown(ev(), [76.2, 25.4], c); sch.onPointerDown(ev(), [88.9, 25.4], c); assert.ok(sch.onKey("Enter", {}, c));
  assert.strictEqual(c.log.length, before, "two points make no polygon"); assert.strictEqual(sch.state.draw, null);
});

test("rule area: a closed polygon as (rule_area (polyline …)) — dashed, the uuid inside the polyline, no repeated point; drags and deletes keep that shape", () => {
  const { d, c } = fresh();
  sch.onActivate("rulearea", c);
  for (const p of [[152.4, 25.4], [165.1, 25.4], [165.1, 38.1], [152.4, 38.1]]) sch.onPointerDown(ev(), p, c);
  sch.onPointerDown(ev(), [152.4, 38.1], c);                         // a click on the last point ends it
  const cm = lastCommit(c); assert.strictEqual(cm.label, "rule area"); assert.strictEqual(cm.changes[0].typeName, "SCH_RULE_AREA"); assert.strictEqual(cm.changes[0].kind, "ADDED");
  const n = fragItem(cm.changes[0]);
  assert.deepStrictEqual(n.slice(0, 5), ["rule_area", ["exclude_from_sim", "no"], ["in_bom", "yes"], ["on_board", "yes"], ["dnp", "no"]]);
  const pl = n[5]; assert.strictEqual(n.length, 6);
  assert.deepStrictEqual(pl.slice(0, 4), ["polyline", ["pts", ["xy", 152.4, 25.4], ["xy", 165.1, 25.4], ["xy", 165.1, 38.1], ["xy", 152.4, 38.1]], ["stroke", ["width", 0], ["type", "dash"]], FILL_NONE]);
  assert.strictEqual(pl[4][0], "uuid"); assert.strictEqual(K.uuidOf(pl), cm.changes[0].id, "the change id is the polyline's uuid"); assert.strictEqual(kid(n, "uuid"), null, "no uuid on the rule_area itself");
  const it = d.items.get(cm.changes[0].id); assert.ok(it && it.kind === "rule_area"); assert.ok(it.geom[0].t === "poly" && it.geom[0].close);
  const dm = dragItem(c, it, [152.4, 30], [165.1, 30]);
  assert.strictEqual(dm.changes[0].id, it.id); const moved = fragItem(dm.changes[0]);
  assert.strictEqual(kid(moved, "uuid"), null, "the canvas's direct uuid is stripped again"); assert.deepStrictEqual(ptsOf(kid(moved, "polyline"))[0], [165.1, 25.4]);
  sch.onActivate("delete", c); assert.ok(sch.onPointerDown(ev(), [165.1, 30], c));
  assert.deepStrictEqual(lastCommit(c).changes.map((x) => [x.kind, x.id, x.typeName]), [["REMOVED", it.id, "SCH_RULE_AREA"]]); assert.ok(!d.items.has(it.id));
});

const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
test("image: the picked file rides on the cursor and lands as (image (at) (uuid) (data …)) in 76-column base64", () => {
  const { d, c } = fresh();
  let asked = 0; sch.setImagePicker((ctx, done) => { asked++; done({ name: "dot.png", base64: PNG_1x1 }); });
  sch.onActivate("image", c); assert.strictEqual(asked, 1);
  assert.ok(sch.state.carry && sch.state.carry.kind === "image"); assert.deepStrictEqual(sch.state.carry.size.map((v) => +v.toFixed(4)), [0.0847, 0.0847], "1 px at 300 PPI");
  sch.onPointerMove(ev(), [50.9, 76.1], c); assert.deepStrictEqual(atOf(sch.state.carry.node).slice(0, 2), [50.8, 76.2]);
  assert.ok(sch.onPointerDown(ev(), [50.9, 76.1], c));
  const cm = lastCommit(c); assert.strictEqual(cm.label, "image"); assert.strictEqual(cm.changes[0].typeName, "SCH_BITMAP");
  const n = fragItem(cm.changes[0]);
  assert.deepStrictEqual(n.slice(0, 2), ["image", ["at", 50.8, 76.2]]); assert.strictEqual(n[2][0], "uuid"); assert.strictEqual(n[3][0], "data"); assert.strictEqual(n.length, 4);
  assert.strictEqual(kid(n, "scale"), null, "scale 1 is not written (saveBitmap)");
  assert.strictEqual(_.imageData(n), PNG_1x1); assert.ok(n[3].slice(1).every((s) => s.length <= 76));
  assert.ok(d.items.get(cm.changes[0].id)); assert.strictEqual(sch.state.carry, null); assert.strictEqual(sch.state.sel, cm.changes[0].id);
  assert.deepStrictEqual(_.imageSize(_.base64ToBytes(PNG_1x1)), [1, 1]);
  const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xFF, 0xC0, 0, 17, 8, 0x01, 0x2C, 0x02, 0x58, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  assert.deepStrictEqual(_.imageSize(jpeg), [600, 300], "JPEG SOF0 width/height");
  assert.strictEqual(_.bytesToBase64(_.base64ToBytes(PNG_1x1)), PNG_1x1);
  const big = _.imageNode([0, 0], "A".repeat(200)); assert.deepStrictEqual(kid(big, "data").slice(1).map((s) => s.length), [76, 76, 48]);
  assert.ok(sch.onPointerDown(ev(), [60, 60], c)); assert.strictEqual(asked, 2, "the next click asks for a file again");
  sch.setImagePicker((ctx, done) => done(null)); sch.onActivate("select", c);
});

test("highlight net: wires, junctions, labels, pins and bus entries on one net; net labels, global labels and power symbols join by name", () => {
  const { d, c } = fresh();
  const ids = (it, near) => Array.from(sch.netItems(d, it, near)).sort();
  assert.deepStrictEqual(ids(d.items.get("w1")), ["j1", "l1", "w1", "w2", "w3"], "a T of three wires, its junction and the label on w1");
  assert.deepStrictEqual(ids(d.items.get("w4")), ["w4"]);
  const l2 = K.createItem(d, _.labelNode("label", "NETA", [133.35, 50.8], 0));       // on the middle of w5
  const netA = ["j1", "l1", l2.id, "w1", "w2", "w3", "w5", "w6"].sort();
  assert.deepStrictEqual(ids(d.items.get("w6")), netA, "same-name net labels join across the sheet");
  const wa = addWire(d, [12.7, 96.52], [25.4, 96.52]), wb = addWire(d, [25.4, 104.14], [38.1, 104.14]);   // R1's pins 1 and 2
  assert.deepStrictEqual(ids(wa), ["s1", wa.id].sort(), "a wire into a pin reaches the symbol, not the other pin's wire");
  assert.deepStrictEqual(ids(d.items.get("s1"), [25.4, 96.52]), ["s1", wa.id].sort()); assert.deepStrictEqual(ids(d.items.get("s1"), [25.4, 104.14]), ["s1", wb.id].sort());
  const bus = K.createItem(d, _.lineNode("bus", [203.2, 25.4], [215.9, 25.4])), be = K.createItem(d, _.busEntryNode([203.2, 25.4], 2.54, 2.54));
  const wc = addWire(d, [205.74, 27.94], [220, 27.94]), wd = addWire(d, [215.9, 25.4], [215.9, 40]);
  assert.deepStrictEqual(ids(wc), [wc.id, be.id, bus.id].sort(), "a bus entry bridges wire and bus"); assert.deepStrictEqual(ids(wd), [wd.id], "a wire end on a bus end does not connect");
  d.lib.set("power:GND", K.parse(LIB_SYM("power:GND", "#PWR", "(power)")));
  const gnd = K.createItem(d, _.symbolNode(d, "power:GND", [50.8, 127], 0, "")), gl = K.createItem(d, _.labelNode("global_label", "GND", [76.2, 127], 0)), we = addWire(d, [76.2, 127], [88.9, 127]);
  assert.deepStrictEqual(ids(gnd), [gnd.id, gl.id, we.id].sort(), "power symbol value = global label name");
  const sheet = K.createItem(d, _.sheetNode([101.6, 88.9], [127, 101.6], "Sub", "Sub.kicad_sch")); _.placeSheetPin(c, sheet, "IN", [101.6, 95.25], "left");
  const wf = addWire(d, [88.9, 95.25], [101.6, 95.25]);
  assert.deepStrictEqual(ids(wf), [wf.id, sheet.id].sort(), "sheet pins connect");
  // the tool: a click reports the net through ctx.setHighlight; empty space, Escape and a document switch clear it
  const seen = []; c.setHighlight = (s) => seen.push(s ? Array.from(s).sort() : null);
  sch.onActivate("highlight", c);
  sch.onPointerMove(ev(), [70, 63.55], c); assert.strictEqual(sch.state.hover, "w2");
  assert.ok(sch.onPointerDown(ev(), [70, 63.55], c)); assert.deepStrictEqual(seen[0], netA); assert.deepStrictEqual(Array.from(sch.state.highlight).sort(), netA);
  assert.ok(sch.onPointerDown(ev(), [25.4, 96.52], c)); assert.deepStrictEqual(seen[1], ["s1", wa.id].sort(), "a pin picks that pin's net");
  assert.ok(sch.onPointerDown(ev(), [150, 150], c)); assert.strictEqual(seen[2], null); assert.strictEqual(sch.state.highlight, null);
  sch.onPointerDown(ev(), [70, 63.55], c); assert.ok(sch.state.highlight);
  sch.onDocChanged(c); assert.ok(sch.state.highlight, "an edit of the same sheet keeps it");
  const other = makeCtx(K.parseDoc(SHEET)); sch.onDocChanged(other); assert.strictEqual(sch.state.highlight, null, "another sheet clears it"); sch.onDocChanged(c);
  sch.onActivate("select", c); c.cursor = [25.4, 96.52];
  assert.ok(sch.onKey("`", {}, c)); assert.strictEqual(sch.state.tool, "select", "` highlights at once, without a tool");
  assert.deepStrictEqual(Array.from(sch.state.highlight).sort(), ["s1", wa.id].sort());
});

test("multi-item drag: an array moves together — the wire between two moved pins just moves, outside wires stretch, one commit", () => {
  const { d, c } = fresh();
  const ra = addR(d, [152.4, 101.6]), rb = addR(d, [152.4, 127]);                  // ra pin 2 (152.4, 105.41), rb pin 1 (152.4, 123.19)
  const between = addWire(d, [152.4, 105.41], [152.4, 123.19]), feed = addWire(d, [139.7, 97.79], [152.4, 97.79]);   // feed into ra pin 1
  assert.ok(sch.beginDrag(c, [ra, rb, between, between], [152.4, 101.6], true));
  assert.deepStrictEqual(sch.state.drag.items.map((e) => e.item.id).sort(), [ra.id, rb.id, between.id].sort(), "duplicates collapse");
  _.moveDrag(c, [165.1, 101.6]);
  assert.deepStrictEqual(sch.state.drag.preview, [], "no stub between two moved pins");
  assert.deepStrictEqual(ptsOf(between.node), [[165.1, 105.41], [165.1, 123.19]], "live preview moves the spanning wire whole");
  assert.deepStrictEqual(ptsOf(feed.node), [[139.7, 97.79], [165.1, 97.79]], "the feed stretches on its axis");
  _.endDrag(c, true);
  const cm = lastCommit(c); assert.strictEqual(cm.label, "drag");
  assert.deepStrictEqual(Object.fromEntries(cm.changes.map((x) => [x.id, x.kind])), { [ra.id]: "MODIFIED", [rb.id]: "MODIFIED", [between.id]: "MODIFIED", [feed.id]: "MODIFIED" });
  assert.deepStrictEqual(atOf(fragItem(cm.changes.find((x) => x.id === rb.id))).slice(0, 2), [165.1, 127]);
  assert.deepStrictEqual(ptsOf(fragItem(cm.changes.find((x) => x.id === between.id))), [[165.1, 105.41], [165.1, 123.19]]);
  assert.ok(/\(at 152\.4 127 0\)/.test(cm.before[cm.changes.findIndex((x) => x.id === rb.id)]), "originals restored before commit (undo)");
  assert.deepStrictEqual(ptsOf(d.items.get(feed.id).node), [[139.7, 97.79], [165.1, 97.79]], "applied");
  // a wire spanning two dragged symbols is promoted into the move even when it is not selected
  const { d: d2, c: c2 } = fresh();
  const xa = addR(d2, [152.4, 101.6]), xb = addR(d2, [152.4, 127]), mid = addWire(d2, [152.4, 105.41], [152.4, 123.19]);
  assert.ok(sch.beginDrag(c2, [xa, xb], [152.4, 101.6], true)); assert.ok(sch.state.drag.items.some((e) => e.item === mid));
  _.moveDrag(c2, [152.4, 114.3]); _.endDrag(c2, true);
  const c2m = lastCommit(c2); assert.deepStrictEqual(ptsOf(fragItem(c2m.changes.find((x) => x.id === mid.id))), [[152.4, 118.11], [152.4, 135.89]]);
  assert.strictEqual(c2m.changes.filter((x) => x.kind === "ADDED").length, 0);
  assert.ok(sch.beginDrag(c2, xa, [152.4, 114.3], true)); assert.strictEqual(sch.state.drag.items.length, 1); assert.strictEqual(sch.state.drag.item, xa); _.endDrag(c2, false);
  assert.strictEqual(sch.beginDrag(c2, [], [0, 0], true), null);
});

test("deleteChanges([...]) on the module: REMOVED for every item plus the junctions only they justified; the document is untouched", () => {
  const { d } = fresh();
  const ch = sch.deleteChanges(d, [d.items.get("w1"), d.items.get("w2")]);
  assert.deepStrictEqual(ch.map((x) => [x.kind, x.id]).sort(), [["REMOVED", "j1"], ["REMOVED", "w1"], ["REMOVED", "w2"]].sort(), "w3 alone at the T needs no junction");
  assert.ok(ch.every((x) => x.typeName && x.properties));
  assert.deepStrictEqual(sch.deleteChanges(d, [d.items.get("s1"), d.items.get("s1")]).map((x) => x.id), ["s1"], "duplicates collapse");
  assert.deepStrictEqual(sch.deleteChanges(d, d.items.get("l1")).map((x) => x.id), ["l1"], "a single item still works");
  assert.ok(d.items.has("w1") && d.items.has("w2") && d.items.has("j1"), "nothing applied");
});

// ---- the command map: clipboard, select connection, repeat, conversions, autoplace, annotation, ERC, swap / align / move exactly, group transforms, fields table, bus unfolding ----
const A = sch.actions;
const symAt = (c, x, y) => { const n = _.symbolNode(c.doc, "Device:R", [x, y], 0, ""); return K.createItem(c.doc, n); };
const LIB_PIN = (name, ref, type, extra) => `(symbol "${name}" ${extra || ""} (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
  (property "Reference" "${ref}" (at 0 -2.54 0) (effects (font (size 1.27 1.27)))) (property "Value" "${name.split(":")[1]}" (at 0 2.54 0) (effects (font (size 1.27 1.27))))
  (symbol "${name.split(":")[1]}_0_1" (rectangle (start 2.54 -1.27) (end 5.08 1.27) (stroke (width 0.254) (type default)) (fill (type none))))
  (symbol "${name.split(":")[1]}_1_1" (pin ${type} line (at 0 0 0) (length 2.54) (name "P" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))`;
function place(c, lib, at, ref) { const n = _.symbolNode(c.doc, lib, at, 0, ""); if (ref) _.setReference(n, ref); return K.createItem(c.doc, n); }

test("actions map: stable ids with KiCad's labels and default hotkeys; every entry runs through runAction", () => {
  const want = { cut: "Ctrl+X", copy: "Ctrl+C", paste: "Ctrl+V", pasteSpecial: "Ctrl+Shift+V", duplicate: "Ctrl+D", copyAsText: "Ctrl+Shift+C", unselectAll: "Ctrl+Shift+A", selectConnection: "Ctrl+4", selectNode: "Alt+3",
    repeatLast: "Insert", autoplace: "O", editReference: "U", editValue: "V", editFootprint: "F", swap: "Alt+S", unfoldBus: "C", rotateSelection: "R", rotateSelectionCW: "Shift+R", mirrorSelectionX: "X", mirrorSelectionY: "Y",
    highlightNet: "`", clearHighlight: "~", nextNetItem: "Tab", previousNetItem: "Shift+Tab", showDatasheet: "D" };
  for (const [id, key] of Object.entries(want)) { assert.ok(A[id], id + " exists"); assert.strictEqual(A[id].key, key, id + " hotkey"); assert.strictEqual(A[id].id, id); }
  for (const id of ["toLabel", "toGLabel", "toHLabel", "toText", "toTextBox", "toDLabel", "annotate", "clearAnnotation", "runERC", "alignToGrid", "moveExactly", "fieldsTable", "breakWire", "alignTop", "alignCenterX", "setDNP", "nextUnit", "cycleBodyStyle", "syncSheetPins", "cleanupSheetPins", "toggleAnnotateAuto", "increment"])
    assert.ok(A[id] && typeof A[id].run === "function" && A[id].label, id);
  assert.deepStrictEqual([A.toLabel.label, A.autoplace.label, A.selectConnection.label, A.fieldsTable.label, A.runERC.label], ["Change to Label", "Autoplace Fields", "Select/Expand Connection", "Symbol Fields Table...", "Electrical Rules Checker"]);
  assert.strictEqual(sch.runAction("nope", makeCtx(K.parseDoc(SHEET))), false);
  const { c } = fresh(); c.viewOnly = true; c.selected = { id: "s1" }; assert.strictEqual(sch.runAction("cut", c), false); assert.ok(c.toasts.some((m) => /View-only/.test(m)));
});

test("copy: the desktop's clipboard format — (lib_symbols …) then the items, no wrapper; the document form on request", () => {
  const { d, c } = fresh();
  c.selection = new Set(["s1", "w1", "l1"]);
  assert.ok(sch.runAction("copy", c));
  const text = c.clip; assert.ok(text.startsWith("(lib_symbols (symbol \"Device:R"), text.slice(0, 60));
  const trees = K.parseAll(text); assert.deepStrictEqual(trees.map((t) => t[0]), ["lib_symbols", "symbol", "wire", "label"]);
  assert.strictEqual(K.uuidOf(trees[1]), "s1", "copied items keep their identity on the clipboard (paste renews it)");
  const wrapped = sch.clipboardText(d, [d.items.get("l1")], { wrap: true });
  assert.ok(/^\(kicad_sch \(version 20250114\) \(generator "kicad-collab-web"\) \(generator_version "9\.0"\)\n\(label "NETA"/.test(wrapped), wrapped);
  assert.deepStrictEqual(K.parseDoc(wrapped).items.get("l1").kind, "label");
  const parsed = sch.parseClipboard(text); assert.strictEqual(parsed.nodes.length, 3); assert.strictEqual(parsed.libs.length, 1);
  assert.strictEqual(sch.parseClipboard("hello world"), null); assert.strictEqual(sch.parseClipboard(""), null);
  c.selection.clear(); c.selected = null; sch.select(null); c.toasts.length = 0; assert.strictEqual(sch.runAction("copy", c), false); assert.deepStrictEqual(c.toasts, [], "KiCad says nothing");
});

test("paste: fresh uuids, no instances, offset to the snapped cursor, junction cleanup, R? unless the reference is free, selection handed back", () => {
  const { d: src, c: cs } = fresh();
  cs.selection = new Set(["s1", "w1", "l1"]); sch.runAction("copy", cs);
  const { d, c } = fresh(); sch.state.annotateAuto = true;
  c.clip = cs.clip; c.cursor = [101.7, 127.1]; const before = d.items.size;
  assert.ok(sch.runAction("paste", c));
  const cm = lastCommit(c); assert.strictEqual(cm.label, "paste");
  const added = cm.changes.filter((x) => x.kind === "ADDED"); assert.strictEqual(added.length, 3); assert.strictEqual(d.items.size, before + 3);
  const sym = added.find((x) => x.typeName === "SCH_SYMBOL"), sn = fragItem(sym);
  assert.notStrictEqual(sym.id, "s1"); assert.ok(kids(sn, "pin").every((p) => !["p1", "p2"].includes(K.uuidOf(p))), "pins renewed"); assert.strictEqual(kid(sn, "instances"), null);
  assert.deepStrictEqual(atOf(sn).slice(0, 2), [101.6, 127], "the symbol's anchor lands on the snapped cursor");
  assert.strictEqual(kids(sn, "property")[0][2], "R2", "R1 already lives on the sheet: automatic annotation (on by default) picks the next free number");
  assert.ok(sym.sexpr.includes("(lib_symbols (symbol \"Device:R"), "fragment embeds the library symbol");
  const wire = fragItem(added.find((x) => x.typeName === "SCH_LINE")); assert.deepStrictEqual(ptsOf(wire), [[127, 90.17], [139.7, 90.17]], "everything else keeps its offset from the symbol (76.2, 26.67)");
  const lab = fragItem(added.find((x) => x.typeName === "SCH_LABEL")); assert.deepStrictEqual(atOf(lab).slice(0, 2), [132.08, 90.17]);
  assert.deepStrictEqual(c.lastSelection.slice().sort(), added.map((x) => x.id).sort(), "ctx.setSelection got the pasted ids");
  // a reference that is free stays; a pasted wire ending on the middle of a wire gets its junction
  const { d: d2, c: c2 } = fresh();
  d2.items.delete("s1"); c2.clip = cs.clip; c2.cursor = [50.8, 25.4];
  assert.ok(sch.runAction("paste", c2)); assert.strictEqual(fragItem(lastCommit(c2).changes.find((x) => x.typeName === "SCH_SYMBOL"))[7][2] === "R1" || kids(fragItem(lastCommit(c2).changes.find((x) => x.typeName === "SCH_SYMBOL")), "property")[0][2], "R1");
  const { d: d3, c: c3 } = fresh();
  c3.clip = _.lineNode("wire", [88.9, 63.5], [101.6, 63.5]).concat([["uuid", "clip-w"]]) && K.serialize(_.lineNode("wire", [88.9, 63.5], [101.6, 63.5]).concat([["uuid", "clip-w"]]));
  c3.cursor = [88.9, 63.5]; assert.ok(sch.runAction("paste", c3));
  const c3m = lastCommit(c3); assert.ok(c3m.changes.some((x) => x.typeName === "SCH_JUNCTION"), "end on w4's middle -> junction");
  assert.ok(!d3.items.has("clip-w") && c3m.changes.find((x) => x.typeName === "SCH_LINE").id !== "clip-w", "a fresh uuid even for a bare wire");
  // a (kicad_sch …) document pastes too; garbage does not
  const { d: d4, c: c4 } = fresh(); c4.clip = sch.clipboardText(src, [src.items.get("l1")], { wrap: true }); c4.cursor = [10, 10];
  assert.ok(sch.runAction("paste", c4)); assert.strictEqual(fragItem(lastCommit(c4).changes[0])[1], "NETA");
  c4.clip = "not a schematic"; c4.toasts.length = 0; const n4 = c4.log.length; assert.strictEqual(sch.runAction("paste", c4), false); assert.strictEqual(c4.log.length, n4); assert.ok(c4.toasts.some((m) => /no schematic items/.test(m)));
  // pasteSpecial keeps annotations; automatic annotation numbers the copy instead of R?
  const { c: c5 } = fresh(); c5.clip = cs.clip; c5.cursor = [10, 10]; assert.ok(sch.runAction("pasteSpecial", c5));
  assert.strictEqual(kids(fragItem(lastCommit(c5).changes.find((x) => x.typeName === "SCH_SYMBOL")), "property")[0][2], "R1");
  // with automatic annotation off the paste mode is REMOVE_ANNOTATIONS: R?
  const { c: c6 } = fresh(); sch.runAction("toggleAnnotateAuto", c6); assert.strictEqual(sch.state.annotateAuto, false); c6.clip = cs.clip; c6.cursor = [10, 10]; assert.ok(sch.runAction("paste", c6));
  assert.strictEqual(kids(fragItem(lastCommit(c6).changes.find((x) => x.typeName === "SCH_SYMBOL")), "property")[0][2], "R?"); sch.runAction("toggleAnnotateAuto", c6); assert.strictEqual(sch.state.annotateAuto, true);
  assert.strictEqual(_.pasteText(c6, ""), false);
});

test("cut removes the selection (with junction cleanup) after copying it; duplicate of a multi-selection pastes at the cursor", () => {
  const { d, c } = fresh();
  c.selection = new Set(["w1", "w2"]);
  assert.ok(sch.runAction("cut", c));
  assert.ok(c.clip.includes("(wire (pts (xy 50.8 63.5)"));
  const cm = lastCommit(c); assert.strictEqual(cm.label, "cut");
  assert.deepStrictEqual(cm.changes.map((x) => [x.kind, x.id]).sort(), [["REMOVED", "j1"], ["REMOVED", "w1"], ["REMOVED", "w2"]].sort(), "j1 only marked the T");
  assert.ok(!d.items.has("w1") && !d.items.has("j1")); assert.deepStrictEqual(c.lastSelection, []);
  const { d: d2, c: c2 } = fresh();
  c2.selection = new Set(["s1", "l1"]); c2.cursor = [76.2, 127];
  assert.ok(sch.runAction("duplicate", c2));
  const dm = lastCommit(c2); assert.strictEqual(dm.label, "duplicate"); assert.strictEqual(dm.changes.filter((x) => x.kind === "ADDED").length, 2);
  assert.deepStrictEqual(atOf(fragItem(dm.changes.find((x) => x.typeName === "SCH_SYMBOL"))).slice(0, 2), [76.2, 127]); assert.strictEqual(d2.items.size, 11);
  c2.selection.clear(); c2.selected = { id: "s1" }; assert.ok(sch.runAction("duplicate", c2));
  const one = fragItem(lastCommit(c2).changes.find((x) => x.typeName === "SCH_SYMBOL"));
  assert.notStrictEqual(kids(one, "property")[0][2], "R1", "a duplicated symbol never repeats its reference (Paste's UNIQUE_ANNOTATIONS)");
  assert.strictEqual(kids(one, "property")[0][2], "R3");
  sch.onActivate("select", c2);
  c2.selected = null; c2.selection = new Set(["s1", "l1"]); assert.ok(sch.runAction("copyAsText", c2)); assert.strictEqual(c2.clip, "R1 10k\nNETA");
});

test("select connection (Ctrl+4): the whole net of the selection, or of what is under the cursor; Tab walks it", () => {
  const { c } = fresh();
  sch.select("w1");
  assert.ok(sch.runAction("selectConnection", c)); assert.deepStrictEqual(c.lastSelection.slice().sort(), ["j1", "l1", "w1", "w2", "w3"]);
  c.selection.clear(); c.selected = null; sch.select(null); c.cursor = [70, 63.55];
  assert.ok(sch.runAction("selectConnection", c)); assert.deepStrictEqual(c.lastSelection.slice().sort(), ["j1", "l1", "w1", "w2", "w3"]);
  c.cursor = [200, 200]; c.selection.clear(); c.selected = null; assert.strictEqual(sch.runAction("selectConnection", c), false);
  c.selection = new Set(["w1"]); assert.ok(sch.runAction("nextNetItem", c)); assert.deepStrictEqual(c.lastSelection, ["w2"]);
  assert.ok(sch.runAction("previousNetItem", c)); assert.deepStrictEqual(c.lastSelection, ["w1"]);
  c.cursor = [70, 63.55]; assert.ok(sch.runAction("selectNode", c)); assert.deepStrictEqual(c.lastSelection, ["w2"]);
  assert.ok(sch.runAction("unselectAll", c)); assert.deepStrictEqual(c.lastSelection, []); assert.strictEqual(sch.state.sel, null);
});

test("repeat last item (Insert): labels step their number and move by the repeat offset, wires too, symbols ride to the cursor", () => {
  assert.deepStrictEqual(["D1", "A07", "X", "D1_2A", "DATA[0..3]"].map((t) => _.incrementText(t)), ["D2", "A08", "X", "D1_3A", "DATA[0..4]"]);
  assert.strictEqual(_.incrementText("D0", -1), null, "cannot go below zero");
  const { d, c } = fresh(); sch.state.annotateAuto = true;
  c.toasts.length = 0; assert.strictEqual(sch.runAction("repeatLast", c), false); assert.deepStrictEqual(c.toasts, [], "nothing remembered: KiCad does nothing");
  _.placeText(c, "label", "D0", [88.9, 88.9], 0);
  assert.ok(sch.onKey("Insert", {}, c));
  let n = fragItem(lastCommit(c).changes[0]); assert.strictEqual(lastCommit(c).label, "Repeat Item");
  assert.deepStrictEqual([n[0], n[1], atOf(n)], ["label", "D1", [88.9, 91.44, 0]], "100 mil down, number + 1");
  assert.deepStrictEqual(c.lastSelection, [lastCommit(c).changes[0].id]);
  sch.runAction("repeatLast", c); n = fragItem(lastCommit(c).changes[0]); assert.deepStrictEqual([n[1], atOf(n)[1]], ["D2", 93.98], "repeats chain");
  sch.onActivate("wire", c); sch.onPointerDown(ev(), [152.4, 25.4], c); sch.onPointerDown(ev(), [165.1, 25.4], c); sch.onPointerMove(ev(), [165.1, 38.1], c); sch.onKey("Enter", {}, c); sch.onActivate("select", c);
  assert.ok(sch.runAction("repeatLast", c), "the whole wire is repeated, every segment"); 
  assert.deepStrictEqual(lastCommit(c).changes.slice(0, 2).map((x) => [fragItem(x)[0], ptsOf(fragItem(x))]), [["wire", [[152.4, 27.94], [165.1, 27.94]]], ["wire", [[165.1, 27.94], [165.1, 40.64]]]]);
  // the copy lands across the original's vertical leg: AddJunctionsIfNeeded breaks it, CleanUp merges the overlap
  assert.ok(lastCommit(c).changes.some((x) => x.typeName === "SCH_JUNCTION" && atOf(fragItem(x))[1] === 27.94));
  _.startCarry(c, "symbol", _.symbolNode(d, "Device:R", [0, 0], 0, ""), [190.5, 101.6]); _.placeCarry(c, [190.5, 101.6]); _.dropCarry(c);
  c.cursor = [203.3, 101.5]; assert.ok(sch.runAction("repeatLast", c));
  n = fragItem(lastCommit(c).changes[0]); assert.deepStrictEqual(atOf(n).slice(0, 2), [203.2, 101.6]); assert.strictEqual(kids(n, "property")[0][2], "R2", "automatic annotation (KiCad's default) gives the repeat the next free number");
  assert.ok(d.items.get(lastCommit(c).changes[0].id));
  const l = K.createItem(d, _.labelNode("label", "Z0", [10, 10], 0)); c.selection = new Set([l.id]);
  assert.ok(sch.runAction("increment", c)); assert.strictEqual(d.items.get(l.id).node[1], "Z1"); assert.ok(sch.runAction("decrement", c)); assert.strictEqual(d.items.get(l.id).node[1], "Z0");
  assert.strictEqual(sch.runAction("decrement", c), false, "Z0 cannot go below zero");
});

test("type conversions: label ↔ global ↔ hierarchical ↔ text ↔ text box keep position, text and spin; REMOVED + ADDED like ChangeTextType", () => {
  const { d, c } = fresh();
  c.selection = new Set(["l1"]);
  assert.ok(sch.runAction("toGLabel", c));
  let cm = lastCommit(c); assert.strictEqual(cm.label, "change to global label");
  assert.deepStrictEqual(cm.changes.map((x) => [x.kind, x.typeName]), [["REMOVED", "SCH_LABEL"], ["ADDED", "SCH_GLOBALLABEL"]]);
  let n = fragItem(cm.changes[1]); assert.notStrictEqual(cm.changes[1].id, "l1");
  assert.deepStrictEqual(n.slice(0, 5), ["global_label", "NETA", ["shape", "input"], ["at", 55.88, 63.5, 0], ["fields_autoplaced", "yes"]]);
  assert.deepStrictEqual(kid(kid(n, "effects"), "justify"), ["justify", "left"]); assert.ok(kids(n, "property").some((p) => p[1] === "Intersheetrefs"));
  assert.ok(!d.items.has("l1") && d.items.get(cm.changes[1].id).kind === "global_label"); assert.deepStrictEqual(c.lastSelection, [cm.changes[1].id]);
  assert.ok(sch.runAction("toHLabel", c)); n = fragItem(lastCommit(c).changes[1]); assert.strictEqual(n[0], "hierarchical_label"); assert.deepStrictEqual(kid(n, "shape"), ["shape", "input"]); assert.ok(!kids(n, "property").length, "no intersheet refs on a hierarchical label");
  assert.ok(sch.runAction("toText", c)); n = fragItem(lastCommit(c).changes[1]); assert.deepStrictEqual(n.slice(0, 4), ["text", "NETA", ["exclude_from_sim", "no"], ["at", 55.88, 63.5, 0]]);
  assert.strictEqual(sch.runAction("toText", c), false, "already a text");
  assert.ok(sch.runAction("toLabel", c)); n = fragItem(lastCommit(c).changes[1]); assert.deepStrictEqual(n.slice(0, 4), ["label", "NETA", ["at", 55.88, 63.5, 0], ["effects", ["font", ["size", 1.27, 1.27]], ["justify", "left", "bottom"]]]);
  assert.ok(sch.runAction("toTextBox", c)); n = fragItem(lastCommit(c).changes[1]); assert.strictEqual(n[0], "text_box"); assert.strictEqual(n[1], "NETA"); assert.ok(atOf(n)[0] < 55.88 && atOf(n)[1] < 63.5, "box wraps the label"); assert.deepStrictEqual(kid(n, "margins"), ["margins", 0.9525, 0.9525, 0.9525, 0.9525]);
  assert.ok(sch.runAction("toLabel", c)); n = fragItem(lastCommit(c).changes[1]); assert.strictEqual(n[0], "label");
  assert.ok(atOf(n)[0] <= 55.88 && near(atOf(n)[0] / 1.27, Math.round(atOf(n)[0] / 1.27)) && Math.abs(atOf(n)[1] - 63.5) <= 1.28 && atOf(n)[2] === 0, "a horizontal box converts at its left edge centre (the box centre, not the old bottom-justified anchor), on the grid, reading right: " + atOf(n));
  const tb2 = K.createItem(d, _.textBoxNode("BOXED", [53, 61], [60, 65])), tbl = _.convertNode(tb2, "label", 1.27);
  assert.deepStrictEqual(tbl.slice(0, 3), ["label", "BOXED", ["at", 53.34, 63.5, 0]], "margins and the label size ratio inflate the text area, then the left edge centre snaps");
  // spin survives label <-> global, a text with a space becomes a valid net name, directive labels carry their netclass
  const rl = K.createItem(d, _.labelNode("label", "SPIN", [10.16, 10.16], 180)); c.selection = new Set([rl.id]);
  assert.ok(sch.runAction("toGLabel", c)); n = fragItem(lastCommit(c).changes[1]); assert.deepStrictEqual([atOf(n)[2], kid(kid(n, "effects"), "justify")], [180, ["justify", "right"]]);
  const tx = K.createItem(d, _.labelNode("text", "my net", [20.32, 20.32], 90)); c.selection = new Set([tx.id]);
  assert.ok(sch.runAction("toLabel", c)); n = fragItem(lastCommit(c).changes[1]); assert.deepStrictEqual([n[1], atOf(n)[2]], ["my_net", 0]);
  assert.ok(sch.runAction("toDLabel", c)); n = fragItem(lastCommit(c).changes[1]); assert.strictEqual(n[0], "netclass_flag"); assert.strictEqual(kids(n, "property")[0][2], "my_net");
  assert.ok(sch.runAction("toLabel", c)); n = fragItem(lastCommit(c).changes[1]); assert.strictEqual(n[1], "my_net");
  assert.strictEqual(_.validNetname("a\nb c"), "a_b_c"); assert.strictEqual(_.validNetname("{A B}"), "{A B}"); assert.strictEqual(_.validNetname(""), "<empty>");
  c.selection = new Set(["s1"]); assert.strictEqual(sch.runAction("toLabel", c), false, "symbols do not convert");
});

test("autoplace fields (O): AUTOPLACER's side choice, 50 mil rounding and justification; (fields_autoplaced yes) lands before the uuid", () => {
  const { d, c } = fresh();
  assert.deepStrictEqual(_.bodyBox(d, d.items.get("s1")), [24.384, 97.79, 26.416, 102.87], "the R body, pins excluded (their roots are inside it)");
  assert.deepStrictEqual(_.symbolPins(d, d.items.get("s1")).map((p) => [p.number, p.side, p.type, p.x, p.y]), [["1", "top", "passive", 25.4, 96.52], ["2", "bottom", "passive", 25.4, 104.14]]);
  const ext = _.fieldExtent(["property", "Reference", "R1", ["effects", ["font", ["size", 1.27, 1.27]]]]); assert.ok(ext.h > 1.27 && ext.h <= 2.54, "a 50 mil field takes one 100 mil row: " + ext.h);
  c.selected = { id: "s1" };
  assert.ok(sch.onKey("o", {}, c));
  const cm = lastCommit(c); assert.strictEqual(cm.label, "autoplace fields"); assert.strictEqual(cm.changes[0].kind, "MODIFIED");
  const n = fragItem(cm.changes[0]), props = kids(n, "property");
  assert.deepStrictEqual(atOf(props[0]), [27.94, 99.06, 0], "Reference: right of the body (no pins there), rounded up to the 50 mil grid, top row");
  assert.deepStrictEqual(atOf(props[1]), [27.94, 101.6, 0], "Value on the next row");
  assert.deepStrictEqual(kid(kid(props[0], "effects"), "justify"), ["justify", "left"]); assert.deepStrictEqual(kid(kid(props[1], "effects"), "justify"), ["justify", "left"]);
  assert.deepStrictEqual(atOf(props[2]).slice(0, 2), [23.622, 100.33], "hidden fields stay put");
  const ui = n.findIndex((x) => Array.isArray(x) && x[0] === "uuid"); assert.deepStrictEqual(n[ui - 1], ["fields_autoplaced", "yes"]);
  assert.strictEqual(fragItem(cm.changes[0])[0], "symbol");
  // a symbol turned 90° stores vertical field angles (they display horizontally); a Y-mirrored one stores the flipped justify
  const r90 = K.createItem(d, _.symbolNode(d, "Device:R", [76.2, 25.4], 90, "")), m = _.autoplaceNode(d, r90);
  assert.strictEqual(atOf(kids(m, "property")[0])[2], 90); assert.ok(atOf(kids(m, "property")[0])[1] < 25.4 - 1.5, "fields above a horizontal resistor (top side has no pins)");
  const my = K.createItem(d, _.symbolNode(d, "Device:R", [101.6, 25.4], 0, "y")), mn = _.autoplaceNode(d, my);
  assert.deepStrictEqual(kid(kid(kids(mn, "property")[0], "effects"), "justify"), ["justify", "right"], "stored right so the mirrored symbol renders it left-justified");
  assert.deepStrictEqual(atOf(kids(mn, "property")[0]).slice(0, 2), [104.14, 24.13]);
  // power symbols: the hidden pin counts, so GND (pin above its bars) gets its value below and VCC (pin below its bar) above, centred; a wire in the way pushes fields to another side
  d.lib.set("power:GND", K.parse(LIB_SYM("power:GND", "#PWR", "(power)")));
  d.lib.set("power:VCC", K.parse(LIB_SYM("power:VCC", "#PWR", "(power)").replace("(xy 0 0) (xy 0 -1.27) (xy 1.27 -1.27) (xy 0 -2.54) (xy -1.27 -1.27) (xy 0 -1.27)", "(xy 0 0) (xy 0 1.27) (xy 1.27 1.27) (xy 0 2.54) (xy -1.27 1.27) (xy 0 1.27)").replace("(at 0 0 270)", "(at 0 0 90)")));
  const g = K.createItem(d, _.symbolNode(d, "power:GND", [127, 50.8], 0, "")), gn = _.autoplaceNode(d, g);
  assert.deepStrictEqual(atOf(kids(gn, "property")[1]), [127, 55.88, 0], "GND's value sits below the bars (body bottom 53.34 + 15 mil, first row, rounded up)");
  assert.deepStrictEqual(kid(kid(kids(gn, "property")[1], "effects"), "justify"), null, "centred (no justify token)");
  const v = K.createItem(d, _.symbolNode(d, "power:VCC", [139.7, 50.8], 0, "")), vn = _.autoplaceNode(d, v);
  assert.deepStrictEqual(atOf(kids(vn, "property")[1]), [139.7, 45.72, 0], "VCC's value sits above its bar (body top 48.26 - 15 mil, rounded down)");
  K.createItem(d, _.lineNode("wire", [27.94, 96.52], [40.64, 96.52])); K.createItem(d, _.lineNode("wire", [27.94, 101.6], [40.64, 101.6]));
  const blocked = _.autoplaceNode(d, d.items.get("s1"));
  assert.ok(atOf(kids(blocked, "property")[0])[0] < 24.384, "wires on the right: the fields go left, right-justified: " + atOf(kids(blocked, "property")[0]));
  assert.deepStrictEqual(kid(kid(kids(blocked, "property")[0], "effects"), "justify"), ["justify", "right"]);
  c.selected = null; c.selection = new Set(["w1"]); assert.strictEqual(sch.runAction("autoplace", c), false);
});

test("annotate: X-then-Y numbering per prefix, incremental keeps existing references, reset renumbers, sheet start; clear goes back to R?; instances follow", () => {
  const { d, c } = fresh();
  const a = symAt(c, 76.2, 25.4), b = symAt(c, 50.8, 25.4), e = symAt(c, 63.5, 50.8), f = symAt(c, 63.5, 25.4);
  d.lib.set("power:GND", K.parse(LIB_SYM("power:GND", "#PWR", "(power)"))); const g = K.createItem(d, _.symbolNode(d, "power:GND", [10, 10], 0, ""));
  assert.deepStrictEqual([a.ref, g.ref], ["R?", "#PWR?"]);
  assert.deepStrictEqual(_.splitRef("R12"), { prefix: "R", num: 12, isNew: false }); assert.deepStrictEqual(_.splitRef("U?"), { prefix: "U", num: -1, isNew: true }); assert.deepStrictEqual(_.splitRef("XYZ"), { prefix: "XYZ", num: -1, isNew: true });
  assert.ok(sch.runAction("annotate", c));
  const cm = lastCommit(c); assert.strictEqual(cm.label, "annotate");
  const refOf = (id) => kids(d.items.get(id).node, "property")[0][2];
  assert.deepStrictEqual([refOf("s1"), refOf(b.id), refOf(f.id), refOf(e.id), refOf(a.id), refOf(g.id)], ["R1", "R2", "R3", "R4", "R5", "#PWR1"], "left to right, then top to bottom");
  assert.ok(cm.changes.every((x) => x.kind === "MODIFIED" && x.typeName === "SCH_SYMBOL") && cm.changes.length === 5);
  assert.ok(c.toasts.some((m) => /Annotated 5 symbols/.test(m)));
  assert.strictEqual(sch.runAction("annotate", c), true); assert.ok(c.toasts.some((m) => /Nothing to annotate/.test(m)));
  assert.ok(sch.runAction("annotate", c, { keep: false, order: "y" })); assert.deepStrictEqual([refOf(b.id), refOf(f.id), refOf(a.id), refOf(e.id), refOf("s1")], ["R1", "R2", "R3", "R4", "R5"], "top to bottom, then left to right");
  assert.ok(sch.runAction("clearAnnotation", c));
  assert.deepStrictEqual([refOf("s1"), refOf(a.id), refOf(g.id)], ["R?", "R?", "#PWR?"]);
  const inst = kid(d.items.get("s1").node, "instances"); assert.strictEqual(str(kid(kid(kid(inst, "project"), "path"), "reference")[1]), "R?", "instance data follows the reference");
  assert.ok(sch.runAction("annotate", c, { sheetInterval: 100, sheetNumber: 2 })); assert.deepStrictEqual([refOf("s1"), refOf(b.id)], ["R201", "R202"]);
  assert.strictEqual(str(kid(kid(kid(kid(d.items.get("s1").node, "instances"), "project"), "path"), "reference")[1]), "R201");
  assert.ok(sch.runAction("clearAnnotation", c)); assert.ok(sch.runAction("annotate", c, { start: 10 })); assert.strictEqual(refOf("s1"), "R11");
  const only = sch.annotateChanges(d, { only: new Set([a.id]), keep: false }); assert.strictEqual(only.length, 1);
  assert.deepStrictEqual(sch.clearAnnotationChanges(d, new Set(["s1"])).map((x) => x.id), ["s1"]);
  // references used on the project's other sheets are skipped (one reference list over the whole hierarchy)
  assert.ok(sch.runAction("clearAnnotation", c)); assert.ok(sch.runAction("annotate", c, { reserved: ["R1", "R2", "R4", "#PWR1", "C1"] }));
  assert.deepStrictEqual([refOf("s1"), refOf(b.id), refOf(f.id), refOf(g.id)], ["R3", "R5", "R6", "#PWR2"], "R1, R2, R4 and #PWR1 belong to another sheet");
});

test("paste modes (DIALOG_PASTE_SPECIAL): keep, remove, unique", () => {
  const { d } = fresh(); const s1 = d.items.get("s1"); const text = sch.clipboardText(d, [s1]);
  const parsed = sch.parseClipboard(text); const refOf = (n) => str(kids(n, "property").find((p) => str(p[1]) === "Reference")[2]);
  const paste = (mode) => { const { ids } = sch._.pasteChanges(d, sch.parseClipboard(text), [200, 200], { pasteMode: mode }); return refOf(d.items.get(ids[0]).node); };
  assert.ok(parsed); const orig = refOf(s1.node);
  assert.strictEqual(paste("keep"), orig, "kept even though duplicated");
  assert.ok(/\?$/.test(paste("remove")), "cleared");
  const u = paste("unique"); assert.ok(/^\D+\d+$/.test(u) && u !== orig, "next free number: " + u);
});

test("annotate: new units of a multi-unit symbol share one reference with distinct units, like GetNextRefDesForUnits", () => {
  const { d, c } = fresh();
  d.lib.set("T:DUAL", K.parse(`(symbol "T:DUAL" (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes) (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27)))) (property "Value" "DUAL" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (symbol "DUAL_1_1" (pin input line (at 0 0 0) (length 2.54) (name "A" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))))
    (symbol "DUAL_2_1" (pin input line (at 0 0 0) (length 2.54) (name "B" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))))`));
  const withUnit = (it, u) => { const n = it.node; const k = kid(n, "unit"); k[1] = u; return it; };
  const a = withUnit(place(c, "T:DUAL", [20.32, 76.2], "U?"), 1), b = withUnit(place(c, "T:DUAL", [40.64, 76.2], "U?"), 2);
  const e = withUnit(place(c, "T:DUAL", [60.96, 76.2], "U?"), 1), f = withUnit(place(c, "T:DUAL", [81.28, 76.2], "U?"), 1);
  const changes = sch.annotateChanges(d, {});
  const refOf = (it) => { const ch = changes.find((x) => x.id === it.id); return kids(fragItem(ch), "property")[0][2]; };
  assert.deepStrictEqual([refOf(a), refOf(b), refOf(e), refOf(f)], ["U1", "U1", "U2", "U3"], "unit B joins U1; a second unit A needs U2");
  // an annotated U5 unit A with another value leaves no room for this unit B: it takes a number of its own
  const g = place(c, "T:DUAL", [10, 90], "U1"); kids(g.node, "property")[1][2] = "OTHER";
  const h = withUnit(place(c, "T:DUAL", [30, 90], "U?"), 2);
  const ch2 = sch.annotateChanges(d, {}).find((x) => x.id === h.id); assert.strictEqual(kids(fragItem(ch2), "property")[0][2], "U2", "a different value never shares U1");
});

test("ERC on the embedded sheet: unconnected pins, dangling wires, then the fixes and the other findings", () => {
  const { d, c } = fresh();
  assert.ok(sch.runAction("runERC", c));
  let ms = sch.markers(); const texts = () => ms.map((m) => m.text);
  assert.strictEqual(ms, sch.state.markers);
  assert.ok(texts().includes("Pin not connected: R1 pin 1") && texts().includes("Pin not connected: R1 pin 2"));
  assert.ok(ms.some((m) => m.code === "wire_dangling" && m.severity === "error" && m.ids.includes("w4") && m.x === 101.6 && m.y === 63.5), "w4 touches nothing at either end");
  assert.strictEqual(ms.filter((m) => m.code === "unconnected_wire_endpoint").length, 5, "w1, w2, w3, w5 and w6 each have a loose end");
  assert.ok(!ms.some((m) => /Label not connected/.test(m.text)), "NETA sits on w1");
  assert.ok(ms.every((m) => typeof m.x === "number" && typeof m.y === "number" && ["error", "warning"].includes(m.severity) && Array.isArray(m.ids)));
  assert.ok(c.toasts.some((m) => /^ERC: 3 errors, 5 warnings$/.test(m)), c.toasts.join("|"));
  // fixes: a no-connect on pin 1, a wire on pin 2; a no-connect on a connected pin warns; an unannotated symbol and a duplicate reference are errors
  K.createItem(d, _.noConnectNode([25.4, 96.52])); K.createItem(d, _.lineNode("wire", [25.4, 104.14], [38.1, 104.14])); K.createItem(d, _.noConnectNode([25.4, 104.14]));
  const dup = symAt(c, 50.8, 127); _.setReference(dup.node, "R1"); K.buildGeom(d, dup); const q = symAt(c, 76.2, 127);
  ms = sch.ercCheck(d);
  assert.ok(!ms.some((m) => m.code === "pin_not_connected" && m.ids.includes("s1")), "R1's pins are covered (the duplicate R1 still has loose pins)");
  assert.strictEqual(ms.filter((m) => m.code === "pin_not_connected" && m.ids.includes(dup.id)).length, 2);
  assert.ok(ms.some((m) => m.code === "no_connect_connected" && m.severity === "warning" && /R1 pin 2/.test(m.text)));
  assert.ok(ms.some((m) => m.code === "duplicate_reference" && m.ids.includes(dup.id) && m.ids.includes("s1")));
  assert.ok(ms.some((m) => m.code === "unannotated" && m.ids.includes(q.id) && m.text === "Symbol R? is not annotated"));
  assert.ok(ms.some((m) => m.code === "no_connect_dangling") === false);
  K.createItem(d, _.noConnectNode([150, 150])); ms = sch.ercCheck(d); assert.ok(ms.some((m) => m.code === "no_connect_dangling" && m.x === 150));
  // labels on nothing, only one pin, similar names, empty
  K.createItem(d, _.labelNode("label", "LONELY", [160, 160], 0)); K.createItem(d, _.labelNode("global_label", "lonely", [170, 170], 0)); K.createItem(d, _.labelNode("label", "", [180, 180], 0));
  const w = K.createItem(d, _.lineNode("wire", [76.2, 123.19], [88.9, 123.19])); K.createItem(d, _.labelNode("label", "ONEPIN", [88.9, 123.19], 0));   // q's pin 1
  ms = sch.ercCheck(d);
  assert.ok(ms.some((m) => m.code === "label_dangling" && m.text === "Label not connected: LONELY"));
  assert.ok(ms.some((m) => m.code === "similar_labels" && /LONELY, lonely|lonely, LONELY/.test(m.text)));
  assert.ok(ms.some((m) => m.code === "empty_label_name" && m.severity === "error"));
  assert.ok(ms.some((m) => m.code === "isolated_pin_label" && /ONEPIN/.test(m.text) && m.severity === "warning"), texts().join("|"));
  assert.ok(ms.some((m) => m.code === "label_multiple_wires") === false); K.createItem(d, _.lineNode("wire", [88.9, 123.19], [88.9, 110])); ms = sch.ercCheck(d); assert.ok(ms.some((m) => m.code === "label_multiple_wires" && /ONEPIN/.test(m.text)));
  ms.sort((a, b) => a.y - b.y); assert.ok(w);
});

test("ERC pin conflicts: KiCad's pin matrix (two outputs, output to power output), power inputs without a power output, sheet pins against the sub-sheet's hierarchical labels", () => {
  const { d, c } = fresh();
  for (const [name, type] of [["T:OUT", "output"], ["T:IN", "input"], ["T:PWRI", "power_in"], ["T:PWRO", "power_out"], ["T:PAS", "passive"], ["T:BIDI", "bidirectional"]]) d.lib.set(name, K.parse(LIB_PIN(name, "U", type)));
  d.lib.set("power:PWR_FLAG", K.parse(LIB_PIN("power:PWR_FLAG", "#FLG", "power_out", "(power)"))); d.lib.set("power:VCC", K.parse(LIB_SYM("power:VCC", "#PWR", "(power)")));
  // two outputs wired together
  const o1 = place(c, "T:OUT", [50.8, 152.4], "U1"), o2 = place(c, "T:OUT", [76.2, 152.4], "U2"); K.createItem(d, _.lineNode("wire", [50.8, 152.4], [76.2, 152.4]));
  let ms = sch.ercCheck(d), m = ms.find((x) => x.code === "pin_to_pin_error");
  assert.ok(m && m.severity === "error" && /Pins of type Output and Output are connected: U1 pin 1 \(P\) and U2 pin 1 \(P\)/.test(m.text) && m.ids.includes(o1.id) && m.ids.includes(o2.id), JSON.stringify(m));
  // an input driven by a bidirectional pin is fine; an output on a power output is an error; an unspecified pin warns
  const i1 = place(c, "T:IN", [50.8, 165.1], "U3"), b1 = place(c, "T:BIDI", [76.2, 165.1], "U4"); K.createItem(d, _.lineNode("wire", [50.8, 165.1], [76.2, 165.1]));
  ms = sch.ercCheck(d); assert.ok(!ms.some((x) => x.ids.includes(i1.id) && /pin_to_pin|not driven/.test(x.code)), "input + bidi is clean"); assert.ok(b1);
  place(c, "T:OUT", [50.8, 177.8], "U5"); place(c, "T:PWRO", [76.2, 177.8], "U6"); K.createItem(d, _.lineNode("wire", [50.8, 177.8], [76.2, 177.8]));
  ms = sch.ercCheck(d); assert.ok(ms.some((x) => x.code === "pin_to_pin_error" && /Output and Power output/.test(x.text)));
  // a chip's power input fed by a passive pin: not driven until a PWR_FLAG (power output) joins the net
  const pi = place(c, "T:PWRI", [101.6, 152.4], "U7"); place(c, "T:PAS", [127, 152.4], "J1"); K.createItem(d, _.lineNode("wire", [101.6, 152.4], [127, 152.4]));
  ms = sch.ercCheck(d); m = ms.find((x) => x.code === "power_pin_not_driven");
  assert.ok(m && m.severity === "error" && /Input Power pin not driven by any Output Power pins: U7 pin 1/.test(m.text) && m.ids.includes(pi.id), texts(ms));
  place(c, "power:PWR_FLAG", [114.3, 152.4], "#FLG1"); ms = sch.ercCheck(d); assert.ok(!ms.some((x) => x.code === "power_pin_not_driven"), "PWR_FLAG drives it");
  // a power symbol's net without a power output: only a warning here, the flag may live on another sheet
  const pi2 = place(c, "T:PWRI", [101.6, 165.1], "U8"); place(c, "power:VCC", [127, 165.1], "#PWR1"); K.createItem(d, _.lineNode("wire", [101.6, 165.1], [127, 165.1]));
  ms = sch.ercCheck(d); m = ms.find((x) => x.code === "power_pin_not_driven"); assert.ok(m && m.severity === "warning" && /no driver on this sheet/.test(m.text) && m.ids.includes(pi2.id));
  // an input with nothing driving it, and a hierarchical label that hides the driver on another sheet
  const i2 = place(c, "T:IN", [101.6, 177.8], "U9"); place(c, "T:IN", [127, 177.8], "U10"); K.createItem(d, _.lineNode("wire", [101.6, 177.8], [127, 177.8]));
  ms = sch.ercCheck(d); assert.ok(ms.some((x) => x.code === "pin_not_driven" && x.severity === "error" && x.ids.includes(i2.id)));
  K.createItem(d, _.labelNode("hierarchical_label", "FROM_PARENT", [114.3, 177.8], 0)); ms = sch.ercCheck(d); assert.ok(!ms.some((x) => x.code === "pin_not_driven"));
  // sheet pins vs the sub-sheet
  const sheet = K.createItem(d, _.sheetNode([152.4, 152.4], [177.8, 165.1], "Sub", "Sub.kicad_sch")); _.placeSheetPin(c, sheet, "A", [152.4, 154.94], "left"); _.placeSheetPin(c, d.items.get(sheet.id), "B", [152.4, 157.48], "left");
  K.createItem(d, _.lineNode("wire", [139.7, 154.94], [152.4, 154.94])); K.createItem(d, _.lineNode("wire", [139.7, 157.48], [152.4, 157.48]));
  const sub = `(kicad_sch (version 20250114) (generator "eeschema") (uuid "sub-uuid") (paper "A4") (hierarchical_label "A" (shape input) (at 10 10 0) (effects (font (size 1.27 1.27)) (justify left)) (uuid "ha")) (hierarchical_label "C" (shape input) (at 10 20 0) (effects (font (size 1.27 1.27)) (justify left)) (uuid "hc")))`;
  ms = sch.ercCheck(d); assert.ok(!ms.some((x) => x.code === "hier_label_mismatch"), "without the sub-sheet nothing can be checked");
  ms = sch.ercCheck(d, { sheetDocs: new Map([["Sub.kicad_sch", sub]]) });
  const hm = ms.filter((x) => x.code === "hier_label_mismatch").map((x) => x.text).sort();
  assert.deepStrictEqual(hm, ["Hierarchical label C in Sub.kicad_sch has no sheet pin", "Sheet pin B has no matching hierarchical label in Sub.kicad_sch"]);
  c.sheetDocs = { "Sub.kicad_sch": sub }; sch.runAction("runERC", c); assert.strictEqual(sch.markers().filter((x) => x.code === "hier_label_mismatch").length, 2);
  c.parentSheetPins = ["OTHER"]; sch.runAction("runERC", c); assert.ok(sch.markers().some((x) => /FROM_PARENT has no sheet pin on the parent sheet/.test(x.text)));
  // sync / cleanup sheet pins against the sub-sheet
  c.selection = new Set([sheet.id]); assert.ok(sch.runAction("syncSheetPins", c)); assert.deepStrictEqual(kids(d.items.get(sheet.id).node, "pin").map((p) => p[1]), ["A", "B", "C"]);
  assert.ok(sch.runAction("cleanupSheetPins", c)); assert.deepStrictEqual(kids(d.items.get(sheet.id).node, "pin").map((p) => p[1]), ["A", "C"]);
  assert.ok(sch.runAction("clearMarkers", c)); assert.deepStrictEqual(sch.markers(), []);
  sch.runAction("runERC", c); assert.ok(sch.markers().length); sch.onDocChanged(c); assert.ok(sch.markers().length, "a commit keeps the markers"); sch.onDocChanged(makeCtx(K.parseDoc(SHEET))); assert.deepStrictEqual(sch.markers(), [], "a different sheet drops them");
  function texts(list) { return list.map((x) => x.text).join(" | "); }
});

test("swap (Alt+S): positions swap pairwise in selection order; same-lib symbols swap orientation, labels swap spin", () => {
  const { d, c } = fresh();
  const la = K.createItem(d, _.labelNode("label", "A", [10.16, 10.16], 0)), lb = K.createItem(d, _.labelNode("label", "B", [30.48, 20.32], 180));
  c.selection = new Set([la.id, lb.id]);
  assert.ok(sch.runAction("swap", c));
  const cm = lastCommit(c); assert.strictEqual(cm.label, "swap");
  const na = fragItem(cm.changes.find((x) => x.id === la.id)), nb = fragItem(cm.changes.find((x) => x.id === lb.id));
  assert.deepStrictEqual([atOf(na), atOf(nb)], [[30.48, 20.32, 180], [10.16, 10.16, 0]]);
  assert.deepStrictEqual(kid(kid(na, "effects"), "justify"), ["justify", "right", "bottom"]);
  const ra = symAt(c, 50.8, 50.8), rb = K.createItem(d, _.symbolNode(d, "Device:R", [76.2, 63.5], 90, ""));
  const nodes = _.swapNodes([ra, rb]);
  assert.deepStrictEqual([atOf(nodes[0]), atOf(nodes[1])], [[76.2, 63.5, 90], [50.8, 50.8, 0]], "positions and orientations swapped");
  assert.deepStrictEqual(atOf(kids(nodes[0], "property")[0]).slice(0, 2), [76.2 + 2.032, 63.5], "fields moved with their symbol");
  c.selection = new Set([la.id]); c.toasts.length = 0; assert.strictEqual(sch.runAction("swap", c), false); assert.ok(c.toasts.some((m) => /two or more/.test(m)));
  // three items rotate through the list like KiCad's sequential swaps
  const l3 = K.createItem(d, _.labelNode("label", "C", [40.64, 40.64], 0)); const three = _.swapNodes([d.items.get(la.id), d.items.get(lb.id), l3]);
  assert.deepStrictEqual(three.map((n) => atOf(n).slice(0, 2)), [[10.16, 10.16], [40.64, 40.64], [30.48, 20.32]]);
});

test("align to grid and edge alignment: pins, ends and anchors land on the grid with junction cleanup; edges line up on the extreme item", () => {
  const { d, c } = fresh();
  const off = K.createItem(d, _.symbolNode(d, "Device:R", [50.9, 50.7], 0, "")), lw = K.createItem(d, _.lineNode("wire", [60.1, 50.7], [70.2, 50.8])), lab = K.createItem(d, _.labelNode("label", "OFF", [80.1, 80.1], 0));
  c.selection = new Set([off.id, lw.id, lab.id]);
  assert.ok(sch.runAction("alignToGrid", c));
  const cm = lastCommit(c); assert.strictEqual(cm.label, "align to grid");
  assert.deepStrictEqual(atOf(fragItem(cm.changes.find((x) => x.id === off.id))).slice(0, 2), [50.8, 50.8]);
  assert.deepStrictEqual(ptsOf(fragItem(cm.changes.find((x) => x.id === lw.id))), [[59.69, 50.8], [69.85, 50.8]]);
  assert.deepStrictEqual(atOf(fragItem(cm.changes.find((x) => x.id === lab.id))).slice(0, 2), [80.01, 80.01]);
  assert.strictEqual(sch.runAction("alignToGrid", c), true); assert.ok(c.toasts.some((m) => /Already on the grid/.test(m)));
  const s2 = K.createItem(d, _.sheetNode([100.1, 100.1], [120.3, 110.2], "S", "S.kicad_sch")); c.selection = new Set([s2.id]); assert.ok(sch.runAction("alignToGrid", c));
  const sn = fragItem(lastCommit(c).changes[0]); assert.deepStrictEqual([atOf(sn).slice(0, 2), kid(sn, "size").slice(1)], [[100.33, 100.33], [20.32, 10.16]]);
  const t1 = K.createItem(d, _.labelNode("label", "T1", [10.16, 30.48], 0)), t2 = K.createItem(d, _.labelNode("label", "T2", [40.64, 20.32], 0)), t3 = K.createItem(d, _.labelNode("label", "T3", [25.4, 40.64], 0));
  c.selection = new Set([t1.id, t2.id, t3.id]);
  assert.ok(sch.runAction("alignTop", c)); assert.deepStrictEqual([t1.id, t2.id, t3.id].map((id) => atOf(d.items.get(id).node)[1]), [20.32, 20.32, 20.32]);
  assert.ok(sch.runAction("alignLeft", c)); assert.deepStrictEqual([t1.id, t2.id, t3.id].map((id) => atOf(d.items.get(id).node)[0]), [10.16, 10.16, 10.16]);
  c.selection = new Set([t1.id]); assert.strictEqual(sch.runAction("alignBottom", c), false);
});

test("move exactly: dx / dy and a rotation about the selection centre, as one commit; the dialog is only DOM", () => {
  const { d, c } = fresh();
  c.selection = new Set(["s1"]);
  assert.ok(sch.runAction("moveExactly", c, { dx: 2.54, dy: -1.27, rot: 0 }));
  let n = fragItem(lastCommit(c).changes[0]); assert.deepStrictEqual(atOf(n), [27.94, 99.06, 0]); assert.strictEqual(lastCommit(c).label, "move exactly");
  assert.deepStrictEqual(atOf(kids(n, "property")[0]).slice(0, 2), [29.972, 97.79], "fields ride along");
  assert.ok(sch.runAction("moveExactly", c, { dx: 0, dy: 0, rot: 90 }));
  n = fragItem(lastCommit(c).changes[0]); assert.strictEqual(atOf(n)[2], 90, "turned counterclockwise");
  assert.deepStrictEqual(atOf(n).slice(0, 2), [27.94, 99.06], "a lone symbol turns about its own position, as with R");
  assert.deepStrictEqual(_.rotationCentre([d.items.get("s1"), d.items.get("l1")]), _.selectionCentre([d.items.get("s1"), d.items.get("l1")]), "a group about the selection centre");
  const l = K.createItem(d, _.labelNode("label", "MX", [50.8, 50.8], 0)); c.selection = new Set([l.id]);
  assert.ok(sch.runAction("moveExactly", c, { dx: 0, dy: 0, rot: 180 })); n = fragItem(lastCommit(c).changes[0]); assert.deepStrictEqual(atOf(n), [50.8, 50.8, 180]);
  assert.strictEqual(_.moveExactChanges(c, [d.items.get(l.id)], 0, 0, 0).length, 1, "a no-op still yields the (unchanged) modification"); c.selection = new Set(); c.selected = null; sch.select(null); assert.strictEqual(sch.runAction("moveExactly", c, { dx: 1 }), false);
});

test("group rotate / mirror: a multi-selection turns about its half-grid centre with one R / X / Y; single shapes turn about their box", () => {
  const { d, c } = fresh();
  const lab = K.createItem(d, _.labelNode("label", "G", [38.1, 100.33], 0)), wire = K.createItem(d, _.lineNode("wire", [25.4, 96.52], [38.1, 96.52]));
  c.selection = new Set(["s1", lab.id, wire.id]);
  const items = [d.items.get("s1"), lab, wire], C = _.selectionCentre(items); assert.strictEqual(C[0] % 0.635 < 1e-9 || Math.abs(C[0] % 0.635 - 0.635) < 1e-9, true, "half-grid centre");
  assert.ok(sch.onKey("r", {}, c));
  const cm = lastCommit(c); assert.strictEqual(cm.label, "rotate");
  const sn = fragItem(cm.changes.find((x) => x.id === "s1")), ln = fragItem(cm.changes.find((x) => x.id === lab.id)), wn = fragItem(cm.changes.find((x) => x.id === wire.id));
  const rot = (p) => [+(C[0] + (p[1] - C[1])).toFixed(4), +(C[1] - (p[0] - C[0])).toFixed(4)];   // counterclockwise on screen
  assert.deepStrictEqual(atOf(sn), [...rot([25.4, 100.33]), 90]); assert.deepStrictEqual(atOf(ln), [...rot([38.1, 100.33]), 90]);
  assert.deepStrictEqual(ptsOf(wn), [rot([25.4, 96.52]), rot([38.1, 96.52])]);
  assert.deepStrictEqual(K.pinPoints(d, d.items.get("s1")).map((p) => [+p.x.toFixed(4), +p.y.toFixed(4)])[0], rot([25.4, 96.52]), "the wire still ends on the pin");
  assert.ok(sch.onKey("x", {}, c)); const mm = lastCommit(c); assert.strictEqual(mm.label, "mirror");
  const s2 = fragItem(mm.changes.find((x) => x.id === "s1")); assert.deepStrictEqual(kid(s2, "mirror") || null, kid(s2, "mirror"), "mirror written like the transform search says");
  assert.strictEqual(+(2 * C[0] - atOf(sn)[0]).toFixed(4), atOf(s2)[0], "X flips x about the centre");
  assert.ok(sch.runAction("mirrorSelectionY", c)); assert.strictEqual(+(2 * C[1] - atOf(s2)[1]).toFixed(4), atOf(fragItem(lastCommit(c).changes.find((x) => x.id === "s1")))[1], "Y flips y about the centre");
  assert.ok(sch.runAction("rotateSelectionCW", c)); assert.strictEqual(lastCommit(c).label, "rotate");
  // a single rectangle (no orientation of its own) turns about its half-grid box centre; a bus entry, a text box and a directive label turn too
  const r = K.createItem(d, _.rectangleNode([101.6, 101.6], [114.3, 106.68])); c.selection = new Set(); c.selected = null; sch.select(r.id);
  assert.ok(sch.onKey("r", {}, c)); const rn = fragItem(lastCommit(c).changes[0]); assert.deepStrictEqual([kid(rn, "start").slice(1), kid(rn, "end").slice(1)], [[105.41, 97.79], [110.49, 110.49]]);
  const tb = K.createItem(d, _.textBoxNode("box", [120, 120], [140, 130])); sch.select(tb.id); assert.ok(sch.onKey("r", {}, c)); const tn = fragItem(lastCommit(c).changes[0]); assert.deepStrictEqual([atOf(tn)[2], kid(tn, "size").slice(1)], [90, [10, 20]]);
  const fl = K.createItem(d, _.classLabelNode("Power", [150, 150], 0)); sch.select(fl.id); assert.ok(sch.onKey("r", {}, c)); const fn = fragItem(lastCommit(c).changes[0]); assert.deepStrictEqual(atOf(fn), [150, 150, 90]); assert.deepStrictEqual(atOf(kids(fn, "property")[0]), [147.46, 149.3015, 90], "the Netclass field is re-autoplaced for the new spin");
  assert.ok(sch.onKey("y", {}, c)); assert.deepStrictEqual(atOf(fragItem(lastCommit(c).changes[0]))[2], 270, "Mirror Vertically flips a vertical flag");
  const sh = K.createItem(d, _.sheetNode([160, 160], [180, 170], "S", "S.kicad_sch")); _.placeSheetPin(c, sh, "P", [160, 165.1], "left"); c.selected = { id: sh.id }; sch.select(null);
  assert.ok(sch.onKey("r", {}, c)); const shn = fragItem(lastCommit(c).changes[0]); assert.deepStrictEqual(kid(shn, "size").slice(1), [10, 20]);
  const pin = kids(shn, "pin")[0]; assert.strictEqual(atOf(pin)[2], 270, "the left pin is now on the bottom edge"); assert.strictEqual(atOf(pin)[1], atOf(shn)[1] + 20);
  assert.deepStrictEqual(atOf(kids(shn, "property")[0]).slice(0, 2), [atOf(shn)[0], +(atOf(shn)[1] - _.SHEET_NAME_OFF).toFixed(4)], "Sheetname re-autoplaced above the new top-left");
});

test("symbol fields table: every symbol's fields as rows; edits (including a new custom field and the reference) commit as one change set", () => {
  const { d, c } = fresh();
  const r2 = symAt(c, 50.8, 50.8); _.setReference(r2.node, "R2"); r2.node.push(["property", "MPN", "ERJ-1", ["at", 50.8, 50.8, 0], ["hide", "yes"], ["effects", ["font", ["size", 1.27, 1.27]]]]); K.buildGeom(d, r2);
  const t = sch.fieldsTableRows(d);
  assert.deepStrictEqual(t.fields, ["Reference", "Value", "Footprint", "Datasheet", "Description", "MPN"]);
  assert.deepStrictEqual(t.rows.map((r) => r.ref), ["R1", "R2"]); assert.deepStrictEqual(t.rows[1].values, { Reference: "R2", Value: "R", Footprint: "", Datasheet: "~", Description: "Resistor", MPN: "ERJ-1" });
  const changes = sch.fieldsTableChanges(d, [{ id: "s1", values: { Value: "4k7", MPN: "ERJ-2", Reference: "R7" } }, { id: r2.id, values: { Value: "R" } }]);
  assert.strictEqual(changes.length, 1, "only the symbol that changed"); assert.strictEqual(changes[0].kind, "MODIFIED"); assert.strictEqual(changes[0].id, "s1");
  const n = fragItem(changes[0]), props = kids(n, "property");
  assert.deepStrictEqual(props.map((p) => [p[1], p[2]]), [["Reference", "R7"], ["Value", "4k7"], ["Footprint", ""], ["Datasheet", "~"], ["Description", "Resistor"], ["MPN", "ERJ-2"]]);
  assert.deepStrictEqual(kid(props[5], "hide"), ["hide", "yes"]); assert.ok(n.findIndex((x) => Array.isArray(x) && x[0] === "property") < n.findIndex((x) => Array.isArray(x) && x[0] === "pin"), "fields stay ahead of the pins");
  assert.strictEqual(str(kid(kid(kid(kid(n, "instances"), "project"), "path"), "reference")[1]), "R7", "instance reference follows");
  c.commit(changes, "symbol fields"); assert.strictEqual(d.items.get("s1").ref, "R7");
  assert.deepStrictEqual(sch.fieldsTableChanges(d, [{ id: "s1", values: { Nope: "" } }]), [], "an empty new field is not created");
  assert.strictEqual(sch.runAction("fieldsTable", c), false, "the dialog needs KDialogs (browser only)");
});

test("bus unfolding: member names from bus vectors and groups; an entry and the member label leave the bus where clicked, ride with the wire tool and join its one Draw Wires commit", () => {
  assert.deepStrictEqual(sch.busMembers("DATA[0..3]").members, ["DATA0", "DATA1", "DATA2", "DATA3"]);
  assert.deepStrictEqual(sch.busMembers("A[3..1]-").members, ["A1-", "A2-", "A3-"], "reversed ranges and a +-PN suffix");
  assert.deepStrictEqual(sch.busMembers("{A B C}").members, ["A", "B", "C"]); assert.deepStrictEqual(sch.busMembers("BUS{A B}").members, ["BUS.A", "BUS.B"]);
  assert.deepStrictEqual(sch.busMembers("{D[0..1] E}").members, ["D0", "D1", "E"]); assert.strictEqual(sch.busMembers("PLAIN"), null); assert.strictEqual(sch.busMembers("X[2..2]"), null);
  const { d, c } = fresh();
  const bus = K.createItem(d, _.lineNode("bus", [101.6, 127], [152.4, 127])); K.createItem(d, _.labelNode("global_label", "DATA[0..3]", [110, 127], 0));
  assert.deepStrictEqual(_.unfoldMembers(d, bus), ["DATA0", "DATA1", "DATA2", "DATA3"]);
  const before = d.items.size, commits = c.log.length;
  c.selection = new Set([bus.id]); c.cursor = [127.3, 120];
  assert.ok(sch.runAction("unfoldBus", c, { member: "DATA1" }));
  assert.strictEqual(c.log.length, commits, "nothing is committed while the unfold is in flight (IS_NEW)");
  const u = sch.state.unfold, en = d.items.get(u.entryId).node, ln = d.items.get(u.labelId).node;
  assert.deepStrictEqual(en.slice(1, 3), [["at", 127, 127], ["size", 2.54, -2.54]], "the entry leaves the bus toward the cursor's side");
  assert.deepStrictEqual([ln[1], atOf(ln)], ["DATA1", [129.54, 124.46, 90]], "member label at the entry's end, standing away from a horizontal bus");
  assert.strictEqual(sch.state.tool, "wire"); assert.deepStrictEqual(sch.state.wire && sch.state.wire.segs[0][0], [129.54, 124.46], "the wire starts at the entry end");
  // Esc: doDrawSegments' cleanup() takes the entry and the label away again
  _.cancelWire(c);
  assert.strictEqual(sch.state.unfold, null); assert.strictEqual(d.items.size, before, "Esc leaves nothing behind"); assert.strictEqual(c.log.length, commits);
  // again: motion to the left flips the entry, the label rides the cursor, the first click places it and (a label is a terminal point) ends the wire
  sch.onActivate("select", c); c.selection = new Set([bus.id]); c.cursor = [127.3, 120];
  assert.ok(sch.runAction("unfoldBus", c, { member: "DATA1" }));
  sch.onPointerMove(ev(), [121.92, 111.76], c);
  const u2 = sch.state.unfold;
  assert.deepStrictEqual(kid(d.items.get(u2.entryId).node, "size").slice(1), [-2.54, -2.54], "the entry flipped toward the cursor");
  assert.deepStrictEqual(atOf(d.items.get(u2.labelId).node).slice(0, 2), [121.92, 111.76], "the label ghost sits on the cursor");
  assert.deepStrictEqual(sch.state.wire.segs[0][0], [124.46, 124.46], "the wire starts from the flipped entry's end");
  sch.onPointerDown(ev(), [121.92, 111.76], c);
  assert.strictEqual(sch.state.wire, null); assert.strictEqual(c.log.length, commits + 1, "one undo step");
  const wm = lastCommit(c); assert.strictEqual(wm.label, "Draw Wires");
  const added = wm.changes.filter((x) => x.kind === "ADDED").map((x) => x.typeName);
  assert.ok(added.includes("SCH_BUS_WIRE_ENTRY") && added.includes("SCH_LABEL") && added.includes("SCH_LINE"), added.join());
  const lc = wm.changes.find((x) => x.typeName === "SCH_LABEL"); assert.deepStrictEqual(atOf(fragItem(lc)).slice(0, 2), [121.92, 111.76], "the label stays where the click placed it");
  const wc = wm.changes.find((x) => x.typeName === "SCH_LINE");
  assert.strictEqual(sch.state.unfold, null);
  assert.ok(sch.netItems(d, d.items.get(wc.id)).has(bus.id), "wire, entry, label and bus are one net");
  // a vertical bus, a group bus label, no member option -> the first member; nothing to unfold without a bus label
  const vb = K.createItem(d, _.lineNode("bus", [190.5, 25.4], [190.5, 76.2])); K.createItem(d, _.labelNode("global_label", "CTRL{EN RST}", [190.5, 30], 90));
  sch.onActivate("select", c); c.selection = new Set([vb.id]); c.cursor = [180, 50.8]; assert.ok(sch.runAction("unfoldBus", c));
  const vn = d.items.get(sch.state.unfold.labelId).node; assert.deepStrictEqual([vn[1], atOf(vn)], ["CTRL.EN", [187.96, 53.34, 180]], "reads away from a vertical bus");
  _.cancelWire(c); sch.onActivate("select", c);
  const nb = K.createItem(d, _.lineNode("bus", [10, 10], [30, 10])); c.selection = new Set([nb.id]); c.toasts.length = 0; assert.strictEqual(sch.runAction("unfoldBus", c), false); assert.ok(c.toasts.some((m) => /No bus label/.test(m)));
  c.selection = new Set(); c.selected = null; sch.select(null); c.cursor = [200, 200]; assert.strictEqual(sch.runAction("unfoldBus", c), false);
});

test("duplicate / paste in flight (SCH_MOVE_TOOL on IS_NEW items): nothing reaches the document until the click; Esc, Ctrl+Z and Del leave no trace and no redo", () => {
  const { d, c } = fresh(); _.setFollow(true);
  const key = (k, mods) => _.onKeyCapture(Object.assign({ key: k, target: null, stopImmediatePropagation() {}, preventDefault() {} }, mods || {}));
  try {
    const before = d.items.size, n0 = c.log.length;
    // a wire on R1's pin 1 (25.4, 96.52): a copy stacked on the original would want a junction there
    K.createItem(d, _.lineNode("wire", [25.4, 96.52], [25.4, 88.9])); const base = d.items.size;
    c.selection = new Set(["s1"]); c.selected = { id: "s1" }; c.cursor = [25.4, 100.33];
    assert.ok(sch.runAction("duplicate", c));
    assert.strictEqual(c.log.length, n0, "no commit while the copy follows the cursor");
    const dr = sch.state.drag; assert.ok(dr && dr.local && dr.local.size === 1);
    assert.strictEqual(d.items.size, base + 1, "the copy only, no junction");
    // Del: KiCad's doDelete ends the move with nothing committed
    key("Delete"); assert.strictEqual(sch.state.drag, null); assert.strictEqual(d.items.size, base, "the copy went"); assert.strictEqual(c.log.length, n0);
    // Esc and Ctrl+Z: the same, and no undo is run (so no redo entry)
    let undos = 0; c.undo = () => { undos++; };
    for (const k of [["Escape"], ["z", { ctrlKey: true }]]) {
      c.selection = new Set(["s1"]); c.selected = { id: "s1" }; assert.ok(sch.runAction("duplicate", c));
      key(k[0], k[1]); assert.strictEqual(sch.state.drag, null, k[0]); assert.strictEqual(d.items.size, base); assert.strictEqual(c.log.length, n0);
    }
    assert.strictEqual(undos, 0, "nothing to undo");
    // Ctrl+Y and Ctrl+D mid-move beep
    c.selection = new Set(["s1"]); c.selected = { id: "s1" }; assert.ok(sch.runAction("duplicate", c));
    key("y", { ctrlKey: true }); key("d", { ctrlKey: true }); assert.ok(sch.state.drag && sch.state.drag.local, "still in flight"); assert.strictEqual(c.log.length, n0);
    // the click: one "duplicate" step, the copy where it landed with a fresh reference, junctions only where it landed
    sch.moveDrag(c, [50.8, 100.33]); sch.endDrag(c, true);
    assert.strictEqual(c.log.length, n0 + 1); const cm = lastCommit(c); assert.strictEqual(cm.label, "duplicate");
    assert.deepStrictEqual(cm.changes.map((x) => [x.kind, x.typeName]), [["ADDED", "SCH_SYMBOL"]], "no junction at the original pin");
    const sy = fragItem(cm.changes[0]); assert.deepStrictEqual(atOf(sy).slice(0, 2), [50.8, 100.33]);
    assert.strictEqual(str(kids(sy, "property")[0][2]), "R2");
    assert.strictEqual(d.items.size, base + 1); assert.deepStrictEqual(c.lastSelection, [cm.changes[0].id], "the copy stays selected");
    void before;
  } finally { _.setFollow(false); }
});

test("break / slice in flight: Esc before a click restores with no commit; each BREAK click breaks the tail again; Esc after one keeps them; one Break Wire step", () => {
  const { d, c } = fresh(); _.setFollow(true);
  try {
    const w5 = () => ptsOf(d.items.get("w5").node), n0 = c.log.length, size0 = d.items.size;
    c.cursor = [130.5, 48]; sch.select("w5");
    assert.ok(sch.runAction("breakWire", c)); assert.strictEqual(c.log.length, n0, "the break is local");
    assert.deepStrictEqual(w5(), [[127, 50.8], [130.81, 50.8]]); assert.strictEqual(d.items.size, size0 + 1);
    sch.moveDrag(c, [130.81, 45.72]); assert.deepStrictEqual(w5(), [[127, 50.8], [130.81, 45.72]], "the corner follows the cursor");
    sch.endDrag(c, false);
    assert.deepStrictEqual(w5(), [[127, 50.8], [139.7, 50.8]], "Esc puts the wire back"); assert.strictEqual(d.items.size, size0); assert.strictEqual(c.log.length, n0, "no commit, so no redo either");
    // break, click (breaks again), move, Esc: both corners kept
    sch.select("w5"); assert.ok(sch.runAction("breakWire", c));
    sch.moveDrag(c, [130.81, 45.72]); assert.ok(_.breakAgain(c)); assert.ok(sch.state.drag, "BREAK keeps going after a click");
    sch.moveDrag(c, [134.62, 45.72]); sch.endDrag(c, false);
    assert.strictEqual(c.log.length, n0 + 1); let cm = lastCommit(c); assert.strictEqual(cm.label, "Break Wire");
    const after = (cm2) => cm2.changes.filter((x) => x.typeName === "SCH_LINE").map((x) => ptsOf(fragItem(x)));
    assert.deepStrictEqual(after(cm), [[[127, 50.8], [130.81, 45.72]], [[130.81, 45.72], [134.62, 45.72]], [[134.62, 45.72], [139.7, 50.8]]]);
    assert.deepStrictEqual(cm.changes.map((x) => x.kind), ["MODIFIED", "ADDED", "ADDED"]);
    // Ctrl+Z mid-break after a click still reverts everything
    const n1 = c.log.length; sch.select("w4"); c.cursor = [101.6, 60];
    assert.ok(sch.runAction("breakWire", c)); sch.moveDrag(c, [95.25, 60.96]); assert.ok(_.breakAgain(c));
    _.onKeyCapture({ key: "z", ctrlKey: true, target: null, stopImmediatePropagation() {}, preventDefault() {} });
    assert.strictEqual(sch.state.drag, null); assert.strictEqual(c.log.length, n1); assert.deepStrictEqual(ptsOf(d.items.get("w4").node), [[101.6, 50.8], [101.6, 76.2]]);
    // SLICE: the click finishes
    sch.select("w4"); c.cursor = [101.6, 60]; assert.ok(sch.runAction("slice", c)); assert.strictEqual(_.breakAgain(c), false, "only BREAK breaks again");
    sch.moveDrag(c, [101.6, 58.42]); sch.endDrag(c, true);
    cm = lastCommit(c); assert.strictEqual(cm.label, "Slice Wire"); assert.deepStrictEqual(after(cm), [[[101.6, 50.8], [101.6, 58.42]], [[101.6, 59.69], [101.6, 76.2]]]);
  } finally { _.setFollow(false); }
});

test("with an item on the cursor Ctrl+Y beeps and Del cancels it (TwoClickPlace / PlaceSymbol)", () => {
  const { d, c } = fresh();
  const key = (k, mods) => { let eaten = false; _.onKeyCapture(Object.assign({ key: k, target: null, stopImmediatePropagation() { eaten = true; }, preventDefault() {} }, mods || {})); return eaten; };
  sch.onActivate("label", c); sch.state.carry = { kind: "label", node: _.labelNode("label", "FOO", [10, 10], 0), item: null, pos: [10, 10] };
  assert.ok(key("y", { ctrlKey: true }), "redo is swallowed"); assert.ok(sch.state.carry, "the label stays on the cursor");
  assert.ok(key("Delete")); assert.strictEqual(sch.state.carry, null, "Del drops it"); void d;
  sch.onActivate("select", c);
});

test("a new wire, bus or graphic line inherits the stroke of the line it starts on (startSegments duplicates GetLine) and merges with it", () => {
  const { d, c } = fresh();
  const w = K.createItem(d, ["wire", ["pts", ["xy", 50.8, 30.48], ["xy", 63.5, 30.48]], ["stroke", ["width", 0], ["type", "solid"]], ["uuid", "ws"]]);
  sch.onActivate("wire", c); sch.onPointerDown(ev(), [50.8, 30.48], c); sch.onPointerDown(ev(), [45.72, 30.48], c); sch.onKey("Enter", {}, c);
  const cm = lastCommit(c); assert.strictEqual(cm.label, "Draw Wires");
  assert.strictEqual(cm.changes.filter((x) => x.kind === "ADDED").length, 0, "the continuation merged into the solid wire");
  assert.deepStrictEqual(ptsOf(d.items.get("ws").node).map((p) => p[0]).sort((a, b) => a - b), [45.72, 63.5]); void w;
  const g = K.createItem(d, ["polyline", ["pts", ["xy", 50.8, 20.32], ["xy", 63.5, 20.32]], ["stroke", ["width", 0.254], ["type", "dash"], ["color", 255, 0, 0, 1]], ["uuid", "gl"]]);
  sch.onActivate("lines", c); sch.onPointerDown(ev(), [63.5, 20.32], c); sch.onPointerDown(ev(), [63.5, 12.7], c); sch.onKey("Enter", {}, c);
  const add = lastCommit(c).changes.find((x) => x.kind === "ADDED"); assert.ok(add);
  assert.deepStrictEqual(kid(fragItem(add), "stroke"), ["stroke", ["width", 0.254], ["type", "dash"], ["color", 255, 0, 0, 1]], "dashed red line continued as such"); void g;
  assert.strictEqual(_.sourceLine(d, "wire", [10, 10]), null);
  sch.onActivate("select", c);
});

test("a hidden global power pin shows the dangling indicator; a local power symbol's does not (SCH_PAINTER / SCH_PIN::IsGlobalPower)", () => {
  const sheet = SHEET.replace("  )\n  (junction", `    (symbol "power:GND" (power) (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
      (property "Reference" "#PWR" (at 0 -6.35 0) (hide yes) (effects (font (size 1.27 1.27))))
      (property "Value" "GND" (at 0 -3.81 0) (effects (font (size 1.27 1.27))))
      (symbol "GND_1_1" (pin power_in line (at 0 0 270) (length 0) (hide yes) (name "GND" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))
    (symbol "power:LGND" (power local) (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
      (property "Reference" "#PWR" (at 0 -6.35 0) (hide yes) (effects (font (size 1.27 1.27))))
      (property "Value" "LGND" (at 0 -3.81 0) (effects (font (size 1.27 1.27))))
      (symbol "LGND_1_1" (pin power_in line (at 0 0 270) (length 0) (hide yes) (name "LGND" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))
  )
  (symbol (lib_id "power:GND") (at 250 170 0) (unit 1) (uuid "pg") (property "Reference" "#PWR01" (at 250 176 0) (hide yes) (effects (font (size 1.27 1.27)))) (property "Value" "GND" (at 250 174 0) (effects (font (size 1.27 1.27)))) (pin "1" (uuid "pg1")))
  (symbol (lib_id "power:LGND") (at 270 170 0) (unit 1) (uuid "pl") (property "Reference" "#PWR02" (at 270 176 0) (hide yes) (effects (font (size 1.27 1.27)))) (property "Value" "LGND" (at 270 174 0) (effects (font (size 1.27 1.27)))) (pin "1" (uuid "pl1")))
  (junction`);
  const d = K.parseDoc(sheet); assert.ok(d.items.get("pg") && d.items.get("pl"), "fixture parsed");
  const list = _.danglingEnds(d);
  assert.strictEqual(list.filter((x) => x.item.id === "pg").length, 1, "the GND pin dangles");
  assert.strictEqual(list.filter((x) => x.item.id === "pl").length, 0, "a local power pin is not global");
  assert.strictEqual(list.filter((x) => x.item.id === "s1").length, 2, "R1's visible pins still dangle");
});

test("text box point editor: the box cannot shrink below its text (SCH_TEXTBOX::GetMinSize)", () => {
  const tb = ["text_box", "Hello", ["at", 10, 10, 0], ["size", 20, 10], ["margins", 0.9525, 0.9525, 0.9525, 0.9525], ["effects", ["font", ["size", 1.27, 1.27]], ["justify", "left", "top"]], ["uuid", "tb"]];
  const [w, h] = _.textBoxMinSize(tb); assert.strictEqual(w, 0); assert.ok(h > 3.8 && h < 4.1, "one 1.27 mm line plus the margins: " + h);
  const two = JSON.parse(JSON.stringify(tb)); two[1] = "a\nb"; assert.ok(_.textBoxMinSize(two)[1] > h + 1.9, "a second line adds an interline pitch");
  const vert = JSON.parse(JSON.stringify(tb)); kid(vert, "at")[3] = 90; assert.ok(_.textBoxMinSize(vert)[0] > 3.8 && _.textBoxMinSize(vert)[1] === 0, "vertical text sets a minimum width");
  const empty = JSON.parse(JSON.stringify(tb)); empty[1] = ""; assert.deepStrictEqual(_.textBoxMinSize(empty), [0, 0]);
});

test("smaller commands: break wire, symbol flags, units and body styles, reference / value prompts, datasheet", () => {
  const { d, c } = fresh();
  c.cursor = [130.5, 48]; sch.select("w5");   // w5 runs 127..139.7 at y 50.8: the selection wins, the cursor's grid point projects onto it
  assert.ok(sch.runAction("breakWire", c));
  let cm = lastCommit(c); assert.strictEqual(cm.label, "Break Wire"); assert.deepStrictEqual(cm.changes.map((x) => [x.kind, x.typeName]), [["MODIFIED", "SCH_LINE"], ["ADDED", "SCH_LINE"]]);
  assert.deepStrictEqual([ptsOf(fragItem(cm.changes[0])), ptsOf(fragItem(cm.changes[1]))], [[[127, 50.8], [130.81, 50.8]], [[130.81, 50.8], [139.7, 50.8]]]);
  assert.deepStrictEqual(_.breakWireChanges(d, d.items.get("w5"), [114.3, 50.8]), [], "a point clamped to the wire's end breaks nothing");
  c.cursor = [136, 50.9]; c.selection = new Set(); c.selected = null; sch.select(null); assert.ok(sch.runAction("slice", c), "the wire under the cursor");
  cm = lastCommit(c); assert.deepStrictEqual(ptsOf(fragItem(cm.changes[0])), [[130.81, 50.8], [135.89, 50.8]]); assert.deepStrictEqual(ptsOf(fragItem(cm.changes[1])), [[135.89, 50.8], [139.7, 50.8]]);
  assert.strictEqual(cm.label, "Slice Wire");
  assert.deepStrictEqual(c.lastSelection, [cm.changes[0].id], "slice carries the first half's end"); assert.ok(d.items.get(cm.changes[1].id));
  // several selected lines break at their midpoints
  const w4 = d.items.get("w4"), w6 = d.items.get("w6"); c.selection = new Set(["w4", "w6"]);
  assert.ok(sch.runAction("breakWire", c)); cm = lastCommit(c);
  assert.deepStrictEqual(cm.changes.filter((x) => x.kind === "MODIFIED").map((x) => ptsOf(fragItem(x))[1]), [[101.6, 63.5], [139.7, 57.15]]);
  assert.ok(w4 && w6); c.selection = new Set();
  c.selection = new Set(["s1"]);
  assert.ok(sch.runAction("setDNP", c)); assert.deepStrictEqual(kid(fragItem(lastCommit(c).changes[0]), "dnp"), ["dnp", "yes"]); assert.ok(sch.runAction("setDNP", c)); assert.deepStrictEqual(kid(fragItem(lastCommit(c).changes[0]), "dnp"), ["dnp", "no"]);
  assert.ok(sch.runAction("setExcludeFromBOM", c)); assert.deepStrictEqual(kid(fragItem(lastCommit(c).changes[0]), "in_bom"), ["in_bom", "no"]);
  assert.ok(sch.runAction("setExcludeFromSim", c)); assert.deepStrictEqual(kid(fragItem(lastCommit(c).changes[0]), "exclude_from_sim"), ["exclude_from_sim", "yes"]);
  assert.ok(sch.runAction("setExcludeFromBoard", c)); assert.deepStrictEqual(kid(fragItem(lastCommit(c).changes[0]), "on_board"), ["on_board", "no"]);
  c.toasts.length = 0; assert.strictEqual(sch.runAction("nextUnit", c), false); assert.ok(c.toasts.some((m) => /single unit/.test(m)));
  d.lib.set("T:DUAL", K.parse(`(symbol "T:DUAL" (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes) (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27)))) (property "Value" "DUAL" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (symbol "DUAL_1_1" (pin input line (at 0 0 0) (length 2.54) (name "A" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))))
    (symbol "DUAL_2_1" (pin input line (at 0 0 0) (length 2.54) (name "B" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27))))))
    (symbol "DUAL_1_2" (rectangle (start 0 0) (end 1 1) (stroke (width 0) (type default)) (fill (type none)))))`));
  const u = place(c, "T:DUAL", [50.8, 76.2], "U1"); c.selection = new Set([u.id]);
  assert.deepStrictEqual(_.libUnits(d, u.node), { units: 2, styles: 2 });
  assert.ok(sch.runAction("nextUnit", c)); assert.deepStrictEqual(kid(fragItem(lastCommit(c).changes[0]), "unit"), ["unit", 2]);
  assert.ok(sch.runAction("nextUnit", c)); assert.deepStrictEqual(kid(fragItem(lastCommit(c).changes[0]), "unit"), ["unit", 1], "wraps");
  assert.ok(sch.runAction("previousUnit", c)); assert.deepStrictEqual(kid(d.items.get(u.id).node, "unit"), ["unit", 2]);
  assert.ok(sch.runAction("cycleBodyStyle", c)); assert.deepStrictEqual(kid(fragItem(lastCommit(c).changes[0]), "body_style"), ["body_style", 2]);
  assert.ok(sch.runAction("placeNextSymbolUnit", c)); assert.ok(sch.state.carry && kid(sch.state.carry.node, "unit")[1] === 1 && kids(sch.state.carry.node, "property")[0][2] === "U1", "the free unit rides on the cursor with the same reference");
  sch.onActivate("select", c);
  sch.setPrompt((title, initial, client, done) => { assert.strictEqual(title, "Reference"); assert.strictEqual(initial, "U1"); done("U9"); });
  c.selection = new Set([u.id]); assert.ok(sch.onKey("u", {}, c)); assert.strictEqual(d.items.get(u.id).ref, "U9"); assert.strictEqual(lastCommit(c).label, "reference");
  sch.setPrompt((title, initial, client, done) => { assert.strictEqual(title, "Value"); done("Quad"); }); assert.ok(sch.onKey("v", {}, c)); assert.strictEqual(d.items.get(u.id).value, "Quad");
  sch.setPrompt((title, initial, client, done) => { assert.strictEqual(initial, ""); done("R_0402"); }); assert.ok(sch.runAction("editFootprint", c)); assert.strictEqual(kids(d.items.get(u.id).node, "property").find((p) => p[1] === "Footprint")[2], "R_0402");
  sch.setPrompt((t, i, cl, done) => done(null));
  c.selection = new Set(); c.selected = null; sch.select("w1"); assert.strictEqual(sch.onKey("u", {}, c), false, "no symbol: the key is not ours");
  c.selection = new Set(["s1"]); c.toasts.length = 0; assert.strictEqual(sch.runAction("showDatasheet", c), false); assert.ok(c.toasts.some((m) => /No datasheet/.test(m)));
  const dsp = kids(d.items.get("s1").node, "property").find((p) => p[1] === "Datasheet"); dsp[2] = "ftp://x"; assert.ok(sch.runAction("showDatasheet", c)); assert.ok(c.toasts.some((m) => /Datasheet: ftp/.test(m)));
  _.highlightClick(c, [70, 63.55]); assert.ok(sch.state.highlight); assert.ok(sch.onKey("~", {}, c)); assert.strictEqual(sch.state.highlight, null); assert.strictEqual(sch.onKey("~", {}, c), false);
});

test("drag net collision (SCH_DRAG_NET_COLLISION_MONITOR): a junction joining two nets, a connection the move broke", () => {
  let { d, c } = fresh();
  const w = addWire(d, [12.7, 96.52], [25.4, 96.52]);               // into R1 pin 1
  sch.setDragMode(c, "move");
  assert.ok(_.beginDrag(c, d.items.get("s1"), [25.4, 100.33], true)); _.moveDrag(c, [25.4, 113.03]);
  let m = _.collisionMarkers(d, sch.state.drag.collision, _.dragJunctions(d, sch.state.drag));
  assert.strictEqual(m.breaks.length, 1, "the wire is left behind: one broken connection");
  assert.deepStrictEqual([m.breaks[0].a, m.breaks[0].b].map(String).sort(), ["25.4,109.22", "25.4,96.52"].sort());
  assert.ok(Math.abs(m.breaks[0].r - 0.1524) < 1e-9, "radius: the wire's pen (above the 800 IU floor)");
  _.moveDrag(c, [25.4, 100.33]);
  m = _.collisionMarkers(d, sch.state.drag.collision, _.dragJunctions(d, sch.state.drag));
  assert.strictEqual(m.breaks.length, 0, "back in place: connected again");
  _.endDrag(c, false); assert.ok(w);
  ({ d, c } = fresh()); sch.setDragMode(c, "move");
  addWire(d, [165.1, 50.8], [190.5, 50.8]); const v = addWire(d, [177.8, 38.1], [177.8, 44.45]);
  assert.ok(_.beginDrag(c, v, [177.8, 44.45], true)); _.moveDrag(c, [177.8, 50.8]);
  m = _.collisionMarkers(d, sch.state.drag.collision, _.dragJunctions(d, sch.state.drag));
  assert.deepStrictEqual(m.junctions.map((j) => j.p), [[177.8, 50.8]], "the moved wire's end lands on another net's wire");
  assert.ok(Math.abs(m.junctions[0].r - 0.9144 * 1.5) < 1e-9);
  d.schSettings = { junctionDiameter: 1.524 };                      // Schematic Setup: a bigger junction dot
  m = _.collisionMarkers(d, sch.state.drag.collision, _.dragJunctions(d, sch.state.drag));
  assert.ok(Math.abs(m.junctions[0].r - 1.524 * 1.5) < 1e-9, "the preview junction's GetEffectiveDiameter() * 1.5");
  d.schSettings = { junctionDiameter: 0 };                          // "None": GetJunctionSize's 1 IU, then the 800 IU floor
  m = _.collisionMarkers(d, sch.state.drag.collision, _.dragJunctions(d, sch.state.drag));
  assert.ok(Math.abs(m.junctions[0].r - 0.08) < 1e-9);
  delete d.schSettings;
  _.endDrag(c, false);
  ({ d, c } = fresh());
  const g = K.createItem(d, _.rectangleNode([150, 150], [160, 160]));
  assert.ok(_.beginDrag(c, g, [150, 150], true)); assert.strictEqual(sch.state.drag.collision, null, "graphics only: no monitor"); _.endDrag(c, false);
});

// ---- the asynchronous sheet tool, then the checks over every fragment produced ----
async function testAsync(name, fn) { try { await fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
async function main() {
await testAsync("sheet: two corners, name and file prompts, the file created on the server (POST docs + snapshot 0), then KiCad's (sheet …) with instance data", async () => {
  const { d, c } = fresh();
  c.docs = [{ docId: "root-doc", path: "t.kicad_sch", docType: "kicad_sch" }, { docId: "pcb", path: "t.kicad_pcb", docType: "kicad_pcb" }, { docId: "pro", path: "t.kicad_pro", docType: "kicad_pro" }];
  c.project = { projectId: "proj-1", name: "Display name" }; c.docId = "root-doc"; c.apiCalls = [];
  c.api = async (path, opts) => { c.apiCalls.push({ path, opts }); if (/\/docs$/.test(path)) return { docId: "doc-2", path: JSON.parse(opts.body).path, docType: "kicad_sch", existing: false }; return { ok: true, docId: "doc-2", seq: 0, written: true }; };
  sch.setPrompt((title, initial, client, done) => { if (title === "Sheet name") done("Power"); else { assert.strictEqual(title, "Sheet file"); assert.strictEqual(initial, "Power.kicad_sch"); done(initial); } });
  sch.onActivate("sheet", c);
  assert.ok(sch.onPointerDown(ev(), [101.6, 88.9], c)); sch.onPointerMove(ev(), [127, 101.6], c); assert.deepStrictEqual(sch.state.draw.cur, [127, 101.6]);
  assert.ok(sch.onPointerDown(ev(), [127, 101.6], c));
  const job = sch.state.sheetJob; assert.ok(job && job.promise, "creation runs asynchronously"); assert.strictEqual(sch.state.draw, null);
  c.toasts.length = 0; assert.ok(sch.onPointerDown(ev(), [10, 10], c)); assert.strictEqual(sch.state.draw, null, "clicks while the request is out start nothing"); assert.ok(c.toasts.length);
  const item = await job.promise; assert.ok(item && item.kind === "sheet");
  assert.strictEqual(c.apiCalls.length, 2);
  assert.strictEqual(c.apiCalls[0].path, "/api/projects/proj-1/docs"); assert.strictEqual(c.apiCalls[0].opts.method, "POST");
  assert.deepStrictEqual(JSON.parse(c.apiCalls[0].opts.body), { path: "Power.kicad_sch", docType: "kicad_sch" });
  assert.strictEqual(c.apiCalls[1].path, "/api/docs/doc-2/snapshots?seq=0"); assert.strictEqual(c.apiCalls[1].opts.method, "POST"); assert.strictEqual(c.apiCalls[1].opts.headers["content-type"], "text/plain");
  const snap = K.parse(c.apiCalls[1].opts.body); assert.strictEqual(snap[0], "kicad_sch");
  assert.deepStrictEqual(kid(snap, "version"), ["version", 20250114]); assert.deepStrictEqual(kid(snap, "generator"), ["generator", "kicad-collab-web"]); assert.deepStrictEqual(kid(snap, "generator_version"), ["generator_version", "9.0"]);
  assert.ok(K.uuidOf(snap).length > 10); assert.deepStrictEqual(kid(snap, "paper"), ["paper", "A4"]); assert.deepStrictEqual(kid(snap, "lib_symbols"), ["lib_symbols"]);
  assert.deepStrictEqual(kid(snap, "sheet_instances"), ["sheet_instances", ["path", "/", ["page", "1"]]]); assert.strictEqual(K.parseDoc(c.apiCalls[1].opts.body).items.size, 0);
  assert.ok(c.docs.some((x) => x.docId === "doc-2" && x.path === "Power.kicad_sch"), "the new doc joined ctx.docs");
  const cm = lastCommit(c); assert.strictEqual(cm.label, "sheet"); assert.strictEqual(cm.changes[0].typeName, "SCH_SHEET"); assert.strictEqual(cm.changes[0].kind, "ADDED");
  const n = fragItem(cm.changes[0]);
  assert.deepStrictEqual(n.slice(0, 10), ["sheet", ["at", 101.6, 88.9], ["size", 25.4, 12.7], ["exclude_from_sim", "no"], ["in_bom", "yes"], ["on_board", "yes"], ["dnp", "no"], ["fields_autoplaced", "yes"], ["stroke", ["width", 0.1524], ["type", "solid"]], ["fill", ["color", 0, 0, 0, 0]]]);
  assert.strictEqual(n[10][0], "uuid");
  assert.deepStrictEqual(n[11], ["property", "Sheetname", "Power", ["at", 101.6, 88.1888, 0], ["effects", ["font", ["size", 1.27, 1.27]], ["justify", "left", "bottom"]]], "name sits border/2 + 4 IU + 0.5 × text size above");
  assert.deepStrictEqual(n[12], ["property", "Sheetfile", "Power.kicad_sch", ["at", 101.6, 102.1842, 0], ["effects", ["font", ["size", 1.27, 1.27]], ["justify", "left", "top"]]], "file sits border/2 + 4 IU + 0.4 × text size below");
  assert.deepStrictEqual(n[13], ["instances", ["project", "t", ["path", "/root-uuid", ["page", "2"]]]], "the path and project name this sheet's symbols record; page 2 of a 2-sheet project (quoted: a string to KiCad)");
  assert.strictEqual(n.length, 14);
  assert.ok(/\(page "2"\)/.test(cm.changes[0].sexpr) && /\(color 0 0 0 0\)/.test(cm.changes[0].sexpr), cm.changes[0].sexpr);
  const it = d.items.get(cm.changes[0].id); assert.strictEqual(it.name, "Power"); assert.strictEqual(it.file, "Power.kicad_sch"); assert.ok(it.movable);
  assert.deepStrictEqual(c.selected, { id: it.id }); assert.strictEqual(sch.state.sheetJob, null); assert.strictEqual(sch.state.tool, "sheet");
});

await testAsync("sheet: an existing file is referenced (no request) relative to the current sheet; a failed request toasts and places nothing; pages skip the ones in use", async () => {
  const { d, c } = fresh();
  c.docs = [{ docId: "root", path: "hw/main.kicad_sch", docType: "kicad_sch" }, { docId: "sub", path: "hw/sub/Power.kicad_sch", docType: "kicad_sch" }, { docId: "other", path: "lib/Old.kicad_sch", docType: "kicad_sch" }];
  c.docId = "root"; c.project = { projectId: "p" }; c.api = async () => { throw new Error("boom"); };
  assert.deepStrictEqual(await _.ensureSheetDoc(c, "Power.kicad_sch"), { file: "sub/Power.kicad_sch", docId: "sub", created: false });
  assert.deepStrictEqual(await _.ensureSheetDoc(c, "Old.kicad_sch"), { file: "../lib/Old.kicad_sch", docId: "other", created: false });
  await assert.rejects(_.ensureSheetDoc(c, "New.kicad_sch"), /boom/);
  sch.setPrompt((title, initial, client, done) => done(title === "Sheet name" ? "New" : initial));
  sch.onActivate("sheet", c); sch.onPointerDown(ev(), [10.16, 10.16], c); sch.onPointerDown(ev(), [30.48, 20.32], c);
  const before = c.log.length; await sch.state.sheetJob.promise;
  assert.strictEqual(c.log.length, before, "nothing committed"); assert.ok(c.toasts.some((m) => /Could not create the sheet: boom/.test(m))); assert.strictEqual(sch.state.sheetJob, null);
  assert.strictEqual(_.nextPage(c, d), 3);
  const sn = _.sheetNode([50.8, 50.8], [63.5, 63.5], "X", "X.kicad_sch"); sn.push(["instances", ["project", "t", ["path", "/root-uuid", ["page", "3"]]]]); K.createItem(d, sn);
  assert.strictEqual(_.nextPage(c, d), 4);
  assert.deepStrictEqual(_.sheetInstance(c, d, 4), ["instances", ["project", "t", ["path", "/root-uuid", ["page", "4"]]]]);
  assert.strictEqual(_.sheetInstance(c, K.parseDoc('(kicad_sch (version 20250114) (generator "eeschema") (paper "A4"))'), 2), null, "no instance data without a known sheet path");
  // a subdirectory in the file name goes to the server verbatim, relative to this sheet's directory; the extension is added
  const calls = []; c.api = async (path, opts) => { calls.push({ path, opts }); return path.endsWith("/docs") ? { docId: "n1", path: JSON.parse(opts.body).path, docType: "kicad_sch", existing: true } : {}; };
  assert.deepStrictEqual(await _.ensureSheetDoc(c, "parts/Regs"), { file: "parts/Regs.kicad_sch", docId: "n1", created: false });
  assert.strictEqual(calls.length, 1, "an existing server doc gets no snapshot"); assert.deepStrictEqual(JSON.parse(calls[0].opts.body), { path: "hw/parts/Regs.kicad_sch", docType: "kicad_sch" });
  delete c.api; await assert.rejects(_.ensureSheetDoc(c, "Nope.kicad_sch"), /cannot create/);
  sch.setPrompt((t, i, cl, done) => done(null));
});


test("AnalyzePoint: exits per layer decide junctions; IsExplicitJunctionAllowed breaks crossings", () => {
  const { d } = fresh();
  assert.strictEqual(_.analyzePoint(d, [63.5, 63.5], false).isJunction, true, "the T at j1 (three wire exits)");
  assert.strictEqual(_.analyzePoint(d, [139.7, 50.8], false).isJunction, false, "a corner is two exits");
  assert.strictEqual(_.explicitJunctionAllowed(d, [101.6, 63.5]), false, "the middle of one wire: two exits even broken");
  addWire(d, [88.9, 63.5], [114.3, 63.5]);                                      // crosses w4's middle
  assert.strictEqual(_.analyzePoint(d, [101.6, 63.5], false).isJunction, false, "a plain crossing is no junction");
  assert.strictEqual(_.explicitJunctionAllowed(d, [101.6, 63.5]), true, "but a junction may be placed there (four exits once broken)");
  assert.strictEqual(_.explicitJunctionNeeded(d, [139.7, 50.8], [{ kind: "wire", a: [139.7, 50.8], b: [152.4, 50.8] }]), true, "an extra line makes the corner a T");
  assert.deepStrictEqual(_.previewJunctions(d, [{ kind: "wire", a: [139.7, 38.1], b: [139.7, 50.8] }]), [[139.7, 50.8]], "the preview shows the dot the drop will add");
});

test("finishSegments: a new wire continuing an existing one merges with it; existing pins on a new wire get junctions; TrimWire across a two-pin symbol", () => {
  let { d, c } = fresh();
  sch.onActivate("wire", c); sch.onPointerDown(ev(), [139.7, 63.5], c); sch.onPointerDown(Object.assign(ev(), { detail: 2 }), [139.7, 76.2], c);
  let cm = lastCommit(c);                                                       // w6 runs 50.8..63.5 at x 139.7: collinear and touching
  assert.deepStrictEqual(cm.changes.map((x) => [x.kind, x.id]), [["MODIFIED", "w6"]], "CleanUp keeps the existing wire and extends it");
  assert.deepStrictEqual(ptsOf(fragItem(cm.changes[0])), [[139.7, 50.8], [139.7, 76.2]]);
  ({ d, c } = fresh());
  sch.onActivate("wire", c); sch.onPointerDown(ev(), [25.4, 88.9], c); sch.onPointerDown(Object.assign(ev(), { detail: 2 }), [25.4, 116.84], c);   // straight through R1 (pins at 96.52 and 104.14)
  cm = lastCommit(c);
  const lines = cm.changes.filter((x) => x.typeName === "SCH_LINE" && x.kind !== "REMOVED").map((x) => ptsOf(fragItem(x)));
  assert.deepStrictEqual(lines.sort((a, b) => a[0][1] - b[0][1]), [[[25.4, 88.9], [25.4, 96.52]], [[25.4, 104.14], [25.4, 116.84]]], "the part between the two pins is trimmed away");
  ({ d, c } = fresh());
  sch.onActivate("wire", c); sch.onPointerDown(ev(), [127, 63.5], c); sch.onPointerDown(Object.assign(ev(), { detail: 2 }), [152.4, 63.5], c);   // across w6's end (139.7, 63.5)
  cm = lastCommit(c);
  assert.ok(cm.changes.some((x) => x.typeName === "SCH_JUNCTION" && atOf(fragItem(x))[0] === 139.7), "an existing wire end on the new wire's middle: junction");
  assert.strictEqual(cm.changes.filter((x) => x.typeName === "SCH_LINE" && x.kind === "ADDED").length, 2, "and the new wire is split there");
  ({ d, c } = fresh());
  sch.onActivate("wire", c); sch.onPointerDown(ev(), [152.4, 101.6], c); sch.onPointerMove(ev(), [165.1, 101.6], c); sch.onPointerMove(ev(), [158.75, 101.6], c);
  sch.onPointerDown(Object.assign(ev(), { detail: 2 }), [158.75, 101.6], c);
  assert.deepStrictEqual(lastCommit(c).changes.map((x) => ptsOf(fragItem(x))), [[[152.4, 101.6], [158.75, 101.6]]], "a backtrack is merged away (simplifyWireList)");
  assert.deepStrictEqual(_.simplifyWireList([[[0, 0], [10, 0]], [[10, 0], [5, 0]], [[5, 0], [5, 5]]]), [[[0, 0], [10, 0]], [[5, 0], [5, 5]]]);
});

test("IsTerminalPoint: wires end on junctions, labels, sheet pins and bus entries; buses on buses and labels; computeBreakPoint forces a sheet pin's leg horizontal", () => {
  const { d, c } = fresh();
  assert.ok(_.isTerminalPoint(d, [63.5, 63.5], "wire"), "junction"); assert.ok(_.isTerminalPoint(d, [55.88, 63.5], "wire"), "label (on a wire)");
  K.createItem(d, _.labelNode("label", "LONE", [177.8, 177.8], 0)); assert.ok(_.isTerminalPoint(d, [177.8, 177.8], "wire"), "any label");
  K.createItem(d, _.busEntryNode([200, 100], 2.54, 2.54)); assert.ok(_.isTerminalPoint(d, [202.54, 102.54], "wire"), "bus entry end");
  assert.ok(!_.isTerminalPoint(d, [177.8, 150], "wire")); assert.ok(!_.isTerminalPoint(d, [63.5, 63.5], "bus"), "a bus does not stop on a wire junction");
  const sh = _.sheetNode([100, 140], [130, 160], "S", "s.kicad_sch"); sh.splice(sh.length, 0, _.sheetPinNode("IN", [100, 147.32], "left")); K.createItem(d, sh);
  assert.ok(_.isTerminalPoint(d, [100, 147.32], "wire"), "sheet pin");
  const seg = [[100, 147.32], [100, 147.32]], next = [[100, 147.32], [100, 147.32]];
  const end = _.computeBreakPoint(d, seg, next, [100, 152.4], "90", false, 1.27);
  assert.deepStrictEqual(end, [98.73, 152.4], "a cursor on the pin's x is pushed one grid outside the sheet");
  assert.deepStrictEqual(seg[1], [98.73, 147.32], "the first leg leaves the pin horizontally");
});

test("dangling ends: unconnected wire ends, pins and labels get KiCad's indicators; auto-start picks the line kind", () => {
  const { d } = fresh();
  const dang = _.danglingEnds(d), at = (w, p) => dang.some((x) => x.what === w && Math.abs(x.p[0] - p[0]) < 1e-6 && Math.abs(x.p[1] - p[1]) < 1e-6);
  assert.ok(at("wire", [50.8, 63.5]) && at("wire", [76.2, 63.5]), "the T's free ends"); assert.ok(!at("wire", [63.5, 63.5]), "the junction ties the T");
  assert.ok(at("pin", [25.4, 96.52]) && at("pin", [25.4, 104.14]), "R1's open pins"); assert.ok(!dang.some((x) => x.what === "label"), "NETA sits on a wire");
  assert.ok(!at("wire", [139.7, 50.8]), "a corner is joined");
  K.createItem(d, _.labelNode("label", "FLOAT", [177.8, 177.8], 0)); assert.ok(_.danglingEnds(d).some((x) => x.what === "label"), "a label on nothing dangles");
  assert.strictEqual(_.autostartKind(d, [25.4, 96.52]), "wire", "an open pin starts a wire"); assert.strictEqual(_.autostartKind(d, [50.8, 63.5]), "wire", "a free wire end too");
  assert.strictEqual(_.autostartKind(d, [63.5, 63.5]), null, "a connected point does not");
  K.createItem(d, _.labelNode("label", "D[0..3]", [190.5, 177.8], 0)); sch.state.docGen++; assert.strictEqual(_.autostartKind(d, [190.5, 177.8]), "bus", "a bus label starts a bus");
  K.createItem(d, _.lineNode("polyline", [10, 190], [30, 190])); sch.state.docGen++; assert.strictEqual(_.autostartKind(d, [30, 190]), "polyline", "a graphic line end continues the line");
});

test("tool switching mid-operation is refused (vetoTool) with KiCad's infobar text; Ctrl+Z with a label on the cursor drops it", () => {
  const { c } = fresh();
  assert.strictEqual(sch.vetoTool("label", c), false, "nothing in flight");
  sch.onActivate("wire", c); sch.onPointerDown(ev(), [10.16, 10.16], c);
  c.toasts.length = 0; assert.strictEqual(sch.vetoTool("label", c), true); assert.deepStrictEqual(c.toasts, ["Press <ESC> to cancel drawing."]);
  _.cancelWire(c); sch.onActivate("select", c);
  _.startCarry(c, "symbol", _.symbolNode(c.doc, "Device:R", [0, 0], 0, ""), [50, 50]);
  c.toasts.length = 0; assert.strictEqual(sch.vetoTool("wire", c), true); assert.deepStrictEqual(c.toasts, ["Press <ESC> to cancel symbol creation."]);
  sch.state.carry = null;
  _.startCarry(c, "label", _.labelNode("label", "X", [0, 0], 0), [50, 50]);
  c.toasts.length = 0; assert.strictEqual(sch.vetoTool("wire", c), true); assert.deepStrictEqual(c.toasts, ["Press <ESC> to cancel item creation."]);
  sch.state.carry = null; assert.strictEqual(sch.vetoTool("wire", c), false);
});

test("point editor: corners, edges and centre of a rectangle; circle radius; arc ends keep the centre (SCH_POINT_EDITOR, \"Move Point\")", () => {
  const { d, c } = fresh(); sch.onActivate("select", c);
  const rect = K.createItem(d, _.rectangleNode([101.6, 127], [127, 139.7]));
  const pe = (id, at, to) => { sch.state.sel = id; assert.ok(_.pointEditStart(c, at, {}), "a handle at " + at); _.pointEditMove(c, to, {}); return _.pointEditEnd(c, true); };
  assert.deepStrictEqual(_.editHandles(_.editPoints(d, rect)).length, 10, "four corners, the centre, RECT_RADIUS, four edge midpoints");
  assert.deepStrictEqual(_.editPoints(d, rect).circles, [5], "RECT_RADIUS is drawn as a circle");
  let ch = pe(rect.id, [127, 139.7], [134.62, 144.78]);
  assert.strictEqual(lastCommit(c).label, "Move Point");
  let n = fragItem(ch[0]); assert.deepStrictEqual([kid(n, "start").slice(1), kid(n, "end").slice(1)], [[101.6, 127], [134.62, 144.78]]);
  ch = pe(rect.id, [101.6, (127 + 144.78) / 2], [96.52, 120]);               // the left edge: only x moves
  n = fragItem(ch[0]); assert.deepStrictEqual([kid(n, "start").slice(1), kid(n, "end").slice(1)], [[96.52, 127], [134.62, 144.78]]);
  ch = pe(rect.id, [115.57, 135.89], [120.65, 140.97]);                 // the centre moves it whole
  n = fragItem(ch[0]); assert.deepStrictEqual([kid(n, "start").slice(1), kid(n, "end").slice(1)], [[101.6, 132.08], [139.7, 149.86]]);
  ch = pe(rect.id, kid(n, "end").slice(1), [0, 0]);                         // a corner dragged past the opposite one stops 1 mil short
  n = fragItem(ch[0]); assert.deepStrictEqual(kid(n, "end").slice(1).map((v, i) => +(v - kid(n, "start")[i + 1]).toFixed(4)), [0.0254, 0.0254]);
  const circ = K.createItem(d, ["circle", ["center", 50.8, 152.4], ["radius", 2.54], ["stroke", ["width", 0], ["type", "default"]], ["fill", ["type", "none"]]]);
  ch = pe(circ.id, [53.34, 152.4], [50.8, 157.48]); n = fragItem(ch[0]); assert.strictEqual(kid(n, "radius")[1], 5.08); assert.deepStrictEqual(kid(n, "center").slice(1), [50.8, 152.4]);
  const arc = K.createItem(d, _.arcNode([60.96, 152.4], [63.5, 149.86], [66.04, 152.4]));   // centre (63.5, 152.4), r 2.54, over the top
  ch = pe(arc.id, [60.96, 152.4], [58.42, 152.4]); n = fragItem(ch[0]);
  assert.deepStrictEqual([kid(n, "start").slice(1), kid(n, "end").slice(1)], [[58.42, 152.4], [68.58, 152.4]], "both ends on the new radius");
  assert.deepStrictEqual(kid(n, "mid").slice(1), [63.5, 147.32], "the same side as before");
  const rr = K.createItem(d, _.rectangleNode([0, 0], [10.16, 6.35])); kid(rr.node, "end"); rr.node.splice(rr.node.indexOf(kid(rr.node, "end")) + 1, 0, ["radius", 1.27]); K.replaceChange(d, rr);
  assert.deepStrictEqual(_.editPoints(d, rr).pts[5], [8.89, 0], "RECT_RADIUS sits at ( right - radius, top )");
  ch = pe(rr.id, [8.89, 0], [2.54, 2.54]); n = fragItem(ch[0]);
  assert.strictEqual(kid(n, "radius")[1], 3.175, "clamped to half the shorter side");
  assert.ok(n.indexOf(kid(n, "radius")) === n.indexOf(kid(n, "end")) + 1, "(radius) right after (end), as the writer puts it");
  ch = pe(rr.id, [10.16 - 3.175, 0], [12.7, 0]); n = fragItem(ch[0]); assert.ok(!kid(n, "radius"), "radius 0: no (radius) token");
  const before = c.log.length; sch.state.sel = rect.id; assert.ok(!_.pointEditStart(c, [200, 200], {}), "away from the handles: not the point editor");
  _.pointEditStart(c, kid(n, "start").slice(1), {}); _.pointEditEnd(c, true); assert.strictEqual(c.log.length, before, "a click without a move commits nothing");
});

test("point editor: wire ends, joined graphic lines follow, a sheet's pins stay on their edges with their wires", () => {
  const { d, c } = fresh(); sch.onActivate("select", c);
  const pe = (id, at, to) => { sch.state.sel = id; c.selected = null; assert.ok(_.pointEditStart(c, at, {}), "a handle at " + at); _.pointEditMove(c, to, {}); return _.pointEditEnd(c, true); };
  let ch = pe("w4", [101.6, 76.2], [109.22, 76.2]);
  assert.deepStrictEqual(ch.map((x) => [x.id, ptsOf(fragItem(x))]), [["w4", [[101.6, 50.8], [109.22, 76.2]]]], "only the wire: KiCad's line editor drags notes-layer lines alone");
  const l1 = K.createItem(d, _.lineNode("polyline", [10.16, 170.18], [20.32, 170.18])), l2 = K.createItem(d, _.lineNode("polyline", [20.32, 170.18], [20.32, 180.34]));
  ch = pe(l1.id, [20.32, 170.18], [22.86, 167.64]);
  assert.deepStrictEqual(ch.map((x) => ptsOf(fragItem(x))).sort(), [[[10.16, 170.18], [22.86, 167.64]], [[22.86, 167.64], [20.32, 180.34]]].sort(), "the joined graphic line keeps the joint");
  const sh = _.sheetNode([127, 152.4], [152.4, 172.72], "S", "s.kicad_sch"); sh.push(_.sheetPinNode("OUT", [152.4, 160.02], "right"), _.sheetPinNode("IN", [127, 170.18], "left"));
  const sheet = K.createItem(d, sh); addWire(d, [152.4, 160.02], [165.1, 160.02]);
  c.selected = { id: sheet.id }; sch.state.sel = null;
  assert.ok(_.pointEditStart(c, [152.4, (152.4 + 172.72) / 2], {})); _.pointEditMove(c, [160.02, 150], {}); ch = _.pointEditEnd(c, true);
  const sn = fragItem(ch.find((x) => x.id === sheet.id)); assert.deepStrictEqual(kid(sn, "size").slice(1), [33.02, 20.32], "the right edge moved");
  const pins = kids(sn, "pin").map((p) => atOf(p).slice(0, 2)); assert.deepStrictEqual(pins, [[160.02, 160.02], [127, 170.18]], "the right pin rides the edge, the left one stays");
  const wire = ch.find((x) => x.typeName === "SCH_LINE"); assert.ok(wire, "the wire on the pin follows"); assert.deepStrictEqual(ptsOf(fragItem(wire))[0], [160.02, 160.02]);
  c.selected = { id: sheet.id };
  assert.ok(_.pointEditStart(c, [127, 172.72], {})); _.pointEditMove(c, [127, 165.1], {}); ch = _.pointEditEnd(c, true);
  assert.strictEqual(kid(fragItem(ch[0]), "size")[2], 17.78, "the bottom stops where the left pin still fits");
});

test("ghostSegs: the in-flight wire is offered to peers as mm segments", () => {
  const { d, c } = fresh();
  assert.deepStrictEqual(sch.ghostSegs(c), [], "nothing in flight");
  sch.onActivate("wire", c); sch.onPointerDown(ev(), [25.4, 25.4], c); sch.onPointerMove(ev(), [50.8, 38.1], c);
  // the committed anchor plus the live 90-degree leg, in mm with the wire's own width
  assert.deepStrictEqual(sch.ghostSegs(c), [[25.4, 25.4, 50.8, 25.4, 0.1524], [50.8, 25.4, 50.8, 38.1, 0.1524]]);
  sch.onPointerDown(ev(), [50.8, 38.1], c); sch.onPointerDown(Object.assign(ev(), { detail: 2 }), [50.8, 38.1], c);   // a double click ends it
  assert.strictEqual(sch.state.wire, null);
  assert.deepStrictEqual(sch.ghostSegs(c), [], "finishing clears it, so peers stop drawing the stale leg");
});

test("every fragment is in the copyable-only grammar the desktop parser accepts", () => {
  assert.ok(allSexprs.length > 15);
  for (const c of allSexprs) {
    const roots = K.parseAll(c.sexpr);
    // no (kicad_sch …) wrapper: SCH_IO_KICAD_SEXPR_PARSER::ParseSchematic has no case for it
    // in copyable-only mode and throws, which drops the op with no error anywhere.
    assert.ok(!roots.some((r) => r[0] === "kicad_sch"), "no document wrapper: " + c.sexpr.slice(0, 40));
    assert.ok(roots.every((r) => r[0] === "lib_symbols" || SCH_ITEM_TOKENS.has(r[0])), "item roots only: " + roots.map((r) => r[0]));
    const items = roots.filter((r) => r[0] !== "lib_symbols");
    assert.strictEqual(items.length, 1); assert.strictEqual(idOf(items[0]), c.id);
    const once = K.serialize(K.parse(c.sexpr)); assert.strictEqual(K.serialize(K.parse(once)), once, "parse/serialise is stable");
  }
});

const SAMPLE = process.env.SCH_SAMPLE || path.join(__dirname, "..", "..", "..", "demos", "stickhub", "StickHub.kicad_sch");
if (fs.existsSync(SAMPLE)) {
  test("StickHub sample: wire onto a real wire's middle, rotate a real mirrored symbol", () => {
    const big = K.parseDoc(fs.readFileSync(SAMPLE, "utf8")), cb = makeCtx(big); sch.onDocChanged(cb);
    // a long horizontal wire with a free grid point on it, and free space above that point
    const busy = (x, y, r) => Array.from(big.items.values()).some((it) => it.bbox && x > it.bbox[0] - r && x < it.bbox[2] + r && y > it.bbox[1] - r && y < it.bbox[3] + r);
    let mid = null, w = null;
    for (const it of big.items.values()) {
      if (it.kind !== "wire") continue; const p = ptsOf(it.node); if (p.length !== 2 || p[0][1] !== p[1][1] || Math.abs(p[1][0] - p[0][0]) < 7.62) continue;
      const x = K.snap(Math.min(p[0][0], p[1][0]) + 3.81, 1.27), y = p[0][1];
      if (K.wireEndsAt(big, x, y, 1e-3).length || _.pinsAt(big, x, y).length || _.junctionAt(big, x, y)) continue;
      if (busy(x, y - 5.08, 2) || busy(x, y - 2.54, 0.4)) continue;
      mid = [x, y]; w = it; break;
    }
    assert.ok(w, "found a candidate wire");
    sch.onActivate("wire", cb); sch.onPointerDown(ev(), [mid[0], mid[1] - 5.08], cb); sch.onPointerDown(ev(), mid, cb);
    assert.strictEqual(sch.state.wire, null, "finished on the wire");
    const js = lastCommit(cb).changes.filter((x) => x.typeName === "SCH_JUNCTION"); assert.strictEqual(js.length, 1);
    assert.deepStrictEqual(atOf(fragItem(js[0])).slice(0, 2), mid);
    assert.deepStrictEqual(ptsOf(fragItem(lastCommit(cb).changes[0])), [[mid[0], mid[1] - 5.08], mid]);
    const gnd = big.items.get("090d21fc-658e-4e52-ac1d-2a96842b3b13");           // (at … 90) (mirror x)
    const before = _.tFrom(90, "x");
    sch.onActivate("select", cb); cb.selected = { id: gnd.id }; assert.ok(sch.onKey("r", {}, cb));
    const n = fragItem(lastCommit(cb).changes[0]); const m = kid(n, "mirror");
    assert.deepStrictEqual(_.tFrom(atOf(n)[2], m ? str(m[1]) : ""), _.mul(_.RCCW, before));
    assert.strictEqual(fragItem(lastCommit(cb).changes[0])[0], "symbol");
    const c17 = big.items.get("13f55e82-3c7c-40b8-a54b-9ac60e170cc1");
    const dup = _.symbolNode(big, c17.lib, [100, 100], 0, ""); assert.strictEqual(kids(dup, "property")[0][2], "C?"); assert.strictEqual(kids(dup, "property")[1][2], "Csmall");
    assert.ok(kids(dup, "property").some((q) => q[1] === "Voltage"), "custom library fields are copied like KiCad does");
  });
} else console.log("  skip StickHub sample (set SCH_SAMPLE to run it)");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
