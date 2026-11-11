import { netLabel } from "./names";
// review/diff.ts — what changed between two versions of a schematic sheet or a board.
//
// Items are matched by uuid, the identity KiCad keeps for an item for life; an item without one is
// matched by its text.  A matched pair whose s-expression differs is "modified", and the difference is
// broken down into the rows of KiCad's own diff dialog (Property / Before / After).  Zone fills are
// left out of the comparison: a refill follows from another change and is not a decision anyone made.
//
// The rows the tree shows are coarser than items where KiCad's dialog is: the tracks and vias of one
// net are one row per category, and wires that touch are one row.
//
// Nothing here touches the DOM; the module runs under node for the tests (the canvas library is
// passed in, since it is a global in the browser and a loaded bundle under node).

export type Category = "added" | "removed" | "modified";
export type Box = [number, number, number, number];

export interface PropRow { name: string; before: string; after: string }

export interface Change {
  /** stable id of the row */
  key: string;
  category: Category;
  /** kind of the first item ("symbol", "segment" …) or "document" for the sheet's own settings */
  kind: string;
  /** the items of the newer version this row stands for (empty for a removal) */
  ids: string[];
  /** the items of the older version this row stands for (empty for an addition) */
  oldIds: string[];
  label: string;
  /** one line under the label: "moved 2.54 mm", "Value: 10k → 22k" */
  detail: string;
  /** everything the row covers, in mm: where the older and the newer items are */
  bbox: Box | null;
  props: PropRow[];
  /** what a comment on this change would be pinned to: an item of the newer version, by preference */
  ref?: string;
  net?: string;
}

export interface DocDiff {
  type: "sch" | "pcb";
  changes: Change[];
  /** item ids, for the painter: `added` and `modified` are in the newer document, `removed` and `modifiedOld` in the older */
  added: Set<string>; removed: Set<string>; modified: Set<string>; modifiedOld: Set<string>;
  counts: Record<Category, number>;
}

type Canvas = KiCadCanvasApi;
type Atom = string | number;

const isList = (v: unknown): v is SNode => Array.isArray(v);

// ---------------------------------------------------------------- naming
const KIND_NAMES: Record<string, string> = {
  symbol: "Symbol", footprint: "Footprint", wire: "Wire", bus: "Bus", polyline: "Line", segment: "Track", via: "Via", label: "Label",
  global_label: "Global label", hierarchical_label: "Hierarchical label", netclass_flag: "Netclass directive", directive_label: "Directive label",
  text: "Text", gr_text: "Text", text_box: "Text box", gr_text_box: "Text box", junction: "Junction", zone: "Zone", no_connect: "No-connect",
  bus_entry: "Bus entry", sheet: "Sheet", gr_line: "Line", gr_rect: "Rectangle", gr_circle: "Circle", gr_arc: "Arc", gr_poly: "Polygon", gr_curve: "Curve",
  rectangle: "Rectangle", circle: "Circle", bezier: "Curve", dimension: "Dimension", group: "Group", image: "Image", table: "Table", rule_area: "Rule area",
  target: "Target", generated: "Generated item", ellipse: "Ellipse", gr_ellipse: "Ellipse", barcode: "Barcode", point: "Point",
};
const TEXTUAL = new Set(["label", "global_label", "hierarchical_label", "netclass_flag", "directive_label", "text", "gr_text", "text_box", "gr_text_box"]);
const ROUTING = new Set(["segment", "via"]);
const WIRING = new Set(["wire", "bus", "junction", "bus_entry"]);

function kindName(it: KItem): string {
  if (it.kind === "arc") return it.docType === "pcb" && it.node.some((c) => isList(c) && c[0] === "net") ? "Track arc" : "Arc";
  return KIND_NAMES[it.kind] || it.kind.replace(/^gr_/, "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
const short = (s: string, n = 48): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** "Symbol R1 (10k)", "Track on F.Cu", "Label VBUS": the way KiCad names an item in a list. */
export function describeItem(K: Canvas, doc: KDoc, it: KItem): string {
  const kind = kindName(it);
  let what = "";
  if (it.ref) what = `${it.ref}${it.value ? ` (${it.value})` : ""}`;
  else if (it.name) what = it.name;
  else if (TEXTUAL.has(it.kind)) what = short(K.str(it.node[1]).replace(/\s+/g, " "));
  const net = it.docType === "pcb" ? netName(K, doc, it) : "";
  const layer = it.docType === "pcb" && it.kind !== "footprint" ? layerName(K, it) : "";
  return `${kind}${what ? " " + what : ""}${layer ? " on " + layer : ""}${net && it.kind !== "footprint" ? `, net ${netLabel(net)}` : ""}`;
}
function layerName(K: Canvas, it: KItem): string {
  const l = K.kid(it.node, "layer"); if (l) return K.str(l[1]);
  const ls = K.kid(it.node, "layers"); return ls ? ls.slice(1).map((x) => K.str(x)).join(", ") : it.layer || "";
}
function netName(K: Canvas, doc: KDoc, it: KItem): string {
  const f = K.netNameOf as ((d: KDoc, n: SNode) => string) | undefined;
  try { return f ? f(doc, it.node) : ""; } catch { return ""; }
}

// ---------------------------------------------------------------- comparison text
/** Children that never count as a difference: the fill a zone was last given, and render caches. */
const IGNORED = new Set(["filled_polygon", "fill_segments", "filled_areas_thickness"]);

function comparable(K: Canvas, node: SNode): string {
  const strip = (n: SNode): SNode => {
    let out: SNode | null = null;
    for (let i = 0; i < n.length; i++) {
      const c = n[i];
      if (isList(c)) {
        if (IGNORED.has(c[0] as string)) { if (!out) out = n.slice(0, i); continue; }
        const s = strip(c);
        if (s !== c && !out) out = n.slice(0, i);
        if (out) out.push(s);
      } else if (out) out.push(c);
    }
    return out || n;
  };
  return K.serialize(node[0] === "zone" || node[0] === "footprint" ? strip(node) : node);
}

// ---------------------------------------------------------------- properties
const mmText = (v: number): string => `${Number(v.toFixed(4))} mm`;
const degText = (v: number): string => `${Number(v.toFixed(3))}°`;
const titled = (s: string): string => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

const NAMES: Record<string, string> = {
  layer: "Layer", layers: "Layers", net: "Net", width: "Width", size: "Size", drill: "Drill", lib_id: "Library link", lib_name: "Library symbol", unit: "Unit",
  dnp: "Do not populate", in_bom: "In BOM", on_board: "On board", in_pos_files: "In position files", exclude_from_sim: "Exclude from simulation",
  locked: "Locked", mirror: "Mirror", shape: "Shape", fields_autoplaced: "Fields autoplaced", attr: "Attributes", descr: "Description", tags: "Keywords",
  path: "Sheet path", sheetname: "Sheet name", sheetfile: "Sheet file", net_name: "Net", priority: "Priority", hatch: "Outline hatch", clearance: "Clearance",
  min_thickness: "Minimum width", "connect_pads": "Pad connection", body_style: "Body style", convert: "Body style", free: "Free via", angle: "Angle",
  "stroke › width": "Line width", "stroke › type": "Line style", "stroke › color": "Line colour", "fill › type": "Fill", "fill › color": "Fill colour",
  "effects › font › size": "Text size", "effects › font › thickness": "Text thickness", "effects › justify": "Justification", "effects › hide": "Hidden",
  "effects › font › bold": "Bold", "effects › font › italic": "Italic", "effects › font › face": "Font",
};
/** Children that repeat inside one parent and are told apart by their first argument. */
const NAMED = new Set(["property", "pad", "pin", "fp_text", "model", "net", "sheet_instances", "project", "path"]);
const POINTS = new Set(["pts", "polygon"]);
const SKIP = new Set(["uuid", "tstamp", "tedit", ...IGNORED]);

function pointsText(K: Canvas, node: SNode): string {
  const pts: string[] = [];
  const walk = (n: SNode): void => { for (const c of n) if (isList(c)) { if (c[0] === "xy") pts.push(`${K.num(c[1])}, ${K.num(c[2])}`); else walk(c); } };
  walk(node);
  const text = pts.join("; ");
  return `${pts.length} point${pts.length === 1 ? "" : "s"}${text ? ": " + short(text, 90) : ""}`;
}

/** Flatten an item into "name → text" rows; nested lists become "parent › child". */
function flatten(K: Canvas, doc: KDoc, it: KItem): Map<string, string> {
  const out = new Map<string, string>();
  const put = (key: string, value: string): void => { let k = key, n = 2; while (out.has(k)) k = `${key} (${n++})`; out.set(k, value); };
  const node = it.node;
  const lead = node.slice(1).filter((c): c is Atom => !isList(c));
  if (lead.length) put(it.kind === "footprint" ? "Library link" : TEXTUAL.has(it.kind) ? "Text" : "Value", lead.map((a) => K.str(a)).join(" "));

  const walk = (n: SNode, prefix: string, depth: number): void => {
    for (let i = 1; i < n.length; i++) {
      const c = n[i]; if (!isList(c)) continue;
      const head = String(c[0]); if (SKIP.has(head)) continue;
      const atoms = c.slice(1).filter((x): x is Atom => !isList(x)), subs = c.slice(1).filter(isList);
      if (!prefix && head === "at") {
        put("Position X", mmText(K.num(c[1]))); put("Position Y", mmText(K.num(c[2])));
        if (c.length > 3 && !isList(c[3])) put("Orientation", degText(K.num(c[3])));
        continue;
      }
      if (!prefix && (head === "start" || head === "end" || head === "mid" || head === "center")) {
        put(`${titled(head)} X`, mmText(K.num(c[1]))); put(`${titled(head)} Y`, mmText(K.num(c[2]))); continue;
      }
      if (!prefix && head === "net") { put("Net", netName(K, doc, it) || atoms.map((a) => K.str(a)).join(" ")); continue; }
      if (POINTS.has(head)) { put(prefix + (head === "pts" ? "Outline" : "Polygon"), pointsText(K, c)); continue; }
      if (head === "property") {
        const name = prefix + K.str(c[1]);
        put(name, K.str(c[2]));
        walk(c, name + " › ", depth + 1);
        continue;
      }
      if (head === "instances" || head === "lib_symbols") continue;   // sheet bookkeeping, not the item
      const named = NAMED.has(head) && atoms.length ? `${head} ${K.str(atoms[0])}` : head;
      const key = prefix + named;
      const shown = NAMED.has(head) && atoms.length ? atoms.slice(1) : atoms;
      if (shown.length) {
        const dims = head === "size" || head === "drill" || head === "width" || head === "thickness" || head === "clearance" || head === "min_thickness";
        put(key, dims && shown.every((a) => typeof a === "number") ? shown.map((a) => mmText(a as number)).join(" × ") : shown.map((a) => K.str(a)).join(" "));
      } else if (!subs.length) put(key, "yes");
      if (subs.length && depth < 4) walk(c, key + " › ", depth + 1);
    }
  };
  walk(node, "", 0);
  return out;
}
function friendly(key: string): string {
  if (NAMES[key]) return NAMES[key];
  const parts = key.split(" › ");
  for (let i = 1; i < parts.length; i++) {
    const tail = parts.slice(i).join(" › ");
    if (NAMES[tail]) return `${parts.slice(0, i).map(part).join(" › ")} › ${NAMES[tail].toLowerCase()}`;
  }
  return parts.map(part).join(" › ");
}
function part(p: string): string {
  if (p === "at") return "position";
  const m = /^(pad|pin|model|fp_text|net|path|project) (.*)$/.exec(p);
  if (m) return `${titled(m[1].replace("fp_text", "text"))} ${m[2]}`;
  return /^[a-z_]+( \(\d+\))?$/.test(p) ? titled(p) : p;
}

function propRows(K: Canvas, a: KDoc, ia: KItem, b: KDoc, ib: KItem): PropRow[] {
  const fa = flatten(K, a, ia), fb = flatten(K, b, ib), rows: PropRow[] = [];
  for (const [k, v] of fa) { const w = fb.get(k); if (w !== v) rows.push({ name: friendly(k), before: v, after: w === undefined ? "" : w }); }
  for (const [k, w] of fb) if (!fa.has(k)) rows.push({ name: friendly(k), before: "", after: w });
  // a part that moved carries its fields along: their positions changed by the same step, which says nothing new
  const p = positionOf(K, ia), q = positionOf(K, ib);
  if (!p || !q || (p[0] === q[0] && p[1] === q[1])) return rows;
  const dx = q[0] - p[0], dy = q[1] - p[1];
  return rows.filter((r) => {
    if (!/ › position$/.test(r.name)) return true;
    const x = r.before.split(/\s+/).map(Number), y = r.after.split(/\s+/).map(Number);
    if (x.length < 2 || x.length !== y.length || x.some(Number.isNaN) || y.some(Number.isNaN)) return true;
    return !(Math.abs(y[0] - x[0] - dx) < 1e-6 && Math.abs(y[1] - x[1] - dy) < 1e-6 && x.slice(2).every((v, i) => v === y[i + 2]));
  });
}

function listProps(K: Canvas, doc: KDoc, it: KItem, side: "before" | "after"): PropRow[] {
  const rows: PropRow[] = [];
  for (const [k, v] of flatten(K, doc, it)) {
    if (k.includes(" › ") && !/^(stroke|fill|effects) › /.test(k)) continue;   // the item's own properties, not every pad's
    rows.push(side === "before" ? { name: friendly(k), before: v, after: "" } : { name: friendly(k), before: "", after: v });
    if (rows.length >= 40) break;
  }
  return rows;
}

// ---------------------------------------------------------------- geometry helpers
function union(a: Box | null, b: Box | null | undefined): Box | null {
  if (!b) return a; if (!a) return [b[0], b[1], b[2], b[3]];
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}
function boxOf(items: (KItem | undefined)[]): Box | null {
  let out: Box | null = null;
  for (const it of items) if (it) out = union(out, it.bbox);
  return out;
}
const positionOf = (K: Canvas, it: KItem): [number, number] | null => {
  const at = K.kid(it.node, "at"); if (at) return [K.num(at[1]), K.num(at[2])];
  return typeof it.x === "number" && typeof it.y === "number" ? [it.x, it.y] : null;
};

function summary(K: Canvas, ia: KItem, ib: KItem, rows: PropRow[]): string {
  if (!rows.length) return "definition changed";
  const names = new Set(rows.map((r) => r.name));
  const onlyMove = Array.from(names).every((n) => /^(Position|Start|End|Mid|Center) [XY]$/.test(n) || / › position$/.test(n) || /^(Outline|Polygon)$/.test(n));
  if (onlyMove) {
    const p = positionOf(K, ia), q = positionOf(K, ib);
    if (p && q && (p[0] !== q[0] || p[1] !== q[1])) return `moved ${mmText(Math.hypot(q[0] - p[0], q[1] - p[1]))}`;
    return names.has("Outline") || names.has("Polygon") ? "outline changed" : "moved";
  }
  if (names.size === 1 && names.has("Orientation")) return `rotated to ${rows[0].after}`;
  const own = rows.filter((r) => !/^(Position|Start|End|Mid|Center) [XY]$/.test(r.name) && !/ › /.test(r.name));
  const pick = (own.length ? own : rows).slice(0, 2).map((r) => (r.before && r.after ? `${r.name}: ${short(r.before, 18)} → ${short(r.after, 18)}` : r.after ? `${r.name}: ${short(r.after, 24)}` : `${r.name} removed`));
  const more = rows.length - Math.min(2, (own.length ? own : rows).length);
  return pick.join(", ") + (more > 0 ? `, +${more} more` : "");
}

// ---------------------------------------------------------------- grouping
/** Wires, buses and junctions that touch form one row. */
function wireClusters(K: Canvas, items: KItem[]): KItem[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r) as string; parent.set(x, r); return r; };
  const at = new Map<string, string>();
  const key = (p: [number, number] | number[]): string => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)}`;
  for (const it of items) {
    parent.set(it.id, it.id);
    let pts: number[][] = [];
    if (it.kind === "junction") { const a = K.atOf(it.node); pts = [[a[0], a[1]]]; }
    else if (it.kind === "bus_entry") { const a = K.atOf(it.node), s = K.kid(it.node, "size"); pts = [[a[0], a[1]], [a[0] + K.num(s ? s[1] : 0), a[1] + K.num(s ? s[2] : 0)]]; }
    else pts = K.ptsOf(it.node);
    for (const p of pts) { const k = key(p), other = at.get(k); if (other) parent.set(find(it.id), find(other)); else at.set(k, it.id); }
  }
  const groups = new Map<string, KItem[]>();
  for (const it of items) { const r = find(it.id); const g = groups.get(r); if (g) g.push(it); else groups.set(r, [it]); }
  return Array.from(groups.values());
}
const plural = (n: number, one: string, many = one + "s"): string => `${n} ${n === 1 ? one : many}`;
function tally(items: KItem[]): string {
  const counts = new Map<string, number>();
  for (const it of items) { const k = it.kind === "arc" ? "segment" : it.kind; counts.set(k, (counts.get(k) || 0) + 1); }
  const names: Record<string, [string, string?]> = { segment: ["segment"], via: ["via"], wire: ["wire"], bus: ["bus", "buses"], junction: ["junction"], bus_entry: ["bus entry", "bus entries"] };
  return Array.from(counts).map(([k, n]) => plural(n, (names[k] || [k])[0], (names[k] || [])[1])).join(", ");
}

// ---------------------------------------------------------------- the diff
const isRouting = (K: Canvas, doc: KDoc, it: KItem): boolean => it.docType === "pcb" && (ROUTING.has(it.kind) || (it.kind === "arc" && !!K.kid(it.node, "net")));

export function diffDocs(K: Canvas, a: KDoc, b: KDoc): DocDiff {
  const added: KItem[] = [], removed: KItem[] = [], pairs: [KItem, KItem][] = [];
  // anonymous items (no uuid) get a fresh id every parse: match them by what they say
  const anonA = new Map<string, KItem[]>();
  const isAnon = (it: KItem): boolean => it.id.startsWith("anon-");
  for (const it of a.items.values()) {
    if (isAnon(it)) { const t = comparable(K, it.node); const l = anonA.get(t); if (l) l.push(it); else anonA.set(t, [it]); continue; }
    const other = b.items.get(it.id);
    if (!other) removed.push(it);
    else if (comparable(K, it.node) !== comparable(K, other.node)) pairs.push([it, other]);
  }
  for (const it of b.items.values()) {
    if (isAnon(it)) { const l = anonA.get(comparable(K, it.node)); if (l && l.length) l.pop(); else added.push(it); continue; }
    if (!a.items.has(it.id)) added.push(it);
  }
  for (const l of anonA.values()) removed.push(...l);

  // a symbol whose library copy changed is drawn differently although its own text is the same
  if (a.type === "sch" && b.type === "sch") {
    const changedLibs = new Set<string>();
    for (const [name, lib] of b.lib) { const old = a.lib.get(name); if (old && K.serialize(old) !== K.serialize(lib)) changedLibs.add(name); }
    if (changedLibs.size) {
      const paired = new Set(pairs.map((p) => p[1].id));
      for (const it of b.items.values()) {
        if (it.kind !== "symbol" || paired.has(it.id)) continue;
        const old = a.items.get(it.id); if (!old) continue;
        const id = K.str((K.kid(it.node, "lib_name") || K.kid(it.node, "lib_id") || [])[1]);
        if (changedLibs.has(id)) pairs.push([old, it]);
      }
    }
  }

  const changes: Change[] = [];
  const single = (category: Category, doc: KDoc, it: KItem): Change => ({
    key: `${category}:${it.id}`, category, kind: it.kind, ids: category === "added" ? [it.id] : [], oldIds: category === "removed" ? [it.id] : [],
    label: describeItem(K, doc, it), detail: "", bbox: boxOf([it]), props: listProps(K, doc, it, category === "added" ? "after" : "before"),
    ref: it.ref || undefined, net: netName(K, doc, it) || undefined,
  });

  const grouped = (category: "added" | "removed", doc: KDoc, items: KItem[]): void => {
    const routing = new Map<string, KItem[]>(), wiring: KItem[] = [];
    for (const it of items) {
      if (isRouting(K, doc, it)) { const net = netName(K, doc, it) || ""; const l = routing.get(net); if (l) l.push(it); else routing.set(net, [it]); }
      else if (doc.type === "sch" && WIRING.has(it.kind)) wiring.push(it);
      else changes.push(single(category, doc, it));
    }
    const ids = (l: KItem[]) => l.map((it) => it.id);
    for (const [net, l] of routing) {
      if (l.length === 1) { changes.push(single(category, doc, l[0])); continue; }
      changes.push({ key: `${category}:routing:${net}`, category, kind: "segment", ids: category === "added" ? ids(l) : [], oldIds: category === "removed" ? ids(l) : [],
        label: net ? `Tracks on net ${netLabel(net)}` : "Tracks without a net", detail: tally(l), bbox: boxOf(l), props: [], net: net || undefined });
    }
    for (const l of wireClusters(K, wiring)) {
      if (l.length === 1) { changes.push(single(category, doc, l[0])); continue; }
      changes.push({ key: `${category}:wiring:${l[0].id}`, category, kind: "wire", ids: category === "added" ? ids(l) : [], oldIds: category === "removed" ? ids(l) : [],
        label: "Wiring", detail: tally(l), bbox: boxOf(l), props: [] });
    }
  };
  grouped("added", b, added);
  grouped("removed", a, removed);

  // modified: the tracks of one net are one row, everything else its own
  const modRouting = new Map<string, [KItem, KItem][]>();
  for (const [ia, ib] of pairs) {
    if (isRouting(K, b, ib)) { const net = netName(K, b, ib) || ""; const l = modRouting.get(net); if (l) l.push([ia, ib]); else modRouting.set(net, [[ia, ib]]); continue; }
    const rows = propRows(K, a, ia, b, ib);
    changes.push({ key: `modified:${ib.id}`, category: "modified", kind: ib.kind, ids: [ib.id], oldIds: [ia.id], label: describeItem(K, b, ib),
      detail: summary(K, ia, ib, rows), bbox: boxOf([ia, ib]), props: rows.length ? rows : [{ name: "Library symbol", before: "previous definition", after: "updated definition" }],
      ref: ib.ref || undefined, net: netName(K, b, ib) || undefined });
  }
  for (const [net, l] of modRouting) {
    if (l.length === 1) {
      const [ia, ib] = l[0], rows = propRows(K, a, ia, b, ib);
      changes.push({ key: `modified:${ib.id}`, category: "modified", kind: ib.kind, ids: [ib.id], oldIds: [ia.id], label: describeItem(K, b, ib), detail: summary(K, ia, ib, rows), bbox: boxOf([ia, ib]), props: rows, net: net || undefined });
      continue;
    }
    changes.push({ key: `modified:routing:${net}`, category: "modified", kind: "segment", ids: l.map((p) => p[1].id), oldIds: l.map((p) => p[0].id),
      label: net ? `Tracks on net ${netLabel(net)}` : "Tracks without a net", detail: `${tally(l.map((p) => p[1]))} changed`, bbox: boxOf(l.flat()), props: [], net: net || undefined });
  }

  // the sheet's own settings
  const docRows: PropRow[] = [];
  const A = a as unknown as Record<string, unknown>, B = b as unknown as Record<string, unknown>;
  const text = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
  if (text(A.paper) !== text(B.paper) || a.page[0] !== b.page[0] || a.page[1] !== b.page[1]) docRows.push({ name: "Page size", before: `${text(A.paper)} (${mmText(a.page[0])} × ${mmText(a.page[1])})`, after: `${text(B.paper)} (${mmText(b.page[0])} × ${mmText(b.page[1])})` });
  const ta = (A.titleBlock || {}) as Record<string, string>, tb = (B.titleBlock || {}) as Record<string, string>;
  for (const k of new Set([...Object.keys(ta), ...Object.keys(tb)])) if (text(ta[k]) !== text(tb[k])) docRows.push({ name: `Title block ${k.replace(/^comment/, "comment ")}`, before: text(ta[k]), after: text(tb[k]) });
  if (b.type === "pcb") {
    const la = Array.from(a.layers.keys()).join(", "), lb = Array.from(b.layers.keys()).join(", ");
    if (la !== lb) docRows.push({ name: "Enabled layers", before: short(la, 200), after: short(lb, 200) });
    if (text(a.thickness) !== text(b.thickness)) docRows.push({ name: "Board thickness", before: a.thickness ? mmText(a.thickness) : "", after: b.thickness ? mmText(b.thickness) : "" });
  }
  if (docRows.length) changes.push({ key: "modified:document", category: "modified", kind: "document", ids: [], oldIds: [], label: b.type === "sch" ? "Sheet settings" : "Board settings",
    detail: docRows.map((r) => r.name).slice(0, 3).join(", "), bbox: null, props: docRows });

  const order: Record<Category, number> = { added: 0, removed: 1, modified: 2 };
  changes.sort((x, y) => order[x.category] - order[y.category] || x.label.localeCompare(y.label, undefined, { numeric: true }));

  const out: DocDiff = { type: b.type, changes, added: new Set(), removed: new Set(), modified: new Set(), modifiedOld: new Set(), counts: { added: 0, removed: 0, modified: 0 } };
  for (const c of changes) {
    out.counts[c.category]++;
    if (c.category === "added") for (const id of c.ids) out.added.add(id);
    else if (c.category === "removed") for (const id of c.oldIds) out.removed.add(id);
    else { for (const id of c.ids) out.modified.add(id); for (const id of c.oldIds) out.modifiedOld.add(id); }
  }
  return out;
}

/** The change row an item belongs to, by the item's id in either version. */
export function changeOfItem(diff: DocDiff, id: string): Change | null {
  for (const c of diff.changes) if (c.ids.includes(id) || c.oldIds.includes(id)) return c;
  return null;
}

/** "3 added, 1 removed, 2 modified" — or "No differences". */
export function countsText(diff: DocDiff): string {
  const c = diff.counts, parts: string[] = [];
  if (c.added) parts.push(`${c.added} added`); if (c.removed) parts.push(`${c.removed} removed`); if (c.modified) parts.push(`${c.modified} modified`);
  return parts.length ? parts.join(", ") : "No differences";
}
