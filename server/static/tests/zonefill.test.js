// node server/static/tests/zonefill.test.js — the browser zone filler (server/web/fab/zonefill.ts, a port of
// pcbnew's ZONE_FILLER) through the fab bundle's KiCadFab.fillZones / filledZoneNode.  `npm run build` must have
// produced static/kicad-canvas.js and static/dist/fab.js first.
"use strict";
const assert = require("assert");
const path = require("path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "dist", "fab.js"));
const K = globalThis.KiCadCanvas, F = globalThis.KiCadFab;

let passed = 0, failed = 0; const pending = [];
function test(name, fn) { pending.push(Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  ", name); }, (e) => { failed++; console.error("FAIL", name + ":", e && e.stack || e); })); }

const RULES = { netClearance: () => 0.2, minClearance: 0, holeClearance: 0.25, edgeClearance: 0.5 };
const area = (o) => { let a = 0; for (let i = 0, j = o.length - 1; i < o.length; j = i++) a += o[j][0] * o[i][1] - o[i][0] * o[j][1]; return Math.abs(a / 2); };
const totalArea = (lf) => lf.outlines.reduce((s, o) => s + area(o), 0);
const inside = (o, x, y) => { let c = false; for (let i = 0, j = o.length - 1; i < o.length; j = i++) { const [xi, yi] = o[i], [xj, yj] = o[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
const filledAt = (lf, x, y) => lf.outlines.some((o) => inside(o, x, y));
const bbox = (lf) => { const b = [Infinity, Infinity, -Infinity, -Infinity]; for (const o of lf.outlines) for (const [x, y] of o) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); } return b; };

const board = (...items) => `(kicad_pcb (version 20260206) (generator "pcbnew") (general (thickness 1.6))
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (1 "F.Mask" user) (3 "B.Mask" user) (25 "Edge.Cuts" user) (5 "F.SilkS" user "F.Silkscreen"))
 (setup (pad_to_mask_clearance 0))
 (net 0 "") (net 1 "GND") (net 2 "SIG")
 (gr_rect (start 100 100) (end 140 130) (stroke (width 0.1) (type default)) (fill no) (layer "Edge.Cuts") (uuid "edge"))
 ${items.join("\n ")})`;
const zone = (opts = {}) => `(zone (net "${opts.net || "GND"}") (layer "${opts.layer || "F.Cu"}") (uuid "${opts.uuid || "z1"}") (hatch edge 0.5) ${opts.priority ? `(priority ${opts.priority})` : ""}
  (connect_pads ${opts.connect || ""} (clearance ${opts.clearance ?? 0.5})) (min_thickness ${opts.minThickness ?? 0.25})
  (fill ${opts.fill || ""} (thermal_gap 0.5) (thermal_bridge_width 0.5) ${opts.smoothing || ""} (island_removal_mode ${opts.islands ?? 0}) ${opts.islandMin ? `(island_area_min ${opts.islandMin})` : ""} ${opts.hatch || ""})
  (polygon (pts ${(opts.pts || [[95, 95], [145, 95], [145, 135], [95, 135]]).map(([x, y]) => `(xy ${x} ${y})`).join(" ")})))`;
const smdFp = (ref, x, y, net, w = 2, h = 2) => `(footprint "T:SMD" (layer "F.Cu") (uuid "fp-${ref}") (at ${x} ${y})
  (property "Reference" "${ref}" (at 0 -3) (layer "F.SilkS") (uuid "r-${ref}") (effects (font (size 1 1) (thickness 0.15))))
  (pad "1" smd rect (at 0 0) (size ${w} ${h}) (layers "F.Cu" "F.Mask") (net "${net}") (uuid "p-${ref}")))`;
const thtFp = (ref, x, y, net, extra = "") => `(footprint "T:THT" (layer "F.Cu") (uuid "fp-${ref}") (at ${x} ${y})
  (property "Reference" "${ref}" (at 0 -3) (layer "F.SilkS") (uuid "r-${ref}") (effects (font (size 1 1) (thickness 0.15))))
  (pad "1" thru_hole circle (at 0 0) (size 2 2) (drill 1) (layers "*.Cu" "*.Mask") (net "${net}") ${extra} (uuid "p-${ref}")))`;
const seg = (x1, y1, x2, y2, net, w = 0.25, layer = "F.Cu") => `(segment (start ${x1} ${y1}) (end ${x2} ${y2}) (width ${w}) (layer "${layer}") (net "${net}") (uuid "s-${x1}-${y1}-${x2}-${y2}"))`;

async function fill(text, ids = null, rules = RULES) {
  const doc = K.parseDoc(text, "kicad_pcb");
  const res = await F.fillZones({ doc, setup: text }, rules, ids);
  return { doc, res, layer: (id, l) => res.find((r) => r.id === id).layers.find((x) => x.layer === l) };
}
const zid = (doc, uuid) => [...doc.items.values()].find((it) => it.kind === "zone" && K.str(K.kid(it.node, "uuid")[1]) === uuid).id;

test("a plain zone fills the board inside the edge clearance and the outline", async () => {
  const { doc, layer } = await fill(board(zone()));
  const lf = layer(zid(doc, "z1"), "F.Cu");
  assert.equal(lf.outlines.length, 1);
  const b = bbox(lf);
  // the zone outline overhangs the board: the fill is the board minus copper_edge_clearance (0.5) from the edge's centre line
  assert.ok(Math.abs(b[0] - 100.5) < 0.01 && Math.abs(b[1] - 100.5) < 0.01 && Math.abs(b[2] - 139.5) < 0.01 && Math.abs(b[3] - 129.5) < 0.01, b.join(","));
  assert.ok(Math.abs(totalArea(lf) - 39 * 29) < 0.5, "area " + totalArea(lf));
});

test("another net's pad is knocked out with the larger of the zone and netclass clearances", async () => {
  const { doc, layer } = await fill(board(zone(), smdFp("R1", 120, 115, "SIG")));
  const lf = layer(zid(doc, "z1"), "F.Cu");
  assert.ok(!filledAt(lf, 120, 115), "no copper on the pad");
  assert.ok(!filledAt(lf, 121.4, 115), "no copper within the 0.5 mm zone clearance of the pad edge");
  assert.ok(filledAt(lf, 121.6, 115), "copper past the clearance");
  // area: the board minus a 2 x 2 pad grown by 0.5 (round corners)
  const hole = 3 * 3 - (1 - Math.PI / 4) * 0.25 * 4;
  assert.ok(Math.abs(totalArea(lf) - (39 * 29 - hole)) < 0.3, "area " + totalArea(lf));
});

test("a track of another net is cleared; the same net's track is poured over", async () => {
  const other = await fill(board(zone(), seg(105, 110, 135, 110, "SIG", 0.3)));
  const lf = other.layer(zid(other.doc, "z1"), "F.Cu");
  assert.ok(!filledAt(lf, 120, 110.6), "0.15 + 0.5 around the track"); assert.ok(filledAt(lf, 120, 110.7));
  const same = await fill(board(zone(), seg(105, 110, 135, 110, "GND", 0.3), smdFp("R1", 105, 110, "GND")));
  const ls = same.layer(zid(same.doc, "z1"), "F.Cu");
  assert.ok(filledAt(ls, 120, 110), "the zone covers its own net's track");
});

test("a same-net through-hole pad gets a thermal relief: a gap and four spokes", async () => {
  const { doc, layer } = await fill(board(zone(), thtFp("J1", 120, 115, "GND")));
  const lf = layer(zid(doc, "z1"), "F.Cu");
  // the gap ring (pad radius 1, thermal gap 0.5) is empty on the diagonals; circular pads get 45 degree spokes
  const r = 1.25;
  assert.ok(filledAt(lf, 120 + r * Math.SQRT1_2, 115 + r * Math.SQRT1_2), "a spoke on the diagonal");
  assert.ok(!filledAt(lf, 120 + r, 115), "the gap beside the spokes");
  assert.ok(!filledAt(lf, 120, 115), "the hole is never filled");
  assert.ok(filledAt(lf, 120 + 3, 115), "copper beyond the relief");
  // (connect_pads yes): the pad is poured over solid
  const solid = await fill(board(zone({ connect: "yes" }), thtFp("J1", 120, 115, "GND")));
  const ls = solid.layer(zid(solid.doc, "z1"), "F.Cu");
  assert.ok(filledAt(ls, 120 + r, 115), "a solid connection fills right up to the pad");
  // a pad's own (zone_connect 0) overrides the zone: no connection, the pad is cleared
  const none = await fill(board(zone(), thtFp("J1", 120, 115, "GND", "(zone_connect 0)")));
  const ln = none.layer(zid(none.doc, "z1"), "F.Cu");
  assert.ok(!filledAt(ln, 120 + r * Math.SQRT1_2, 115 + r * Math.SQRT1_2), "no spokes"); assert.ok(!filledAt(ln, 121.4, 115));
});

test("islands: removed always (0), kept and flagged never (1), removed below the area (2)", async () => {
  // a box of SIG tracks walls off the corner 100..110 x 100..110: copper inside it holds no GND pad
  const walls = [seg(110, 99, 110, 111, "SIG", 0.4), seg(99, 110, 111, 110, "SIG", 0.4)];
  const items = (opts) => [zone(opts), smdFp("R1", 130, 120, "GND"), ...walls];
  const always = await fill(board(...items({ islands: 0 })));
  const la = always.layer(zid(always.doc, "z1"), "F.Cu");
  assert.ok(!filledAt(la, 105, 105), "the island is gone"); assert.ok(filledAt(la, 120, 120)); assert.equal(la.islands.size, 0);
  const never = await fill(board(...items({ islands: 1 })));
  const ln = never.layer(zid(never.doc, "z1"), "F.Cu");
  assert.ok(filledAt(ln, 105, 105), "kept"); assert.equal(ln.islands.size, 1, "and flagged as an island");
  const small = await fill(board(...items({ islands: 2, islandMin: 200 })));
  assert.ok(!filledAt(small.layer(zid(small.doc, "z1"), "F.Cu"), 105, 105), "an 89 mm² island is under 200 mm²");
  const big = await fill(board(...items({ islands: 2, islandMin: 10 })));
  assert.ok(filledAt(big.layer(zid(big.doc, "z1"), "F.Cu"), 105, 105), "and over 10 mm²");
  // a zone with no pad anywhere is a deliberately unconnected pour: every island is kept
  const lone = await fill(board(zone({ islands: 0 }), ...walls));
  assert.ok(filledAt(lone.layer(zid(lone.doc, "z1"), "F.Cu"), 105, 105));
});

test("a higher-priority zone of another net is filled first and cleared around; a keepout keeps copper out", async () => {
  const hi = zone({ net: "SIG", uuid: "z2", priority: 1, pts: [[110, 105], [125, 105], [125, 120], [110, 120]] });
  const { doc, layer } = await fill(board(zone(), hi, smdFp("R1", 130, 125, "GND"), smdFp("R2", 117, 112, "SIG")));
  const lo = layer(zid(doc, "z1"), "F.Cu"), up = layer(zid(doc, "z2"), "F.Cu");
  assert.ok(filledAt(up, 117, 107), "the high zone fills its outline");
  assert.ok(!filledAt(lo, 117, 107), "the low zone stays out of it"); assert.ok(!filledAt(lo, 109.6, 112), "by the clearance"); assert.ok(filledAt(lo, 109.3, 112));
  const ko = `(zone (layer "F.Cu") (uuid "k1") (hatch edge 0.5) (connect_pads (clearance 0)) (min_thickness 0.25) (keepout (tracks allowed) (vias allowed) (pads allowed) (copperpour not_allowed) (footprints allowed)) (fill (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts (xy 102 102) (xy 108 102) (xy 108 108) (xy 102 108))))`;
  const k = await fill(board(zone(), ko, smdFp("R1", 130, 125, "GND")));
  const lk = k.layer(zid(k.doc, "z1"), "F.Cu");
  assert.ok(!filledAt(lk, 105, 105), "no pour in the rule area"); assert.ok(filledAt(lk, 109, 109));
  assert.ok(!k.res.some((r) => r.id === zid(k.doc, "k1")), "a rule area is never filled");
});

test("hatch fill leaves a grid of holes; chamfered corners cut the outline", async () => {
  const hatch = await fill(board(zone({ fill: "yes (mode hatch)", hatch: "(hatch_thickness 1) (hatch_gap 1.5) (hatch_orientation 0) (hatch_border_algorithm hatch_thickness) (hatch_min_hole_area 0.3)" }), smdFp("R1", 130, 125, "GND")));
  const lh = hatch.layer(zid(hatch.doc, "z1"), "F.Cu");
  const solid = 39 * 29; const a = totalArea(lh);
  assert.ok(a < solid * 0.75 && a > solid * 0.3, "a hatch is mostly holes: " + a);
  const inner = [[100, 100], [140, 100], [140, 130], [100, 130]];
  const ch = await fill(board(zone({ pts: inner, smoothing: "(smoothing chamfer) (radius 3)" })));
  const lc = ch.layer(zid(ch.doc, "z1"), "F.Cu");
  assert.ok(!filledAt(lc, 101.2, 101.2), "the corner is chamfered off"); assert.ok(filledAt(lc, 104, 101.2));
});

test("filledZoneNode writes (fill yes …) and the filled polygons after the outline, layer by layer, islands flagged", async () => {
  const walls = [seg(110, 99, 110, 111, "SIG", 0.4), seg(99, 110, 111, 110, "SIG", 0.4)];
  const text = board(zone({ islands: 1, layer: "F.Cu" }).replace('(layer "F.Cu")', '(layers "F.Cu" "B.Cu")'), smdFp("R1", 130, 120, "GND"), ...walls);
  const { doc, res } = await fill(text);
  const it = doc.items.get(zid(doc, "z1")); const r = res[0];
  const node = F.filledZoneNode(it.node, r, doc.copper, K.cloneNode);
  const ser = K.serialize(node);
  assert.ok(/\(fill yes \(thermal_gap/.test(ser), ser.slice(0, 400));
  const kinds = node.slice(1).filter(Array.isArray).map((c) => c[0]);
  assert.ok(kinds.lastIndexOf("polygon") < kinds.indexOf("filled_polygon"), "after the outline");
  const layers = node.filter((c) => Array.isArray(c) && c[0] === "filled_polygon").map((c) => K.str(K.kid(c, "layer")[1]));
  assert.deepEqual([...new Set(layers)], ["F.Cu", "B.Cu"], "front first");
  assert.ok(/\(filled_polygon \(layer "F.Cu"\) \(island yes\) \(pts/.test(ser), "an island carries (island yes)");
  assert.ok(!/filled_areas_thickness/.test(ser));
});

Promise.all(pending).then(() => { console.log(`zonefill: ${passed} passed, ${failed} failed`); if (failed) process.exit(1); });
