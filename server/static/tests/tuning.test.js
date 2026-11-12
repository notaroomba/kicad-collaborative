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
  P.state.tune.pattern = null; P.state.tune.picker = null; P.state.tuneSettings.single = P.meanderDefaults(); P.setCustomRules(null); P.state.druSrc = undefined;
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

test("Ctrl+L and E open Tuning Pattern Properties only inside the tuner (pcb_tuning_pattern.cpp's loop)", () => {
  const { ctx } = fakeCtx(); const opened = [];
  pcb.setRoutingDialogs({ tuning: (o) => opened.push(o.mode) });
  ctx.setTool("select");
  assert.equal(pcb.runAction("lengthTunerSettings", ctx), true, "the key is taken"); assert.equal(opened.length, 0, "but nothing opens");
  assert.equal(pcb.tunerProperties(ctx), false, "E falls to the selection's properties");
  ctx.setTool("tunesingle");
  pcb.runAction("lengthTunerSettings", ctx); assert.deepEqual(opened, ["single"]);
  assert.equal(pcb.tunerProperties(ctx), true); assert.deepEqual(opened, ["single", "single"]);
  ctx.setTool("tuneskew"); pcb.tunerProperties(ctx); assert.equal(opened[2], "diff_pair_skew");
  ctx.setTool("select");
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

const SKEW = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
  (segment (start 10 10) (end 30 10) (width 0.2) (layer "F.Cu") (net "CLK_P") (uuid "p1"))
  (segment (start 10 10.45) (end 31 10.45) (width 0.2) (layer "F.Cu") (net "CLK_N") (uuid "n1"))
  (segment (start 10 20) (end 30 20) (width 0.2) (layer "F.Cu") (net "LONE") (uuid "l1"))
)`;
test("Tune Skew (9): the clicked line is meandered to its partner's length plus the target skew; 'Skew:' in the status", () => {
  const { ctx, log, doc } = fakeCtx(SKEW);
  ctx.setTool("tuneskew");
  pcb.onPointerMove(ev(), [20, 10], ctx);
  let info = P.state.tune.picker; assert.equal(info, "p1");
  pcb.onPointerDown(ev(), [11, 10], ctx); pcb.onPointerMove(ev(), [29, 9], ctx);
  const T = P.state.tune.pattern; assert.ok(T); assert.ok(Math.abs(T.coupled - 21) < 1e-9, "the partner is 21 mm");
  assert.equal(T.res.status, "tuned"); assert.ok(Math.abs(T.res.length / IU - 21) < 0.1, "P is brought to N's length (skew 0): " + T.res.length / IU);
  pcb.onPointerDown(ev(), [29, 9], ctx);
  assert.equal(log.commits.at(-1).label, "Tune");
  const gen = [...doc.items.values()].find((it) => it.kind === "generated");
  assert.equal(K.str(K.kid(gen.node, "tuning_mode")[1]), "diff_pair_skew"); assert.equal(K.kid(gen.node, "target_skew")[1], 0);
  const pLen = [...doc.items.values()].filter((it) => (it.kind === "segment" || it.kind === "arc") && P.netOf(it.node).name === "CLK_P").reduce((t, it) => t + trackLen(it), 0);
  assert.ok(Math.abs(pLen - 21) < 0.1, "CLK_P is 21 mm: " + pLen);
  const n = doc.items.get("n1"); for (const it of [...doc.items.values()].filter((x) => x.kind === "segment" && P.netOf(x.node).name === "CLK_P")) {
    assert.ok(P.segSegDist(P.pt(it.node, "start"), P.pt(it.node, "end"), P.pt(n.node, "start"), P.pt(n.node, "end")) >= 0.45 - 0.2 - 1e-6, "the meanders keep off the partner");
  }
});

test("Tune Skew refusals: a net without a partner, and the skew target in the dialog", () => {
  const { ctx, log } = fakeCtx(SKEW);
  ctx.setTool("tuneskew");
  pcb.onPointerDown(ev(), [15, 20], ctx); assert.equal(log.toasts.pop(), P.TUNE_MSG_SKEW_NETS); assert.equal(P.state.tune.pattern, null);
  const st = P.meanderDefaults(); P.applyTuneSettings(st, Object.assign(P.tuneSettingsView(st, "skew"), { targetLength: 0.5 }), "skew");
  assert.deepEqual(st.skew, { min: 0.4 * IU, opt: 0.5 * IU, max: 0.6 * IU }); assert.equal(st.target.opt, P.LENGTH_UNCONSTRAINED, "the length target is untouched");
  assert.equal(P.tuneSettingsView(st, "skew").targetLength, 0.5);
});

// ---- a placed pattern as one object (PCB_TUNING_PATTERN is a PCB_GENERATOR): selection, delete, edit points
test("a click on a meander selects the whole pattern (FilterCollectorForHierarchy), the requested selection keeps the generator", () => {
  const f = placeTuned(40); const g = f.gen(); const m = K.groupMemberIds(g.node);
  const mem = f.doc.items.get(m.find((id) => f.doc.items.get(id).kind === "segment"));
  const a = P.pt(mem.node, "start"), b = P.pt(mem.node, "end");
  P.state.sel.clear(); pcb.onSelectDown(ev(), [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], f.ctx);
  assert.ok(P.state.sel.has(g.id), "the generator is selected"); for (const id of m) assert.ok(P.state.sel.has(id));
  assert.equal(P.selectedTuningPattern(f.ctx).id, g.id);
  assert.equal(P.topParentOf(f.doc, mem.id).id, g.id);
  const r = P.requestSelection(f.ctx, {}); assert.ok(r.ids.includes(g.id)); assert.ok(!r.items.some((it) => it.kind === "generated"));
  P.state.sel.clear();
});

test("Delete: the pattern alone goes back to its base line; with another item it is removed with its members", () => {
  let f = placeTuned(40);
  f.ctx.commit(P.deleteChanges(f.doc, [...P.expandGroups(f.doc, [f.gen().id])]), "Delete");
  assert.ok(!f.gen()); assert.ok(Math.abs(f.len() - (20 + Math.SQRT2 * 10)) < 1e-3, "baseline restored");
  f = placeTuned(40); const m = K.groupMemberIds(f.gen().node);
  const ids = [...P.expandGroups(f.doc, [f.gen().id]), "t1"];
  f.ctx.commit(P.deleteChanges(f.doc, ids), "Delete");
  assert.ok(!f.gen()); for (const id of m) assert.ok(!f.doc.items.has(id), "member removed outright"); assert.ok(!f.doc.items.has("t1"));
  assert.ok(f.len() < 20 + Math.SQRT2 * 10 - 1, "no base line put back: " + f.len());
});

test("edit points: origin, end, amplitude handle at maxAmp + width/2 off the base line, spacing handle 1.5 spacings along", () => {
  const f = placeTuned(40); const g = f.gen(); const info = P.tuningPatternInfo(g);
  const hs = P.tuningEditPoints(g); assert.equal(hs.length, 4);
  assert.deepEqual(hs[0].p, info.base[0]); assert.deepEqual(hs[1].p, info.base[info.base.length - 1]);
  const A = info.base[0], B = info.base[1]; const L = Math.hypot(B[0] - A[0], B[1] - A[1]); const u = [(B[0] - A[0]) / L, (B[1] - A[1]) / L];
  const amp = info.st.maxAmp / IU + info.width / 2; const sgn = info.st.initialSide === -1 ? -1 : 1;
  const w = [A[0] - u[1] * amp * sgn, A[1] + u[0] * amp * sgn];
  assert.ok(Math.hypot(hs[2].p[0] - w[0], hs[2].p[1] - w[1]) < 1e-9, "width handle " + hs[2].p + " vs " + w); assert.ok(hs[2].ignoreGrid && hs[3].ignoreGrid);
  const sp = info.st.spacing / IU * 1.5; assert.ok(Math.hypot(hs[3].p[0] - (w[0] + u[0] * sp), hs[3].p[1] - (w[1] + u[1] * sp)) < 1e-9);
  // dragging the width handle 0.5 mm further out: max amplitude + 0.5, rounded to 0.01 mm, side from the handle
  const n2 = P.tuningEditNode(g.node, "2", [w[0] - u[1] * 0.5 * sgn + 0.001, w[1] + u[0] * 0.5 * sgn]);
  assert.ok(Math.abs(K.kid(n2, "max_amplitude")[1] - (info.st.maxAmp / IU + 0.5)) < 0.011);
  assert.equal(K.str(K.kid(n2, "initial_side")[1]), sgn < 0 ? "left" : "right");
  const n3 = P.tuningEditNode(g.node, "3", [w[0] + u[0] * 1.5, w[1] + u[1] * 1.5]); assert.equal(K.kid(n3, "min_spacing")[1], 1);
  const n0 = P.tuningEditNode(g.node, "0", [15, 10]); assert.deepEqual(K.kid(n0, "origin")[1].slice(1), [15, 10]);
});

test("Edit Tuning Pattern: a new end re-tunes live (preview hides the old copper) and commits once; Escape leaves the board", () => {
  const f = placeTuned(40); const g = f.gen(); const before = f.log.commits.length;
  P.genStartEdit(f.ctx, g); const node = P.tuningEditNode(g.node, "1", [25, 10]);
  const fin = P.genUpdateEdit(f.ctx, node); assert.ok(fin, "an update"); assert.ok(P.state.genEdit.hidden.size > 0);
  assert.equal(f.log.commits.length, before, "nothing committed while dragging");
  P.genCancelEdit(f.ctx); assert.equal(f.log.commits.length, before); assert.equal(P.state.genEdit, null);
  P.genStartEdit(f.ctx, g); P.genUpdateEdit(f.ctx, node); P.genFinishEdit(f.ctx);
  assert.equal(f.log.commits.length, before + 1); assert.equal(f.log.commits.at(-1).label, "Edit Tuning Pattern");
  const g2 = f.gen(); const info = P.tuningPatternInfo(g2);
  assert.deepEqual(info.end, [25, 10], "the end moved"); assert.deepEqual(info.base.at(-1), [25, 10], "the base line follows");
  assert.ok(Math.abs(f.len() - 40) < 0.1, "still tuned to 40 mm: " + f.len());
  for (const id of K.groupMemberIds(g2.node)) assert.ok(f.doc.items.has(id));
});

test("getOutline: the base line grown by the clamped max amplitude + width/2 (round ends); single-sided keeps one side", () => {
  const info = { base: [[0, 0], [10, 0]], coupled: null, mode: "single", width: 0.2, gap: 0, st: Object.assign(P.meanderDefaults(), { maxAmp: 1 * IU }) };
  const o = P.tuningOutline(info); const ys = o.map((p) => p[1]), xs = o.map((p) => p[0]);
  assert.ok(Math.abs(Math.max(...ys) - 1.1) < 1e-9 && Math.abs(Math.min(...ys) + 1.1) < 1e-9); assert.ok(Math.abs(Math.max(...xs) - 11.1) < 1e-9 && Math.abs(Math.min(...xs) + 1.1) < 1e-9);
  info.st.singleSided = true; info.st.initialSide = 1; const s1 = P.tuningOutline(info);
  assert.ok(Math.max(...s1.map((p) => p[1])) > 1 && Math.min(...s1.map((p) => p[1])) > -1e-9, "right side (+y) only");
});

test("E on a selected pattern: Tuning Pattern Properties from its own settings; OK re-tunes it as 'Edit Tuning Pattern'", () => {
  const f = placeTuned(40); const g = f.gen(); let req = null, done = null;
  pcb.setRoutingDialogs({ tuning: (o, cb) => { req = o; done = cb; } });
  for (const id of P.expandGroups(f.doc, [g.id])) P.state.sel.add(id);
  assert.equal(pcb.tunerProperties(f.ctx), true); assert.equal(req.mode, "single"); assert.equal(req.settings.targetLength, 40);
  const before = f.log.commits.length;
  done(Object.assign({}, req.settings, { targetLength: 36 }));
  assert.equal(f.log.commits.length, before + 1); assert.equal(f.log.commits.at(-1).label, "Edit Tuning Pattern");
  assert.equal(K.kid(f.gen().node, "target_length")[1], 36); assert.ok(Math.abs(f.len() - 36) < 0.1, "re-tuned to 36: " + f.len());
  P.state.sel.clear();
});

test("message panel of a selected pattern: Type, Net, Resolved Netclass, Layer, Width, Routed Length, Target Length", () => {
  const f = placeTuned(40); const g = f.gen();
  const rows = P.msgPanelInfo(f.doc, [...P.expandGroups(f.doc, [g.id])], { units: "mm" });
  const t = (k) => (rows.find((r) => r.title === k) || {}).value;
  assert.equal(t("Type"), "Tuning Pattern"); assert.equal(t("Net"), "SIG"); assert.equal(t("Resolved Netclass"), "Default"); assert.equal(t("Layer"), "F.Cu");
  assert.equal(t("Width"), "0.2000 mm"); assert.ok(/^\d+\.\d{4} mm$/.test(t("Routed Length")));
  assert.equal(t("Target Length: 40.0000 mm"), "(from tuning pattern properties)");
});

test("moving a selected pattern slides it along its track and re-tunes it (genUpdateEdit); Escape leaves the board as it was", () => {
  const f = placeTuned(40); const g = f.gen(); const o0 = P.tuningPatternInfo(g).origin;
  for (const id of P.expandGroups(f.doc, [g.id])) P.state.sel.add(id);
  const before = f.log.commits.length; const snap = K.serialize(f.gen().node);
  assert.ok(pcb.beginMove(f.ctx, [15, 10], false)); assert.ok(P.state.move.gen);
  P.selectMoveTo(f.ctx, [17, 10]); assert.ok(P.state.genEdit && P.state.genEdit.fin, "previewed");
  P.finishSelectMove(f.ctx, false); assert.equal(f.log.commits.length, before); assert.equal(K.serialize(f.gen().node), snap, "Escape: untouched");
  assert.ok(pcb.beginMove(f.ctx, [15, 10], false)); P.selectMoveTo(f.ctx, [17, 11]); P.finishSelectMove(f.ctx, true);
  assert.equal(f.log.commits.length, before + 1); assert.equal(f.log.commits.at(-1).label, "Move");
  const info = P.tuningPatternInfo(f.gen()); assert.ok(Math.abs(info.origin[0] - (o0[0] + 2)) < 1e-6 && Math.abs(info.origin[1] - 10) < 1e-6, "origin slid along the track: " + info.origin);
  assert.ok(Math.abs(f.len() - 40) < 0.1, "still tuned: " + f.len());
  P.state.sel.clear();
});

test("a Properties-panel edit of a pattern: member edits (Width) and node edits (Max Amplitude) re-tune in one 'Edit Tuning Pattern'", () => {
  const f = placeTuned(40); let g = f.gen(); const before = f.log.commits.length;
  const node = JSON.parse(JSON.stringify(g.node)); K.kid(node, "max_amplitude")[1] = 0.8;
  P.editTuningPattern(f.ctx, g, node, (n) => { K.kid(n, "width")[1] = 0.15; });
  assert.equal(f.log.commits.length, before + 1); assert.equal(f.log.commits.at(-1).label, "Edit Tuning Pattern");
  g = f.gen(); assert.equal(K.kid(g.node, "max_amplitude")[1], 0.8);
  const mem = K.groupMemberIds(g.node).map((id) => f.doc.items.get(id));
  assert.ok(mem.length && mem.every((it) => P.widthOf(it.node) === 0.15), "the members carry the new width");
  assert.ok(Math.abs(f.len() - 40) < 0.1, "still tuned: " + f.len());
});


// ---- Tune Length of a Differential Pair (8): PNS::DP_MEANDER_PLACER
const DP = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
  (segment (start 10 10) (end 30 10) (width 0.2) (layer "F.Cu") (net "USB_P") (uuid "p1"))
  (segment (start 10 10.3) (end 30 10.3) (width 0.2) (layer "F.Cu") (net "USB_N") (uuid "n1"))
  (segment (start 10 20) (end 30 20) (width 0.2) (layer "F.Cu") (net "LONE") (uuid "l1"))
)`;
const pairGap = (doc) => {
  const seg = (n) => [...doc.items.values()].filter((it) => it.kind === "segment" && P.netOf(it.node).name === n);
  let m = Infinity; for (const a of seg("USB_P")) for (const b of seg("USB_N")) m = Math.min(m, P.segSegDist(P.pt(a.node, "start"), P.pt(a.node, "end"), P.pt(b.node, "start"), P.pt(b.node, "end")));
  return m;
};
const netLenN = (doc, name) => [...doc.items.values()].filter((it) => (it.kind === "segment" || it.kind === "arc") && P.netOf(it.node).name === name).reduce((t, it) => t + trackLen(it), 0);

test("DIFF_PAIR::CoupledSegmentPairs: parallel P / N segments at the pair's gap, clipped to their common stretch", () => {
  const c = P.coupledSegmentPairs([[0, 0], [20 * IU, 0]], [[5 * IU, 0.3 * IU], [30 * IU, 0.3 * IU]], 0.2 * IU, 0.1 * IU);
  assert.equal(c.length, 1); assert.deepEqual(c[0].coupledP.A.map((v) => v / IU), [5, 0]); assert.deepEqual(c[0].coupledP.B.map((v) => v / IU), [20, 0]);
  assert.deepEqual(c[0].coupledN.A.map((v) => v / IU), [5, 0.3]);
  assert.equal(P.coupledSegmentPairs([[0, 0], [20 * IU, 0]], [[0, 1 * IU], [20 * IU, 1 * IU]], 0.2 * IU, 0.1 * IU).length, 0, "another gap is not coupled");
  assert.equal(P.coupledSegmentPairs([[0, 0], [20 * IU, 0]], [[0, 0.3 * IU], [20 * IU, 2 * IU]], 0.2 * IU, 0.1 * IU).length, 0, "not parallel");
});

test("DP_MEANDER_PLACER: both lines meander together around the centre line, the longer one reaches the target, the gap is kept", () => {
  const st = P.meanderDefaults(); P.setTargetLength(st, 32 * IU); st.keepEndpoints = true; st.initialSide = -1;
  const r = P.dpMeanderMove({ ptsP: [[10 * IU, 10 * IU], [40 * IU, 10 * IU]], ptsN: [[10 * IU, 10.3 * IU], [40 * IU, 10.3 * IU]], origin: [12 * IU, 10 * IU], end: [38 * IU, 10 * IU],
    st, width: 0.2 * IU, gap: 0.1 * IU, clearance: 0.2 * IU, lengthP: 30 * IU, lengthN: 30 * IU });
  assert.equal(r.status, "tuned"); assert.ok(r.hasMeanders);
  const lp = P.chLength(r.finalP) / IU, ln = P.chLength(r.finalN) / IU;
  assert.ok(Math.abs(Math.max(lp, ln) - 32) < 0.1, "max(P, N) is the target: " + lp + " " + ln);
  assert.ok(Math.abs(r.length / IU - Math.max(lp, ln)) < 1e-3);
  const ptsP = P.chPoints(r.finalP), ptsN = P.chPoints(r.finalN);
  let m = Infinity; for (let i = 0; i + 1 < ptsP.length; i++) for (let j = 0; j + 1 < ptsN.length; j++) m = Math.min(m, P.segSegDist(ptsP[i], ptsP[i + 1], ptsN[j], ptsN[j + 1]));
  assert.ok(m / IU > 0.1 + 0.2 - 0.06, "the lines stay a gap apart: " + m / IU);
  assert.deepEqual(r.finalP[0].p, [10 * IU, 10 * IU]); assert.deepEqual(r.finalN.at(-1).p, [40 * IU, 10.3 * IU], "the ends stay");
});

test("Tune DP length (8): click, move, click commits 'Tune' with a diff_pair pattern over both lines; Delete brings both base lines back", () => {
  const { ctx, log, doc } = fakeCtx(DP);
  P.state.tuneSettings.diffpair = P.meanderDefaults(); P.setTargetLength(P.state.tuneSettings.diffpair, 24 * IU);
  ctx.setTool("tunediff");
  pcb.onPointerMove(ev(), [20, 10], ctx); assert.equal(P.state.tune.picker, "p1");
  pcb.onPointerDown(ev(), [13, 10], ctx); const T = P.state.tune.pattern; assert.ok(T && T.dp, "the pair is assembled");
  assert.ok(Math.abs(T.dp.gap - 0.1) < 1e-6, "the gap is measured: " + T.dp.gap); assert.equal(T.dp.mineIsP, true);
  pcb.onPointerMove(ev(), [27, 9], ctx);
  assert.equal(T.res.status, "tuned"); assert.ok(T.res.finalCoupled, "the coupled line is rebuilt too");
  assert.ok(P.tuneHiddenIds().has("n1"), "the preview hides both old lines");
  pcb.onPointerDown(ev(), [27, 9], ctx);
  assert.equal(log.commits.at(-1).label, "Tune");
  assert.ok(!doc.items.has("p1") && !doc.items.has("n1"), "both lines are replaced");
  const gen = [...doc.items.values()].find((it) => it.kind === "generated");
  assert.equal(K.str(K.kid(gen.node, "tuning_mode")[1]), "diff_pair");
  assert.ok(K.kid(gen.node, "base_line_coupled"), "base_line_coupled is written");
  assert.equal(K.kid(gen.node, "last_diff_pair_gap")[1], 0.1);
  const lp = netLenN(doc, "USB_P"), ln = netLenN(doc, "USB_N");
  assert.ok(Math.abs(Math.max(lp, ln) - 24) < 0.1, "tuned to 24 mm: " + lp + " / " + ln);
  assert.ok(pairGap(doc) > 0.3 - 0.06, "the pair keeps its spacing: " + pairGap(doc));
  const members = K.groupMemberIds(gen.node).map((id) => doc.items.get(id));
  assert.ok(members.some((it) => P.netOf(it.node).name === "USB_P") && members.some((it) => P.netOf(it.node).name === "USB_N"), "both nets' meanders are members");
  // regenerate keeps it tuned, then Delete restores both straight lines
  const ch = P.regenerateTuningChanges(ctx, gen); assert.ok(ch.length, "the pair pattern regenerates"); ctx.commit(ch, "Update");
  const g2 = [...doc.items.values()].find((it) => it.kind === "generated");
  assert.ok(Math.abs(Math.max(netLenN(doc, "USB_P"), netLenN(doc, "USB_N")) - 24) < 0.1, "still 24 mm after a regenerate");
  ctx.commit(P.tuningRemoveChanges(doc, [g2], new Set([g2.id])), "Delete");
  assert.ok(Math.abs(netLenN(doc, "USB_P") - 20) < 1e-6 && Math.abs(netLenN(doc, "USB_N") - 20) < 1e-6, "both base lines are back: " + netLenN(doc, "USB_P") + " " + netLenN(doc, "USB_N"));
  assert.ok(![...doc.items.values()].some((it) => it.kind === "generated"));
});

test("Tune DP length refusals: a net without a partner; the dialog runs in diff_pair mode", () => {
  const { ctx, log } = fakeCtx(DP);
  ctx.setTool("tunediff");
  pcb.onPointerDown(ev(), [15, 20], ctx); assert.equal(log.toasts.pop(), P.TUNE_MSG_DP_NETS); assert.equal(P.state.tune.pattern, null);
  assert.ok(P.TUNE_MSG_DP_NETS.startsWith("Unable to find complementary differential pair net for length tuning."));
});


// ---- custom rules (.kicad_dru): DRC_RULES_PARSER, PCBEXPR conditions, DRC_ENGINE::EvalRules
const DRU = `(version 1)
(rule "usb length"
  (condition "A.inDiffPair('USB')")
  (constraint length (min 23.9mm) (opt 24mm) (max 24.1mm)))
(rule "sig len" (condition "A.NetName == 'SIG'") (constraint length (min 39.5mm) (max 41mm)))
(rule "later wins" (condition "A.NetName == 'S*' && A.Type == 'Track'") (constraint length (opt 40mm) (min 39.9mm) (max 40.1mm)))
(rule "bad" (condition "A.NetName == ") (constraint length (opt 1mm)))
(rule "skew" (condition "A.inDiffPair('*') || A.hasNetclass('HS*')") (constraint skew (max 0.5mm)) (layer outer))
`;
test("custom rules: values with units, conditions with wildcards / functions, the later rule wins, a broken one never matches", () => {
  assert.equal(P.parseDru("(rule a (constraint length (min 10mil)))").rules[0].constraints[0].min, 0.254);
  const d = P.parseDru(DRU); assert.equal(d.rules.length, 5); assert.equal(d.errors.length, 1, "the broken condition is reported: " + d.errors);
  const doc = K.parseDoc(DP.replace('(net "LONE")', '(net "SIG")'), "kicad_pcb"); const s = P.designSettings(null);
  const p1 = doc.items.get("p1"), l1 = doc.items.get("l1");
  const usb = P.evalRuleConstraint(d.rules, "length", doc, s, p1, null);
  assert.deepEqual([usb.name, usb.min, usb.opt, usb.max], ["rule 'usb length'", 23.9, 24, 24.1]);
  assert.equal(usb.text, "min 23.9000 mm; opt 24.0000 mm; max 24.1000 mm", "MessageTextFromMinOptMax");
  const sig = P.evalRuleConstraint(d.rules, "length", doc, s, l1, null); assert.equal(sig.name, "rule 'later wins'", "later rules take precedence");
  assert.equal(P.evalRuleConstraint(d.rules, "skew", doc, s, p1, null).max, 0.5);
  assert.equal(P.evalRuleConstraint(d.rules, "skew", doc, s, l1, null), null);
  assert.ok(P.wildMatch("us?_*", "USB_DATA")); assert.throws(() => P.parseCondition("A.NetName == 'x"));
});

test("a custom rule sets the tuner's target (Update without Override Custom Rules) and the status min / max", () => {
  const { ctx, log, doc } = fakeCtx(DP);
  P.setCustomRules(DRU); P.state.tuneSettings.diffpair = P.meanderDefaults();
  ctx.setTool("tunediff");
  pcb.onPointerMove(ev(), [20, 10], ctx);
  const info = P.tuneStatus(ctx); assert.equal(info.min, "23.9000"); assert.equal(info.max, "24.1000");
  pcb.onPointerDown(ev(), [13, 10], ctx); assert.deepEqual(P.state.tune.pattern.st.target, { min: 23.9 * IU, opt: 24 * IU, max: 24.1 * IU });
  pcb.onPointerMove(ev(), [27, 9], ctx); pcb.onPointerDown(ev(), [27, 9], ctx);
  assert.equal(log.commits.at(-1).label, "Tune");
  const lp = netLenN(doc, "USB_P"), ln = netLenN(doc, "USB_N"); assert.ok(Math.abs(Math.max(lp, ln) - 24) < 0.1, "tuned to the rule's 24 mm: " + lp + " " + ln);
  const gen = [...doc.items.values()].find((it) => it.kind === "generated"); assert.equal(K.kid(gen.node, "target_length")[1], 24);
  const rows = P.msgPanelInfo(doc, [gen.id]);
  assert.ok(rows.some((r) => r.title === "Length Constraints: min 23.9000 mm; opt 24.0000 mm; max 24.1000 mm" && r.value === "(from rule 'usb length')"), JSON.stringify(rows));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
