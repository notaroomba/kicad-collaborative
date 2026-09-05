// props.js — the Properties panel: KiCad's symbol / footprint / item property
// dialogs as a live side panel of the web editor.
//
// The node editors up top only touch the raw s-expression array, so they also
// run under node for the tests; everything that needs a DOM sits below the
// "panel" line and is only reached from render().  Every edit works on a clone
// of the item's node and commits one whole-item replace change, so app.js can
// record the untouched original as the undo step.
(function (root) {
"use strict";

// ---------------------------------------------------------------- s-expression helpers
const isList = Array.isArray;
function kid(node, key) { for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) return c; } return null; }
function kids(node, key) { const out = []; for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) out.push(c); } return out; }
function num(v, d = 0) { if (typeof v === "number") return v; if (v === undefined || v === null || v === "") return d; const x = Number(v); return isNaN(x) ? d : x; }
function str(v) { return v === undefined || v === null ? "" : String(v); }
function has(node, tok) { for (let j = 1; j < node.length; j++) if (node[j] === tok) return true; return false; }
function r6(v) { return +(+v).toFixed(6); }          // the file's precision; also turns -0 into 0
function clone(node) { return JSON.parse(JSON.stringify(node)); }
function deg360(a) { return ((Math.round(a) % 360) + 360) % 360; }
function normDeg(a) { a = ((a % 360) + 360) % 360; return a > 180 ? a - 360 : a; }   // KiCad keeps board angles in (-180, 180]
function atOf(node) { return root.KiCadCanvas.atOf(node); }
function setAt(node, x, y, rot) { root.KiCadCanvas.setAt(node, x, y, rot); }
function layerOf(node, def) { const l = kid(node, "layer"); return l ? str(l[1]) : def; }
function idxOf(node, key) { for (let j = 1; j < node.length; j++) if (isList(node[j]) && node[j][0] === key) return j; return -1; }
/** Replace the first (key …) child or insert one before the first of `before` (else append). */
function setKid(node, key, values, before) {
  const k = kid(node, key);
  if (k) { k.length = 1; k.push(...values); return k; }
  const n = [key, ...values];
  let at = node.length;
  for (const b of before || []) { const i = idxOf(node, b); if (i > 0) { at = i; break; } }
  node.splice(at, 0, n);
  return n;
}
function delKid(node, key) { const i = idxOf(node, key); if (i > 0) node.splice(i, 1); }
/** (key yes|no) children; a bare token (older files) counts as yes. */
function yes(node, key, def) { const k = kid(node, key); if (k) return str(k[1]) !== "no"; return has(node, key) ? true : def; }
function setYesNo(node, key, on) {
  const k = kid(node, key); if (k) { k[1] = on ? "yes" : "no"; return; }
  setKid(node, key, [on ? "yes" : "no"], ["fields_autoplaced", "uuid", "property"]);
}

// ---------------------------------------------------------------- fields (symbols, footprints, sheets)
const MANDATORY = ["Reference", "Value", "Footprint", "Datasheet", "Description"];
function field(node, name) { for (const p of kids(node, "property")) if (str(p[1]) === name) return p; return null; }
function fieldList(node) {
  const all = kids(node, "property").filter((p) => !str(p[1]).startsWith("ki_"));
  const rank = (p) => { const i = MANDATORY.indexOf(str(p[1])); return i < 0 ? MANDATORY.length : i; };
  return all.map((p, i) => [p, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
}
/** Set a field's text; a missing field is created hidden at the anchor. */
function setField(node, name, value) {
  let p = field(node, name);
  if (!p) {
    const fp = node[0] === "footprint";
    const [x, y] = fp ? [0, 0] : atOf(node);
    p = ["property", name, "", ["at", x, y, 0]];
    if (fp) p.push(["layer", layerOf(node, "F.Cu") === "B.Cu" ? "B.Fab" : "F.Fab"]);
    p.push(["hide", "yes"], ["effects", ["font", ["size", 1.27, 1.27]]]);
    const last = kids(node, "property").pop();
    node.splice(last ? node.indexOf(last) + 1 : node.length, 0, p);
  }
  p[2] = str(value);
  return p;
}
function isHidden(p) {
  const h = kid(p, "hide"); if (h) return str(h[1]) !== "no";
  if (has(p, "hide")) return true;
  const e = kid(p, "effects"); if (!e) return false;
  const eh = kid(e, "hide"); return has(e, "hide") || !!(eh && str(eh[1]) !== "no");
}
/** (hide yes) as KiCad 8+ writes it; older files carried a bare `hide` inside effects, which we drop. */
function setFieldHidden(node, name, hidden) {
  const p = field(node, name); if (!p) return false;
  const e = kid(p, "effects"); if (e) { const i = e.indexOf("hide"); if (i > 0) e.splice(i, 1); delKid(e, "hide"); }
  const i = p.indexOf("hide"); if (i > 2) p.splice(i, 1);
  delKid(p, "hide");
  if (hidden) setKid(p, "hide", ["yes"], ["show_name", "do_not_autoplace", "uuid", "effects"]);
  return true;
}

// ---------------------------------------------------------------- symbols (schematic)
// KiCad's TRANSFORM (x1 y1 x2 y2) per orientation — the table kicad-canvas.js draws with.
const ORIENT = { 0: [1, 0, 0, -1], 90: [0, -1, -1, 0], 180: [-1, 0, 0, 1], 270: [0, 1, 1, 0] };
function mirrorOf(node) { const m = kid(node, "mirror"); return m ? str(m[1]) : ""; }
function symbolT(rot, mirror) {
  const T = (ORIENT[deg360(rot)] || ORIENT[0]).slice();
  if (mirror === "y") { T[0] = -T[0]; T[1] = -T[1]; } else if (mirror === "x") { T[2] = -T[2]; T[3] = -T[3]; }
  return T;
}
/**
 * Re-orient a symbol.  Field positions are stored already transformed (sheet
 * coordinates) while their angle is the raw 0/90, so keep each field's
 * library-frame offset: p' = a + B·Aᵀ·(p − a), A and B being orthonormal.
 */
function setSymbolTransform(node, rot, mirror) {
  const [ax, ay, oldRot] = atOf(node);
  const A = symbolT(oldRot, mirrorOf(node)), B = symbolT(rot, mirror);
  for (const p of kids(node, "property")) {
    const at = kid(p, "at"); if (!at) continue;
    const dx = num(at[1]) - ax, dy = num(at[2]) - ay;
    const lx = A[0] * dx + A[2] * dy, ly = A[1] * dx + A[3] * dy;
    at[1] = r6(ax + B[0] * lx + B[1] * ly); at[2] = r6(ay + B[2] * lx + B[3] * ly);
  }
  setAt(node, undefined, undefined, deg360(rot));
  if (mirror) setKid(node, "mirror", [mirror], ["unit", "body_style", "convert", "exclude_from_sim", "in_bom", "uuid", "property"]);
  else delKid(node, "mirror");
}
function setSymbolRotation(node, deg) { setSymbolTransform(node, deg, mirrorOf(node)); }
function setSymbolMirror(node, m) { setSymbolTransform(node, atOf(node)[2], m === "x" || m === "y" ? m : ""); }
/** Fields ride along with the anchor. */
function setSymbolPosition(node, x, y) {
  const [ox, oy] = atOf(node); const dx = x - ox, dy = y - oy;
  setAt(node, r6(x), r6(y));
  for (const p of kids(node, "property")) { const at = kid(p, "at"); if (at) { at[1] = r6(num(at[1]) + dx); at[2] = r6(num(at[2]) + dy); } }
}
function setSymbolUnit(node, n) { setKid(node, "unit", [Math.max(1, Math.round(num(n, 1)))], ["body_style", "convert", "exclude_from_sim", "in_bom", "uuid", "property"]); }
function setSymbolFlag(node, key, on) { setYesNo(node, key, on); }
function libUnitCount(doc, node) {
  const lib = doc && root.KiCadCanvas.resolveLib(doc, str((kid(node, "lib_id") || [])[1]));
  let n = 1;
  if (lib) for (const s of kids(lib, "symbol")) { const m = str(s[1]).match(/_(\d+)_(\d+)$/); if (m) n = Math.max(n, +m[1]); }
  return n;
}

// ---------------------------------------------------------------- footprints (board)
function flipLayer(name) { return /^F\./.test(name) ? "B." + name.slice(2) : /^B\./.test(name) ? "F." + name.slice(2) : name; }
function setFootprintPosition(node, x, y) { setAt(node, r6(x), r6(y)); }
/** Pad and text angles are absolute in the file, so they follow the body. */
function setFootprintRotation(node, deg) {
  const d = deg - atOf(node)[2]; if (!d) return false;
  setAt(node, undefined, undefined, normDeg(deg));
  for (const c of node) if (isList(c) && (c[0] === "pad" || c[0] === "fp_text" || c[0] === "property")) { const at = kid(c, "at"); if (at) at[3] = normDeg(num(at[3]) + d); }
  return true;
}
/** Negate the local Y of a graphic (line/rect/circle/arc/poly and pad primitives). */
function mirrorYGraphic(g) {
  for (const key of ["start", "end", "center", "mid"]) { const k = kid(g, key); if (k) k[2] = r6(-num(k[2])); }
  const pts = kid(g, "pts"); if (pts) for (const xy of pts) if (isList(xy) && xy[0] === "xy") xy[2] = r6(-num(xy[2]));
}
function setMirrored(textNode, on) {
  let e = kid(textNode, "effects"); if (!e) e = setKid(textNode, "effects", []);
  const j = kid(e, "justify");
  if (on) { if (!j) setKid(e, "justify", ["mirror"]); else if (!has(j, "mirror")) j.push("mirror"); }
  else if (j) { const i = j.indexOf("mirror"); if (i > 0) j.splice(i, 1); if (j.length === 1) delKid(e, "justify"); }
}
/**
 * Put a footprint on the other side the way KiCad's Flip does (about the X axis
 * through its anchor): back-side files hold the library shape with local Y
 * negated, the orientation and every absolute angle negate, F.* / B.* layers
 * swap and texts toggle their mirror flag.  leftRight picks KiCad's other flip
 * direction, which instead maps the orientation to 180 − θ.
 */
function setFootprintSide(node, side, leftRight) {
  if (layerOf(node, "F.Cu") === side) return false;
  const ang = (a) => normDeg(leftRight ? 180 - a : -a);
  const flipAt = (c) => { const at = kid(c, "at"); if (!at) return; at[2] = r6(-num(at[2])); const a = ang(num(at[3])); if (a || at.length > 3) at[3] = a; };
  const flipLayers = (c) => { const l = kid(c, "layer"); if (l) l[1] = flipLayer(str(l[1])); const ls = kid(c, "layers"); if (ls) for (let i = 1; i < ls.length; i++) ls[i] = flipLayer(str(ls[i])); };
  setKid(node, "layer", [side], ["uuid", "tstamp", "at", "transform"]);
  setAt(node, undefined, undefined, ang(atOf(node)[2]));
  for (const c of node) {
    if (!isList(c)) continue;
    const k = c[0];
    if (k === "pad") {
      flipAt(c); flipLayers(c);
      const dr = kid(c, "drill"); const off = dr && kid(dr, "offset"); if (off) off[2] = r6(-num(off[2]));
      const prims = kid(c, "primitives"); if (prims) for (const g of prims) if (isList(g)) mirrorYGraphic(g);
    } else if (k === "property" || k === "fp_text") {
      if (!kid(c, "at")) continue;
      flipAt(c); flipLayers(c);
      setMirrored(c, /^B\./.test(layerOf(c, side)));
    } else if (/^fp_/.test(k)) {
      mirrorYGraphic(c); flipLayers(c);
    }
  }
  return true;
}
const ATTR_TYPES = ["smd", "through_hole"];
const ATTR_FLAGS = ["board_only", "exclude_from_pos_files", "exclude_from_bom", "dnp", "allow_missing_courtyard", "allow_soldermask_bridges"];
function footprintAttrs(node) {
  const a = kid(node, "attr"); const toks = a ? a.slice(1).map(str) : [];
  const out = { type: toks.find((t) => ATTR_TYPES.includes(t)) || "" };
  for (const f of ATTR_FLAGS) out[f] = toks.includes(f);
  out.other = toks.filter((t) => !ATTR_TYPES.includes(t) && !ATTR_FLAGS.includes(t));   // tokens we don't know survive untouched
  return out;
}
function setFootprintAttrs(node, attrs) {
  const cur = Object.assign(footprintAttrs(node), attrs);
  const toks = []; if (cur.type) toks.push(cur.type);
  for (const f of ATTR_FLAGS) if (cur[f]) toks.push(f);
  toks.push(...(cur.other || []));
  if (toks.length) setKid(node, "attr", toks, ["fp_text", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "pad", "model"]);
  else delKid(node, "attr");
}
/** Net name of a track/via/zone/pad: inline in new files, else from the pads' (net n "name") table. */
function netNameOf(doc, node) {
  const nn = kid(node, "net_name"); if (nn) return str(nn[1]);
  const n = kid(node, "net"); if (!n || n.length < 2) return "";
  if (typeof n[1] !== "number") return str(n[1]);
  if (n.length > 2) return str(n[2]);
  const code = n[1]; if (code === 0) return "";
  if (doc) for (const it of doc.items.values()) {
    if (it.kind !== "footprint") continue;
    for (const p of kids(it.node, "pad")) { const pn = kid(p, "net"); if (pn && pn.length > 2 && num(pn[1], -1) === code) return str(pn[2]); }
  }
  return "#" + code;
}
function padList(doc, node) {
  return kids(node, "pad").map((p) => {
    const sz = kid(p, "size"); const w = sz ? num(sz[1]) : 0, h = sz ? num(sz[2], w) : 0;
    const dr = kid(p, "drill"); const drill = !dr ? "" : str(dr[1]) === "oval" ? num(dr[2]) + "×" + num(dr[3]) : str(dr[1]);
    return { number: str(p[1]), type: str(p[2]), shape: str(p[3]), net: netNameOf(doc, p), w, h, drill, layers: (kid(p, "layers") || []).slice(1).map(str) };
  });
}

// ---------------------------------------------------------------- other items
function strokeWidth(node) { const s = kid(node, "stroke"); const w = s && kid(s, "width"); return w ? num(w[1]) : 0; }
function setStrokeWidth(node, w) { let s = kid(node, "stroke"); if (!s) s = setKid(node, "stroke", [], ["uuid", "tstamp"]); setKid(s, "width", [r6(w)]); }
function setWidth(node, w) { setKid(node, "width", [r6(w)], ["layer", "net", "uuid", "tstamp"]); }
function setLayer(node, layer) { setKid(node, "layer", [layer], ["net", "uuid", "tstamp", "effects"]); }
function setText(node, text) { node[1] = str(text); }
function textSize(node) { const e = kid(node, "effects"); const f = e && kid(e, "font"); const s = f && kid(f, "size"); return s ? num(s[2], num(s[1], 1.27)) : 1.27; }
function setTextSize(node, size) {
  let e = kid(node, "effects"); if (!e) e = setKid(node, "effects", [], ["uuid", "tstamp"]);
  let f = kid(e, "font"); if (!f) f = setKid(e, "font", [], ["justify", "hide"]);
  setKid(f, "size", [r6(size), r6(size)], ["thickness", "bold", "italic"]);
}
function setRotation(node, deg) { setAt(node, undefined, undefined, deg360(deg)); }
function setShape(node, shape) { setKid(node, "shape", [shape], ["at", "fields_autoplaced", "effects", "uuid"]); }
function setDiameter(node, d) { setKid(node, "diameter", [r6(d)], ["color", "uuid"]); }
function setViaSize(node, s) { setKid(node, "size", [r6(s)], ["drill", "layers", "net", "uuid", "tstamp"]); }
function setViaDrill(node, d) { setKid(node, "drill", [r6(d)], ["layers", "net", "uuid", "tstamp"]); }
function setViaLayers(node, a, b) { setKid(node, "layers", [a, b], ["net", "uuid", "tstamp"]); }
function setZoneName(node, name) { if (str(name)) setKid(node, "name", [str(name)], ["hatch", "priority", "connect_pads"]); else delKid(node, "name"); }
function setZonePriority(node, p) { p = Math.max(0, Math.round(num(p))); if (p) setKid(node, "priority", [p], ["connect_pads", "min_thickness"]); else delKid(node, "priority"); }

const STD_LAYERS = ["F.Cu", "B.Cu", "F.Adhes", "B.Adhes", "F.Paste", "B.Paste", "F.SilkS", "B.SilkS", "F.Mask", "B.Mask", "Dwgs.User", "Cmts.User", "Eco1.User", "Eco2.User", "Edge.Cuts", "Margin", "F.CrtYd", "B.CrtYd", "F.Fab", "B.Fab"];
/** Layer names to offer: the parsed table where it holds names, the ones in use, and the standard set. */
function boardLayers(doc, copperOnly) {
  const names = new Set(STD_LAYERS);
  for (const k of doc.layers.keys()) if (k.includes(".")) names.add(k);
  for (const it of doc.items.values()) for (const g of it.geom) if (g.layer && g.layer !== "holes" && g.layer.includes(".")) names.add(g.layer);
  const rank = (l) => l === "F.Cu" ? 0 : /^In\d+\.Cu$/.test(l) ? +l.slice(2) : l === "B.Cu" ? 500 : 1000 + STD_LAYERS.indexOf(l);
  return [...names].filter((l) => !copperOnly || /\.Cu$/.test(l)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

const helpers = { kid, kids, num, str, setKid, delKid, yes, setYesNo, field, fieldList, setField, isHidden, setFieldHidden, symbolT, mirrorOf, setSymbolTransform, setSymbolRotation, setSymbolMirror, setSymbolPosition, setSymbolUnit, setSymbolFlag, libUnitCount, flipLayer, setFootprintPosition, setFootprintRotation, setFootprintSide, footprintAttrs, setFootprintAttrs, netNameOf, padList, strokeWidth, setStrokeWidth, setWidth, setLayer, setText, textSize, setTextSize, setRotation, setShape, setDiameter, setViaSize, setViaDrill, setViaLayers, setZoneName, setZonePriority, boardLayers, normDeg, deg360 };

// ================================================================ panel (DOM from here on)
const KIND_NAMES = { symbol: "Symbol", footprint: "Footprint", wire: "Wire", bus: "Bus", polyline: "Line", segment: "Track", via: "Via", label: "Label", global_label: "Global label", hierarchical_label: "Hierarchical label", netclass_flag: "Netclass directive", directive_label: "Directive label", text: "Text", gr_text: "Text", text_box: "Text box", gr_text_box: "Text box", junction: "Junction", zone: "Zone", no_connect: "No connect", bus_entry: "Bus entry", sheet: "Sheet", gr_line: "Line", gr_rect: "Rectangle", gr_circle: "Circle", gr_arc: "Arc", gr_poly: "Polygon", rectangle: "Rectangle", circle: "Circle", dimension: "Dimension", group: "Group" };
const LABEL_SHAPES = ["input", "output", "bidirectional", "tri_state", "passive"];
const CTRL = "background:var(--panel);border:1px solid var(--line);border-radius:3px;padding:4px 6px;color:var(--ink);font-family:var(--mono);width:100%";
function esc(s) { return str(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function mm(v, d) { return (+v || 0).toFixed(d === undefined ? 3 : d); }

let last = null;        // {el, selected, ctx} of the latest render, for refresh()
let inspected = null;   // raw doc item handed over by a tool module (shown when app.js has no selection)
let busy = false;       // a commit of our own is re-rendering: never defer that
let deferred = false;   // a render was skipped to protect an edit in progress

function dirtyFocus(el) {
  const a = typeof document !== "undefined" && document.activeElement;
  if (!a || !el.contains(a)) return false;
  if (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && (a.type === "text" || a.type === "number"))) return a.value !== a.defaultValue;
  return false;
}

function render(el, selected, ctx) {
  last = { el, selected, ctx };
  if (!busy && dirtyFocus(el)) { deferred = true; return; }   // a peer's edit must not eat what the user is typing
  deferred = false;
  if (!el.dataset.propsBound) {
    el.dataset.propsBound = "1";
    el.addEventListener("focusout", () => { if (deferred) setTimeout(() => { if (deferred && last) render(last.el, last.selected, last.ctx); }, 0); });
  }
  const doc = ctx && ctx.doc;
  if (!doc) { el.innerHTML = `<p class="note">No document loaded.</p>`; return; }
  let item = selected ? doc.items.get(selected.id) || null : null;
  if (selected) inspected = null;
  else if (inspected) { item = doc.items.get(inspected.id) || null; if (!item) inspected = null; }
  if (!item) { renderFacts(el, ctx); return; }
  const P = panel(el, ctx, item, !!selected);
  if (ctx.isSch && item.kind === "symbol") renderSymbol(P, item);
  else if (!ctx.isSch && item.kind === "footprint") renderFootprint(P, item);
  else renderOther(P, item);
  P.flush();
}
function refresh() { if (last) render(last.el, last.selected, last.ctx); }
/** Tool modules hand over a raw doc item (or null to clear); it shows while app.js has nothing selected. */
function inspect(item) { inspected = item || null; if (last) render(last.el, last.selected, last.ctx); }

function renderFacts(el, ctx) {
  const doc = ctx.doc; const counts = new Map();
  for (const it of doc.items.values()) counts.set(it.kind, (counts.get(it.kind) || 0) + 1);
  const rows = [...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `<label>${esc(KIND_NAMES[k] || k)}</label><div class="ro">${n}</div>`).join("");
  const b = doc.bbox;
  const size = ctx.isSch ? `${mm(doc.page[0], 1)} × ${mm(doc.page[1], 1)} mm` : b ? `${mm(b[2] - b[0], 2)} × ${mm(b[3] - b[1], 2)} mm` : "—";
  el.innerHTML = `<p class="note">${ctx.isSch ? "Select a symbol on the sheet to edit its fields and placement." : "Select a footprint on the board to edit its fields, placement and attributes."}</p>
    <h3>${ctx.isSch ? "Sheet" : "Board"}</h3><div class="kv"><label>${ctx.isSch ? "Page" : "Size"}</label><div class="ro">${size}</div>
    ${!ctx.isSch && b ? `<label>Origin</label><div class="ro">${mm(b[0], 2)}, ${mm(b[1], 2)} mm</div>` : ""}
    <label>Items</label><div class="ro">${doc.items.size}</div></div>
    <h3>By kind</h3><div class="kv">${rows}</div>`;
}

/** Accumulates rows and their change handlers, then writes the DOM once. */
function panel(el, ctx, item, appSelected) {
  const parts = [], handlers = new Map(); let n = 0;
  const ro = !!ctx.viewOnly;
  const key = (fn) => { const k = "k" + n++; handlers.set(k, fn); return k; };
  const P = {
    ctx, item, ro,
    h3(t) { parts.push(`<h3>${esc(t)}</h3>`); },
    open() { parts.push('<div class="kv">'); },
    close() { parts.push("</div>"); },
    raw(h) { parts.push(h); },
    row(label, html) { parts.push(`<label title="${esc(label)}">${esc(label)}</label>${html}`); },
    ro(label, value) { P.row(label, `<div class="ro" title="${esc(value)}">${esc(value) || "—"}</div>`); },
    text(label, value, on, multi) {
      if (ro) return P.ro(label, value);
      if (multi) P.row(label, `<textarea data-k="${key(on)}" rows="3" style="${CTRL};resize:vertical">${esc(value)}</textarea>`);
      else P.row(label, `<input data-k="${key(on)}" type="text" value="${esc(value)}">`);
    },
    num(label, value, on, opts) {
      opts = opts || {};
      if (ro) return P.ro(label, mm(value, opts.digits));
      P.row(label, `<input data-k="${key((v) => { const x = parseFloat(v); if (!isNaN(x)) on(x); })}" type="number" step="${opts.step || "0.01"}"${opts.min !== undefined ? ` min="${opts.min}"` : ""} value="${mm(value, opts.digits)}">`);
    },
    select(label, value, options, on) {   // options: [value, text] pairs or plain strings
      const opts = options.map((o) => isList(o) ? o : [o, o]);
      if (ro) { const hit = opts.find((o) => String(o[0]) === String(value)); return P.ro(label, hit ? hit[1] : value); }
      P.row(label, `<select data-k="${key(on)}" style="${CTRL}">${opts.map((o) => `<option value="${esc(o[0])}"${String(o[0]) === String(value) ? " selected" : ""}>${esc(o[1])}</option>`).join("")}</select>`);
    },
    check(label, checked, on) {   // box then text across the row, as in KiCad's dialogs
      if (ro) return P.ro(label, checked ? "yes" : "no");
      parts.push(`<label style="grid-column:1/-1;display:flex;gap:8px;align-items:center;color:var(--ink)"><input data-k="${key(on)}" type="checkbox" style="width:auto;margin:0"${checked ? " checked" : ""}>${esc(label)}</label>`);
    },
    /** A property row: text plus a "shown" toggle (omit onHide for fields without one). */
    field(name, value, hidden, onText, onHide) {
      if (ro) return P.row(name, `<div class="ro"${hidden ? ' style="opacity:.55"' : ""} title="${esc(value)}">${esc(value) || "—"}</div>`);
      const box = onHide ? `<input data-k="${key(onHide)}" type="checkbox" title="Show ${ctx.isSch ? "on sheet" : "on board"}" style="width:auto;margin:0"${hidden ? "" : " checked"}>` : "";
      P.row(name, `<div style="display:flex;gap:6px;align-items:center"><input data-k="${key(onText)}" type="text" value="${esc(value)}" style="flex:1;min-width:0">${box}</div>`);
    },
    actions(list) {   // [[label, fn, cls]]
      if (ro) return;
      parts.push(`<div class="actions">${list.map(([label, fn, cls]) => `<button class="btn sm${cls ? " " + cls : ""}" data-k="${key(fn)}">${esc(label)}</button>`).join("")}</div>`);
    },
    /** Apply fn to a clone of the node and commit the whole item; fn may return false for "nothing to do". */
    edit(label, fn) {
      const K = ctx.K; const node = clone(item.node);
      if (fn(node) === false) return;
      const change = K.replaceChange(ctx.doc, Object.assign({}, item, { node, geom: [], bbox: null }));
      busy = true;
      try {
        ctx.commit([change], label);
        // the doc now holds a fresh item object: point the app's selection (or our inspect) at it
        if (appSelected) ctx.setSelected((ctx.items || []).find((f) => f.id === item.id) || { id: item.id });
        else { inspected = ctx.doc.items.get(item.id) || inspected; render(el, null, ctx); }
      } finally { busy = false; }
    },
    remove() {
      busy = true;
      try {
        ctx.commit([ctx.K.removeChange(item)], "delete");
        if (appSelected) ctx.setSelected(null); else { inspected = null; render(el, null, ctx); }
      } finally { busy = false; }
    },
    flush() {
      el.innerHTML = parts.join("");
      el.querySelectorAll("[data-k]").forEach((c) => {
        const fn = handlers.get(c.dataset.k); if (!fn) return;
        if (c.tagName === "BUTTON") c.addEventListener("click", () => fn());
        else c.addEventListener("change", () => { c.defaultValue = c.value; fn(c.type === "checkbox" ? c.checked : c.value, c); });
      });
    },
  };
  if (ro) P.raw(`<p class="note">View-only access — properties are read-only.</p>`);
  else if (!ctx.live) P.raw(`<p class="note">Not connected — edits stay local until you rejoin.</p>`);
  return P;
}

function renderFields(P, node) {
  for (const p of fieldList(node)) {
    const name = str(p[1]);
    P.field(name, str(p[2]), isHidden(p),
      (v) => P.edit(name.toLowerCase(), (n) => setField(n, name, v)),
      (shown) => P.edit((shown ? "show " : "hide ") + name, (n) => setFieldHidden(n, name, !shown)));
  }
}

function renderSymbol(P, item) {
  const n = item.node, ctx = P.ctx;
  const [x, y, rot] = atOf(n); const mirror = mirrorOf(n);
  P.h3("Symbol " + (item.ref || ""));
  P.open();
  P.ro("Library", str((kid(n, "lib_id") || [])[1]));
  renderFields(P, n);
  P.close();
  P.h3("Placement");
  P.open();
  P.num("X (mm)", x, (v) => P.edit("position", (m) => setSymbolPosition(m, v, y)));
  P.num("Y (mm)", y, (v) => P.edit("position", (m) => setSymbolPosition(m, x, v)));
  P.select("Rotation", deg360(rot), [[0, "0°"], [90, "90°"], [180, "180°"], [270, "270°"]], (v) => P.edit("rotation", (m) => setSymbolRotation(m, +v)));
  P.select("Mirror", mirror, [["", "Not mirrored"], ["x", "Around X axis"], ["y", "Around Y axis"]], (v) => P.edit("mirror", (m) => setSymbolMirror(m, v)));
  const units = libUnitCount(ctx.doc, n);
  if (units > 1) {
    const unit = kid(n, "unit") ? num(kid(n, "unit")[1], 1) : 1;
    const opts = []; for (let u = 1; u <= units; u++) opts.push([u, u + (u <= 26 ? " (" + String.fromCharCode(64 + u) + ")" : "")]);
    P.select("Unit", unit, opts, (v) => P.edit("unit", (m) => setSymbolUnit(m, +v)));
  }
  P.close();
  P.h3("Attributes");
  P.open();
  P.check("Do not populate", yes(n, "dnp", false), (on) => P.edit("dnp", (m) => setSymbolFlag(m, "dnp", on)));
  P.check("Exclude from BOM", !yes(n, "in_bom", true), (on) => P.edit("bom", (m) => setSymbolFlag(m, "in_bom", !on)));
  P.check("Exclude from board", !yes(n, "on_board", true), (on) => P.edit("board", (m) => setSymbolFlag(m, "on_board", !on)));
  if (kid(n, "exclude_from_sim")) P.check("Exclude from simulation", yes(n, "exclude_from_sim", false), (on) => P.edit("simulation", (m) => setSymbolFlag(m, "exclude_from_sim", on)));
  if (kid(n, "in_pos_files")) P.check("Exclude from position files", !yes(n, "in_pos_files", true), (on) => P.edit("position files", (m) => setSymbolFlag(m, "in_pos_files", !on)));
  P.close();
  P.open(); P.ro("UUID", item.id); P.close();
  P.actions([["Delete", () => P.remove(), "danger"]]);
}

function renderFootprint(P, item) {
  const n = item.node, ctx = P.ctx, doc = ctx.doc;
  const [x, y, rot] = atOf(n); const side = layerOf(n, "F.Cu");
  P.h3("Footprint " + (item.ref || ""));
  P.open();
  P.ro("Footprint", str(n[1]));
  renderFields(P, n);
  P.close();
  P.h3("Placement");
  P.open();
  P.num("X (mm)", x, (v) => P.edit("position", (m) => setFootprintPosition(m, v, y)));
  P.num("Y (mm)", y, (v) => P.edit("position", (m) => setFootprintPosition(m, x, v)));
  P.num("Rotation (°)", rot, (v) => P.edit("rotation", (m) => setFootprintRotation(m, v)), { step: "any", digits: 1 });
  P.select("Side", side, [["F.Cu", "Front"], ["B.Cu", "Back"]], (v) => P.edit("side", (m) => setFootprintSide(m, v)));
  P.close();
  P.h3("Attributes");
  P.open();
  const a = footprintAttrs(n); const attr = (patch, label) => P.edit(label || "attributes", (m) => setFootprintAttrs(m, patch));
  P.select("Type", a.type, [["", "Unspecified"], ["smd", "SMD"], ["through_hole", "Through hole"]], (v) => attr({ type: v }, "type"));
  P.check("Not in schematic", a.board_only, (on) => attr({ board_only: on }));
  P.check("Exclude from position files", a.exclude_from_pos_files, (on) => attr({ exclude_from_pos_files: on }));
  P.check("Exclude from BOM", a.exclude_from_bom, (on) => attr({ exclude_from_bom: on }));
  P.check("Do not populate", a.dnp, (on) => attr({ dnp: on }, "dnp"));
  P.close();
  const pads = padList(doc, n);
  P.h3(`Pads (${pads.length})`);
  P.raw(`<div style="display:grid;grid-template-columns:auto 1fr auto auto;gap:2px 10px;font:11px var(--mono);max-height:200px;overflow:auto">
    <span class="muted">#</span><span class="muted">net</span><span class="muted">shape</span><span class="muted">size</span>
    ${pads.slice(0, 400).map((p) => `<span>${esc(p.number)}</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p.net)}">${esc(p.net) || "<span class=muted>–</span>"}</span><span>${esc(p.shape)}</span><span title="${esc(p.type)}${p.drill ? " drill " + esc(p.drill) : ""}">${mm(p.w, 2)}×${mm(p.h, 2)}</span>`).join("")}</div>`);
  P.open(); P.ro("UUID", item.id); P.close();
  P.actions([["Delete", () => P.remove(), "danger"]]);
}

function renderOther(P, item) {
  const n = item.node, k = item.kind, ctx = P.ctx, doc = ctx.doc, K = ctx.K;
  const sch = !!ctx.isSch;
  const pt = (p) => p ? `${mm(p[0])}, ${mm(p[1])}` : "—";
  P.h3(KIND_NAMES[k] || k);
  P.open();
  if (sch && (k === "wire" || k === "bus" || k === "polyline")) {
    const pts = K.ptsOf(n);
    P.ro("Start", pt(pts[0])); P.ro("End", pt(pts[pts.length - 1]));
    P.num("Width (mm)", strokeWidth(n), (v) => P.edit("width", (m) => setStrokeWidth(m, v)), { min: 0 });
    P.raw(`<span></span><span class="note" style="margin:0">0 = default width</span>`);
  } else if (!sch && (k === "segment" || k === "arc")) {
    const s = kid(n, "start"), e = kid(n, "end");
    P.ro("Net", netNameOf(doc, n));
    P.num("Width (mm)", num((kid(n, "width") || [])[1], 0.25), (v) => P.edit("width", (m) => setWidth(m, v)), { min: 0 });
    P.select("Layer", layerOf(n, "F.Cu"), boardLayers(doc, true), (v) => P.edit("layer", (m) => setLayer(m, v)));
    P.ro("Start", s ? `${mm(s[1])}, ${mm(s[2])}` : "—"); P.ro("End", e ? `${mm(e[1])}, ${mm(e[2])}` : "—");
    if (k === "segment" && s && e) P.ro("Length", mm(Math.hypot(num(e[1]) - num(s[1]), num(e[2]) - num(s[2]))) + " mm");
  } else if (!sch && k === "via") {
    const [x, y] = atOf(n); const ls = kid(n, "layers"); const copper = boardLayers(doc, true);
    P.ro("Net", netNameOf(doc, n));
    P.ro("Position", `${mm(x)}, ${mm(y)}`);
    if (n.includes("blind") || n.includes("micro")) P.ro("Type", n.includes("micro") ? "micro" : "blind/buried");
    P.num("Size (mm)", num((kid(n, "size") || [])[1], 0.8), (v) => P.edit("via size", (m) => setViaSize(m, v)), { min: 0 });
    P.num("Drill (mm)", num((kid(n, "drill") || [])[1], 0.4), (v) => P.edit("via drill", (m) => setViaDrill(m, v)), { min: 0 });
    const a = ls ? str(ls[1]) : "F.Cu", b = ls ? str(ls[2]) : "B.Cu";
    P.select("From layer", a, copper, (v) => P.edit("via layers", (m) => setViaLayers(m, v, b)));
    P.select("To layer", b, copper, (v) => P.edit("via layers", (m) => setViaLayers(m, a, v)));
  } else if (sch && /label|netclass_flag/.test(k)) {
    const [x, y, rot] = atOf(n);
    P.text("Text", str(n[1]), (v) => P.edit("label", (m) => setText(m, v)));
    if (k === "global_label" || k === "hierarchical_label") P.select("Shape", str((kid(n, "shape") || [])[1] || "input"), LABEL_SHAPES.map((s) => [s, s.replace("_", "-")]), (v) => P.edit("shape", (m) => setShape(m, v)));
    P.select("Rotation", deg360(rot), [[0, "0°"], [90, "90°"], [180, "180°"], [270, "270°"]], (v) => P.edit("rotation", (m) => setRotation(m, +v)));
    P.num("Size (mm)", textSize(n), (v) => P.edit("text size", (m) => setTextSize(m, v)), { min: 0.01 });
    P.ro("Position", `${mm(x)}, ${mm(y)}`);
  } else if (k === "text" || k === "gr_text") {
    const [x, y, rot] = atOf(n);
    P.text("Text", str(n[1]), (v) => P.edit("text", (m) => setText(m, v)), true);
    P.num("Size (mm)", textSize(n), (v) => P.edit("text size", (m) => setTextSize(m, v)), { min: 0.01 });
    P.num("Rotation (°)", rot, (v) => P.edit("rotation", (m) => setRotation(m, v)), { step: "any", digits: 1 });
    if (!sch) P.select("Layer", layerOf(n, "Dwgs.User"), boardLayers(doc, false), (v) => P.edit("layer", (m) => setLayer(m, v)));
    P.ro("Position", `${mm(x)}, ${mm(y)}`);
  } else if (sch && k === "junction") {
    const [x, y] = atOf(n);
    P.ro("Position", `${mm(x)}, ${mm(y)}`);
    P.num("Diameter (mm)", num((kid(n, "diameter") || [])[1], 0), (v) => P.edit("diameter", (m) => setDiameter(m, v)), { min: 0 });
    P.raw(`<span></span><span class="note" style="margin:0">0 = default diameter</span>`);
  } else if (!sch && k === "zone") {
    const single = kid(n, "layer"), multi = kid(n, "layers");
    P.text("Name", str((kid(n, "name") || [])[1]), (v) => P.edit("zone name", (m) => setZoneName(m, v)));
    P.ro("Net", netNameOf(doc, n));
    P.num("Priority", num((kid(n, "priority") || [])[1], 0), (v) => P.edit("zone priority", (m) => setZonePriority(m, v)), { step: "1", min: 0, digits: 0 });
    P.ro("Layers", single ? str(single[1]) : multi ? multi.slice(1).map(str).join(" ") : "—");
    if (kid(n, "keepout")) P.ro("Keepout", "yes");
  } else if (k === "sheet") {
    for (const name of ["Sheetname", "Sheetfile"]) { const p = field(n, name); if (p) P.field(name, str(p[2]), false, (v) => P.edit(name.toLowerCase(), (m) => setField(m, name, v))); }
    const [x, y] = atOf(n); P.ro("Position", `${mm(x)}, ${mm(y)}`);
  } else {
    if (kid(n, "at") || kid(n, "transform")) { const [x, y, rot] = atOf(n); P.ro("Position", `${mm(x)}, ${mm(y)}`); if (rot) P.ro("Rotation", mm(rot, 1) + "°"); }
    if (kid(n, "layer")) P.ro("Layer", layerOf(n, ""));
    if (kid(n, "stroke")) P.num("Width (mm)", strokeWidth(n), (v) => P.edit("width", (m) => setStrokeWidth(m, v)), { min: 0 });
    if (!sch && kid(n, "net")) P.ro("Net", netNameOf(doc, n));
  }
  P.ro("UUID", item.id);
  P.close();
  P.actions([["Delete", () => P.remove(), "danger"]]);
}

root.CollabTools = root.CollabTools || {};
root.CollabTools.props = { render, refresh, inspect, helpers };
if (typeof module !== "undefined" && module.exports) module.exports = root.CollabTools.props;
})(typeof window !== "undefined" ? window : globalThis);
