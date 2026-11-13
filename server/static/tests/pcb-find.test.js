// pcb-find.test.js — the board editor's Find (pcbnew/dialogs/dialog_find.cpp): EDA_ITEM::Matches' plain, whole-word
// and wildcard modes, the hit list DIALOG_FIND::search builds (footprints by reference, value, text and fields; board
// texts; zones; DRC markers; nets) and the hit cursor's walk with and without Wrap.
// Run: node server/static/tests/pcb-find.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools;

const BOARD = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (37 "F.SilkS" user) (49 "F.Fab" user))
  (footprint "Test:R" (layer "F.Cu") (uuid "fp-1") (at 100 50)
    (property "Reference" "R1" (at 0 -1.5) (layer "F.SilkS") (uuid "p-1") (effects (font (size 1 1) (thickness 0.15))))
    (property "Value" "10k" (at 0 1.5) (layer "F.Fab") (uuid "p-2") (effects (font (size 1 1) (thickness 0.15))))
    (property "MPN" "RC0603" (at 0 0) (layer "F.Fab") (hide yes) (uuid "p-3") (effects (font (size 1 1) (thickness 0.15))))
    (fp_text user "TUNE_ME" (at 0 2) (layer "F.SilkS") (uuid "t-1") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at -0.9 0) (size 1 1.2) (layers "F.Cu") (net "GND") (uuid "pad-1")))
  (footprint "Test:C" (layer "F.Cu") (uuid "fp-2") (at 120 50)
    (property "Reference" "C12" (at 0 -1.5) (layer "F.SilkS") (hide yes) (uuid "p-4") (effects (font (size 1 1) (thickness 0.15))))
    (property "Value" "100n" (at 0 1.5) (layer "F.Fab") (uuid "p-5") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at 0 0) (size 1 1.2) (layers "F.Cu") (net "/SIG_R1") (uuid "pad-2")))
  (gr_text "Board R1 rev{slash}A" (at 90 40) (layer "F.SilkS") (uuid "gt-1") (effects (font (size 1 1) (thickness 0.15))))
  (zone (net "GND") (net_name "GND") (layer "F.Cu") (uuid "z-1") (name "R1_pour") (hatch edge 0.5) (polygon (pts (xy 0 0) (xy 10 0) (xy 10 10)))))
)`;
const doc = () => K.parseDoc(BOARD, "kicad_pcb");
const ALL = { references: true, values: true, texts: true, markers: true, nets: true };
const ids = (hits) => hits.map((h) => h.kind === "item" ? h.id : h.kind === "net" ? "net:" + h.name : "marker:" + h.index);
const fpIds = (d) => { const m = {}; for (const it of d.items.values()) if (it.kind === "footprint") m[it.ref] = it.id; else m[it.kind] = it.id; return m; };

test("EDA_ITEM::Matches: plain is a case-insensitive substring unless Match case", () => {
  assert.equal(P.edaMatches("Hello World", { findString: "lo w" }), true);
  assert.equal(P.edaMatches("Hello World", { findString: "lo w", matchCase: true }), false);
  assert.equal(P.edaMatches("Hello World", { findString: "lo W", matchCase: true }), true);
});
test("EDA_ITEM::Matches: whole words need non-word characters (or the ends) around the match", () => {
  assert.equal(P.edaMatches("R1", { findString: "R1", wholeWord: true }), true);
  assert.equal(P.edaMatches("R10", { findString: "R1", wholeWord: true }), false);
  assert.equal(P.edaMatches("/SIG_R1", { findString: "R1", wholeWord: true }), false, "an underscore is a word character");
  assert.equal(P.edaMatches("R10 R1", { findString: "R1", wholeWord: true }), true, "a later occurrence still counts");
});
test("EDA_ITEM::Matches: wildcards match the whole text (wxString::Matches)", () => {
  assert.equal(P.edaMatches("C12", { findString: "C*", wildcards: true }), true);
  assert.equal(P.edaMatches("C12", { findString: "C?", wildcards: true }), false);
  assert.equal(P.edaMatches("C12", { findString: "C??", wildcards: true }), true);
  assert.equal(P.edaMatches("XC12", { findString: "C*", wildcards: true }), false);
});
test("the hit list: footprints first, then board texts, zones and nets, in DIALOG_FIND's order", () => {
  const d = doc(), m = fpIds(d);
  const hits = P.boardFindHits(d, { findString: "R1", ...ALL }, { nets: [{ name: "/SIG_R1", code: 3 }, { name: "GND", code: 1 }] });
  assert.deepEqual(ids(hits), [m.R1, m.gr_text, m.zone, "net:/SIG_R1"]);
});
test("a hidden reference is found only with Include hidden fields (PCB_FIELD::Matches)", () => {
  const d = doc(), m = fpIds(d);
  assert.deepEqual(ids(P.boardFindHits(d, { findString: "C12", ...ALL })), []);
  assert.deepEqual(ids(P.boardFindHits(d, { findString: "C12", ...ALL, hiddenFields: true })), [m.C12]);
  assert.deepEqual(ids(P.boardFindHits(d, { findString: "RC0603", ...ALL })), [], "a hidden user field too");
  assert.deepEqual(ids(P.boardFindHits(d, { findString: "RC0603", ...ALL, hiddenFields: true })), [m.R1]);
});
test("the kinds can be left out: values only, other text, markers", () => {
  const d = doc(), m = fpIds(d);
  const none = { references: false, values: false, texts: false, markers: false, nets: false };
  assert.deepEqual(ids(P.boardFindHits(d, { findString: "100n", ...none, values: true })), [m.C12]);
  assert.deepEqual(ids(P.boardFindHits(d, { findString: "R1", ...none, references: true })), [m.R1]);
  assert.deepEqual(ids(P.boardFindHits(d, { findString: "tune", ...none, texts: true })), [m.R1], "a footprint's own text");
  assert.deepEqual(ids(P.boardFindHits(d, { findString: "rev/a", ...none, texts: true })), [m.gr_text], "escapes are undone");
  const markers = [{ x: 1, y: 2, text: "Clearance violation" }, { x: 3, y: 4, text: "Unconnected items" }];
  assert.deepEqual(ids(P.boardFindHits(d, { findString: "unconn", ...none, markers: true }, { markers })), ["marker:1"]);
  assert.deepEqual(ids(P.boardFindHits(d, { findString: "unconn", ...none }, { markers })), []);
});
test("the cursor: Find Next walks and wraps, Find Previous walks back; without Wrap the end is reported", () => {
  // fresh list: forward starts on the first hit, backward on the last
  assert.deepEqual(P.findStep(-1, 3, true, true, true), { pos: 0, endReached: false });
  assert.deepEqual(P.findStep(-1, 3, false, true, true), { pos: 2, endReached: false });
  assert.deepEqual(P.findStep(0, 3, true, false, true), { pos: 1, endReached: false });
  assert.deepEqual(P.findStep(2, 3, true, false, true), { pos: 0, endReached: false });
  assert.deepEqual(P.findStep(2, 3, true, false, false), { pos: 2, endReached: true });
  assert.deepEqual(P.findStep(0, 3, false, false, true), { pos: 2, endReached: false });
  assert.deepEqual(P.findStep(0, 3, false, false, false), { pos: 0, endReached: true });
  assert.deepEqual(P.findStep(-1, 0, true, true, true), { pos: -1, endReached: false });
});
