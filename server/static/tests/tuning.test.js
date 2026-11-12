// tuning.test.js — Tune Length of a Single Track (7) (pcb-tools.js, after pcbnew/router/pns_meander.cpp,
// pns_meander_placer.cpp, pns_meander_placer_base.cpp and pcbnew/generators/pcb_tuning_pattern.cpp): the meander
// geometry and the length trimming, the click / move / click flow committing "Tune" with its
// (generated (type tuning_pattern) …), KiCad's refusals, the 1-4 steps, Escape, and the Tuning Pattern Properties
// dialog's logic (web/editor/routersettings.ts) and the drawing tool menu's tuning entries (web/editor/ctxmenus.ts).
// Run: node server/static/tests/tuning.test.js
"use strict";
const path = require("path"), assert = require("assert/strict");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, pcb = globalThis.CollabTools.pcb;
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", ...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const CM = load(["editor", "ctxmenus.ts"]);
const IU = 1e6;

let passed = 0, failed = 0;
function test(name, fn) { reset(); try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 6).join("\n       ")); } }

// SIG: a 20 mm run then a 45° leg (34.14 mm); a GND track 0.6 mm above part of it
const BOARD = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "") (net 1 "SIG") (net 2 "GND")
  (segment (start 10 10) (end 30 10) (width 0.2) (layer "F.Cu") (net 1) (uuid "s1"))
  (segment (start 30 10) (end 40 20) (width 0.2) (layer "F.Cu") (net 1) (uuid "s2"))
  (segment (start 10 40) (end 30 40) (width 0.2) (layer "F.Cu") (net 1) (uuid "t1"))
  (segment (start 20 39.4) (end 40 39.4) (width 0.2) (layer "F.Cu") (net 2) (uuid "g1"))
)`;
function fakeCtx(text) {
  const doc = K.parseDoc(text || BOARD, "kicad_pcb");
  const log = { commits: [], toasts: [] };
  const ctx = {
    K, doc, IU, isSch: false, zoom: 1, pxPerMm: 4, gridPitch: 0.05, snapOn: true, selected: null, items: [], viewOnly: false, live: true,
    snap: (mm) => mm, worldMm: () => [0, 0], requestRender() {}, applyLocal() {}, setSelected() {},
    commit(changes, label) { log.commits.push({ changes, label }); for (const c of changes) K.applyChange(doc, c, IU); pcb.onDocChanged(ctx); },
    toast(m) { log.toasts.push(m); }, setTool(t) { log.tool = t; pcb.onActivate(t, ctx); },
  };
  pcb.onDocChanged(ctx); pcb.setLayer(ctx, "F.Cu");
  return { ctx, log, doc };
}
const ev = (extra) => Object.assign({ button: 0, shiftKey: false, clientX: 0, clientY: 0 }, extra || {});
const key = (k) => Object.assign({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, preventDefault() {} });
function reset() {
  try { pcb.cancel && pcb.cancel(); } catch (e) { /* nothing in progress */ }
  P.state.tune.pattern = null; P.state.tune.picker = null; P.state.tuneSettings.single = P.meanderDefaults();
}
const tracks = (doc, net) => [...doc.items.values()].filter((it) => (it.kind === "segment" || it.kind === "arc") && P.netOf(it.node).code === net);
function trackLen(it) {
  const a = P.pt(it.node, "start"), b = P.pt(it.node, "end");
  if (it.kind === "arc") { const c = K.arcFrom3(a, P.pt(it.node, "mid"), b); let sw = c.anticlockwise ? c.a0 - c.a1 : c.a1 - c.a0; sw = ((sw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); return c.r * sw; }
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}
const netLen = (doc, net, ids) => tracks(doc, net).filter((t) => !ids || ids.includes(t.id)).reduce((s, t) => s + trackLen(t), 0);
const STRAIGHT = (len) => ({ pts: [[0, 0], [len * IU, 0]] });
function tuneStraight(len, target, extra) {
  const st = Object.assign(P.meanderDefaults(), extra || {}); P.setTargetLength(st, target * IU); st.keepEndpoints = true;
  return P.meanderMove({ pts: STRAIGHT(len).pts, origin: [0, 0], end: [len * IU, 0], cursor: [len * IU, -IU], st, width: 0.2 * IU, clearance: 0.2 * IU, lineLength: len * IU, collides: null });
}

console.log("length tuning");

test("MEANDER_SETTINGS defaults: amplitude 0.2-1 mm, spacing 0.6 mm, step 0.05 mm, round corners at 80 %", () => {
  const st = P.meanderDefaults();
  assert.equal(st.minAmp, 0.2 * IU); assert.equal(st.maxAmp, 1 * IU); assert.equal(st.spacing, 0.6 * IU); assert.equal(st.step, 0.05 * IU);
  assert.equal(st.crPct, 80); assert.equal(st.round, true); assert.equal(st.singleSided, false);
  assert.equal(st.target.opt, P.LENGTH_UNCONSTRAINED);
  P.setTargetLength(st, 10 * IU); assert.deepEqual(st.target, { min: 9.9 * IU, opt: 10 * IU, max: 10.1 * IU }, "DEFAULT_LENGTH_TOLERANCE is 0.1 mm");
});

test("MEANDER_PLACER: a 10 mm line tuned to 14 mm lands within the tolerance, the meanders on one side within the amplitude", () => {
  const r = tuneStraight(10, 14);
  assert.equal(r.status, "tuned"); assert.ok(r.hasMeanders);
  assert.ok(Math.abs(r.length / IU - 14) < 0.1, "length " + r.length / IU);
  assert.ok(Math.abs(P.chLength(r.final) / IU - 14) < 0.1, "the final line carries that length");
  const ys = r.final.map((n) => n.p[1] / IU);
  assert.ok(Math.max(...ys.map(Math.abs)) <= 1 + 1e-6, "no deeper than the maximum amplitude");
  assert.ok(r.final.some((n) => n.m), "round corners are arcs");
  assert.deepEqual(r.final[0].p, [0, 0]); assert.deepEqual(r.final[r.final.length - 1].p, [10 * IU, 0], "the end points stay");
});

test("chamfered corners: no arcs, 45° cuts", () => {
  const r = tuneStraight(10, 13, { round: false });
  assert.equal(r.status, "tuned"); assert.ok(!r.final.some((n) => n.m));
  for (let i = 1; i < r.final.length; i++) {
    const a = r.final[i - 1].p, b = r.final[i].p; const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]);
    assert.ok(dx < 2 || dy < 2 || Math.abs(dx - dy) < 2, "a 45° multiple at " + i);
  }
});

test("single-sided meanders stay on the cursor's side", () => {
  const r = tuneStraight(10, 13, { singleSided: true });
  const ys = r.final.map((n) => n.p[1]); assert.ok(ys.every((y) => y <= 1) || ys.every((y) => y >= -1), "one side only");
});

test("too long: a line already over the target is left as it is", () => {
  const r = tuneStraight(10, 5); assert.equal(r.status, "too_long"); assert.equal(r.hasMeanders, false);
});

test("too short: meanders at the maximum amplitude cannot reach a far target", () => {
  const r = tuneStraight(5, 50); assert.equal(r.status, "too_short"); assert.ok(r.hasMeanders); assert.ok(r.length / IU < 49.9);
});

test("click, move, click: 'Tune' replaces the run and adds a tuning_pattern generator with the new copper as members", () => {
  const { ctx, log, doc } = fakeCtx();
  P.setTargetLength(P.state.tuneSettings.single, 40 * IU);
  ctx.setTool("tunesingle");
  pcb.onPointerMove(ev(), [12, 10], ctx); assert.equal(P.state.tune.picker, "s1", "the track under the cursor is picked before the click");
  pcb.onPointerDown(ev(), [12, 10], ctx); assert.ok(P.state.tune.pattern, "anchored");
  pcb.onPointerMove(ev(), [28, 9], ctx);
  assert.equal(P.state.tune.pattern.res.status, "tuned");
  pcb.onPointerDown(ev(), [28, 9], ctx);
  assert.equal(log.commits.length, 1); assert.equal(log.commits[0].label, "Tune");
  assert.equal(P.state.tune.pattern, null);
  assert.ok(!doc.items.has("s1"), "the tuned segment is replaced"); assert.ok(doc.items.has("s2"), "the leg outside the pattern stays");
  const gen = [...doc.items.values()].find((it) => it.kind === "generated"); assert.ok(gen);
  assert.equal(K.str(K.kid(gen.node, "type")[1]), "tuning_pattern");
  assert.equal(K.str(K.kid(gen.node, "tuning_mode")[1]), "single");
  assert.equal(K.str(K.kid(gen.node, "last_netname")[1]), "SIG");
  assert.equal(K.str(K.kid(gen.node, "last_status")[1]), "tuned");
  assert.equal(K.kid(gen.node, "target_length")[1], 40);
  const members = K.groupMemberIds(gen.node); assert.ok(members.length > 4);
  for (const id of members) assert.ok(doc.items.has(id), "member " + id + " exists");
  const total = netLen(doc, 1, tracks(doc, 1).filter((t) => P.pt(t.node, "start")[1] < 30 && P.pt(t.node, "end")[1] < 30).map((t) => t.id));
  assert.ok(Math.abs(total - 40) < 0.1, "the line is now 40 mm long, got " + total);
  assert.ok(tracks(doc, 1).every((t) => P.layerOf(t.node) === "F.Cu" && Math.abs(P.widthOf(t.node) - 0.2) < 1e-9), "same layer and width");
});

test("meanders keep clear of other nets (the GND track above the second line)", () => {
  const { ctx, doc } = fakeCtx();
  P.setTargetLength(P.state.tuneSettings.single, 26 * IU);
  ctx.setTool("tunesingle");
  pcb.onPointerDown(ev(), [11, 40], ctx); pcb.onPointerMove(ev(), [29, 39], ctx); pcb.onPointerDown(ev(), [29, 39], ctx);
  const g = doc.items.get("g1"); const ga = P.pt(g.node, "start"), gb = P.pt(g.node, "end");
  for (const t of tracks(doc, 1)) {
    const a = P.pt(t.node, "start"), b = P.pt(t.node, "end"); if (a[1] < 30) continue;
    if (t.kind === "segment") assert.ok(P.segSegDist(a, b, ga, gb) >= 0.2 + 0.2 - 1e-3, "clearance to GND");
  }
});

test("a line longer than the target: KiCad's 'No tuning pattern added' warning, nothing committed", () => {
  const { ctx, log } = fakeCtx();
  P.setTargetLength(P.state.tuneSettings.single, 5 * IU);
  ctx.setTool("tunesingle");
  pcb.onPointerDown(ev(), [12, 10], ctx); pcb.onPointerMove(ev(), [28, 9], ctx); pcb.onPointerDown(ev(), [28, 9], ctx);
  assert.equal(log.commits.length, 0);
  assert.equal(log.toasts.pop(), "No tuning pattern added: no meanders were needed or would fit (too long).");
});

test("a track inside another tuning pattern is refused", () => {
  const { ctx, log, doc } = fakeCtx();
  P.setTargetLength(P.state.tuneSettings.single, 40 * IU);
  ctx.setTool("tunesingle");
  pcb.onPointerDown(ev(), [12, 10], ctx); pcb.onPointerMove(ev(), [28, 9], ctx); pcb.onPointerDown(ev(), [28, 9], ctx);
  const gen = [...doc.items.values()].find((it) => it.kind === "generated"); const member = doc.items.get(K.groupMemberIds(gen.node)[0]);
  const at = P.pt(member.node, "start");
  pcb.onPointerDown(ev(), at, ctx);
  assert.equal(log.toasts.pop(), P.TUNE_MSG_INSIDE); assert.equal(P.state.tune.pattern, null);
});

test("1/2 spacing and 3/4 amplitude step the pending pattern; without one KiCad warns 'Select a track to tune first.'", () => {
  const { ctx, log } = fakeCtx();
  ctx.setTool("tunesingle");
  pcb.onKey("1", key("1"), ctx); assert.equal(log.toasts.pop(), P.TUNE_MSG_SELECT);
  pcb.onPointerDown(ev(), [12, 10], ctx); pcb.onPointerMove(ev(), [28, 9], ctx);
  const st = P.state.tune.pattern.st;
  pcb.onKey("1", key("1"), ctx); assert.equal(st.spacing, 0.65 * IU);
  pcb.onKey("2", key("2"), ctx); pcb.onKey("2", key("2"), ctx); assert.equal(st.spacing, 0.55 * IU);
  pcb.onKey("4", key("4"), ctx); assert.equal(st.maxAmp, 0.95 * IU);
  pcb.onKey("3", key("3"), ctx); pcb.onKey("3", key("3"), ctx); assert.equal(st.maxAmp, 1.05 * IU);
  assert.equal(P.state.tuneSettings.single.maxAmp, 1.05 * IU, "the step is stored as the default");
});

test("Escape drops the pending pattern, the board untouched; outside the tuner 1-4 are not taken", () => {
  const { ctx, log } = fakeCtx();
  ctx.setTool("tunesingle");
  pcb.onPointerDown(ev(), [12, 10], ctx); pcb.onPointerMove(ev(), [28, 9], ctx);
  assert.ok(pcb.cancel ? (pcb.cancel(ctx), true) : true);
  assert.equal(P.state.tune.pattern, null); assert.equal(log.commits.length, 0);
  ctx.setTool("route"); assert.equal(pcb.onKey("3", key("3"), ctx), false);
});

test("Tuning Pattern Properties: settings view / apply round-trip in mm, empty target = unconstrained", () => {
  const st = P.meanderDefaults(); const v = P.tuneSettingsView(st);
  assert.equal(v.targetLength, null); assert.equal(v.minAmp, 0.2); assert.equal(v.maxAmp, 1); assert.equal(v.spacing, 0.6);
  P.applyTuneSettings(st, Object.assign(v, { targetLength: 25, maxAmp: 1.5, round: false, crPct: 50, singleSided: true }));
  assert.deepEqual(st.target, { min: 24.9 * IU, opt: 25 * IU, max: 25.1 * IU });
  assert.equal(st.maxAmp, 1.5 * IU); assert.equal(st.round, false); assert.equal(st.crPct, 50); assert.equal(st.singleSided, true);
  P.applyTuneSettings(st, Object.assign(P.tuneSettingsView(st), { targetLength: null })); assert.equal(st.target.opt, P.LENGTH_UNCONSTRAINED);
  const RS = load(["editor", "routersettings.ts"]);
  const f = RS.tuneForm("single", P.tuneSettingsView(P.meanderDefaults()));
  assert.equal(f.targetLabel, "Target Length:"); assert.equal(f.targetText("mm"), ""); assert.ok(f.targetEnabled()); assert.equal(f.sourceInfo(), null);
  assert.ok(f.setTarget("1000 mils", "mm")); assert.equal(f.values.targetLength, 25.4);
  assert.equal(RS.tuneForm("diff_pair_skew", P.tuneSettingsView(P.meanderDefaults())).targetLabel, "Target Skew: ");
  const ruled = RS.tuneForm("single", Object.assign(P.tuneSettingsView(P.meanderDefaults()), { constraint: "'hs'" }));
  assert.equal(ruled.targetEnabled(), false); assert.equal(ruled.sourceInfo(), "(from 'hs')");
  ruled.values.overrideCustomRules = true; assert.ok(ruled.targetEnabled());
});

test("the drawing tool menu offers the tuner's steps and settings while tuning", () => {
  const menu = CM.menuFor({ editor: "pcb", tool: "tunesingle" }, true);
  const acts = CM.evaluate ? CM.evaluate(menu, { editor: "pcb", tool: "tunesingle" }).map((e) => e.act) : menu.entries.map((e) => e.act);
  for (const a of ["PCB_ACTIONS::spacingIncrease", "PCB_ACTIONS::spacingDecrease", "PCB_ACTIONS::amplIncrease", "PCB_ACTIONS::amplDecrease", "PCB_ACTIONS::lengthTunerSettings"]) assert.ok(acts.includes(a), a);
});

function placeTuned(target) {
  const f = fakeCtx(); P.setTargetLength(P.state.tuneSettings.single, target * IU);
  f.ctx.setTool("tunesingle");
  pcb.onPointerDown(ev(), [12, 10], f.ctx); pcb.onPointerMove(ev(), [28, 9], f.ctx); pcb.onPointerDown(ev(), [28, 9], f.ctx);
  f.ctx.setTool("select");
  f.gen = () => [...f.doc.items.values()].find((it) => it.kind === "generated");
  f.len = () => netLen(f.doc, 1, tracks(f.doc, 1).filter((t) => P.pt(t.node, "start")[1] < 30 && P.pt(t.node, "end")[1] < 30).map((t) => t.id));
  return f;
}

test("a meander belongs to its pattern: selecting one expands to the generator and every member", () => {
  const { doc, gen } = placeTuned(40);
  const g = gen(); const m = K.groupMemberIds(g.node);
  const ex = P.expandGroups(doc, [m[0]]); assert.ok(ex.has(g.id)); for (const id of m) assert.ok(ex.has(id));
  const info = P.tuningPatternInfo(g); assert.equal(info.mode, "single"); assert.equal(info.st.target.opt, 40 * IU); assert.deepEqual(info.base[0], [12, 10]);
});

test("Update All Tuning Patterns re-tunes each pattern to its stored target in one commit", () => {
  const f = placeTuned(40);
  const g = f.gen(); const node = JSON.parse(JSON.stringify(g.node));   // the pattern's properties edited to a 37 mm target
  for (const [k, v] of [["target_length", 37], ["target_length_min", 36.9], ["target_length_max", 37.1]]) K.kid(node, k)[1] = v;
  g.node.length = 0; g.node.push(...node);
  const before = f.log.commits.length;
  pcb.runAction("regenerateAllTuning", f.ctx);
  assert.equal(f.log.commits.length, before + 1); assert.equal(f.log.commits.at(-1).label, "Update Tuning Patterns");
  assert.ok(Math.abs(f.len() - 37) < 0.1, "re-tuned to 37 mm, got " + f.len());
  const gens = [...f.doc.items.values()].filter((it) => it.kind === "generated"); assert.equal(gens.length, 1);
  for (const id of K.groupMemberIds(gens[0].node)) assert.ok(f.doc.items.has(id));
  assert.equal(K.kid(gens[0].node, "last_status")[1], "tuned");
});

test("deleting a pattern puts its base line back (PCB_TUNING_PATTERN::Remove)", () => {
  const f = placeTuned(40);
  const ids = [...P.expandGroups(f.doc, [f.gen().id])];
  f.ctx.commit(P.deleteChanges(f.doc, ids), "Delete");
  assert.ok(!f.gen(), "the generator is gone");
  assert.ok(Math.abs(f.len() - (20 + Math.SQRT2 * 10)) < 1e-3, "straight again: " + f.len());
  assert.ok(tracks(f.doc, 1).every((t) => t.kind === "segment"));
  assert.equal(tracks(f.doc, 1).filter((t) => P.pt(t.node, "start")[1] < 30).length, 2, "the straight run is one segment again (removeToBaseline simplifies the line)");
});

test("moving a pattern carries its origin, end and base line", () => {
  const f = placeTuned(40); const g = f.gen();
  const n = P.translateNode(JSON.parse(JSON.stringify(g.node)), 1, 2);
  assert.deepEqual(K.kid(n, "origin")[1].slice(1), [13, 12]);
  const info = P.tuningPatternInfo({ node: n }); assert.deepEqual(info.base[0], [13, 12]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
