// pcb-tools.js — board editing tools for the web editor, mirroring pcbnew's
// interactions: route (X) with KiCad's 45° posture, via (V), active layer
// (PgUp/PgDn), rotate (R) / flip (F) of the selected footprint, selection and
// delete of tracks, vias and graphics, expand to the connected run (U), drag a
// segment (D), width cycling (W), graphic line/rect/circle (Shift+L/R/C) and
// text (T).
//
// Registers on window.CollabTools.pcb.  The geometry and node builders touch no
// DOM and are exported as PcbTools on the global so the node test can drive
// them against a parsed board.
(function (root) {
"use strict";

let K = root.KiCadCanvas;                 // re-bound from ctx.K on every hook
const WIDTHS = [0.2, 0.25, 0.3, 0.5, 0.8, 1.0];
const HL = "#FFB43A", VIA = "#ECECEC";
const SNAP_MM = 0.5, HIT_MM = 0.2, DBL_MS = 400;
// The desktop applier only parses kicad_pcb documents (a bare item takes the
// legacy-format branches), so every fragment travels wrapped.  The version is
// the one boards from this build carry — it must never exceed the desktop's.
const BOARD_VERSION = 20260728;

const S = {
  layer: "F.Cu", gfxLayer: "F.SilkS", widths: {}, via: { size: 0.8, drill: 0.4 },
  sel: new Set(), route: null, drag: null, draw: null, hover: null, text: null, modTool: null, doc: null,
};
let lastCtx = null, chip = null, chipSel = null, domReady = false;

// ---------------------------------------------------------------- small helpers
const isList = Array.isArray;
const r6 = (v) => { const x = +(+v).toFixed(6); return x === 0 ? 0 : x; };   // no -0 in files
const norm360 = (a) => ((a % 360) + 360) % 360;
const norm180 = (a) => { const v = norm360(a); return v > 180 ? v - 360 : v; };   // KiCad's footprint range
const clone = (n) => JSON.parse(JSON.stringify(n));
const samePt = (a, b) => Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3;
function rotator(deg) { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return (x, y) => [x * c + y * s, -x * s + y * c]; }
const flipLayerName = (l) => /^F\./.test(l) ? "B." + l.slice(2) : /^B\./.test(l) ? "F." + l.slice(2) : l;
const sideSpecific = (l) => /^[FB]\./.test(l);
const otherSide = (l) => l === "F.Cu" ? "B.Cu" : "F.Cu";
const layerOf = (node, def) => { const l = K.kid(node, "layer"); return l ? K.str(l[1]) : (def || "F.Cu"); };
const pt = (node, key) => { const k = K.kid(node, key); return k ? [K.num(k[1]), K.num(k[2])] : null; };
const widthOf = (node, def) => { const w = K.kid(node, "width"); return w ? K.num(w[1], def) : def; };
const color = (layer) => (K.PCB_COLORS && K.PCB_COLORS[layer]) || (/\.Cu$/.test(layer) ? "#7FC87F" : "#C2C2C2");
const fmt = (v) => String(+v.toFixed(3));

// ---------------------------------------------------------------- nets
// Boards from this build reference nets by name — (net "GND") — while older
// ones carry (net 3 "GND") on pads and (net 3) on tracks; both are understood
// and new items are written in the document's own style.
function netOf(node) {
  const n = node && K.kid(node, "net"); if (!n) return { code: 0, name: "" };
  if (typeof n[1] === "number") return { code: n[1], name: n.length > 2 ? K.str(n[2]) : "" };
  return { code: -1, name: K.str(n[1]) };
}
const NET_STYLE = new WeakMap();
function netStyle(doc) {
  if (NET_STYLE.has(doc)) return NET_STYLE.get(doc);
  let style = "code";
  for (const it of doc.items.values()) {
    const probe = it.kind === "footprint" ? K.kid(it.node, "pad") : (it.kind === "segment" || it.kind === "via" || it.kind === "arc") ? it.node : null;
    const n = probe && K.kid(probe, "net"); if (!n) continue;
    style = typeof n[1] === "number" ? "code" : "name"; break;
  }
  NET_STYLE.set(doc, style); return style;
}
function netNode(doc, net) { return netStyle(doc) === "name" ? ["net", net && net.name ? net.name : ""] : ["net", net && net.code > 0 ? net.code : 0]; }
const hasNet = (n) => !!(n && (n.name || n.code > 0));
const sameNet = (a, b) => hasNet(a) && hasNet(b) && (a.name && b.name ? a.name === b.name : a.code === b.code);

// ---------------------------------------------------------------- node builders (KiCad board file shapes)
function segmentNode(doc, a, b, width, layer, net) {
  return ["segment", ["start", r6(a[0]), r6(a[1])], ["end", r6(b[0]), r6(b[1])], ["width", r6(width)], ["layer", layer], netNode(doc, net)];
}
function viaNode(doc, x, y, size, drill, net, layers) {
  return ["via", ["at", r6(x), r6(y)], ["size", r6(size)], ["drill", r6(drill)], ["layers"].concat(layers || ["F.Cu", "B.Cu"]), netNode(doc, net)];
}
const gfxWidth = (layer) => layer === "Edge.Cuts" ? 0.05 : 0.1;
const strokeNode = (w) => ["stroke", ["width", r6(w)], ["type", "default"]];
function lineNode(a, b, layer) { return ["gr_line", ["start", r6(a[0]), r6(a[1])], ["end", r6(b[0]), r6(b[1])], strokeNode(gfxWidth(layer)), ["layer", layer]]; }
function rectNode(a, b, layer) { return ["gr_rect", ["start", r6(a[0]), r6(a[1])], ["end", r6(b[0]), r6(b[1])], strokeNode(gfxWidth(layer)), ["fill", "no"], ["layer", layer]]; }
function circleNode(c, e, layer) { return ["gr_circle", ["center", r6(c[0]), r6(c[1])], ["end", r6(e[0]), r6(e[1])], strokeNode(gfxWidth(layer)), ["fill", "no"], ["layer", layer]]; }
function textNode(text, x, y, layer) {
  const eff = ["effects", ["font", ["size", 1, 1], ["thickness", 0.15]]];
  if (/^B\./.test(layer)) eff.push(["justify", "mirror"]);   // back-side text reads mirrored, like KiCad's
  return ["gr_text", text, ["at", r6(x), r6(y), 0], ["layer", layer], eff];
}

// ---------------------------------------------------------------- changes
function wrapBoard(node) { return `(kicad_pcb (version ${BOARD_VERSION}) (generator "pcbnew") ${K.serialize(node)})`; }
// kicad-canvas maps "arc" to the schematic shape name first; boards want PCB_ARC.
const typeNameOf = (item) => item.kind === "arc" ? "PCB_ARC" : K.typeNameOf(item);
function upsertChange(item, kind, net) {
  const c = { id: item.id, kind, typeName: typeNameOf(item), sexpr: wrapBoard(item.node) };
  const n = net || netOf(item.node); if (n.name) c.netName = n.name;   // the desktop re-resolves nets by name
  if (item.kind === "footprint") {
    const pads = {};
    for (const p of K.kids(item.node, "pad")) { const pn = netOf(p); if (pn.name) pads[K.str(p[1])] = pn.name; }
    c.padNets = pads;
  }
  return c;
}
function addedChange(doc, node, net) { return upsertChange(K.createItem(doc, node), "ADDED", net); }
function replacedChange(item, node) { return upsertChange({ id: item.id, kind: item.kind, node }, "MODIFIED"); }
function removedChange(item) { const c = K.removeChange(item); c.typeName = typeNameOf(item); return c; }

// ---------------------------------------------------------------- routing geometry
/** One KiCad-style leg from a to b: a 45° diagonal plus an orthogonal run, in either order. */
function routeLeg(a, b, diagFirst) {
  const dx = b[0] - a[0], dy = b[1] - a[1]; const d = Math.min(Math.abs(dx), Math.abs(dy));
  const diag = [Math.sign(dx) * d, Math.sign(dy) * d], orth = [dx - diag[0], dy - diag[1]];
  const first = diagFirst ? diag : orth, second = diagFirst ? orth : diag;
  const c = [a[0] + first[0], a[1] + first[1]]; const out = [];
  if (Math.hypot(first[0], first[1]) > 1e-6) out.push([a.slice(), c]);
  if (Math.hypot(second[0], second[1]) > 1e-6) out.push([c.slice(), b.slice()]);
  return out;
}

/** Absolute pad centres of a footprint item, with nets and copper layers. */
function padsOf(fp) {
  const n = fp.node; const [fx, fy, frot] = K.atOf(n); const R = rotator(frot); const out = [];
  for (const pad of K.kids(n, "pad")) {
    const [px, py, prot] = K.atOf(pad); const [rx, ry] = R(px, py); const sz = K.kid(pad, "size"); const ls = K.kid(pad, "layers");
    out.push({ x: fx + rx, y: fy + ry, rot: prot, w: sz ? K.num(sz[1]) : 1, h: sz ? K.num(sz[2], K.num(sz[1])) : 1,
      net: netOf(pad), layers: ls ? ls.slice(1).map(K.str) : [], number: K.str(pad[1]) });
  }
  return out;
}
const padOnLayer = (p, layer) => p.layers.some((l) => l === layer || l === "*.Cu" || l === "F&B.Cu");
function padCovers(p, x, y) { const [lx, ly] = rotator(-p.rot)(x - p.x, y - p.y); return Math.abs(lx) <= p.w / 2 && Math.abs(ly) <= p.h / 2; }

/** Magnetic target near (x, y): a pad (centre within tol, or the cursor over it), via or track end on the layer. */
function snapTarget(doc, x, y, tol, layer, net) {
  let best = null, bd = Infinity;
  const take = (px, py, n, kind, inside) => {
    const d = Math.hypot(px - x, py - y); if (!inside && d > tol) return;
    if (hasNet(net) && hasNet(n) && !sameNet(n, net)) return;   // never pull a routed net onto another net
    if (d < bd) { bd = d; best = { x: px, y: py, net: n, kind }; }
  };
  for (const it of doc.items.values()) {
    const b = it.bbox; if (b && (x < b[0] - tol || x > b[2] + tol || y < b[1] - tol || y > b[3] + tol)) continue;
    if (it.kind === "footprint") { for (const p of padsOf(it)) if (padOnLayer(p, layer)) take(p.x, p.y, p.net, "pad", padCovers(p, x, y)); }
    else if (it.kind === "via") { const a = pt(it.node, "at"); if (a) take(a[0], a[1], netOf(it.node), "via", false); }
    else if (it.kind === "segment" && layerOf(it.node) === layer) { for (const key of ["start", "end"]) { const p = pt(it.node, key); if (p) take(p[0], p[1], netOf(it.node), "track", false); } }
  }
  return best;
}
/** Net of whatever copper sits under (x, y): a pad, or a track/via on the layer. */
function netUnder(doc, x, y, layer) {
  for (const it of doc.items.values()) if (it.kind === "footprint" && it.bbox && x >= it.bbox[0] && x <= it.bbox[2] && y >= it.bbox[1] && y <= it.bbox[3]) {
    for (const p of padsOf(it)) if ((!layer || padOnLayer(p, layer)) && padCovers(p, x, y)) return p.net;
  }
  const it = hitTestItem(doc, x, y, HIT_MM);
  if (it && (it.kind === "via" || ((it.kind === "segment" || it.kind === "arc") && (!layer || layerOf(it.node) === layer)))) return netOf(it.node);
  return { code: 0, name: "" };
}

// ---------------------------------------------------------------- hit testing (non-footprint items)
function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1; const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
function pointInPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function inSweep(t, g) {
  const norm = (v) => ((v % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return g.anticlockwise ? norm(g.a0 - t) <= norm(g.a0 - g.a1) : norm(t - g.a0) <= norm(g.a1 - g.a0);
}
/** Distance from (x, y) to a geometry's stroke edge (0 inside a filled shape). */
function geomDist(g, x, y) {
  if (g.t === "line") return distSeg(x, y, g.x1, g.y1, g.x2, g.y2) - g.w / 2;
  if (g.t === "poly") {
    const n = g.pts.length; if (n < 2) return Infinity;
    if (g.fill && pointInPoly(g.pts, x, y)) return 0;
    let d = Infinity;
    for (let i = 0; i < (g.close ? n : n - 1); i++) { const a = g.pts[i], b = g.pts[(i + 1) % n]; d = Math.min(d, distSeg(x, y, a[0], a[1], b[0], b[1])); }
    return d - g.w / 2;
  }
  if (g.t === "circle") { const d = Math.hypot(x - g.x, y - g.y); return g.fill && d <= g.r ? d - g.r : Math.abs(d - g.r) - g.w / 2; }   // deep inside a via beats the tracks meeting under it
  if (g.t === "arc") { const d = Math.hypot(x - g.x, y - g.y); return inSweep(Math.atan2(y - g.y, x - g.x), g) ? Math.abs(d - g.r) - g.w / 2 : Infinity; }
  if (g.t === "rect") return (x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h) ? 0 : Infinity;
  return Infinity;
}
/** Nearest track / via / graphic / text within slop mm of (x, y); footprints are app.js's business. */
function hitTestItem(doc, x, y, slop) {
  let best = null, bd = slop;
  for (const it of doc.items.values()) {
    if (it.kind === "footprint" || it.kind === "group" || it.kind === "generated" || !it.bbox) continue;
    const b = it.bbox; if (x < b[0] - slop || x > b[2] + slop || y < b[1] - slop || y > b[3] + slop) continue;
    let d = Infinity;
    if (it.kind === "gr_text" || it.kind === "gr_text_box" || it.kind === "dimension") d = (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]) ? slop * 0.5 : Infinity;   // precise copper hits win over a text box
    else for (const g of it.geom) { if (it.kind === "zone" && g.fill) continue; d = Math.min(d, geomDist(g, x, y)); }
    if (d < bd) { bd = d; best = it; }
  }
  return best;
}

// ---------------------------------------------------------------- connectivity (U)
function conductorEnds(it) {
  if (it.kind === "segment" || it.kind === "arc") return [pt(it.node, "start"), pt(it.node, "end")].filter(Boolean);
  if (it.kind === "via") { const a = pt(it.node, "at"); return a ? [a] : []; }
  return [];
}
const ptKey = (p) => Math.round(p[0] * 1000) + "," + Math.round(p[1] * 1000);
/** Ids of every track / arc / via reachable from the seeds through shared endpoints (vias bridge layers). */
function connectedRun(doc, seedIds) {
  const index = new Map(), ends = new Map();
  for (const it of doc.items.values()) {
    const e = conductorEnds(it); if (!e.length) continue; ends.set(it.id, e);
    for (const p of e) { const k = ptKey(p); let arr = index.get(k); if (!arr) { arr = []; index.set(k, arr); } arr.push(it); }
  }
  const out = new Set(), q = [];
  for (const id of seedIds) if (ends.has(id)) { out.add(id); q.push(id); }
  while (q.length) {
    const id = q.pop(); const it = doc.items.get(id);
    for (const p of ends.get(id)) for (const o of index.get(ptKey(p)) || []) {
      if (out.has(o.id)) continue;
      const bridged = it.kind === "via" || o.kind === "via" || layerOf(it.node) === layerOf(o.node);
      if (bridged) { out.add(o.id); q.push(o.id); }
    }
  }
  return out;
}

// ---------------------------------------------------------------- footprint rotate / flip (file-level)
// Pad and text angles in the file are absolute (KiCad writes lib angle + footprint angle), so a footprint
// turn re-derives each one from its angle relative to the footprint; a flip negates that relative angle.
const ANGLED = (c) => isList(c) && (c[0] === "pad" || c[0] === "property" || c[0] === "fp_text") && !!K.kid(c, "at");
function setAngle(c, a) { const at = K.kid(c, "at"); a = norm180(r6(a)); if (at.length >= 4) at[3] = a; else if (a !== 0) at.push(a); }
function rotateFootprintNode(node, deg) {
  const [x, y, a0] = K.atOf(node); const a1 = norm180(a0 + deg); K.setAt(node, x, y, a1);
  for (const c of node) if (ANGLED(c)) setAngle(c, K.atOf(c)[2] - a0 + a1);
  return node;
}
function mirrorShapeX(g) {
  for (const key of ["start", "end", "center", "mid"]) { const k = K.kid(g, key); if (k) k[1] = r6(-K.num(k[1])); }
  const pts = K.kid(g, "pts");
  if (pts) for (const p of pts.slice(1)) { if (!isList(p)) continue; if (p[0] === "xy") p[1] = r6(-K.num(p[1])); else mirrorShapeX(p); }
}
function flipLayerKid(c) {
  const l = K.kid(c, "layer"); if (l) l[1] = flipLayerName(K.str(l[1]));
  const ls = K.kid(c, "layers"); if (ls) for (let i = 1; i < ls.length; i++) ls[i] = flipLayerName(K.str(ls[i]));
}
function toggleMirror(c) {
  const l = K.kid(c, "layer"); if (!l || !sideSpecific(K.str(l[1]))) return;   // user layers have no side: no mirroring
  let eff = K.kid(c, "effects"); if (!eff) { eff = ["effects"]; c.push(eff); }
  const j = K.kid(eff, "justify");
  if (!j) { eff.push(["justify", "mirror"]); return; }
  const i = j.indexOf("mirror");
  if (i < 0) j.push("mirror"); else { j.splice(i, 1); if (j.length === 1) eff.splice(eff.indexOf(j), 1); if (eff.length === 1) c.splice(c.indexOf(eff), 1); }
}
/** Flip to the other side about the footprint's own origin (KiCad's F): mirror local X, negate angles, swap F./B. layers. */
function flipFootprintNode(node) {
  const [x, y, a0] = K.atOf(node); const a1 = norm180(-a0); K.setAt(node, x, y, a1);
  const lay = K.kid(node, "layer"); if (lay) lay[1] = flipLayerName(K.str(lay[1]));
  for (const c of node) {
    if (!isList(c)) continue; const t = c[0];
    if (ANGLED(c)) { const at = K.kid(c, "at"); at[1] = r6(-K.num(at[1])); setAngle(c, -(K.atOf(c)[2] - a0) + a1); }
    if (t === "pad") {
      flipLayerKid(c);
      const dr = K.kid(c, "drill"); const off = dr && K.kid(dr, "offset"); if (off) off[1] = r6(-K.num(off[1]));
      const prims = K.kid(c, "primitives"); if (prims) for (const p of prims.slice(1)) if (isList(p)) mirrorShapeX(p);
    } else if (t === "property" || t === "fp_text") { if (ANGLED(c)) { flipLayerKid(c); toggleMirror(c); } }
    else if (/^fp_(line|rect|circle|arc|poly|curve)$/.test(t)) { mirrorShapeX(c); flipLayerKid(c); }
    else if (t === "fp_text_box" || t === "zone") { mirrorShapeX(c); flipLayerKid(c); for (const poly of K.kids(c, "polygon").concat(K.kids(c, "filled_polygon"))) mirrorShapeX(poly); if (t === "fp_text_box") toggleMirror(c); }
  }
  return node;
}

// ---------------------------------------------------------------- track drag (D)
function dragPlan(doc, seg) {
  const a0 = pt(seg.node, "start"), b0 = pt(seg.node, "end"); if (!a0 || !b0) return null;
  const L = Math.hypot(b0[0] - a0[0], b0[1] - a0[1]); if (L < 1e-6) return null;
  const n = [-(b0[1] - a0[1]) / L + 0, (b0[0] - a0[0]) / L + 0]; const layer = layerOf(seg.node);   // + 0 clears a -0
  const viaAt = [false, false], nb = [];
  for (const it of doc.items.values()) if (it.kind === "via") { const p = pt(it.node, "at"); if (!p) continue; if (samePt(p, a0)) { viaAt[0] = true; nb.push({ item: it, key: "at", which: 0 }); } else if (samePt(p, b0)) { viaAt[1] = true; nb.push({ item: it, key: "at", which: 1 }); } }
  for (const it of doc.items.values()) {
    if (it.kind !== "segment" || it.id === seg.id) continue;
    for (const key of ["start", "end"]) {
      const p = pt(it.node, key); if (!p) continue;
      const w = samePt(p, a0) ? 0 : samePt(p, b0) ? 1 : -1;
      if (w >= 0 && (layerOf(it.node) === layer || viaAt[w])) nb.push({ item: it, key, which: w });   // a via at the joint drags the other side's tracks too
    }
  }
  return { id: seg.id, item: seg, a0, b0, n, nb, off: 0, anchor: null };
}
/** New nodes for the dragged segment and its attached neighbours at a normal offset. */
function dragNodes(plan, off) {
  const a = [r6(plan.a0[0] + plan.n[0] * off), r6(plan.a0[1] + plan.n[1] * off)], b = [r6(plan.b0[0] + plan.n[0] * off), r6(plan.b0[1] + plan.n[1] * off)];
  const seg = clone(plan.item.node); K.kid(seg, "start").splice(1, 2, a[0], a[1]); K.kid(seg, "end").splice(1, 2, b[0], b[1]);
  const out = [{ item: plan.item, node: seg }];
  for (const nb of plan.nb) { const node = clone(nb.item.node); const p = nb.which === 0 ? a : b; K.kid(node, nb.key).splice(1, 2, p[0], p[1]); out.push({ item: nb.item, node }); }
  return out;
}

// ---------------------------------------------------------------- app.js state (read defensively)
// app.js keeps the editor state in script-scope lets (tool, kdoc, DOC_TYPE, zoom, selected, state) that
// the module hooks don't carry live; they are read under try/catch, falling back to the last ctx seen.
function appGlobal(fn, fallback) { try { const v = fn(); return v === undefined ? fallback : v; } catch (e) { return fallback; } }
/* global tool, kdoc, DOC_TYPE, zoom, selected, state */
const appTool = () => appGlobal(() => tool, S.modTool || "select");
const isPcbDoc = () => appGlobal(() => DOC_TYPE === "kicad_pcb" && !!kdoc && state.view === "editor", !!(lastCtx && !lastCtx.isSch && lastCtx.doc));
const liveDoc = () => appGlobal(() => kdoc, lastCtx && lastCtx.doc);
const liveZoom = () => appGlobal(() => zoom, lastCtx ? lastCtx.zoom : 1);
const liveSelected = () => appGlobal(() => selected, lastCtx && lastCtx.selected);

function bind(ctx) { lastCtx = ctx; if (ctx && ctx.K) K = ctx.K; if (ctx) ensureDom(ctx); }
const widthFor = (layer) => S.widths[layer] || 0.25;
function nextWidth(w) { const i = WIDTHS.findIndex((v) => Math.abs(v - w) < 1e-6); return WIDTHS[(i + 1) % WIDTHS.length]; }
/** Layer names of the board.  kicad-canvas keys doc.layers by the layer *type* for (n "F.Cu" signal) entries, so fall back to what the items use. */
function layerNames(doc) {
  const names = new Set(doc ? Array.from(doc.layers.keys()).filter((l) => /\./.test(l)) : []);
  if (!names.size && doc) for (const it of doc.items.values()) for (const g of it.geom) if (g.layer && /\./.test(g.layer)) names.add(g.layer);
  return names;
}
function gfxLayers(doc) {
  const names = Array.from(layerNames(doc)).filter((l) => !/\.Cu$/.test(l));
  const out = ["Edge.Cuts", "F.SilkS", "B.SilkS", "Dwgs.User", "Cmts.User", "F.Fab", "B.Fab"];   // every board has these
  for (const l of names) if (!out.includes(l)) out.push(l);
  return out;
}

// ---------------------------------------------------------------- interactions
function hoverPoint(ctx, mm, magnetic) {
  const g = ctx.snap(mm); const out = { x: g[0], y: g[1], snap: null };
  if (magnetic && ctx.doc) {
    const s = snapTarget(ctx.doc, mm[0], mm[1], SNAP_MM, S.route ? S.route.layer : S.layer, S.route ? S.route.net : null);
    if (s) { out.x = s.x; out.y = s.y; out.snap = s; }
  }
  return out;
}
function currentLeg(rt) { return routeLeg(rt.last, rt.target, rt.diagFirst); }
function fixLeg(ctx, target) {
  const rt = S.route; const segs = routeLeg(rt.last, target, rt.diagFirst); if (!segs.length) return false;
  const changes = segs.map(([a, b]) => addedChange(ctx.doc, segmentNode(ctx.doc, a, b, rt.width, rt.layer, rt.net), rt.net));
  S.widths[rt.layer] = rt.width;
  ctx.commit(changes, "route"); rt.last = target.slice(); rt.target = target.slice();
  return true;
}
function endRoute(ctx, fixCurrent) {
  const rt = S.route; if (!rt) return;
  if (fixCurrent && !samePt(rt.target, rt.last)) fixLeg(ctx, rt.target);
  S.route = null; refreshChip(ctx); ctx.requestRender();
}
function routeClick(ctx, hv) {
  const now = Date.now(); const p = [hv.x, hv.y];
  if (!S.route) {
    const net = hv.snap ? hv.snap.net : netUnder(ctx.doc, hv.x, hv.y, S.layer);
    S.route = { last: p, target: p.slice(), net, layer: S.layer, width: widthFor(S.layer), diagFirst: true, clickT: now, clickAt: p.slice() };
    ctx.toast(`Routing ${net.name ? net.name + " " : ""}on ${S.layer} · ${fmt(S.route.width)} mm — click corners, / posture, V via, Enter or double-click to end`, 3500);
    refreshChip(ctx); ctx.requestRender(); return;
  }
  const rt = S.route;
  const dbl = now - rt.clickT < DBL_MS && Math.hypot(p[0] - rt.clickAt[0], p[1] - rt.clickAt[1]) < 0.3;
  rt.clickT = now; rt.clickAt = p.slice();
  if (dbl) { endRoute(ctx, true); return; }
  fixLeg(ctx, p);
  if (hv.snap && hv.snap.kind === "pad") { S.route = null; ctx.toast("Route finished at pad"); refreshChip(ctx); }   // landing on a pad ends the trace, as in KiCad
  ctx.requestRender();
}
/** V while routing: fix the leg to the cursor, drop a via there and continue on the other side. */
function routeVia(ctx, toLayer) {
  const rt = S.route; const p = rt.target.slice(); const doc = ctx.doc;
  const changes = routeLeg(rt.last, p, rt.diagFirst).map(([a, b]) => addedChange(doc, segmentNode(doc, a, b, rt.width, rt.layer, rt.net), rt.net));
  changes.push(addedChange(doc, viaNode(doc, p[0], p[1], S.via.size, S.via.drill, rt.net), rt.net));
  S.widths[rt.layer] = rt.width;
  ctx.commit(changes, "route via");
  rt.last = p; rt.target = p.slice(); rt.layer = toLayer || otherSide(rt.layer); S.layer = rt.layer; rt.width = widthFor(rt.layer);
  ctx.toast(`Via placed — now routing on ${rt.layer}`); refreshChip(ctx); ctx.requestRender();
}
function placeVia(ctx, hv) {
  const net = hv.snap ? hv.snap.net : netUnder(ctx.doc, hv.x, hv.y, null);
  ctx.commit([addedChange(ctx.doc, viaNode(ctx.doc, hv.x, hv.y, S.via.size, S.via.drill, net), net)], "via");
}
function setLayer(ctx, layer) {
  if (S.route) { if (layer !== S.route.layer) routeVia(ctx, layer); return; }   // layer change mid-route goes through a via
  S.layer = layer; ctx.toast(`Active layer: ${layer}`); refreshChip(ctx); ctx.requestRender();
}
function rotateSelected(ctx) {
  const fp = ctx.selected && ctx.doc.items.get(ctx.selected.id); if (!fp || fp.kind !== "footprint") return false;
  ctx.commit([replacedChange(fp, rotateFootprintNode(clone(fp.node), 90))], "rotate"); return true;
}
function flipSelected(ctx) {
  const fp = ctx.selected && ctx.doc.items.get(ctx.selected.id); if (!fp || fp.kind !== "footprint") return false;
  const node = flipFootprintNode(clone(fp.node));
  ctx.commit([replacedChange(fp, node)], "flip"); ctx.toast(`${fp.ref || "Footprint"} flipped to ${layerOf(node)}`); return true;
}
function deleteSelection(ctx) {
  const changes = []; for (const id of S.sel) { const it = ctx.doc.items.get(id); if (it) changes.push(removedChange(it)); }
  S.sel.clear(); if (!changes.length) return;
  ctx.commit(changes, "delete"); ctx.toast(`Deleted ${changes.length} item${changes.length > 1 ? "s" : ""}`);
}
function cycleWidth(ctx) {
  if (S.route) { S.route.width = nextWidth(S.route.width); ctx.toast(`Track width ${fmt(S.route.width)} mm`); refreshChip(ctx); ctx.requestRender(); return; }
  const segs = Array.from(S.sel, (id) => ctx.doc.items.get(id)).filter((it) => it && (it.kind === "segment" || it.kind === "arc"));
  if (segs.length) {
    const w = nextWidth(widthOf(segs[0].node, 0.25));
    const changes = segs.map((it) => { const node = clone(it.node); const wn = K.kid(node, "width"); if (wn) wn[1] = w; else node.push(["width", w]); return replacedChange(it, node); });
    ctx.commit(changes, "track width"); S.widths[layerOf(segs[0].node)] = w; ctx.toast(`Track width ${fmt(w)} mm`); refreshChip(ctx); return;
  }
  S.widths[S.layer] = nextWidth(widthFor(S.layer)); ctx.toast(`Track width ${fmt(S.widths[S.layer])} mm on ${S.layer}`); refreshChip(ctx);
}
function expandSelection(ctx) {
  if (!S.sel.size) return false;
  const before = S.sel.size; S.sel = connectedRun(ctx.doc, S.sel);
  ctx.toast(S.sel.size > before ? `Selected the connected run (${S.sel.size} items)` : "Nothing else connected"); ctx.requestRender(); return true;
}
function beginDrag(ctx) {
  const seg = Array.from(S.sel, (id) => ctx.doc.items.get(id)).find((it) => it && it.kind === "segment"); if (!seg) return false;
  const plan = dragPlan(ctx.doc, seg); if (!plan) return false;
  S.drag = plan; S.sel = new Set([seg.id]); return true;
}
function dragMove(ctx, mm) {
  const d = S.drag; if (!d.anchor) { d.anchor = mm.slice(); return; }
  let off = (mm[0] - d.anchor[0]) * d.n[0] + (mm[1] - d.anchor[1]) * d.n[1];
  if (ctx.snapOn && ctx.gridPitch > 0) { const base = d.a0[0] * d.n[0] + d.a0[1] * d.n[1]; off = K.snap(base + off, ctx.gridPitch) - base; }   // keep the moved line on the grid
  d.off = off;
}
function finishDrag(ctx) {
  const d = S.drag; S.drag = null;
  if (d && Math.abs(d.off) > 1e-6) ctx.commit(dragNodes(d, d.off).map(({ item, node }) => replacedChange(item, node)), "drag track");
  ctx.setTool("select");
}
function drawClick(ctx, hv, t) {
  const p = [hv.x, hv.y], layer = S.gfxLayer;
  if (!S.draw) { S.draw = { shape: t, start: p, cur: p.slice() }; ctx.requestRender(); return; }
  const d = S.draw;
  if (samePt(p, d.start)) { S.draw = null; ctx.requestRender(); return; }   // clicking the start again ends the chain
  const node = t === "gline" ? lineNode(d.start, p, layer) : t === "grect" ? rectNode(d.start, p, layer) : circleNode(d.start, p, layer);
  ctx.commit([addedChange(ctx.doc, node)], t === "gline" ? "line" : t === "grect" ? "rectangle" : "circle");
  S.draw = t === "gline" ? { shape: t, start: p, cur: p.slice() } : null;   // lines chain like KiCad's polyline drawing
  ctx.requestRender();
}
function placeText(ctx, mm, text) { ctx.commit([addedChange(ctx.doc, textNode(text, mm[0], mm[1], S.gfxLayer))], "text"); }
function cancelOps() { S.route = null; S.draw = null; S.drag = null; closeTextPrompt(); }

// ---------------------------------------------------------------- DOM: select-mode picking, stolen keys, layer chip, text prompt
function ensureDom(ctx) {
  if (domReady || typeof document === "undefined" || !ctx.stage) return; domReady = true;
  // The module's pointer hooks only run while one of its tools is active; picking tracks in the app's own
  // select tool listens on the stage after app.js has had its turn with the footprints.
  ctx.stage.addEventListener("pointerdown", onStagePointerDown);
  // Keys app.js consumes before the module (F = fit view, Shift+C = comment, Escape) are caught in the
  // capture phase and re-posted under names of our own so they still arrive through onKey with a fresh ctx.
  document.addEventListener("keydown", onCaptureKey, true);
  chip = document.createElement("div"); chip.id = "pcbChip";
  chip.style.cssText = "position:absolute;left:8px;top:8px;z-index:5;display:none;align-items:center;gap:8px;padding:3px 8px;border-radius:3px;background:rgba(0,16,35,.82);border:1px solid #24374E;color:#D0D2CD;font:11px var(--mono,ui-monospace,monospace);pointer-events:auto;user-select:none";
  chip.innerHTML = '<span data-k="layer" title="Active copper layer — click to swap (PgUp / PgDn)" style="display:inline-flex;align-items:center;gap:5px;cursor:pointer"><i data-k="sw" style="width:10px;height:10px;border-radius:2px;display:inline-block"></i><b data-k="name"></b></span>'
    + '<span data-k="w" title="Track width (W cycles)"></span><span data-k="v" title="Via size / drill"></span>'
    + '<label data-k="gfx" style="display:none;align-items:center;gap:4px">on <select data-k="gsel" style="font:inherit;background:#0A1421;color:inherit;border:1px solid #24374E;border-radius:2px"></select></label>';
  chip.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  chip.querySelector('[data-k="layer"]').addEventListener("click", () => { if (lastCtx) setLayer(lastCtx, otherSide(S.layer)); });
  chipSel = chip.querySelector('[data-k="gsel"]');
  chipSel.addEventListener("change", () => { S.gfxLayer = chipSel.value; chipSel.blur(); if (lastCtx) lastCtx.toast("Drawing on " + S.gfxLayer); });   // blur hands the hotkeys back
  ctx.stage.appendChild(chip);
  // the layer list is rebuilt whenever a document opens: that is the cue to show or hide the chip
  const layersEl = document.getElementById("layers");
  if (layersEl && typeof MutationObserver !== "undefined") new MutationObserver(() => refreshChip(lastCtx)).observe(layersEl, { childList: true });
  refreshChip(ctx);
}
function refreshChip(ctx) {
  if (!chip) return;
  const show = isPcbDoc(); chip.style.display = show ? "flex" : "none"; if (!show) return;
  chip.querySelector('[data-k="sw"]').style.background = color(S.layer);
  chip.querySelector('[data-k="name"]').textContent = S.layer;
  chip.querySelector('[data-k="w"]').textContent = fmt(S.route ? S.route.width : widthFor(S.layer)) + " mm";
  chip.querySelector('[data-k="v"]').textContent = "via " + fmt(S.via.size) + "/" + fmt(S.via.drill);
  const drawing = /^g/.test(S.modTool || "");
  chip.querySelector('[data-k="gfx"]').style.display = drawing ? "inline-flex" : "none";
  if (drawing) {
    const opts = gfxLayers(ctx && ctx.doc);
    if (Array.from(chipSel.options, (o) => o.value).join() !== opts.join()) chipSel.innerHTML = opts.map((l) => `<option value="${l}">${l}</option>`).join("");
    if (!opts.includes(S.gfxLayer)) S.gfxLayer = opts[0] || "F.SilkS";
    chipSel.value = S.gfxLayer;
  }
}
function onStagePointerDown(ev) {
  if (ev.button !== 0 || !isPcbDoc() || appTool() !== "select") return;
  if (ev.target.closest && (ev.target.closest("#cmtPanel") || ev.target.closest("#pcbChip") || ev.target.closest("#signinOverlay"))) return;
  const ctx = lastCtx, doc = liveDoc(); if (!ctx || !doc) return;
  const [x, y] = ctx.worldMm(ev);
  if (K.hitTest(doc, x, y, Math.min(5 / Math.max(1, liveZoom() * 0.6), 0.5))) { if (S.sel.size) { S.sel.clear(); ctx.requestRender(); } return; }   // app.js took the footprint
  const it = hitTestItem(doc, x, y, HIT_MM + 2 / Math.max(1, ctx.pxPerMm || 1));
  if (it) { if (ev.shiftKey) { if (S.sel.has(it.id)) S.sel.delete(it.id); else S.sel.add(it.id); } else S.sel = new Set([it.id]); }
  else if (!ev.shiftKey) S.sel.clear();
  ctx.requestRender();
}
function onCaptureKey(ev) {
  if (!isPcbDoc() || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const tag = ev.target && ev.target.tagName; if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  const k = ev.key;
  if (k === "Escape") {
    if (S.route || S.draw || S.drag || S.text) {   // first Escape only cancels the operation, KiCad style; the next one leaves the tool
      cancelOps(); ev.stopImmediatePropagation(); ev.preventDefault();
      if (lastCtx) { lastCtx.toast("Cancelled"); refreshChip(lastCtx); lastCtx.requestRender(); }
    } else if (S.sel.size) { S.sel.clear(); if (lastCtx) lastCtx.requestRender(); }
    return;
  }
  let remap = null;
  if ((k === "f" || k === "F") && !ev.shiftKey && liveSelected()) remap = "Flip";
  else if (k === "C" && ev.shiftKey) remap = "Circle";
  if (remap) { ev.stopImmediatePropagation(); ev.preventDefault(); document.dispatchEvent(new KeyboardEvent("keydown", { key: remap, bubbles: true, cancelable: true })); }
}
function openTextPrompt(ctx, ev, mm) {
  closeTextPrompt(); if (typeof document === "undefined") return;
  const inp = document.createElement("input"); inp.placeholder = "Text — Enter to place, Esc to cancel";
  inp.style.cssText = `position:fixed;left:${ev.clientX + 6}px;top:${ev.clientY - 14}px;z-index:60;width:220px;padding:3px 6px;border-radius:3px;border:1px solid #4D7FC4;background:#111D2C;color:#E6E6E6;font:12px var(--mono,ui-monospace,monospace)`;
  document.body.appendChild(inp); S.text = { inp, mm };
  inp.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { const v = inp.value.trim(); closeTextPrompt(); if (v) placeText(ctx, mm, v); }
    else if (e.key === "Escape") closeTextPrompt();
  });
  inp.addEventListener("blur", () => setTimeout(closeTextPrompt, 0));
  setTimeout(() => inp.focus(), 0);   // after app.js's preventDefault on the pointerdown that opened it
}
function closeTextPrompt() { const t = S.text; S.text = null; if (t && t.inp.parentNode) t.inp.parentNode.removeChild(t.inp); }

// ---------------------------------------------------------------- overlay
function strokeGeom(c, g) {
  if (g.t === "line") { c.beginPath(); c.moveTo(g.x1, g.y1); c.lineTo(g.x2, g.y2); c.stroke(); }
  else if (g.t === "poly") { if (g.pts.length < 2) return; c.beginPath(); c.moveTo(g.pts[0][0], g.pts[0][1]); for (let i = 1; i < g.pts.length; i++) c.lineTo(g.pts[i][0], g.pts[i][1]); if (g.close) c.closePath(); c.stroke(); }
  else if (g.t === "circle") { c.beginPath(); c.arc(g.x, g.y, g.r, 0, Math.PI * 2); c.stroke(); }
  else if (g.t === "arc") { c.beginPath(); c.arc(g.x, g.y, g.r, g.a0, g.a1, g.anticlockwise); c.stroke(); }
}
function line(c, a, b) { c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); }
function ring(c, p, r) { c.beginPath(); c.arc(p[0], p[1], r, 0, Math.PI * 2); c.stroke(); }
function drawOverlay(c, view, ctx) {
  bind(ctx); const doc = ctx.doc; if (!doc) return;
  if (chip && chip.style.display === "none") refreshChip(ctx);   // the first document renders before the layer-list observer exists
  const px = 1 / (view.ppm * view.zoom * (view.dpr || 1));
  c.lineCap = "round"; c.lineJoin = "round";
  // selection highlight
  c.strokeStyle = HL; c.globalAlpha = 0.85;
  for (const id of S.sel) {
    const it = doc.items.get(id); if (!it) continue;
    if (it.kind === "gr_text" || it.kind === "gr_text_box" || it.kind === "dimension") { const b = it.bbox; if (b) { c.lineWidth = 1.5 * px; c.strokeRect(b[0] - 0.2, b[1] - 0.2, b[2] - b[0] + 0.4, b[3] - b[1] + 0.4); } continue; }
    for (const g of it.geom) { if (it.kind === "zone" && g.fill) continue; c.lineWidth = (g.w || 0) + 3 * px; strokeGeom(c, g); }
  }
  // drag preview: the moved segment and its neighbours at their new places
  if (S.drag && S.drag.anchor) {
    c.globalAlpha = 0.9;
    for (const { item, node } of dragNodes(S.drag, S.drag.off)) {
      const lay = layerOf(node); c.strokeStyle = item.kind === "via" ? VIA : color(lay);
      if (item.kind === "via") { c.lineWidth = 2 * px; ring(c, pt(node, "at"), K.num((K.kid(node, "size") || [0, 0.8])[1]) / 2); }
      else { c.lineWidth = widthOf(node, 0.25); line(c, pt(node, "start"), pt(node, "end")); }
    }
  }
  // route in progress: fixed legs are already in the document, the current one lives here
  if (S.route) {
    const rt = S.route; c.globalAlpha = 0.75; c.strokeStyle = color(rt.layer); c.lineWidth = rt.width;
    for (const [a, b] of currentLeg(rt)) line(c, a, b);
    c.globalAlpha = 1; c.strokeStyle = "#FFFFFF"; c.lineWidth = 1.5 * px; ring(c, rt.last, 4 * px);
  }
  // drawing preview
  if (S.draw) {
    const d = S.draw; c.globalAlpha = 0.85; c.strokeStyle = color(S.gfxLayer); c.lineWidth = Math.max(gfxWidth(S.gfxLayer), 1.5 * px);
    if (d.shape === "gline") line(c, d.start, d.cur);
    else if (d.shape === "grect") c.strokeRect(Math.min(d.start[0], d.cur[0]), Math.min(d.start[1], d.cur[1]), Math.abs(d.cur[0] - d.start[0]), Math.abs(d.cur[1] - d.start[1]));
    else ring(c, d.start, Math.hypot(d.cur[0] - d.start[0], d.cur[1] - d.start[1]));
  }
  // cursor: the via about to be placed, and the magnetic snap marker
  const hv = S.hover;
  if (hv && S.modTool) {
    if (S.modTool === "via" && !S.route) { c.globalAlpha = 0.6; c.strokeStyle = VIA; c.lineWidth = (S.via.size - S.via.drill) / 2; ring(c, [hv.x, hv.y], (S.via.size + S.via.drill) / 4); }
    if (hv.snap) { c.globalAlpha = 1; c.strokeStyle = HL; c.lineWidth = 1.5 * px; ring(c, [hv.x, hv.y], 5 * px); }
  }
  c.globalAlpha = 1;
}

// ---------------------------------------------------------------- module
const TOOLS = [
  { id: "route", label: "Route track", key: "X", cursor: "crosshair", icon: '<path d="M4 18h6l4-4h6"/><circle cx="4" cy="18" r="1.5"/><circle cx="20" cy="14" r="1.5"/>' },
  { id: "via", label: "Add via", key: "V", cursor: "crosshair", icon: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/>' },
  { id: "drag", label: "Drag track segment", key: "D", cursor: "move", icon: '<path d="M5 7h14"/><path d="M5 17h14" stroke-dasharray="2 2"/><path d="M12 9v5M9 12l3 3 3-3"/>' },
  { id: "gline", label: "Draw line", key: "Shift+L", cursor: "crosshair", icon: '<path d="M5 19L19 5"/>' },
  { id: "grect", label: "Draw rectangle", key: "Shift+R", cursor: "crosshair", icon: '<rect x="4" y="6" width="16" height="12" rx="1"/>' },
  { id: "gcircle", label: "Draw circle", key: "Shift+C", cursor: "crosshair", icon: '<circle cx="12" cy="12" r="8"/>' },
  { id: "gtext", label: "Add text", key: "T", cursor: "text", icon: '<path d="M6 6h12M12 6v13M9 19h6"/>' },
];
const TOOL_HINT = { route: "Route — click to start (pads snap), / posture, V via, W width, PgUp/PgDn layer, Enter or double-click to end",
  via: "Via — click to place", drag: "Drag — move the mouse, click to fix", gline: "Line — click start and end; click the start point or press Enter to stop",
  grect: "Rectangle — click two corners", gcircle: "Circle — click the centre, then the radius", gtext: "Text — click where it goes" };

const pcb = {
  id: "pcb", tools: TOOLS, state: S,
  onActivate(t, ctx) {
    bind(ctx);
    const mine = TOOLS.some((x) => x.id === t);
    if (S.route && t !== "route") S.route = null;   // leaving the tool drops the unfixed leg
    if (S.drag && t !== "drag") S.drag = null;
    S.draw = null; closeTextPrompt(); S.hover = null;
    S.modTool = mine ? t : null;
    if (t === "drag" && !beginDrag(ctx)) { S.modTool = null; ctx.toast("Click a track segment first, then press D to drag it"); ctx.setTool("select"); return; }
    if (mine) ctx.toast(/^g/.test(t) ? `${TOOL_HINT[t]} — on ${S.gfxLayer}` : TOOL_HINT[t], 3000);
    refreshChip(ctx); ctx.requestRender();
  },
  onPointerDown(ev, mm, ctx) {
    bind(ctx); const t = S.modTool; if (!t || ev.button !== 0 || !ctx.doc) return false;
    const hv = hoverPoint(ctx, mm, t === "route" || t === "via"); S.hover = hv;
    if (t === "route") routeClick(ctx, hv);
    else if (t === "via") placeVia(ctx, hv);
    else if (t === "drag") finishDrag(ctx);
    else if (t === "gtext") openTextPrompt(ctx, ev, [hv.x, hv.y]);
    else drawClick(ctx, hv, t);
    return true;
  },
  onPointerMove(ev, mm, ctx) {
    bind(ctx); const t = S.modTool; if (!t || !ctx.doc) return;
    const hv = hoverPoint(ctx, mm, t === "route" || t === "via"); S.hover = hv;
    if (S.route) S.route.target = [hv.x, hv.y];
    if (S.drag) dragMove(ctx, mm);
    if (S.draw) S.draw.cur = [hv.x, hv.y];
    ctx.requestRender();
  },
  onPointerUp() {},
  onKey(k, ev, ctx) {
    bind(ctx); if (!ctx.doc) return false;
    const editing = () => { if (ctx.viewOnly) { ctx.toast("View-only access"); return false; } return true; };
    const shift = !!ev.shiftKey;
    switch (k) {
    case "x": case "X": if (!shift) { ctx.setTool("route"); return true; } return false;
    case "v": case "V": if (shift) return false; if (S.route) { if (editing()) routeVia(ctx); } else ctx.setTool("via"); return true;
    case "d": case "D": if (shift || !S.sel.size) return false; if (editing()) ctx.setTool("drag"); return true;
    case "t": case "T": if (!shift) { ctx.setTool("gtext"); return true; } return false;
    case "L": if (shift) { ctx.setTool("gline"); return true; } return false;
    case "R": if (shift) { ctx.setTool("grect"); return true; }
      // fall through: plain R (caps lock) rotates like r
    case "r": return editing() && rotateSelected(ctx);   // false lets app.js's orientation-only fallback run when nothing applies
    case "Circle": ctx.setTool("gcircle"); return true;
    case "Flip": return editing() && flipSelected(ctx);
    case "/": if (S.route) { S.route.diagFirst = !S.route.diagFirst; ctx.requestRender(); return true; } return false;
    case "PageUp": setLayer(ctx, "F.Cu"); return true;
    case "PageDown": setLayer(ctx, "B.Cu"); return true;
    case "u": case "U": return expandSelection(ctx);
    case "w": case "W": if (editing()) cycleWidth(ctx); return true;
    case "Enter":
      if (S.route) { if (editing()) endRoute(ctx, true); return true; }
      if (S.draw) { S.draw = null; ctx.requestRender(); return true; }
      if (S.drag) { if (editing()) finishDrag(ctx); return true; }
      return false;
    case "Delete": case "Backspace": if (!S.sel.size) return false; if (editing()) deleteSelection(ctx); return true;
    default: return false;
    }
  },
  drawOverlay,
  // Called when a document loads and again after every applied change (our own commits included):
  // only a new document object resets the tool state; an update just prunes what vanished.
  onDocChanged(ctx) {
    bind(ctx);
    if (ctx.doc !== S.doc) { S.doc = ctx.doc; cancelOps(); S.sel.clear(); S.hover = null; }
    else if (ctx.doc) {
      for (const id of Array.from(S.sel)) if (!ctx.doc.items.has(id)) S.sel.delete(id);
      if (S.drag && !ctx.doc.items.has(S.drag.id)) S.drag = null;
    }
    refreshChip(ctx);
  },
};
root.CollabTools = root.CollabTools || {};
root.CollabTools.pcb = pcb;
root.PcbTools = { state: S, WIDTHS, BOARD_VERSION, routeLeg, segmentNode, viaNode, lineNode, rectNode, circleNode, textNode, netOf, netNode, netStyle,
  wrapBoard, addedChange, replacedChange, removedChange, padsOf, snapTarget, netUnder, hitTestItem, connectedRun, rotateFootprintNode, flipFootprintNode,
  flipLayerName, dragPlan, dragNodes, nextWidth, norm180, norm360 };
})(typeof window !== "undefined" ? window : globalThis);
