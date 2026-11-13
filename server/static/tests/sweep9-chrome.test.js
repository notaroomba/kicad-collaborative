// sweep9-chrome.test.js — the editor frame's chrome against KiCad: the wheel (WX_VIEW_CONTROLS::onWheel and the zoom
// controllers), the mouse preferences' scroll-modifier grid (PANEL_MOUSE_SETTINGS), the view preset switcher
// (EDA_VIEW_SWITCHER), the Search pane's Groups and Drills tabs (GROUP / DRILL_SEARCH_HANDLER) and the menu bars.
// Run: node server/static/tests/sweep9-chrome.test.js
"use strict";
const path = require("path"), assert = require("assert");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const WEB = path.join(__dirname, "..", "..", "web");
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [path.join(WEB, ...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const W = load(["editor", "wheel-model.ts"]), V = load(["editor", "view-switcher-model.ts"]), Q = load(["editor", "panels", "search-model.ts"]), T = load(["tables.ts"]);

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e && e.stack || e).split("\n").slice(0, 4).join("\n       ")); } }
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const wev = (o) => Object.assign({ deltaX: 0, deltaY: 0, shiftKey: false, ctrlKey: false, altKey: false }, o);

// ---------------------------------------------------------------- wheel
test("CONSTANT_ZOOM_CONTROLLER: one notch (rotation 120, wheel delta 120) zooms by 1 + 100 × scale, out by its inverse", () => {
  near(W.constantZoomScale(W.GTK3_SCALE, 120, 120), 1.2);
  near(W.constantZoomScale(W.GTK3_SCALE, -120, 120), 1 / 1.2);
  near(W.constantZoomScale(W.MSW_SCALE, 120, 120), 1.5);
  near(W.constantZoomScale(W.MAC_SCALE, 10, 0), 1.1);
  // merged notches: three notches in one event are three steps
  near(W.constantZoomScale(W.GTK3_SCALE, 360, 120), Math.pow(1.2, 3));
});
test("zoom controller choice: automatic speed by platform, manual speed × MANUAL_SCALE_FACTOR, acceleration on Windows", () => {
  const s = Object.assign({}, W.DEFAULT_WHEEL);
  near(W.makeZoomController(s, "linux")(120, 120, 0), 1.2);
  near(W.makeZoomController(s, "mac")(10, 0, 0), 1.1);
  near(W.makeZoomController(s, "win")(120, 120, 0), 1.5);
  near(W.makeZoomController(Object.assign({}, s, { zoomSpeedAuto: false, zoomSpeed: 3 }), "linux")(120, 120, 0), 1.3);
  const acc = W.makeZoomController(Object.assign({}, s, { zoomAcceleration: true }), "win");
  near(acc(120, 120, 1000), 1.05);
  assert.ok(acc(120, 120, 1100) > 1.05, "a quick second notch in the same direction accelerates");
  near(acc(-120, 120, 1150), 1 / 1.05);
});
test("onWheel: plain wheel zooms, Ctrl pans horizontally, Shift vertically, two modifiers go to the tools", () => {
  const s = W.DEFAULT_WHEEL;
  assert.deepEqual(W.wheelAction(wev({ deltaY: -100 }), s, 1000, 800), { kind: "zoom", rotation: 120 });
  const h = W.wheelAction(wev({ deltaY: 100, ctrlKey: true }), s, 1000, 800);
  assert.equal(h.kind, "pan"); near(h.dx, -120); near(h.dy, 0);
  const v = W.wheelAction(wev({ deltaX: 100, shiftKey: true }), s, 1000, 800);   // the browser moves Shift+wheel to deltaX
  assert.equal(v.kind, "pan"); near(v.dx, 0); near(v.dy, -96);
  assert.equal(W.wheelAction(wev({ deltaY: 100, ctrlKey: true, shiftKey: true }), s, 1000, 800), null);
});
test("onWheel: a horizontal wheel pans only with input.horizontal_pan; Alt with no assignment pans vertically; reverse zoom", () => {
  const s = W.DEFAULT_WHEEL;
  const h = W.wheelAction(wev({ deltaX: 100 }), s, 1000, 800); assert.equal(h.kind, "pan"); near(h.dx, -120);
  assert.equal(W.wheelAction(wev({ deltaX: 100 }), Object.assign({}, s, { horizontalPan: false }), 1000, 800), null);
  const a = W.wheelAction(wev({ deltaY: 100, altKey: true }), s, 1000, 800); assert.equal(a.kind, "pan"); near(a.dy, -96);
  assert.deepEqual(W.wheelAction(wev({ deltaY: -100 }), Object.assign({}, s, { reverseZoom: true }), 1000, 800), { kind: "zoom", rotation: -120 });
  const r = W.wheelAction(wev({ deltaY: 100, ctrlKey: true }), Object.assign({}, s, { reversePanH: true }), 1000, 800); near(r.dx, 120);
});
test("PANEL_MOUSE_SETTINGS::OnScrollRadioButton: taking a modifier moves its holder to the first free column (none, Ctrl, Shift, Alt)", () => {
  const cur = { zoom: "", panh: "ctrl", panv: "shift" };
  assert.deepEqual(W.assignScrollMod(cur, "zoom", "ctrl"), { zoom: "ctrl", panh: "", panv: "shift" });
  assert.deepEqual(W.assignScrollMod(cur, "panv", "alt"), { zoom: "", panh: "ctrl", panv: "alt" });
  assert.deepEqual(W.assignScrollMod(cur, "panh", "shift"), { zoom: "", panh: "shift", panv: "ctrl" });
  assert.equal(W.scrollMod("meta"), ""); assert.equal(W.scrollMod("alt"), "alt");
});

// ---------------------------------------------------------------- view switcher
test("EDA_VIEW_SWITCHER: Tab advances and wraps, Shift+Tab goes back unless Shift is the switch key", () => {
  assert.equal(V.advance(0, 3, false, "Control"), 1);
  assert.equal(V.advance(2, 3, false, "Control"), 0);
  assert.equal(V.advance(0, 3, true, "Control"), 2);
  assert.equal(V.advance(0, 3, true, "Shift"), 1);
  assert.equal(V.advance(0, 0, false, "Control"), 0);
});
test("PCB_BASE_EDIT_FRAME::TryBefore: Ctrl+Tab the presets, Shift+Tab (Option+Tab on macOS) the viewports", () => {
  const k = (o) => Object.assign({ key: "Tab", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }, o);
  assert.equal(V.switcherFor(k({ ctrlKey: true }), false), "preset");
  assert.equal(V.switcherFor(k({ ctrlKey: true, shiftKey: true }), false), "preset");
  assert.equal(V.switcherFor(k({ shiftKey: true }), false), "viewport");
  assert.equal(V.switcherFor(k({ altKey: true }), true), "viewport");
  assert.equal(V.switcherFor(k({ shiftKey: true }), true), null);
  assert.equal(V.switcherFor(k({}), false), null);
  assert.equal(V.switcherFor(k({ key: "a", ctrlKey: true }), false), null);
});

// ---------------------------------------------------------------- search pane
const fp = (id, ...pads) => ({ id, kind: "footprint", node: ["footprint", "R", ...pads] });
const pad = (type, drill, layers) => ["pad", "1", type, "circle", ["drill", ...drill], ["layers", ...layers]];
test("DRILL_SEARCH_HANDLER: one line per size / shape / plating / pad-or-via / span, most numerous first", () => {
  const items = [
    fp("a", pad("thru_hole", [0.8], ["*.Cu", "*.Mask"]), pad("thru_hole", [0.8], ["*.Cu"]), pad("np_thru_hole", [3], ["*.Cu"])),
    fp("b", pad("thru_hole", [0.8], ["*.Cu"]), pad("thru_hole", ["oval", 1, 2], ["F.Cu", "B.Cu"]), pad("smd", [], ["F.Cu"])),
    { id: "v1", kind: "via", node: ["via", ["drill", 0.4], ["layers", "F.Cu", "B.Cu"]] },
    { id: "v2", kind: "via", node: ["via", ["drill", 0.4], ["layers", "F.Cu", "In1.Cu"]] },
  ];
  const L = Q.drillLines(items, ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"]);
  assert.equal(L.length, 5);
  assert.deepEqual([L[0].qty, L[0].xSize, L[0].plated, L[0].pad, L[0].start, L[0].stop, L[0].ids], [3, 0.8, true, true, "F.Cu", "B.Cu", ["a", "b"]]);
  const slot = L.find((d) => d.slot); assert.deepEqual([slot.xSize, slot.ySize], [1, 2]);
  assert.ok(L.find((d) => !d.plated && d.xSize === 3));
  const blind = L.find((d) => !d.pad && d.stop === "In1.Cu"); assert.deepEqual(blind.ids, ["v2"]);
  const cells = Q.drillCells(L[0], (mm) => mm + " mm", (l) => l);
  assert.deepEqual(cells, ["3", "Round", "0.8 mm", "0.8 mm", "PTH", "Pad", "F.Cu", "B.Cu"]);
  assert.deepEqual(Q.drillCells(slot, String, String).slice(1, 2), ["Slot"]);
});
test("padCuSpan: *.Cu spans the board's copper; a pad on no copper has no span (N/A)", () => {
  assert.deepEqual(Q.padCuSpan(["*.Cu"], ["F.Cu", "In1.Cu", "B.Cu"]), ["F.Cu", "B.Cu"]);
  assert.deepEqual(Q.padCuSpan(["In2.Cu", "In1.Cu"], []), ["In1.Cu", "In2.Cu"]);
  assert.equal(Q.padCuSpan(["F.Mask"], []), null);
});
test("GROUP_SEARCH_HANDLER: a group's members include its nested groups' members, a cycle stops", () => {
  const inner = ["group", "in", ["members", "x", "y"]];
  const outer = ["group", "out", ["members", "a", "g-in"]];
  const loop = ["group", "loop", ["members", "g-loop", "z"]];
  const by = new Map([["g-in", inner], ["g-out", outer], ["g-loop", loop]]);
  assert.deepEqual(Q.groupLeafIds(outer, by), ["a", "x", "y"]);
  assert.deepEqual(Q.groupLeafIds(loop, by), ["z"]);
  assert.equal(Q.groupName(outer), "out");
});

// ---------------------------------------------------------------- menus
const flat = (entries, out = []) => { for (const e of entries) { if (e === "-") continue; if (Array.isArray(e)) flat(e[1], out); else out.push(e.split("|")[0]); } return out; };
const menu = (ed, title) => { const m = T.MENUS[ed].find((x) => x[0].replace("&", "").toLowerCase() === title); assert.ok(m, ed + " " + title); return m[1]; };
const sub = (entries, title) => { const s = entries.find((e) => Array.isArray(e) && e[0].replace("&", "") === title); assert.ok(s, title); return s[1]; };
test("board Edit: Mirror Interactive after Edit Text & Graphics; Select holds Select All / Unselect All only", () => {
  const e = flat(menu("pcb", "edit"));
  assert.equal(e[e.indexOf("mirrorInteractive") - 1], "editTextAndGraphics");
  assert.deepEqual(flat(sub(menu("pcb", "edit"), "Select")), ["selectAll", "unselectAll"]);
});
test("board Place: Drill Chart and Drill Map; all of Geometric Constraints; Route has Spread Tracks", () => {
  const p = flat(menu("pcb", "place"));
  assert.ok(p.includes("placeDrillChart") && p.includes("placeDrillMap"));
  const gc = flat(sub(menu("pcb", "place"), "Geometric Constraints"));
  assert.equal(gc.length, 19); assert.equal(gc[gc.length - 1], "removeConstraints");
  assert.ok(flat(menu("pcb", "route")).includes("routerSpreadTracks"));
});
test("board Tools: Drill Groups, Multi-Channel and External Plugins; no catch-all menu anywhere", () => {
  const t = menu("pcb", "tools");
  assert.ok(flat(t).includes("showDrillGroups"));
  assert.equal(flat(sub(t, "Multi-Channel")).length, 6);
  const ep = flat(sub(t, "External Plugins")); assert.deepEqual(ep.slice(-2), ["pluginsReload", "pluginsShowFolder"]);
  for (const ed of Object.keys(T.MENUS)) for (const [title] of T.MENUS[ed]) assert.ok(!/Other Commands/.test(title));
  assert.deepEqual(flat(sub(menu("sch", "tools"), "External Plugins")), ["pluginsReload", "pluginsShowFolder"]);
});
test("Help menu and the File menus end like KiCad's (Close, not a web Home entry)", () => {
  assert.deepEqual(flat(menu("sch", "help")), ["help", "gettingStarted", "listHotKeys", "getInvolved", "donate", "reportBug", "about"]);
  assert.equal(flat(menu("sch", "file")).pop(), "close");
  assert.equal(flat(menu("pcb", "file")).pop(), "close");
});
test("dock layout: the schematic's panes on the left, the board's Appearance on the right, Version Control hidden", () => {
  assert.deepEqual(T.DOCKS.pcb.right.slice(0, 2), ["appearance", "filter"]);
  assert.ok(T.DOCKS.sch.left.includes("hier") && T.DOCKS.sch.left.includes("props"));
  assert.ok(T.PANE_DEFAULT_HIDDEN.sch.includes("history") && T.PANE_DEFAULT_HIDDEN.pcb.includes("history"));
});
test("wheel zoom is about the pointer by default: the browser cannot warp it (center_on_zoom off unless ticked)", () => {
  assert.equal(W.DEFAULT_WHEEL.centerOnZoom, false);
});
test("modifier names for the Mouse page go through keys.ts: Ctrl / Alt / Shift here, Cmd / Option / Shift on a Mac", () => {
  const K = load(["keys.ts"]);
  assert.deepEqual(["Ctrl", "Alt", "Shift"].map(K.modName), K.IS_MAC ? ["Cmd", "Option", "Shift"] : ["Ctrl", "Alt", "Shift"]);
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
