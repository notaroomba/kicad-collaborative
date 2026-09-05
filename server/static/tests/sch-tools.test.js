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
    commit(changes, label) {
      // like app.js: the pre-change item must still be the original when commit is called
      const before = changes.map((c) => { const it = doc.items.get(c.id); return it ? K.serializeItem(doc, it) : null; });
      ctx.log.push({ changes, label, before });
      for (const c of changes) { if (c.sexpr) allSexprs.push(c); assert.ok(K.applyChange(doc, c, IU), "applyChange accepted " + c.kind + " " + c.id); }
    },
    applyLocal(changes) { for (const c of changes) K.applyChange(doc, c, IU); },
    requestRender() {}, toast(m) { ctx.toasts.push(m); }, enterSheet() {}, setTool(t) { sch.onActivate(t, ctx); },
  };
  return ctx;
}
const ev = (x, y) => ({ button: 0, clientX: x || 0, clientY: y || 0 });
const lastCommit = (ctx) => ctx.log[ctx.log.length - 1];
const byKind = (changes, kind) => changes.filter((c) => c.kind === kind);
function fragRoot(sexpr) { const trees = K.parseAll(sexpr); assert.strictEqual(trees.length, 1, "one root"); return trees[0]; }
function fragItem(change) { const root = fragRoot(change.sexpr); assert.strictEqual(root[0], "kicad_sch"); const it = root.slice(1).find((c) => Array.isArray(c) && K.uuidOf(c) === change.id); assert.ok(it, "fragment carries item " + change.id); return it; }

console.log("sch-tools under node");
const doc = K.parseDoc(SHEET);
const ctx = makeCtx(doc);
sch.onDocChanged(ctx);

test("module registers tools with KiCad-style hotkeys", () => {
  assert.strictEqual(sch.id, "sch");
  assert.deepStrictEqual(sch.tools.map((t) => t.key), ["W", "B", "Z", "J", "Q", "L", "Shift+L", "Shift+H", "T", "A"]);
  for (const t of sch.tools) assert.ok(t.icon.includes("<") && t.label && t.id);
});

test("wire ending on the middle of another wire gets a junction (T)", () => {
  sch.onActivate("wire", ctx);
  assert.ok(sch.onPointerDown(ev(), [88.9, 63.5], ctx));
  sch.onPointerMove(ev(), [101.5, 63.6], ctx);                    // snaps onto w4 at (101.6, 63.5) and auto-finishes
  sch.onPointerDown(ev(), [101.5, 63.6], ctx);
  assert.strictEqual(sch.state.wire, null, "wire finished on connection");
  const c = lastCommit(ctx); assert.strictEqual(c.label, "wire");
  const wires = byKind(c.changes, "ADDED").filter((x) => x.typeName === "SCH_LINE"), js = c.changes.filter((x) => x.typeName === "SCH_JUNCTION");
  assert.strictEqual(wires.length, 1); assert.strictEqual(js.length, 1);
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
  sch.onPointerDown(ev(), [165.1, 101.6], ctx);                  // |dx| >= |dy| -> horizontal first
  assert.deepStrictEqual(sch.state.wire.pts, [[152.4, 88.9], [165.1, 88.9], [165.1, 101.6]]);
  assert.ok(sch.onKey("/", {}, ctx));
  sch.onPointerMove(ev(), [177.8, 114.3], ctx);
  sch.onPointerDown(ev(), [177.8, 114.3], ctx);                  // flipped -> vertical first
  assert.deepStrictEqual(sch.state.wire.pts.slice(3), [[165.1, 114.3], [177.8, 114.3]]);
  assert.ok(sch.onKey("Backspace", {}, ctx)); assert.strictEqual(sch.state.wire.pts.length, 3, "Backspace drops the last leg");
  sch.onPointerDown(ev(), [177.8, 114.3], ctx);
  assert.ok(sch.onKey("Enter", {}, ctx)); assert.strictEqual(sch.state.wire, null);
  const c = lastCommit(ctx);
  const segsMade = c.changes.filter((x) => x.typeName === "SCH_LINE").map((x) => ptsOf(fragItem(x)));
  assert.deepStrictEqual(segsMade, [[[152.4, 88.9], [165.1, 88.9]], [[165.1, 88.9], [165.1, 114.3]], [[165.1, 114.3], [177.8, 114.3]]], "collinear run merged");
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
  assert.ok(/^\(kicad_sch \(version 20250114\) \(generator "kicad-collab-web"\) \(label NET_X \(at 88\.9 76\.2 0\) \(effects \(font \(size 1\.27 1\.27\)\) \(justify left bottom\)\) \(uuid "[^"]+"\)\)\)$/.test(c.changes[0].sexpr), c.changes[0].sexpr);
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
  sch.onActivate("noconnect", ctx); assert.ok(sch.state.carry && sch.state.carry.kind === "no_connect");
  sch.onPointerDown(ev(), [76.2, 88.9], ctx);
  let n = fragItem(lastCommit(ctx).changes[0]); assert.deepStrictEqual(n.slice(0, 2), ["no_connect", ["at", 76.2, 88.9]]);
  sch.onActivate("busentry", ctx);
  assert.ok(sch.onKey("r", {}, ctx), "R rotates the carried entry");
  sch.onPointerDown(ev(), [190.5, 63.5], ctx);
  n = fragItem(lastCommit(ctx).changes[0]); assert.deepStrictEqual(n.slice(0, 4), ["bus_entry", ["at", 190.5, 63.5], ["size", 2.54, -2.54], ["stroke", ["width", 0], ["type", "default"]]]);
  sch.onActivate("junction", ctx);
  sch.onPointerDown(ev(), [63.5, 63.5], ctx);                    // already one there
  assert.ok(ctx.toasts.some((m) => /already/.test(m)));
  sch.onActivate("bus", ctx);
  sch.onPointerDown(ev(), [203.2, 25.4], ctx); sch.onPointerDown(ev(), [215.9, 25.4], ctx); sch.onKey("Enter", {}, ctx);
  n = fragItem(lastCommit(ctx).changes[0]); assert.strictEqual(n[0], "bus"); assert.strictEqual(lastCommit(ctx).changes[0].typeName, "SCH_LINE");
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

test("mirror (X / Y) writes (mirror x|y), toggles off again, and composes with rotation like KiCad", () => {
  ctx.selected = { id: "s1" };
  assert.ok(sch.onKey("x", {}, ctx));
  let n = fragItem(lastCommit(ctx).changes[0]); assert.deepStrictEqual(kid(n, "mirror"), ["mirror", "x"]); assert.strictEqual(atOf(n)[2], 0);
  assert.strictEqual(n.findIndex((x) => Array.isArray(x) && x[0] === "mirror"), n.findIndex((x) => Array.isArray(x) && x[0] === "at") + 1, "(mirror) follows (at)");
  sch.onKey("x", {}, ctx); n = fragItem(lastCommit(ctx).changes[0]); assert.strictEqual(kid(n, "mirror"), null);
  sch.onKey("y", {}, ctx); n = fragItem(lastCommit(ctx).changes[0]); assert.deepStrictEqual(kid(n, "mirror"), ["mirror", "y"]);
  sch.onKey("r", {}, ctx); n = fragItem(lastCommit(ctx).changes[0]);
  assert.deepStrictEqual([atOf(n)[2], str(kid(n, "mirror")[1])], [90, "x"], "CCW turn of a Y-mirrored symbol is (at … 90) (mirror x), as KiCad stores it");
  const T = _.tFrom(90, "x"); assert.deepStrictEqual(T, _.mul(_.RCCW, _.tFrom(0, "y")), "transform algebra agrees");
  // every orientation × every op survives the (rot, mirror) search
  for (const rot of [0, 90, 180, 270]) for (const m of ["", "x", "y"]) for (const op of ["ccw", "cw", "x", "y"]) {
    const node = ["symbol", ["lib_id", "Device:R"], ["at", 0, 0, rot]]; if (m) node.push(["mirror", m]);
    const want = _.mul({ ccw: _.RCCW, cw: [0, -1, 1, 0], x: _.MX, y: _.MY }[op], _.tFrom(rot, m));
    const o = _.orientSymbol(node, op); assert.deepStrictEqual(_.tFrom(o.rot, o.mirror), want, `${rot}/${m || "-"} ${op}`);
    assert.deepStrictEqual(_.tFrom(atOf(node)[2], kid(node, "mirror") ? str(kid(node, "mirror")[1]) : ""), want);
  }
  sch.onKey("x", {}, ctx); sch.onKey("r", {}, ctx); sch.onKey("r", {}, ctx); sch.onKey("r", {}, ctx);   // (90,x) -x-> 90 -> 180 -> 270 -> 0
  n = fragItem(lastCommit(ctx).changes[0]); assert.deepStrictEqual([atOf(n)[2], kid(n, "mirror")], [0, null]);
  assert.deepStrictEqual(atOf(kids(n, "property")[0]).slice(0, 2), [27.432, 99.06], "the field offsets follow the same group action home");
  const parsedBack = K.parseDoc(lastCommit(ctx).changes[0].sexpr); assert.ok(parsedBack.items.get("s1"), "fragment parses as a sheet holding the symbol");
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
  assert.ok(c.changes[0].sexpr.includes("(lib_symbols (symbol Device:R"), "fragment embeds the library symbol");
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
  sch.onActivate("wire", c); sch.onPointerDown(ev(), [152.4, 88.9], c); sch.onPointerMove(ev(), [165.1, 101.6], c); sch.onPointerDown(ev(), [165.1, 101.6], c);
  assert.deepStrictEqual(sch.state.wire.pts, [[152.4, 88.9], [165.1, 101.6]]);
  sch.state.wire = null; sch.onActivate("select", c);
  sch.setLineMode(c, "45");
  sch.onActivate("wire", c); sch.onPointerDown(ev(), [152.4, 88.9], c); sch.onPointerMove(ev(), [177.8, 101.6], c); sch.onPointerDown(ev(), [177.8, 101.6], c);
  assert.deepStrictEqual(sch.state.wire.pts, [[152.4, 88.9], [165.1, 88.9], [177.8, 101.6]], "straight run then 45°");
  sch.state.wire = null; sch.onActivate("select", c);
  sch.setLineMode(c, "90");
});

test("leaving the tool keeps the fixed segments; view-only ignores editing keys", () => {
  const d3 = K.parseDoc(SHEET), c3 = makeCtx(d3); sch.onDocChanged(c3);
  sch.onActivate("wire", c3); sch.onPointerDown(ev(), [10.16, 10.16], c3); sch.onPointerDown(ev(), [20.32, 10.16], c3);
  sch.onActivate("select", c3);
  assert.strictEqual(c3.log.length, 1); assert.strictEqual(sch.state.wire, null);
  c3.viewOnly = true; assert.strictEqual(sch.onKey("w", {}, c3), false);
});

test("every fragment is a kicad_sch document the desktop parser can load", () => {
  assert.ok(allSexprs.length > 15);
  for (const c of allSexprs) {
    const root = fragRoot(c.sexpr);
    assert.strictEqual(root[0], "kicad_sch"); assert.deepStrictEqual(kid(root, "version"), ["version", 20250114]); assert.deepStrictEqual(kid(root, "generator"), ["generator", "kicad-collab-web"]);
    const items = root.slice(1).filter((x) => Array.isArray(x) && !["version", "generator", "lib_symbols"].includes(x[0]));
    assert.strictEqual(items.length, 1); assert.strictEqual(K.uuidOf(items[0]), c.id);
    const once = K.serialize(K.parse(c.sexpr)); assert.strictEqual(K.serialize(K.parse(once)), once, "parse/serialise is stable");
  }
});

const SAMPLE = process.env.SCH_SAMPLE || "/private/tmp/claude-502/-Users-roomba-Documents-GitHub-kicad-collaborative/dbbcf49c-094f-41fc-be3a-cd8a1023d083/scratchpad/shape-test/orig/StickHub.kicad_sch";
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
    assert.strictEqual(K.parseDoc(lastCommit(cb).changes[0].sexpr).items.get(gnd.id).kind, "symbol");
    const c17 = big.items.get("13f55e82-3c7c-40b8-a54b-9ac60e170cc1");
    const dup = _.symbolNode(big, c17.lib, [100, 100], 0, ""); assert.strictEqual(kids(dup, "property")[0][2], "C?"); assert.strictEqual(kids(dup, "property")[1][2], "Csmall");
    assert.ok(kids(dup, "property").some((q) => q[1] === "Voltage"), "custom library fields are copied like KiCad does");
  });
} else console.log("  skip StickHub sample (set SCH_SAMPLE to run it)");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
