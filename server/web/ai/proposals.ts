// proposals.ts — how the assistant changes a design: it doesn't.  `propose_changes` turns the
// model's structured edits into ordinary collaboration changes (the same ADDED / MODIFIED /
// REMOVED records the editor's own tools produce), validates them against the live document and
// parks them as a proposal.  A person accepts it — then the changes go through commitChanges(),
// i.e. the normal op pipeline as one undo step — or rejects it, and nothing happens.
//
// Building a proposal never touches the document: nodes are cloned before they are edited, and
// new items are serialised without being added.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { globalizeLabels } from "./labels";
import { ED, K, ToolError, centreOn, fieldsOf, findByRef, openEntry, schNets } from "./design";
import { projectDocs, resolveDoc } from "./design";
import { footprintNode, kicadFootprint, kicadSymbol, vendorPart, vendorSymbol } from "./library";
import { fieldShifts, inlineFieldShifts, snugFieldShifts, itemsWithin } from "./layout";
import { planSilk } from "./silkscreen";

const W = window as any;
const SCH = (): any => (W.CollabTools && W.CollabTools.sch) || null;
const PCB = (): any => W.PcbTools || null;

export interface Edit { op: string; [k: string]: any }
export interface EditLine { kind: "add" | "modify" | "remove"; text: string; ids: string[] }
export interface Proposal {
  id: string; title: string; rationale: string; docId: string; docPath: string;
  lines: EditLine[]; changes: any[];
  /** each touched item as it was when the proposal was made: an item someone has changed since makes it stale */
  basis: Record<string, string>;
  status: "pending" | "accepted" | "rejected" | "stale";
  note?: string;
  /** schematics: how pin connections differ once applied. Empty: unchanged. Absent: not checked. */
  connectivity?: string[];
  /** extra facts for the model about what an edit did (the autorouter's summary) */
  details?: unknown[];
  /** board rules to write into the project file when accepted (set_rules) */
  rules?: Record<string, number | string>;
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const num = (v: unknown, what: string): number => { if (typeof v !== "number" || !isFinite(v)) throw new ToolError(`${what} must be a number.`); return v; };
const text = (v: unknown, what: string): string => { if (typeof v !== "string" || !v.trim()) throw new ToolError(`${what} is required.`); return v; };
const fmt = (v: number) => String(r4(v));

function target(doc: any, e: Edit): any {
  if (typeof e.id === "string" && e.id) { const it = doc.items.get(e.id); if (!it) throw new ToolError(`no item with id ${e.id} on the open document`); return it; }
  if (typeof e.ref === "string" && e.ref) {
    const hits = findByRef(doc, e.ref);
    if (!hits.length) throw new ToolError(`no component ${e.ref} on the open document`);
    return hits;   // a multi-unit symbol is several items sharing one reference
  }
  throw new ToolError("needs ref or id");
}
const one = (t: any, e: Edit): any => { if (Array.isArray(t)) { if (t.length > 1 && e.op !== "set_field" && e.op !== "remove") throw new ToolError(`${e.ref} has ${t.length} units; address one by id`); return t[0]; } return t; };
const all = (t: any): any[] => (Array.isArray(t) ? t : [t]);
const nameOf = (it: any) => it.ref || `${it.kind} ${String(it.id).slice(0, 8)}`;

// ---------------------------------------------------------------- change records

export function modified(doc: any, it: any, node: any): any {
  if (doc.type === "sch") { const s = SCH(); return { id: it.id, kind: "MODIFIED", typeName: s._.typeNameFor(it), sexpr: s._.itemSexpr(doc, it.kind, node) }; }
  const P = PCB(); const shell = { id: it.id, kind: it.kind, node, docType: "pcb" };
  return K().boardChangeExtras(doc, shell, { id: it.id, kind: "MODIFIED", typeName: P.typeNameOf(shell), sexpr: P.wrapBoard(node) });
}
export function added(doc: any, node: any): any {
  const k = K(); if (!k.uuidOf(node)) node.push(["uuid", k.newUuid()]);
  const id = k.uuidOf(node); const shell = { id, kind: node[0], node, docType: doc.type };
  if (doc.type === "sch") { const s = SCH(); return { id, kind: "ADDED", typeName: s._.typeNameFor(shell), sexpr: s._.itemSexpr(doc, node[0], node) }; }
  const P = PCB();
  return k.boardChangeExtras(doc, shell, { id, kind: "ADDED", typeName: P.typeNameOf(shell), sexpr: P.wrapBoard(node) });
}
export function removed(doc: any, it: any): any {
  const typeName = doc.type === "sch" ? SCH()._.typeNameFor(it) : PCB().typeNameOf(it);
  return { id: it.id, kind: "REMOVED", typeName, properties: [] };
}

// ---------------------------------------------------------------- the edits

function setField(doc: any, it: any, field: string, value: string): any {
  const k = K(); const node = k.cloneNode(it.node);
  let p = k.kids(node, "property").find((q: any) => k.str(q[1]) === field);
  if (p) p[2] = value;
  else {
    const [x, y] = k.atOf(node);
    p = doc.type === "sch"
      ? ["property", field, value, ["at", r4(x), r4(y), 0], ["hide", "yes"], ["effects", ["font", ["size", 1.27, 1.27]]]]
      : ["property", field, value, ["at", 0, 0, 0], ["layer", it.layer === "B.Cu" ? "B.Fab" : "F.Fab"], ["hide", "yes"], ["uuid", k.newUuid()], ["effects", ["font", ["size", 1, 1], ["thickness", 0.15]]]];
    const at = node.findIndex((c: any) => Array.isArray(c) && (c[0] === "pin" || c[0] === "instances" || c[0] === "pad" || c[0] === "fp_line" || c[0] === "fp_text" || c[0] === "model"));
    if (at >= 0) node.splice(at, 0, p); else node.push(p);
  }
  // a symbol's reference also lives in its per-instance data, which is what the desktop reads
  if (field === "Reference" && doc.type === "sch") for (const inst of k.kids(node, "instances")) for (const pr of k.kids(inst, "project")) for (const pa of k.kids(pr, "path")) { const r = k.kid(pa, "reference"); if (r) r[1] = value; }
  return modified(doc, it, node);
}

function moveItem(doc: any, it: any, x: number, y: number, rot: number | undefined, side?: string): any {
  const k = K(); const node = k.cloneNode(it.node);
  if (doc.type === "sch" && (it.kind === "wire" || it.kind === "bus" || it.kind === "polyline")) {
    const pts = k.ptsOf(node); if (!pts.length) throw new ToolError("that line has no points");
    const dx = x - pts[0][0], dy = y - pts[0][1]; k.setPts(node, pts.map((p: number[]) => [p[0] + dx, p[1] + dy]));
    return modified(doc, it, node);
  }
  if (!k.kid(node, "at")) throw new ToolError(`a ${it.kind} has no single position; remove it and add it again where it should go`);
  const [ox, oy, orot] = k.atOf(node); const dx = x - ox, dy = y - oy;
  if (doc.type === "pcb" && it.kind === "footprint") {
    const P = PCB();
    if (side && (side === "back") !== (k.str((k.kid(node, "layer") || [])[1]) === "B.Cu")) P.flipNode(node, ox, doc);
    P.translateNode(node, dx, dy);
    const cur = k.atOf(node)[2] || 0;
    if (rot !== undefined && rot !== cur) P.rotateNode(node, x, y, rot - cur);
  } else {
    k.setAt(node, r4(x), r4(y), rot);
    if (it.kind === "symbol") for (const p of k.kids(node, "property")) { const a = k.kid(p, "at"); if (a) { a[1] = r4(k.num(a[1]) + dx); a[2] = r4(k.num(a[2]) + dy); } }
  }
  return modified(doc, it, node);
}

function nextRef(doc: any, prefix: string, taken: Set<string>): string {
  for (const it of doc.items.values()) if (it.kind === "symbol" && it.ref) taken.add(it.ref);
  let n = 1; while (taken.has(prefix + n)) n++;
  taken.add(prefix + n); return prefix + n;
}

/** Project name and sheet path a new symbol records: what the sheet's other items say, else the root sheet's own uuid. */
function instanceHome(doc: any): { project: string; path: string } | null {
  let found: { path: string | null; project: string | null } = { path: null, project: null };
  try { found = SCH()._.sheetPathHere(doc); } catch { /* older tool module */ }
  // KiCad's project name is the .kicad_pro's base name; the editor lists only sheets and boards, so read it from the project's own docs
  const st = ED()?.api?.state || {}; const all: any[] = (st.project && st.project.docs) || projectDocs();
  const pro = all.find((d: any) => d && (d.docType === "kicad_pro" || /\.kicad_pro$/.test(d.path || "")));
  const project = found.project || (pro ? String(pro.path).split("/").pop()!.replace(/\.kicad_pro$/, "") : String((st.project && st.project.name) || ""));
  const path = found.path || (doc.uuid ? "/" + doc.uuid : "");
  return project && path ? { project, path } : null;
}

function addSymbol(doc: any, e: Edit, taken: Set<string>): { change: any; ref: string } {
  const s = SCH(); const k = K(); const got = e.__lib as { libId: string; node: any; fields?: Record<string, string>; value?: string } | undefined;
  const libId = got ? got.libId : text(e.lib_id, "lib_id");
  if (got && !k.resolveLib(doc, libId)) doc.lib.set(libId, got.node);   // the sheet's own copy wins when it has one; an unused definition is not written out
  if (!k.resolveLib(doc, libId)) throw new ToolError(`symbol ${libId} is not on this sheet and was not found in KiCad's libraries; look it up with find_parts`);
  if (got && got.fields) e = Object.assign({}, e, { value: e.value || got.value, fields: Object.assign({}, got.fields, e.fields || {}) });
  const rot = e.rotation === undefined ? 0 : num(e.rotation, "rotation");
  if (![0, 90, 180, 270].includes(((rot % 360) + 360) % 360)) throw new ToolError("a symbol's rotation is 0, 90, 180 or 270");
  const node = s._.symbolNode(doc, libId, [num(e.x, "x"), num(e.y, "y")], ((rot % 360) + 360) % 360, e.mirror || "");
  const prop = (name: string) => k.kids(node, "property").find((q: any) => k.str(q[1]) === name);
  const unit = e.unit === undefined ? 1 : num(e.unit, "unit"); if (unit !== 1) { const un = k.kid(node, "unit"); if (un) un[1] = unit; }
  const refP = prop("Reference"); let ref = typeof e.reference === "string" && e.reference ? e.reference : "";
  if (ref && unit === 1 && findByRef(doc, ref).length) throw new ToolError(`reference ${ref} is already used on this sheet`);
  if (!ref) { const cur = refP ? k.str(refP[2]) : "U?"; ref = nextRef(doc, /^#/.test(cur) ? cur.replace(/\?$/, "") + "0" : cur.replace(/\?$/, "") || "U", taken); } else taken.add(ref);
  if (refP) refP[2] = ref;
  if (typeof e.value === "string" && e.value) { const v = prop("Value"); if (v) v[2] = e.value; }
  for (const [name, value] of Object.entries(e.fields || {})) {
    const p = prop(name);
    if (p) p[2] = String(value);
    else { const [x, y] = k.atOf(node); const np = ["property", name, String(value), ["at", r4(x), r4(y), 0], ["hide", "yes"], ["effects", ["font", ["size", 1.27, 1.27]]]]; const at = node.findIndex((c: any) => Array.isArray(c) && (c[0] === "pin" || c[0] === "instances")); if (at >= 0) node.splice(at, 0, np); else node.push(np); }
  }
  // where it sits in the hierarchy, as KiCad writes it: without (instances …) desktop KiCad annotates the symbol
  // afresh and its schematic parity check no longer finds the pins of the board's footprints
  const home = instanceHome(doc);
  if (home) { const old = node.findIndex((c: any) => Array.isArray(c) && c[0] === "instances"); if (old >= 0) node.splice(old, 1);
    node.push(["instances", ["project", home.project, ["path", home.path, ["reference", ref], ["unit", unit]]]]); }
  // a turned symbol keeps its library's field positions turned with it, which lays text over its
  // own wires; KiCad's field autoplace puts them beside the body instead
  let out = node;
  if (((rot % 360) + 360) % 360 !== 0 && s._.autoplaceNode) { try { const placed = s._.autoplaceNode(doc, { node, id: "__new", kind: "symbol" }, { manual: false }); if (placed) out = placed; } catch { /* keep the library's positions */ } }
  // a power symbol turned on its side reads best with its name on its own row, beyond its tip,
  // where it cannot land on the label of the pin above or below
  const turn = ((rot % 360) + 360) % 360;
  if ((turn === 90 || turn === 270) && s._.isPowerSymbol(doc, libId) && s._.bodyBox && k.symbolTransform) {
    try {
      const box = s._.bodyBox(doc, { node: out, id: "__new", kind: "symbol" }); const [x, y] = k.atOf(out); const T = k.symbolTransform(turn, e.mirror || "");
      const left = (box[0] + box[2]) / 2 < x, v = k.kids(out, "property").find((q: any) => k.str(q[1]) === "Value");
      if (v) {
        const at = k.kid(v, "at"); if (at) { at[1] = r4(left ? box[0] - 0.635 : box[2] + 0.635); at[2] = r4(y); }
        const flip = (T[1] !== 0 ? T[1] : T[0]) < 0, hj = left ? "right" : "left", stored = flip ? (hj === "left" ? "right" : "left") : hj;
        let ef = k.kid(v, "effects"); if (!ef) { ef = ["effects", ["font", ["size", 1.27, 1.27]]]; v.push(ef); }
        const j = ef.findIndex((c: any) => Array.isArray(c) && c[0] === "justify"); if (j >= 0) ef.splice(j, 1); ef.push(["justify", stored]);
      }
    } catch { /* keep the autoplaced position */ }
  }
  // A two-pin part reads best with its reference and value tight against it: across the wire from each other when
  // the part lies along a horizontal wire (reference above, value below), stacked close together beside the body
  // when it stands on a vertical one.  Always upright text, never on the wire or the body.
  if (!s._.isPowerSymbol(doc, libId) && s._.bodyBox && s._.symbolPins && k.symbolTransform) {
    try {
      const probe = { node: out, id: "__new", kind: "symbol" }; const pins = s._.symbolPins(doc, probe).filter((p: any) => !p.hidden);
      if (pins.length === 2) {
        const box = s._.bodyBox(doc, probe); const [x, y] = k.atOf(out); const T = k.symbolTransform(turn, e.mirror || "");
        const lying = Math.abs(pins[0].y - pins[1].y) < 0.01, standing = Math.abs(pins[0].x - pins[1].x) < 0.01;
        const put = (name: string, px: number, py: number, hj: "left" | "center") => {
          const f = k.kids(out, "property").find((q: any) => k.str(q[1]) === name); if (!f) return;
          const at = k.kid(f, "at"); if (!at) return; at[1] = r4(px); at[2] = r4(py); at[3] = turn === 90 || turn === 270 ? 90 : 0;   // a field turns with its symbol; this keeps it upright
          let ef = k.kid(f, "effects"); if (!ef) { ef = ["effects", ["font", ["size", 1.27, 1.27]]]; f.push(ef); }
          const j = ef.findIndex((c: any) => Array.isArray(c) && c[0] === "justify"); if (j >= 0) ef.splice(j, 1);
          if (hj === "left") { const flip = (T[1] !== 0 ? T[1] : T[0]) < 0; ef.push(["justify", flip ? "right" : "left"]); }
        };
        const gap = 0.4, half = 0.635;   // clear of the body by 0.4 mm; half the 1.27 mm text height
        if (lying) { put("Reference", x, box[1] - gap - half, "center"); put("Value", x, box[3] + gap + half, "center"); }
        else if (standing) { put("Reference", box[2] + 0.635, y - 0.9, "left"); put("Value", box[2] + 0.635, y + 0.9, "left"); }
      }
    } catch { /* keep what the library or the autoplacer gave */ }
  }
  return { change: added(doc, out), ref };
}

function points(e: Edit): number[][] {
  const pts = e.points;
  if (!Array.isArray(pts) || pts.length < 2 || pts.some((p: any) => !Array.isArray(p) || p.length !== 2 || p.some((v: any) => typeof v !== "number" || !isFinite(v)))) throw new ToolError("points must be a list of at least two [x, y] pairs");
  return pts;
}

function boardNet(doc: any, name: string): any {
  // a net of a sheet's local label is "/NAME" on the board: either spelling finds it
  const all = PCB().boardNets(doc); const bare = String(name).replace(/^\//, "");
  const n = all.find((x: any) => x.name === name) || all.find((x: any) => x.name === "/" + bare) || all.find((x: any) => x.name === bare);
  if (!n) throw new ToolError(`there is no net "${name}" on the board`);
  return n;
}

// ---------------------------------------------------------------- schematic to board

interface SyncAdd { ref: string; value: string; fpid: string; x: number; y: number; node: any; padNets: Record<string, string> }
interface SyncUpdate { item: any; node: any; what: string; padNets: Record<string, string> }
interface SyncPlan { adds: SyncAdd[]; updates: SyncUpdate[]; extra: string[]; nets: number; problems: string[]; copper: { item: any; node: any }[]; renamed: Record<string, string> }
const VENDOR_FIELDS: [string, string][] = [["LCSC", "lcsc"], ["Mouser", "mouser"], ["DigiKey", "digikey"]];

/**
 * KiCad's "Update PCB from Schematic", as a plan: every part of the project's sheets that should be
 * on the board and is not gets its footprint, with each pad on its pin's net; a part that is there
 * gets its pad nets and value brought into line.  Nothing is removed.
 */
/** A placed symbol's path as a board footprint records it: the sheet path below the root, then the symbol's uuid. */
function symbolPath(doc: any, node: any): string {
  const k = K(); const u = k.kid(node, "uuid"); if (!u) return "";
  let sheet = "";
  for (const inst of k.kids(node, "instances")) for (const pr of k.kids(inst, "project")) for (const pa of k.kids(pr, "path")) { sheet = k.str(pa[1]); break; }
  const below = sheet.split("/").filter(Boolean).slice(1);   // drop the root sheet's uuid
  return "/" + [...below, k.str(u[1])].join("/");
}

async function planSync(board: any, e: Edit): Promise<SyncPlan> {
  const k = K(); const P = PCB(); const s = SCH(); if (!s) throw new ToolError("The schematic tools are not loaded.");
  const sheets = projectDocs().filter((d) => d.docType === "kicad_sch" && (!e.schematic || d.path === e.schematic || d.path.endsWith("/" + e.schematic)));
  if (!sheets.length) throw new ToolError(e.schematic ? `there is no schematic ${e.schematic} in this project` : "this project has no schematic");
  const parts = new Map<string, { ref: string; value: string; fpid: string; fields: Record<string, string>; pins: Map<string, string>; path: string; sheetfile: string }>(); const netNames = new Set<string>(); const lone = new Set<string>();   // lone: a pin on its own keeps KiCad's unconnected-(…) net on its pad, but is not counted as a net to route
  const problems: string[] = [];
  for (const sh of sheets) {
    const { doc } = await resolveDoc(sh.path);
    const multi = sheets.length > 1; const nets = schNets(doc);
    const local = (n: { board: string }) => n.board;   // as desktop KiCad names it, so its schematic parity check agrees; unnamed nets are named from a pin, unique across sheets
    const pinNet = new Map<string, string>();
    for (const n of nets) { if (n.pins.length < 1) continue; const name = local(n); for (const p of n.pins) pinNet.set(`${p.ref}\u0000${p.number}`, name); if (n.pins.length > 1 || n.named) netNames.add(name); else if (n.pins.length === 1) lone.add(name); }
    for (const it of doc.items.values() as Iterable<any>) {
      if (it.kind !== "symbol" || !it.ref || /^#/.test(it.ref)) continue;
      const ob = k.kid(it.node, "on_board"); if (ob && k.str(ob[1]) === "no") continue;
      const f = fieldsOf(it.node); let part = parts.get(it.ref);
      if (!part) { part = { ref: it.ref, value: f.Value || "", fpid: f.Footprint || "", fields: f, pins: new Map(), path: symbolPath(doc, it.node), sheetfile: sh.path.split("/").pop() || sh.path }; parts.set(it.ref, part); }
      for (const p of s._.symbolPins(doc, it)) { const net = pinNet.get(`${it.ref}\u0000${p.number}`); if (net && (netNames.has(net) || lone.has(net))) part.pins.set(String(p.number), net); }
    }
  }
  if (/\?$/.test(Array.from(parts.keys()).join(" ")) || Array.from(parts.keys()).some((r) => /\?$/.test(r))) problems.push("some symbols are not annotated (their reference ends in ?); annotate the schematic first");

  // nets as this board writes them: by name where the board already does, else code and name with new codes after the highest in use
  const style = P.netStyle(board); const codes = new Map<string, number>(); let top = 0;
  for (const n of P.boardNets(board)) { if (n.code > 0) { codes.set(n.name, n.code); top = Math.max(top, n.code); } }
  const netOf = (name: string) => { if (style === "name") return ["net", name]; let c = codes.get(name); if (!c) { c = ++top; codes.set(name, c); } return ["net", c, name]; };

  const onBoard = new Map<string, any>(); for (const it of board.items.values() as Iterable<any>) if (it.kind === "footprint" && it.ref) onBoard.set(it.ref, it);
  const adds: SyncAdd[] = [], updates: SyncUpdate[] = [];
  const moved = new Map<string, Set<string>>();      // each net the board's pads are on now -> the nets the schematic puts those pads on
  const placements: Record<string, any> = e.placements && typeof e.placements === "object" ? e.placements : {};
  // park new parts in rows to the right of what is there (or from a sensible origin on an empty board)
  const bb = board.bbox && isFinite(board.bbox[0]) && board.items.size ? board.bbox : null;
  const x0 = bb ? bb[2] + 10 : 100, y0 = bb ? bb[1] : 60; let cx = x0, cy = y0, rowH = 0;
  const refs = Array.from(parts.keys()).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const ref of refs) {
    const part = parts.get(ref)!; const have = onBoard.get(ref);
    if (have) {
      const node = k.cloneNode(have.node); const what: string[] = []; const padNets: Record<string, string> = {};
      for (const pad of k.kids(node, "pad")) {
        const num = k.str(pad[1]); const want = part.pins.get(num) || ""; const cur = P.netOf(pad).name || ""; if (want) padNets[num] = want;
        if (cur) { let to = moved.get(cur); if (!to) moved.set(cur, to = new Set()); to.add(want); }
        if (want === cur) continue;
        const i = pad.findIndex((q: any) => Array.isArray(q) && q[0] === "net"); if (i >= 0) pad.splice(i, 1); if (want) pad.push(netOf(want));
        what.push(`pad ${num} ${cur || "no net"} → ${want || "no net"}`);
      }
      const vp = k.kids(node, "property").find((q: any) => k.str(q[1]) === "Value"); if (vp && part.value && k.str(vp[2]) !== part.value) { what.push(`value ${k.str(vp[2])} → ${part.value}`); vp[2] = part.value; }
      if (what.length) updates.push({ item: have, node, what: what.slice(0, 4).join(", ") + (what.length > 4 ? ` and ${what.length - 4} more` : ""), padNets });
      continue;
    }
    try {
      let fpid = part.fpid, sexpr = "";
      const vend = VENDOR_FIELDS.find(([f]) => part.fields[f]);
      const given = e.footprints && typeof e.footprints === "object" ? e.footprints[fpid] : undefined;   // footprint text that comes with the edit (the harness's generated parts)
      if (typeof given === "string" && given) sexpr = given;
      else if (fpid) { try { sexpr = await kicadFootprint(fpid); } catch (err) { if (!vend) throw err; } }
      if (!sexpr && vend) { const vp = await vendorPart(vend[1], part.fields[vend[0]]); const fp = vp.cad && vp.cad.footprint; if (fp) { sexpr = fp.sexpr; fpid = fpid || fp.fpid; } }
      if (!sexpr) throw new ToolError(fpid ? `footprint ${fpid} was not found` : "no Footprint field");
      const extra: Record<string, string> = {}; for (const [name, v] of Object.entries(part.fields)) if (!["Reference", "Value", "Footprint"].includes(name) && !name.startsWith("ki_") && v && v !== "~") extra[name] = v;
      const padNets: Record<string, string> = {};
      const node = footprintNode(fpid, sexpr, ref, part.value, extra, (pad) => { const n = part.pins.get(pad); if (!n) return null; padNets[pad] = n; return netOf(n); });
      // its extent, to park it without overlapping its neighbours
      const probe = k.parseDoc('(kicad_pcb (version 20241229) (generator "pcbnew"))', "kicad_pcb"); const pit = k.addItem(probe, k.cloneNode(node)); const b = pit.bbox || [-2, -2, 2, 2];
      const pl = placements[ref]; let x: number, y: number;
      if (pl && typeof pl.x === "number" && typeof pl.y === "number") {
        x = pl.x; y = pl.y; if (pl.side === "back") P.flipNode(node, 0, board);
        if (typeof pl.rotation === "number" && pl.rotation) P.rotateNode(node, 0, 0, pl.rotation);
      } else {
        const w = b[2] - b[0], h = b[3] - b[1];
        if (cx > x0 && cx + w > x0 + 90) { cx = x0; cy += rowH + 2; rowH = 0; }
        x = r4(cx - b[0]); y = r4(cy - b[1]); cx += w + 2; rowH = Math.max(rowH, h);
      }
      // tie the footprint to its symbol the way KiCad does, by the symbol's uuid path, so update and parity match on it
      if (part.path) { const at = node.findIndex((c: any) => Array.isArray(c) && (c[0] === "attr" || c[0] === "fp_line" || c[0] === "fp_text" || c[0] === "pad"));
        const tie = [["path", part.path], ["sheetname", "/"], ["sheetfile", part.sheetfile]]; if (at >= 0) node.splice(at, 0, ...tie); else node.push(...tie); }
      P.translateNode(node, x, y);
      adds.push({ ref, value: part.value, fpid, x, y, node, padNets });
    } catch (err) { problems.push(`${ref}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  const extra = Array.from(onBoard.keys()).filter((r) => !parts.has(r)).sort();
  // A net whose pads all went to one other name was renamed on the sheet (a label became global, a wired net lost its
  // label, a sheet was redrawn): its tracks, vias and zones take the new name too, so a routed board stays routed.
  const renamed: Record<string, string> = {}; const copper: { item: any; node: any }[] = [];
  for (const [cur, to] of moved) { const [only] = Array.from(to); if (to.size === 1 && only && only !== cur) renamed[cur] = only; }
  if (Object.keys(renamed).length) for (const it of board.items.values() as Iterable<any>) {
    if (it.kind !== "segment" && it.kind !== "arc" && it.kind !== "via" && it.kind !== "zone") continue;
    const to = renamed[P.netOf(it.node).name || ""]; if (!to) continue;
    const node = k.cloneNode(it.node); const ref = netOf(to);
    for (const c of node) {
      if (!Array.isArray(c)) continue;
      if (c[0] === "net") { if (typeof c[1] === "number") { c[1] = ref.length === 3 ? ref[1] : c[1]; if (c.length > 2) c[2] = to; } else c[1] = to; }
      else if (c[0] === "net_name") c[1] = to;
    }
    copper.push({ item: it, node });
  }
  return { adds, updates, extra, nets: netNames.size, problems, copper, renamed };
}

/** Turn the model's edits into changes plus a line of plain words for each.  Throws ToolError naming the edit at fault. */
export async function buildProposal(input: { title?: string; rationale?: string; edits?: Edit[] }): Promise<Proposal> {
  await fetchSources(input.edits);
  return build(input);
}

/** What an edit needs from a library or a vendor is fetched first, so that building stays one synchronous pass over the document. */
async function fetchSources(edits: Edit[] | undefined): Promise<void> {
  const doc = ED()?.kdoc; if (!doc || !Array.isArray(edits)) return;
  await Promise.all(edits.map(async (e) => {
    if (!e || typeof e !== "object") return;
    try {
      if (e.op === "add_symbol" && doc.type === "sch") {
        if (typeof e.symbol === "string" && e.symbol) e.__lib = inlineSymbol(e);   // a definition that comes with the edit (the harness's generated parts)
        else if (e.part && typeof e.part === "object") e.__lib = await vendorSymbol(String(e.part.vendor || "lcsc"), String(e.part.id || ""));
        else if (typeof e.lib_id === "string" && !K().resolveLib(doc, e.lib_id)) e.__lib = { libId: e.lib_id, node: await kicadSymbol(e.lib_id) };
      } else if (e.op === "update_from_schematic" && doc.type === "pcb") e.__sync = await planSync(doc, e);
      else if (e.op === "fill_zones" && doc.type === "pcb") e.__fill = await planFill(doc, edits.length);
    } catch (err) { e.__error = err instanceof Error ? err.message : String(err); }
  }));
}

/**
 * KiCad's "Fill All Zones" for the board as it stands: every zone's fill outlines per layer, worked out by the
 * same filler the editor uses.  A fill depends on all the copper around it, so the edit stands alone in its call.
 */
async function planFill(doc: any, count: number): Promise<any[]> {
  if (count !== 1) throw new ToolError("fill_zones must be the only edit of its call: a fill is worked out from the board as it stands, so apply the tracks, vias and zones first");
  const F = (globalThis as any).KiCadFab; if (!F || !F.fillZones) throw new ToolError("the zone filler is not loaded in this editor");
  const k = K(); const P = PCB(); const s = P.designSettings(ED().proSettings || null);
  if (![...doc.items.values()].some((it: any) => it.kind === "zone" && !k.kid(it.node, "keepout"))) throw new ToolError("the board has no copper zone to fill; add one first");
  const rules = { netClearance: (n: string) => { const nc = P.netclassOf(s, n); return nc && nc.clearance !== undefined ? nc.clearance : s.clearance; },
    minClearance: s.minClearance || 0, holeClearance: s.holeClearance || 0, edgeClearance: s.edgeClearance };
  const quiet = { phase() { /* no dialog here */ }, advance() { /* no dialog here */ }, cancelled: () => false, yield: () => Promise.resolve() };
  // text set in an outline font is cleared around its real outlines: the font files first
  if (typeof k.loadFontsFor === "function") { try { await k.loadFontsFor(doc); } catch { /* the fill then clears around the stroke font's box */ } }
  return (await F.fillZones({ doc, setup: null }, rules, null, quiet)) || [];
}

/** A symbol definition given with the edit itself, as library text: one (symbol "Name" ...) node, or a whole (kicad_symbol_lib ...). */
function inlineSymbol(e: Edit): { libId: string; node: any } {
  const k = K(); const trees = k.parseAll(String(e.symbol));
  let node = trees.find((t: any) => Array.isArray(t) && t[0] === "symbol");
  if (!node) { const lib = trees.find((t: any) => Array.isArray(t) && t[0] === "kicad_symbol_lib"); const want = typeof e.lib_id === "string" ? e.lib_id.split(":").pop() : "";
    const all = lib ? k.kids(lib, "symbol") : []; node = all.find((s: any) => k.str(s[1]) === want) || all[0]; }
  if (!node) throw new ToolError("symbol must be one (symbol ...) definition in KiCad's library format");
  node = k.cloneNode(node); const name = k.str(node[1]).split(":").pop() as string;
  const libId = typeof e.lib_id === "string" && e.lib_id.includes(":") ? e.lib_id : `Generated:${name}`; const own = libId.split(":").pop() as string;
  for (const c of node) if (Array.isArray(c) && c[0] === "symbol" && typeof c[1] === "string" && c[1].startsWith(name + "_")) c[1] = own + c[1].slice(name.length);
  node[1] = libId; e.lib_id = libId;
  return { libId, node };
}

function build(input: { title?: string; rationale?: string; edits?: Edit[] }): Proposal {
  const ed = ED(); const doc = ed?.kdoc; const open = openEntry();
  if (!doc || !open) throw new ToolError("No document is open in the editor, so there is nothing to change.");
  const edits = input.edits; if (!Array.isArray(edits) || !edits.length) throw new ToolError("edits must be a non-empty list.");
  if (edits.length > 400) throw new ToolError("That is too many edits for one proposal; split it into steps a person can review.");
  const isSch = doc.type === "sch"; const k = K();
  const changes: any[] = [], lines: EditLine[] = [], basis: Record<string, string> = {}, problems: string[] = []; const details: unknown[] = []; let rules: Record<string, number | string> | undefined;
  const touched = new Map<string, string>(); const taken = new Set<string>();
  const touch = (it: any, op: string) => { const prev = touched.get(it.id); if (prev) throw new ToolError(`${nameOf(it)} is already changed by an earlier edit (${prev}); combine them or split the proposal`); touched.set(it.id, op); basis[it.id] = k.serialize(it.node); };
  const schOnly = (op: string) => { if (!isSch) throw new ToolError(`${op} is a schematic edit and the board is open`); };
  const pcbOnly = (op: string) => { if (isSch) throw new ToolError(`${op} is a board edit and a schematic sheet is open`); };

  edits.forEach((e, i) => {
    try {
      if (!e || typeof e !== "object" || typeof e.op !== "string") throw new ToolError("needs an op");
      if (e.__error) throw new ToolError(e.__error);
      switch (e.op) {
        case "set_field": {
          const field = text(e.field, "field"); if (typeof e.value !== "string") throw new ToolError("value must be a string");
          const items = all(target(doc, e)).filter((it) => it.kind === "symbol" || it.kind === "footprint");
          if (!items.length) throw new ToolError("fields belong to symbols and footprints");
          const before = fieldsOf(items[0].node)[field];
          if (before === e.value) throw new ToolError(`${nameOf(items[0])} ${field} is already "${e.value}"`);
          for (const it of items) { touch(it, e.op); changes.push(setField(doc, it, field, e.value)); }
          lines.push({ kind: "modify", text: before === undefined ? `${nameOf(items[0])}: add field ${field} = "${e.value}"` : `${nameOf(items[0])}: ${field} "${before}" → "${e.value}"`, ids: items.map((it) => it.id) });
          break;
        }
        case "move": {
          const it = one(target(doc, e), e); touch(it, e.op);
          const x = num(e.x, "x"), y = num(e.y, "y"); const rot = e.rotation === undefined ? undefined : num(e.rotation, "rotation");
          const side = e.side === undefined ? undefined : e.side === "back" || e.side === "front" ? e.side : (() => { throw new ToolError("side is front or back"); })();
          if (side && !(doc.type === "pcb" && it.kind === "footprint")) throw new ToolError("side applies to footprints on the board");
          changes.push(moveItem(doc, it, x, y, rot, side));
          lines.push({ kind: "modify", text: `Move ${nameOf(it)} to (${fmt(x)}, ${fmt(y)})${rot !== undefined ? `, rotated ${rot}°` : ""}${side ? `, ${side} side` : ""}`, ids: [it.id] });
          break;
        }
        case "remove": {
          const items = all(target(doc, e));
          for (const it of items) { touch(it, e.op); changes.push(removed(doc, it)); }
          lines.push({ kind: "remove", text: `Remove ${nameOf(items[0])}${items[0].value ? ` (${items[0].value})` : ""}`, ids: items.map((it) => it.id) });
          break;
        }
        case "add_symbol": {
          schOnly(e.op); const { change, ref } = addSymbol(doc, e, taken); changes.push(change);
          lines.push({ kind: "add", text: `Add ${ref}${e.value ? ` ${e.value}` : ""} (${e.lib_id}) at (${fmt(e.x)}, ${fmt(e.y)})`, ids: [change.id] });
          break;
        }
        case "add_wire": {
          schOnly(e.op); const pts = points(e); const ids: string[] = [];
          for (let j = 1; j < pts.length; j++) {
            if (pts[j][0] === pts[j - 1][0] && pts[j][1] === pts[j - 1][1]) continue;
            const c = added(doc, SCH()._.lineNode("wire", pts[j - 1], pts[j])); changes.push(c); ids.push(c.id);
          }
          if (!ids.length) throw new ToolError("the wire has no length");
          lines.push({ kind: "add", text: `Add wire ${pts.map((p) => `(${fmt(p[0])}, ${fmt(p[1])})`).join(" → ")}`, ids });
          break;
        }
        case "add_label": {
          schOnly(e.op); const kind = e.kind || "label";
          if (!["label", "global_label", "hierarchical_label"].includes(kind)) throw new ToolError("kind is label, global_label or hierarchical_label");
          const node = SCH()._.labelNode(kind, text(e.text, "text"), [num(e.x, "x"), num(e.y, "y")], e.rotation || 0);
          if (e.shape !== undefined && kind !== "label") {
            if (!["input", "output", "bidirectional", "tri_state", "passive"].includes(e.shape)) throw new ToolError("shape is input, output, bidirectional, tri_state or passive");
            const sh = node.find((c: any) => Array.isArray(c) && c[0] === "shape"); if (sh) sh[1] = e.shape;
          }
          const c = added(doc, node); changes.push(c);
          lines.push({ kind: "add", text: `Add ${kind.replace("_", " ")} "${e.text}" at (${fmt(e.x)}, ${fmt(e.y)})`, ids: [c.id] });
          break;
        }
        case "globalize_labels": {
          // plain labels on wire ends become global labels with a direction shape (a stub that goes elsewhere says so)
          schOnly(e.op); const res = globalizeLabels(doc, { added, removed }, { names: Array.isArray(e.names) ? e.names.map(String) : undefined, all: e.all === true });
          if (!res.converted.length) throw new ToolError("there is no plain label on a wire end or a pin to make global");
          changes.push(...res.changes);
          lines.push({ kind: "modify", text: `${res.converted.length} label${res.converted.length > 1 ? "s" : ""} made global with a direction shape: ${Array.from(new Set(res.converted)).slice(0, 12).join(", ")}`, ids: res.ids });
          details.push({ globalize_labels: { converted: res.converted.length, names: Array.from(new Set(res.converted)) } });
          break;
        }
        case "add_junction": case "add_no_connect": {
          schOnly(e.op); const p = [num(e.x, "x"), num(e.y, "y")];
          const c = added(doc, e.op === "add_junction" ? SCH()._.junctionNode(p) : SCH()._.noConnectNode(p)); changes.push(c);
          lines.push({ kind: "add", text: `Add ${e.op === "add_junction" ? "junction" : "no-connect flag"} at (${fmt(p[0])}, ${fmt(p[1])})`, ids: [c.id] });
          break;
        }
        case "add_text": {
          const t = text(e.text, "text"); const x = num(e.x, "x"), y = num(e.y, "y");
          const node = isSch ? SCH()._.labelNode("text", t, [x, y], 0) : PCB().textNode(t, x, y, typeof e.layer === "string" && e.layer ? e.layer : "Cmts.User");
          if (isSch && (e.size !== undefined || e.bold || e.italic)) {
            // a heading or a note: its own size and weight, the way the Text Properties dialog writes them
            const size = e.size === undefined ? 1.27 : num(e.size, "size"); if (size < 0.5 || size > 20) throw new ToolError("size is the text height in millimetres, 0.5 to 20");
            const font = k.kid(k.kid(node, "effects"), "font"); const sz = k.kid(font, "size"); sz[1] = r4(size); sz[2] = r4(size);
            if (e.bold) { font.push(["thickness", r4(size / 5)]); font.push(["bold", "yes"]); }
            if (e.italic) font.push(["italic", "yes"]);
          }
          const c = added(doc, node); changes.push(c);
          lines.push({ kind: "add", text: `Add text "${t.length > 40 ? t.slice(0, 40) + "…" : t}" at (${fmt(x)}, ${fmt(y)})`, ids: [c.id] });
          break;
        }
        case "add_track": {
          pcbOnly(e.op); const P = PCB(); const pts = points(e); const net = boardNet(doc, text(e.net, "net")); const layer = text(e.layer, "layer");
          if (!doc.copper.includes(layer)) throw new ToolError(`${layer} is not a copper layer of this board (${doc.copper.join(", ")})`);
          const s = P.designSettings(ed.proSettings || null); const width = e.width === undefined ? s.trackWidth : num(e.width, "width");
          if (!(width > 0)) throw new ToolError("width must be positive"); const ids: string[] = [];
          // no square corners (the person's rule): a bend of 90° or sharper is cut with a 45° piece, except on antenna and RF nets or when square: true
          const W = globalThis as any; const R = W.PcbAutoRouter;
          if (e.square !== true && pts.length > 2 && !(R && R.netKind && R.netKind(net.name) === "rf") && !/(^|[/_\-])(RF|ANT|ANTENNA|LNA)(\d|_|$|[/_\-])/i.test(net.name)) {
            for (let j = pts.length - 2; j >= 1; j--) {
              const v = pts[j], a = pts[j - 1], b = pts[j + 1]; const la = Math.hypot(a[0] - v[0], a[1] - v[1]), lb = Math.hypot(b[0] - v[0], b[1] - v[1]); if (la < 1e-6 || lb < 1e-6) continue;
              const cos = ((a[0] - v[0]) * (b[0] - v[0]) + (a[1] - v[1]) * (b[1] - v[1])) / (la * lb); if (cos < Math.cos(91 * Math.PI / 180)) continue;
              const d = Math.min(1.0, 3 * width, la / 2, lb / 2); const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
              pts.splice(j, 1, [r6(v[0] + (a[0] - v[0]) / la * d), r6(v[1] + (a[1] - v[1]) / la * d)], [r6(v[0] + (b[0] - v[0]) / lb * d), r6(v[1] + (b[1] - v[1]) / lb * d)]);
            }
          }
          for (let j = 1; j < pts.length; j++) { const c = added(doc, P.segmentNode(doc, pts[j - 1], pts[j], width, layer, net)); changes.push(c); ids.push(c.id); }
          lines.push({ kind: "add", text: `Add ${fmt(width)} mm track on ${layer}, net ${net.name}, ${pts.length - 1} segment${pts.length > 2 ? "s" : ""}`, ids });
          break;
        }
        case "add_via": {
          pcbOnly(e.op); const P = PCB(); const net = boardNet(doc, text(e.net, "net")); const s = P.designSettings(ed.proSettings || null);
          const size = e.size === undefined ? s.viaDiameter : num(e.size, "size"), drill = e.drill === undefined ? s.viaDrill : num(e.drill, "drill");
          if (!(drill > 0 && size > drill)) throw new ToolError("a via's size must be larger than its drill");
          const c = added(doc, P.viaNode(doc, num(e.x, "x"), num(e.y, "y"), size, drill, net)); changes.push(c);
          lines.push({ kind: "add", text: `Add via ${fmt(size)}/${fmt(drill)} mm on net ${net.name} at (${fmt(e.x)}, ${fmt(e.y)})`, ids: [c.id] });
          break;
        }
        case "auto_place": {
          pcbOnly(e.op); const P = PCB(); const R = (window as any).PcbAutoRouter;
          if (!R || !R.place || !R.placementChanges) throw new ToolError("the placement engine is not loaded in this editor");
          const specs = (Array.isArray(e.parts) ? e.parts : []).map((q: any) => { if (!q || typeof q.ref !== "string") throw new ToolError("each entry of parts needs a ref");
            if (!findByRef(doc, q.ref).length) throw new ToolError(`there is no ${q.ref} on the board`);
            return { ref: q.ref, group: q.group, near: q.near, anchor: q.anchor === true ? true : undefined, side: q.side, edge: q.edge, rot: typeof q.rotation === "number" ? q.rotation : undefined,
              fixed: q.fixed && typeof q.fixed.x === "number" && typeof q.fixed.y === "number" ? { x: q.fixed.x, y: q.fixed.y, rot: q.fixed.rotation || 0 } : undefined }; });
          const outline = Array.isArray(e.outline) && e.outline.length === 4 && e.outline.every((v: any) => typeof v === "number") ? e.outline : undefined;
          const res = R.place(k, P, doc, P.designSettings(ed.proSettings || null), { footprints: specs.length ? specs : undefined, outline, spacing: typeof e.spacing === "number" ? e.spacing : undefined, fit: e.fit === true, maxFill: typeof e.max_fill === "number" ? e.max_fill : undefined });
          const cs: any[] = R.placementChanges(k, P, doc, res.placements); if (!cs.length) throw new ToolError("the placement engine moved nothing");
          for (const c of cs) { const it = doc.items.get(c.id); if (it) touch(it, e.op); changes.push(c); }
          if (e.fit === true) {
            // the board pulled in round its parts: the rectangle on Edge.Cuts takes the size the placement settled on
            const edges = (Array.from(doc.items.values()) as any[]).filter((it) => { const l = k.kid(it.node, "layer"); return l && k.str(l[1]) === "Edge.Cuts"; });
            const O = res.outline as number[]; const rect = edges.length && edges.every((it) => it.node[0] === "gr_rect") ? edges[0] : null;
            if (rect && !touched.has(rect.id)) {
              const node = k.cloneNode(rect.node); const a = k.kid(node, "start"), b = k.kid(node, "end"); a[1] = r4(O[0]); a[2] = r4(O[1]); b[1] = r4(O[2]); b[2] = r4(O[3]);
              touch(rect, e.op); changes.push(modified(doc, rect, node)); cs.push({ id: rect.id });
              for (const extra of edges.slice(1)) if (!touched.has(extra.id)) { touch(extra, e.op); changes.push(removed(doc, extra)); }     // a second rectangle drawn over the first
            } else if (!edges.length) {
              const c = added(doc, k.parse(`(gr_rect (start ${r4(O[0])} ${r4(O[1])}) (end ${r4(O[2])} ${r4(O[3])}) (stroke (width 0.05) (type solid)) (fill no) (layer "Edge.Cuts"))`)); changes.push(c); cs.push(c);
            }
          }
          const byGroup = new Map<string, string[]>(); for (const pl of res.placements) { const g = pl.group || "ungrouped"; if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g)!.push(pl.ref); }
          lines.push({ kind: "modify", text: `Place ${res.placements.length} footprint${res.placements.length === 1 ? "" : "s"} in ${byGroup.size} group${byGroup.size === 1 ? "" : "s"} inside (${res.outline.map(fmt).join(", ")})`, ids: cs.map((c) => c.id) });
          details.push({ auto_place: { outline: res.outline.map(r4), outline_from_board: res.outlineFromBoard, score: res.score, groups: res.groups, unknown_refs: res.unknown,
            placements: res.placements.map((pl: any) => ({ ref: pl.ref, x: r4(pl.x), y: r4(pl.y), rotation: pl.rot, side: pl.side })),
            note: "overlaps, courtyardClashes and outside should be 0; ratsnest is the total length of the connections still to route, lower is better. Adjust groups, anchors, edges or the outline and propose again if the score or the picture is poor." } });
          break;
        }
        case "update_from_schematic": {
          pcbOnly(e.op); const plan = e.__sync as SyncPlan | undefined; if (!plan) throw new ToolError("the schematic could not be read");
          if (plan.problems.length && !plan.adds.length && !plan.updates.length) throw new ToolError(plan.problems.join("; "));
          for (const a of plan.adds) { const c = added(doc, a.node); c.padNets = a.padNets; changes.push(c); lines.push({ kind: "add", text: `Add ${a.ref} ${a.value} (${a.fpid}) at (${fmt(a.x)}, ${fmt(a.y)})`, ids: [c.id] }); }
          for (const u of plan.updates) { touch(u.item, e.op); const c = modified(doc, u.item, u.node); c.padNets = u.padNets; changes.push(c); lines.push({ kind: "modify", text: `Update ${u.item.ref}: ${u.what}`, ids: [u.item.id] }); }
          for (const c of plan.copper) { touch(c.item, e.op); changes.push(modified(doc, c.item, c.node)); }
          const names = Object.entries(plan.renamed); if (names.length) lines.push({ kind: "modify", text: `Rename ${names.length} net${names.length === 1 ? "" : "s"} on tracks, vias and zones: ${names.slice(0, 4).map(([a, b]) => `${a} → ${b}`).join(", ")}${names.length > 4 ? ` and ${names.length - 4} more` : ""}`, ids: plan.copper.map((c) => c.item.id) });
          if (!plan.adds.length && !plan.updates.length) throw new ToolError("the board already matches the schematic: every part is on it with the right nets" + (plan.extra.length ? `; on the board but not in the schematic: ${plan.extra.join(", ")}` : ""));
          details.push({ update_from_schematic: { added: plan.adds.map((a) => a.ref), updated: plan.updates.map((u) => u.item.ref), nets: plan.nets, not_in_schematic: plan.extra, problems: plan.problems, nets_renamed: names.length ? plan.renamed : undefined, copper_renamed: plan.copper.length || undefined,
            note: !plan.adds.length ? undefined : plan.adds.every((a) => e.placements && typeof e.placements === "object" && e.placements[a.ref]) ? "New footprints are at the positions given in placements."
              : "New footprints without a position in placements are parked in rows beside the board; place them next (move edits, or give placements with this edit)." } });
          break;
        }
        case "autoroute": {
          pcbOnly(e.op); const P = PCB(); const R = (window as any).PcbAutoRouter;
          if (!R || !R.route) throw new ToolError("the autorouter is not loaded in this editor");
          if (e.nets !== undefined && (!Array.isArray(e.nets) || !e.nets.length)) throw new ToolError("nets must be a non-empty list of net names, or left out for every unrouted net");
          const nets: string[] | null = e.nets ? e.nets.map((n: unknown) => boardNet(doc, text(n, "net")).name) : null;
          const netOpts: Record<string, any> = {};
          for (const [name, o] of Object.entries((e.net_options && typeof e.net_options === "object" ? e.net_options : {}) as Record<string, any>)) {
            const net = boardNet(doc, name).name; if (!o || typeof o !== "object") continue;
            netOpts[net] = { layers: Array.isArray(o.layers) && o.layers.length ? o.layers : undefined, width: typeof o.width === "number" ? o.width : undefined, allowVias: typeof o.allow_vias === "boolean" ? o.allow_vias : undefined,
              maxVias: typeof o.max_vias === "number" ? o.max_vias : undefined, avoid: Array.isArray(o.avoid) ? o.avoid : undefined,
              // named: what the schematic's author called a net that carries no label (it is wired inside its block), so its name still says what it carries
              kind: ["analog", "rf", "switching", "fast", "digital", "supply"].includes(o.kind) ? o.kind : typeof o.named === "string" && o.named && R.netKind ? R.netKind(o.named) : undefined, impedance: typeof o.impedance === "number" && o.impedance > 0 ? o.impedance : undefined };
            if (o.kind !== undefined && !netOpts[net].kind) throw new ToolError(`net_options.${name}.kind must be one of analog, rf, switching, fast, digital, supply`);
          }
          const order = Array.isArray(e.order) ? e.order.map((n: unknown) => boardNet(doc, text(n, "net")).name) : undefined;
          const keepouts = Array.isArray(e.keepouts) ? e.keepouts.filter((q: any) => q && Array.isArray(q.box) && q.box.length === 4).map((q: any) => ({ layers: Array.isArray(q.layers) ? q.layers : undefined, box: q.box })) : undefined;
          const num = (v: unknown) => typeof v === "number" && v >= 0 ? v : undefined;
          const separate = e.separate === false ? false : e.separate && typeof e.separate === "object" ? { quiet: num(e.separate.quiet), noisy: num(e.separate.noisy) } : undefined;
          const fence = e.fence === false ? false : e.fence && typeof e.fence === "object" ? { spacing: num(e.fence.spacing), nets: Array.isArray(e.fence.nets) ? e.fence.nets.map((n: unknown) => boardNet(doc, text(n, "net")).name) : undefined, returnVias: e.fence.return_vias === false ? false : undefined } : undefined;
          const res = R.route(k, P, doc, P.designSettings(ed.proSettings || null), { separate, fence, nets, layers: Array.isArray(e.layers) && e.layers.length ? e.layers : null, allowVias: e.allow_vias !== false, zones: e.zones === false ? false : undefined, timeMs: Math.round(1000 * Math.min(300, Math.max(5, typeof e.time_s === "number" ? e.time_s : 20))), order, netOpts, keepouts, maxViasPerConnection: typeof e.max_vias === "number" && e.max_vias >= 0 ? Math.floor(e.max_vias) : undefined, fanoutLanes: e.fanout_lanes === false ? false : typeof e.fanout_lanes === "number" ? e.fanout_lanes : undefined });
          const failed = (res.failed || []).map((f: any) => ({ net: f.net, from: f.a.map(r4), to: f.b.map(r4) }));
          if (!res.total) throw new ToolError(`nothing to route: every connection ${nets ? "of " + nets.join(", ") : "on the board"} is already made`);
          if (!res.items.length) throw new ToolError(`the autorouter could not make any of the ${res.total} missing connection${res.total === 1 ? "" : "s"} within the design rules: ${JSON.stringify(failed.slice(0, 12))}`);
          const ids: string[] = [];
          for (const it of res.items) { const c = added(doc, it.node); if (!c.netName && it.netName) c.netName = it.netName; changes.push(c); ids.push(c.id); }   // not P.addedChange: that one inserts into the live board
          const conns: any[] = Array.isArray(res.connections) ? res.connections : [];
          details.push({ autoroute: { connections: res.total, routed: res.routed, segments: res.segments, vias: res.vias, length_mm: r4(res.length),
            unrouted: conns.length ? conns.filter((c) => !c.routed).slice(0, 40).map((c) => ({ net: c.net, from: c.from && c.from.pad, to: c.to && c.to.pad, reason: c.reason, detail: c.detail, blocked_by_nets: c.blockedBy && c.blockedBy.nets })) : failed.slice(0, 40),
            longest_detours: conns.filter((c) => c.routed && c.detourRatio > 1.6).sort((a, b) => b.detourRatio - a.detourRatio).slice(0, 12).map((c) => ({ net: c.net, from: c.from && c.from.pad, to: c.to && c.to.pad, length_mm: r4(c.length), detour_ratio: r4(c.detourRatio), vias: c.vias, layers: c.layers })),
            domains: res.domains ? { kept_apart: res.domains.kinds, quiet_mm: res.domains.quiet, noisy_mm: res.domains.noisy, relaxed: res.domains.relaxed } : undefined,
            ground_vias: Array.isArray(res.fences) && res.fences.length ? res.fences.map((f: any) => ({ net: f.net, ground: f.ground, fence: f.fence, return_vias: f.returns, spacing_mm: f.spacing, note: f.note })) : undefined,
            note: "Judge this before the person does: a net left unrouted, a power net with a long detour or many vias, or a sensitive net crossing the board is a reason to change the placement or the net order and options and propose again instead." } });
          lines.push({ kind: "add", text: `Autoroute ${nets ? nets.join(", ") : "all unrouted nets"}: ${res.routed} of ${res.total} connection${res.total === 1 ? "" : "s"}, ${res.segments} track segment${res.segments === 1 ? "" : "s"}, ${res.vias} via${res.vias === 1 ? "" : "s"}, ${Math.round(res.length * 10) / 10} mm${failed.length ? ` (${failed.length} left unrouted)` : ""}`, ids });
          break;
        }
        case "fill_zones": {
          pcbOnly(e.op); const F = (globalThis as any).KiCadFab; const P = PCB(); const res: any[] = e.__fill || [];
          const copper = doc.copper && doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]; const ids: string[] = []; let outlines = 0, islands = 0;
          const scratch = Object.assign({}, doc, { items: new Map(doc.items) });
          for (const r of res) {
            const it = doc.items.get(r.id); if (!it) continue;
            for (const l of r.layers) { outlines += l.outlines.length; islands += l.islands ? l.islands.size : 0; }
            const node = F.filledZoneNode(it.node, r, copper, (n: any) => k.cloneNode(n));
            scratch.items.set(it.id, Object.assign({}, it, { node }));
            if (k.serialize(node) === k.serialize(it.node)) continue;
            touch(it, e.op); changes.push(modified(doc, it, node)); ids.push(it.id);
          }
          // what the fills leave open, counted on the board as it will be: the connections a pour was expected to make
          const open: Record<string, number> = {}; let left = 0;
          try { for (const l of P.ratsnest(scratch)) { open[l.name] = (open[l.name] || 0) + 1; left++; } } catch { /* the count is a courtesy */ }
          details.push({ fill_zones: { zones: res.length, refilled: ids.length, outlines, islands, unconnected: left, unconnected_by_net: left ? open : undefined } });
          if (!ids.length) throw new ToolError("the zones are already filled for the board as it stands");
          lines.push({ kind: "modify", text: `Fill ${res.length} zone${res.length === 1 ? "" : "s"}: ${outlines} filled area${outlines === 1 ? "" : "s"}${islands ? `, ${islands} isolated` : ""}${left ? `, ${left} connection${left === 1 ? "" : "s"} still open` : ""}`, ids });
          break;
        }
        case "set_rules": {
          const out: Record<string, number | string> = {}; const said: string[] = [];
          for (const [key, label] of RULE_KEYS) { const v = (e as any)[key]; if (v === undefined) continue; const n = num(v, key); if (n < 0 || n > 10) throw new ToolError(`${key} is in millimetres, between 0 and 10`); out[key] = n; said.push(`${label} ${fmt(n)} mm`); }
          if (!said.length) throw new ToolError("set_rules needs at least one of: " + RULE_KEYS.map((r) => r[0]).join(", "));
          const cls = typeof e.net_class === "string" && e.net_class ? e.net_class : "Default"; out.net_class = cls;
          rules = Object.assign(rules || {}, out);
          lines.push({ kind: "modify", text: `Board rules (net class ${cls}): ${said.join(", ")}`, ids: [] });
          break;
        }
        case "add_item": {
          const trees = k.parseAll(text(e.sexpr, "sexpr"));
          if (trees.length !== 1 || !Array.isArray(trees[0])) throw new ToolError("sexpr must be exactly one item");
          const node = trees[0]; const kind = String(node[0]);
          const scratch = Object.assign({}, doc, { items: new Map() });
          if (!k.uuidOf(node)) node.push(["uuid", k.newUuid()]);
          if (doc.items.has(k.uuidOf(node))) throw new ToolError("that uuid is already in the document; leave the uuid out and one is assigned");
          let probe: any = null; try { probe = k.addItem(scratch, k.cloneNode(node)); } catch { /* reported below */ }
          if (!probe) throw new ToolError(`"${kind}" is not an item kind a ${isSch ? "schematic sheet" : "board"} holds, or the item is malformed`);
          const c = added(doc, node); changes.push(c);
          lines.push({ kind: "add", text: `Add ${kind.replace(/_/g, " ")}`, ids: [c.id] });
          break;
        }
        case "add_rectangle": {
          schOnly(e.op); const x0 = num(e.x0, "x0"), y0 = num(e.y0, "y0"), x1 = num(e.x1, "x1"), y1 = num(e.y1, "y1");
          if (Math.abs(x1 - x0) < 1 || Math.abs(y1 - y0) < 1) throw new ToolError("a rectangle needs two opposite corners at least a millimetre apart");
          const style = e.style === undefined ? "dash" : String(e.style);
          if (!["default", "solid", "dash", "dot", "dash_dot", "dash_dot_dot"].includes(style)) throw new ToolError("style is solid, dash, dot, dash_dot or dash_dot_dot");
          const node = SCH()._.rectangleNode([x0, y0], [x1, y1]); const st = k.kid(node, "stroke");
          if (st) { const ty = k.kid(st, "type"); if (ty) ty[1] = style; if (e.width !== undefined) { const wd = k.kid(st, "width"); if (wd) wd[1] = r4(num(e.width, "width")); } }
          const c = added(doc, node); changes.push(c);
          lines.push({ kind: "add", text: `Add frame (${fmt(Math.min(x0, x1))}, ${fmt(Math.min(y0, y1))}) to (${fmt(Math.max(x0, x1))}, ${fmt(Math.max(y0, y1))})`, ids: [c.id] });
          break;
        }
        case "autoplace_fields": {
          // KiCad's Autoplace Fields (O): reference and value beside the body, on the side with the fewest pins and nothing in the way
          schOnly(e.op); const s = SCH(); const want = Array.isArray(e.refs) && e.refs.length ? new Set(e.refs.map((r: unknown) => String(r).toLowerCase())) : null;
          const within = Array.isArray(e.within) && e.within.length === 4 ? e.within.map((v: unknown) => num(v, "within")) : null;
          const ids: string[] = [];
          for (const it of Array.from(doc.items.values()) as any[]) {
            if (it.kind !== "symbol" || touched.has(it.id)) continue;
            if (want && !want.has(String(it.ref || "").toLowerCase())) continue;
            if (!want && !e.power && /^#/.test(it.ref || "")) continue;
            if (within && !(it.x >= within[0] && it.x <= within[2] && it.y >= within[1] && it.y <= within[3])) continue;
            let node: any = null; try { node = s._.autoplaceNode(doc, it, { manual: true }); } catch { node = null; }
            if (!node || k.serialize(node) === k.serialize(it.node)) continue;
            touch(it, e.op); changes.push(modified(doc, it, node)); ids.push(it.id);
          }
          if (want && !ids.length && e.refs.some((r: unknown) => !findByRef(doc, String(r)).length)) throw new ToolError(`no component ${e.refs.find((r: unknown) => !findByRef(doc, String(r)).length)} on the open document`);
          lines.push({ kind: "modify", text: `Autoplace the fields of ${ids.length} symbol${ids.length === 1 ? "" : "s"}`, ids });
          break;
        }
        case "clear_fields": {
          // the look a person takes after Autoplace Fields: a reference or value still drawn over a label, a wire or a part moves to the nearest clear spot
          schOnly(e.op); const within = Array.isArray(e.within) && e.within.length === 4 ? e.within.map((v: unknown) => num(v, "within")) : undefined;
          const by = new Map<string, { field: string; dx: number; dy: number }[]>();
          for (const f of e.snug ? snugFieldShifts(doc, { refs: Array.isArray(e.refs) ? e.refs.map(String) : undefined, within }) : e.inline ? inlineFieldShifts(doc, Array.isArray(e.refs) ? e.refs.map(String) : []) : fieldShifts(doc, { refs: Array.isArray(e.refs) ? e.refs.map(String) : undefined, within, power: e.power === true })) { if (!by.has(f.id)) by.set(f.id, []); by.get(f.id)!.push(f); }
          const ids: string[] = [];
          for (const [id, moves] of by) {
            const it = doc.items.get(id); if (!it || touched.has(it.id)) continue; const node = k.cloneNode(it.node); let any = false;
            for (const m of moves) { const p = k.kids(node, "property").find((q: any) => k.str(q[1]) === m.field); const at = p && k.kid(p, "at"); if (!at) continue; at[1] = r4(k.num(at[1]) + m.dx); at[2] = r4(k.num(at[2]) + m.dy); any = true; }
            if (!any) continue; touch(it, e.op); changes.push(modified(doc, it, node)); ids.push(it.id);
          }
          lines.push({ kind: "modify", text: `Move the fields of ${ids.length} symbol${ids.length === 1 ? "" : "s"} clear of what they were drawn over`, ids });
          break;
        }
        case "cleanup": {
          // KiCad's Cleanup Tracks & Vias: collinear and doubled segments become one, a via on top of another goes, a track wholly inside a pad goes
          pcbOnly(e.op); const P = PCB(); if (!P.cleanupPlan) throw new ToolError("the track clean-up is not loaded in this editor");
          const plan = P.cleanupPlan(doc, { shorts: e.shorts === true, vias: e.vias !== false, merge: e.merge !== false, dangling: e.dangling === true, danglingVias: e.dangling === true, inPads: e.in_pads === true });
          const ids: string[] = []; const by: Record<string, number> = {};
          for (const { item, node } of plan.replace) { if (touched.has(item.id) || plan.remove.has(item.id)) continue; touch(item, e.op); changes.push(modified(doc, item, node)); ids.push(item.id); }
          let gone = 0; for (const id of plan.remove) { const it = doc.items.get(id); if (!it || touched.has(id)) continue; touch(it, e.op); changes.push(removed(doc, it)); ids.push(id); gone++; }
          for (const it of plan.items) by[it.code] = (by[it.code] || 0) + 1;
          if (!ids.length) throw new ToolError("the tracks and vias are clean already: nothing to merge or remove");
          lines.push({ kind: "modify", text: `Clean up tracks and vias: ${gone} removed, ${plan.replace.length} merged or shortened`, ids });
          details.push({ cleanup: { removed: gone, changed: plan.replace.length, by_kind: by } });
          break;
        }
        case "silkscreen": {
          // the last pass of a layout: every reference readable beside its part and on nothing, net names beside connector pins
          pcbOnly(e.op);
          const plan = planSilk(doc, { size: typeof e.size === "number" ? e.size : undefined, minSize: typeof e.min_size === "number" ? e.min_size : undefined,
            refs: Array.isArray(e.refs) ? e.refs.map(String) : undefined, unhide: e.unhide === true, keepRefs: e.references === false,
            pinLabels: e.pin_labels === true ? true : Array.isArray(e.pin_labels) ? e.pin_labels.map(String) : false,
            mark: Array.isArray(e.mark) && e.mark.every((l: unknown) => Array.isArray(l)) ? { shapes: e.mark.map((l: unknown[]) => l.map(String)), size: typeof e.mark_size === "number" ? e.mark_size : undefined, layer: typeof e.layer === "string" ? e.layer : undefined } : undefined });
          const ids: string[] = [];
          for (const [id, node] of plan.nodes) { const it = doc.items.get(id); if (!it || touched.has(id)) continue; touch(it, e.op); changes.push(modified(doc, it, node)); ids.push(id); }
          for (const node of plan.adds) { const c = added(doc, node); changes.push(c); ids.push(c.id); }
          const rp = plan.report; const nl = Object.values(rp.pin_labels).reduce((n, l) => n + l.length, 0);
          lines.push({ kind: "modify", text: `Silkscreen: ${rp.references} reference${rp.references === 1 ? "" : "s"} placed clear of pads, other silkscreen, other parts and the edge (${Object.keys(rp.resized).length} made smaller, ${rp.turned.length} turned, ${rp.hidden.length} hidden)${nl ? `, ${nl} pin name${nl === 1 ? "" : "s"} printed` : ""}`, ids });
          details.push({ silkscreen: rp });
          break;
        }
        case "move_region": {
          // everything wholly inside a box moves together, so a finished block keeps its wiring
          schOnly(e.op); const s = SCH(); const box = [num(e.x0, "x0"), num(e.y0, "y0"), num(e.x1, "x1"), num(e.y1, "y1")]; const dx = num(e.dx, "dx"), dy = num(e.dy, "dy");
          if (box[2] <= box[0] || box[3] <= box[1]) throw new ToolError("the box is given as x0, y0 (top left) and x1, y1 (bottom right)");
          const ids = itemsWithin(doc, box);
          if (!ids.length) throw new ToolError("nothing lies wholly inside that box");
          for (const id of ids) { const it = doc.items.get(id); if (!it || touched.has(id)) continue; touch(it, e.op); const node = k.cloneNode(it.node); s._.shiftNode(it.kind, node, r4(dx), r4(dy)); changes.push(modified(doc, it, node)); }
          lines.push({ kind: "modify", text: `Move ${ids.length} item${ids.length === 1 ? "" : "s"} by (${fmt(dx)}, ${fmt(dy)})`, ids });
          break;
        }
        case "pad_connection": {
          // Pad Properties, Connections: how this pad joins a zone of its net.  Solid is the usual cure for a thermal relief with too few spokes.
          pcbOnly(e.op); const it = one(target(doc, e), e); if (it.kind !== "footprint") throw new ToolError("pad_connection applies to a footprint's pads");
          const code = ({ inherit: null, none: 0, thermal: 1, solid: 2 } as Record<string, number | null>)[String(e.connect)]; if (code === undefined) throw new ToolError("connect is solid, thermal, none or inherit");
          const want = (Array.isArray(e.pads) ? e.pads : [e.pad]).filter((v: unknown) => v !== undefined).map(String); if (!want.length) throw new ToolError("give pad (or pads): the pad numbers");
          const node = k.cloneNode(it.node); const hit: string[] = [];
          for (const pad of k.kids(node, "pad")) {
            if (!want.includes(k.str(pad[1]))) continue; hit.push(k.str(pad[1]));
            const at = pad.findIndex((q: any) => Array.isArray(q) && q[0] === "zone_connect"); if (at >= 0) pad.splice(at, 1);
            if (code !== null) { const before = pad.findIndex((q: any) => Array.isArray(q) && ["thermal_bridge_width", "thermal_bridge_angle", "thermal_gap", "options", "primitives", "tenting", "uuid", "tstamp", "teardrops"].includes(q[0])); pad.splice(before >= 0 ? before : pad.length, 0, ["zone_connect", code]); }
          }
          const missing = want.find((w: string) => !hit.includes(w)); if (missing) throw new ToolError(`${nameOf(it)} has no pad ${missing}`);
          if (k.serialize(node) === k.serialize(it.node)) throw new ToolError(`${nameOf(it)} pad ${want.join(", ")} already connects that way`);
          touch(it, e.op); changes.push(modified(doc, it, node));
          lines.push({ kind: "modify", text: `${nameOf(it)} pad ${want.join(", ")}: zone connection ${e.connect}`, ids: [it.id] });
          break;
        }
        case "set_layers": {
          // the copper layer count (Board Setup, Board Editor Layers): inner layers appear as signal layers, or go away when nothing is on them
          pcbOnly(e.op); const BS = k.boardSetup; if (!BS || !BS.setCopperCount) throw new ToolError("the board setup tools are not loaded in this editor");
          const count = num(e.count, "count"); if (count < 2 || count > 32 || count % 2) throw new ToolError("count is the number of copper layers: 2, 4, 6, ... 32");
          const node: any[] = ["layers"]; for (const [name, l] of doc.layers as Map<string, any>) node.push(l.userName ? [l.id, name, l.type, l.userName] : [l.id, name, l.type]);
          const before = BS.layerRows(node); const now = doc.copper.length || before.filter((r: any) => r.copper).length;
          if (count === now) throw new ToolError(`the board already has ${count} copper layers`);
          const rows = BS.setCopperCount(before, count); const keep = new Set(rows.filter((r: any) => r.copper).map((r: any) => r.name));
          const planes = Array.isArray(e.planes) ? new Set(e.planes.map(String)) : new Set<string>();
          for (const r of rows) if (r.copper && planes.has(r.name)) r.type = "power";
          const gone = (doc.copper as string[]).filter((l) => !keep.has(l));
          if (gone.length) for (const it of doc.items.values() as Iterable<any>) { const ly = it.layer || (it.node && k.kid(it.node, "layer") ? k.str(k.kid(it.node, "layer")[1]) : ""); if (gone.includes(ly)) throw new ToolError(`${ly} still has copper on it (${nameOf(it)}); remove it before taking the layer away`); }
          const c = BS.boardSetupChange({ layers: BS.layersText(rows) }); c.was = { layers: BS.layersText(before) };
          changes.push(c);
          lines.push({ kind: "modify", text: `Copper layers ${now} → ${count} (${rows.filter((r: any) => r.copper).map((r: any) => r.name).join(", ")})`, ids: [] });
          break;
        }
        case "set_stackup": {
          // Board Setup, Physical Stackup: the copper and dielectric layers top to bottom with their thickness and material, the
          // solder mask (a flex board's coverlay), the copper finish, and the board thickness that follows from them
          pcbOnly(e.op); const BS = k.boardSetup; if (!BS || !BS.boardSetupChange) throw new ToolError("the board setup tools are not loaded in this editor");
          const rows: any[] = Array.isArray(e.layers) ? e.layers : []; if (!rows.length) throw new ToolError("layers is the stack top to bottom: {name, type: copper, thickness} and {type: core or prepreg, thickness, material, epsilon_r, loss_tangent} between them");
          const cu = rows.filter((r) => r && r.type === "copper").map((r) => String(r.name)); const have = (doc.copper as string[]).slice();
          if (cu.join(",") !== have.join(",")) throw new ToolError(`the stackup's copper layers (${cu.join(", ") || "none"}) must be the board's, top to bottom (${have.join(", ")}); set_layers changes the layer count`);
          const q = (s: any) => JSON.stringify(String(s)); const out: string[] = []; let total = 0, nd = 0, prev = "";
          const mask = e.mask === false ? null : Object.assign({ thickness: 0.01 }, e.mask && typeof e.mask === "object" ? e.mask : {});
          const maskRow = (side: string, name: string) => { const t = num(mask.thickness, "mask thickness"); if (t < 0 || t > 0.5) throw new ToolError("the solder mask or coverlay is 0 to 0.5 mm thick"); total += t;
            return `(layer ${q(name)} (type ${q(side + " Solder Mask")})${mask.color ? ` (color ${q(mask.color)})` : ""} (thickness ${fmt(t)})${mask.material ? ` (material ${q(mask.material)})` : ""}${mask.epsilon_r ? ` (epsilon_r ${fmt(num(mask.epsilon_r, "mask epsilon_r"))})` : ""}${mask.loss_tangent ? ` (loss_tangent ${fmt(num(mask.loss_tangent, "mask loss_tangent"))})` : ""})`; };
          out.push('(layer "F.SilkS" (type "Top Silk Screen"))', '(layer "F.Paste" (type "Top Solder Paste"))'); if (mask) out.push(maskRow("Top", "F.Mask"));
          for (const r of rows) {
            if (!r || typeof r !== "object") throw new ToolError("each stackup layer is an object");
            const t = num(r.thickness, "thickness"); if (!(t > 0 && t <= 10)) throw new ToolError("a layer's thickness is in millimetres, above 0 and at most 10");
            if (r.type === "copper") { if (prev === "copper") throw new ToolError(`there is no dielectric between two copper layers above ${r.name}`); out.push(`(layer ${q(r.name)} (type "copper") (thickness ${fmt(t)}))`); }
            else if (r.type === "core" || r.type === "prepreg") {
              if (!prev) throw new ToolError("the stack starts with the top copper layer");
              const er = r.epsilon_r === undefined ? 4.5 : num(r.epsilon_r, "epsilon_r"); if (!(er >= 1 && er <= 20)) throw new ToolError("epsilon_r is the dielectric constant, 1 to 20");
              const lt = r.loss_tangent === undefined ? 0.02 : num(r.loss_tangent, "loss_tangent");
              const body = `(type ${q(r.type)}) (thickness ${fmt(t)}) (material ${q(r.material || "FR4")}) (epsilon_r ${fmt(er)}) (loss_tangent ${fmt(lt)})`;
              if (prev === "copper") out.push(`(layer "dielectric ${++nd}" ${body})`); else out[out.length - 1] = out[out.length - 1].replace(/\)$/, ` addsublayer ${body})`);   // two sheets between the same copper: KiCad's sub-layers
            } else throw new ToolError(`a stackup layer's type is copper, core or prepreg, not "${r.type}"`);
            total += t; prev = r.type === "copper" ? "copper" : "dielectric";
          }
          if (prev !== "copper") throw new ToolError("the stack ends with the bottom copper layer");
          if (mask) out.push(maskRow("Bottom", "B.Mask")); out.push('(layer "B.Paste" (type "Bottom Solder Paste"))', '(layer "B.SilkS" (type "Bottom Silk Screen"))');
          const oldSetup = (doc.boardSetup && doc.boardSetup.setup) || doc.setupNode || null; const oldGen = (doc.boardSetup && doc.boardSetup.general) || doc.generalNode || null; const oldSt = oldSetup ? k.kid(oldSetup, "stackup") : null;
          const finish = e.finish === undefined ? (oldSt && k.kid(oldSt, "copper_finish") ? k.str(k.kid(oldSt, "copper_finish")[1]) : "None") : String(e.finish);
          if (BS.COPPER_FINISHES && !BS.COPPER_FINISHES.includes(finish)) throw new ToolError(`finish is one of: ${BS.COPPER_FINISHES.join(", ")}`);
          out.push(`(copper_finish ${q(finish)})`, `(dielectric_constraints ${e.controlled ? "yes" : "no"})`);
          for (const key of ["edge_connector", "edge_plating"]) { const n = oldSt ? k.kid(oldSt, key) : null; if (n) out.push(`(${key} ${k.str(n[1])})`); }
          const st = k.parse(`(stackup ${out.join(" ")})`);
          const setup: any[] = oldSetup ? k.parse(BS.sectionText(oldSetup)) : k.parse("(setup (pad_to_mask_clearance 0) (allow_soldermask_bridges_in_footprints no))");
          const at = setup.findIndex((n: any) => Array.isArray(n) && n[0] === "stackup"); if (at > 0) setup[at] = st; else setup.splice(1, 0, st);
          const thick = e.thickness === undefined ? +total.toFixed(4) : num(e.thickness, "thickness"); if (!(thick > 0 && thick <= 20)) throw new ToolError("thickness is the finished board thickness in millimetres");
          const general: any[] = oldGen ? k.parse(BS.sectionText(oldGen)) : k.parse("(general (thickness 1.6) (legacy_teardrops no))");
          const gt = general.findIndex((n: any) => Array.isArray(n) && n[0] === "thickness"); if (gt > 0) general[gt] = ["thickness", thick]; else general.splice(1, 0, ["thickness", thick]);
          const c = BS.boardSetupChange({ setup: BS.sectionText(setup), general: BS.sectionText(general) });
          c.was = { setup: oldSetup ? BS.sectionText(oldSetup) : "", general: oldGen ? BS.sectionText(oldGen) : "" };
          changes.push(c);
          lines.push({ kind: "modify", text: `Physical stackup: ${cu.length} copper layers, ${nd} dielectric${nd === 1 ? "" : "s"}, ${fmt(thick)} mm thick${finish !== "None" ? ", " + finish : ""}${e.title ? ` (${String(e.title).slice(0, 80)})` : ""}`, ids: [] });
          break;
        }
        case "set_page": {
          // File, Page Settings: the paper and the title block's own lines (title, revision, date, company)
          schOnly(e.op); const paper = e.paper === undefined ? String(doc.paper || "A4") : text(e.paper, "paper");
          const lines4 = ["title", "rev", "date", "company"].filter((key) => e[key] !== undefined);
          if (e.paper === undefined && !lines4.length) throw new ToolError("give paper, or title, rev, date or company for the title block");
          if (e.paper !== undefined && !["A5", "A4", "A3", "A2", "A1", "A0", "A", "B", "C", "D", "E", "USLetter", "USLegal", "USLedger", "User"].includes(paper)) throw new ToolError("paper is A5, A4, A3, A2, A1, A0, A, B, C, D, E, USLetter, USLegal, USLedger, or User with width and height in millimetres");
          // a page of the person's own size (Page Settings, "User (Custom)"): KiCad takes 25.4 mm to 1.2 m a side
          const custom = e.paper !== undefined && paper === "User"; const cw = custom ? num(e.width, "width") : 0, ch = custom ? num(e.height, "height") : 0;
          if (custom && !(cw >= 25.4 && cw <= 1200 && ch >= 25.4 && ch <= 1200)) throw new ToolError("a User page is 25.4 to 1200 mm wide and high");
          if (e.paper !== undefined && !lines4.length && doc.paper === paper && !doc.portrait && (!custom || (Math.abs(doc.page[0] - cw) < 0.01 && Math.abs(doc.page[1] - ch) < 0.01))) throw new ToolError(`the page is already ${paper}`);
          const old = doc.titleBlock || {}; const tb: Record<string, any> = { ...old }; for (const key of lines4) tb[key] = String(e[key]);
          const block = (t: Record<string, any>) => { const out: string[] = []; for (const key of ["title", "date", "rev", "company"]) if (t[key]) out.push(`(${key} ${JSON.stringify(String(t[key]))})`); for (let n = 1; n <= 9; n++) if (t["comment" + n]) out.push(`(comment ${n} ${JSON.stringify(String(t["comment" + n]))})`); return out.length ? `(title_block ${out.join(" ")})` : ""; };
          const wasPaper = doc.paper === "User" ? `(paper "User" ${r4(doc.page[0])} ${r4(doc.page[1])})` : `(paper "${doc.paper || "A4"}"${doc.portrait ? " portrait" : ""})`;
          changes.push({ id: "00000000-0000-0000-0000-0000000d0c00", kind: "MODIFIED", typeName: "PAGE_SETTINGS", docProps: { paper: e.paper === undefined ? wasPaper : custom ? `(paper "User" ${r4(cw)} ${r4(ch)})` : `(paper "${paper}")`, titleBlock: block(tb) },
            was: { titleBlock: block(old), paper: wasPaper } });
          lines.push({ kind: "modify", text: (e.paper !== undefined ? `Page size ${doc.paper || "A4"} → ${custom ? `${fmt(cw)} x ${fmt(ch)} mm` : paper}` : "Title block") + (lines4.length ? `: ${lines4.map((key) => `${key} "${e[key]}"`).join(", ")}` : ""), ids: [] });
          break;
        }
        default: throw new ToolError(`unknown op "${e.op}"`);
      }
    } catch (err) {
      if (!(err instanceof ToolError)) console.warn("assistant: edit failed", e, err);
      problems.push(`edit ${i + 1} (${e && e.op}): ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  if (problems.length) throw new ToolError(`No proposal was shown, because ${problems.length === 1 ? "an edit is" : "some edits are"} invalid:\n- ${problems.join("\n- ")}`);
  return { id: "p" + Math.random().toString(36).slice(2, 9), title: String(input.title || "Proposed change").slice(0, 120), rationale: String(input.rationale || "").slice(0, 600),
    docId: open.docId, docPath: open.path, lines, changes, basis, status: "pending", rules, details: details.length ? details : undefined, connectivity: isSch ? connectivityDiff(doc, changes) : undefined };
}

/**
 * Which pins end up connected differently if the changes are applied to a schematic: the nets are
 * worked out on the sheet as it is and on a scratch copy with the changes, and compared pin by pin.
 * This is what catches a moved symbol that left its wires behind, or a wire that lands on a pin it
 * should not. Undefined when the check itself could not run.
 */
function connectivityDiff(doc: any, changes: any[]): string[] | undefined {
  try {
    const k = K(); const ed = ED();
    const scratch = Object.assign({}, doc, { items: new Map(doc.items) });
    for (const c of changes) { if (c.kind === "REMOVED") scratch.items.delete(c.id); else k.applyChange(scratch, c, ed.IU); }
    const groups = (d: any) => {
      const of = new Map<string, string[]>();
      for (const n of schNets(d)) { const pins = n.pins.map((q) => `${q.ref}.${q.number}`); for (const q of pins) of.set(q, pins); }
      return of;
    };
    const before = groups(doc), after = groups(scratch); const out: string[] = []; const seen = new Set<string>();
    for (const [pin, was] of before) {
      const now = after.get(pin); if (!now) continue;   // the part was removed: said by the edit itself
      const lost = was.filter((q) => after.has(q) && !now.includes(q)), gained = now.filter((q) => before.has(q) && !was.includes(q));
      if (!lost.length && !gained.length) continue;
      const key = [pin, ...lost, "|", ...gained].sort().join(","); if (seen.has(key)) continue; seen.add(key);
      out.push(`${pin}: ${lost.length ? `no longer connected to ${lost.slice(0, 6).join(", ")}` : ""}${lost.length && gained.length ? "; " : ""}${gained.length ? `now connected to ${gained.slice(0, 6).join(", ")}` : ""}`);
    }
    return out.slice(0, 24);
  } catch (e) { console.warn("assistant: connectivity check failed", e); return undefined; }
}

/** Why a pending proposal can no longer be applied as it stands, or null when it can. */
export function staleReason(p: Proposal): string | null {
  const ed = ED(); const doc = ed?.kdoc; const open = openEntry(); const k = K();
  if (!doc || !open || open.docId !== p.docId) return `Open ${p.docPath} to apply this.`;
  for (const [id, was] of Object.entries(p.basis)) {
    const it = doc.items.get(id);
    if (!it) return "An item this would change has been deleted since.";
    if (k.serialize(it.node) !== was) return `${nameOf(it)} has been edited since this was proposed.`;
  }
  for (const c of p.changes) if (c.kind === "ADDED" && doc.items.has(c.id)) return "This has already been applied.";
  return null;
}

const RULE_KEYS: [string, string][] = [["clearance", "clearance"], ["track_width", "track width"], ["via_diameter", "via diameter"], ["via_drill", "via drill"],
  ["min_track_width", "minimum track width"], ["min_clearance", "minimum clearance"], ["edge_clearance", "copper to edge clearance"], ["hole_clearance", "copper to hole clearance"], ["min_text_height", "minimum silkscreen text height"]];
/** The rules of a set_rules edit written into a .kicad_pro: the net class's own values, and the board-wide minimums. */
export function writeRules(pro: any, r: Record<string, number | string>): void {
  const ns = pro.net_settings = pro.net_settings || { classes: [], meta: { version: 0 } }; if (!Array.isArray(ns.classes)) ns.classes = [];
  const name = String(r.net_class || "Default"); let c = ns.classes.find((x: any) => x && x.name === name);
  if (!c) { c = { bus_width: 12, clearance: 0.2, diff_pair_gap: 0.25, diff_pair_via_gap: 0.25, diff_pair_width: 0.2, line_style: 0, microvia_diameter: 0.3, microvia_drill: 0.1, name,
    pcb_color: "rgba(0, 0, 0, 0.000)", schematic_color: "rgba(0, 0, 0, 0.000)", track_width: 0.2, via_diameter: 0.6, via_drill: 0.3, wire_width: 6 }; ns.classes.push(c); }
  for (const key of ["clearance", "track_width", "via_diameter", "via_drill"]) if (typeof r[key] === "number") c[key] = r[key];
  const board = pro.board = pro.board || {}; const ds = board.design_settings = board.design_settings || {}; const rules = ds.rules = ds.rules || {};
  if (typeof r.min_track_width === "number") rules.min_track_width = r.min_track_width;
  if (typeof r.min_clearance === "number") rules.min_clearance = r.min_clearance;
  if (typeof r.edge_clearance === "number") rules.min_copper_edge_clearance = r.edge_clearance;
  if (typeof r.hole_clearance === "number") rules.min_hole_clearance = r.hole_clearance;
  if (typeof r.min_text_height === "number") rules.min_text_height = r.min_text_height;
}

/** Apply an accepted proposal through the editor's own commit path: local apply, op to the server, one undo step. */
export function applyProposal(p: Proposal): { ok: boolean; reason?: string } {
  const ed = ED();
  if (ed.viewOnly) return { ok: false, reason: "You have view-only access to this project." };
  const stale = staleReason(p); if (stale) return { ok: false, reason: stale };
  if (p.rules) { const r = p.rules; const save = ed.dialogs && ed.dialogs.saveProject; if (!save) return { ok: false, reason: "This editor cannot change the project's board rules." };
    save((pro: any) => writeRules(pro, r), "board rules").catch((err: unknown) => console.warn("board rules were not saved:", err)); }
  if (p.changes.length) ed.api.commitChanges(p.changes, "AI: " + p.title);
  clearPreview();
  return { ok: true };
}

// ---------------------------------------------------------------- canvas preview

const NS = "http://www.w3.org/2000/svg";
const COLOR = { add: "#1f9d55", modify: "#d98e04", remove: "#d64545" };
let previewOf: string | null = null, previewed: Proposal | null = null, lastZoom = 0;

function layer(): SVGGElement | null {
  const root = document.getElementById("ovRoot"); if (!root) return null;
  let g = document.getElementById("aiG") as unknown as SVGGElement | null;
  if (!g) { g = document.createElementNS(NS, "g") as SVGGElement; g.setAttribute("id", "aiG"); g.setAttribute("pointer-events", "none"); root.appendChild(g); }
  return g;
}

export function clearPreview(): void {
  const g = document.getElementById("aiG"); if (g) g.replaceChildren();
  previewed = null;
  if (previewOf) { previewOf = null; try { ED().api.toolCtx().setHighlight(null); } catch { /* editor gone */ } }
}
export const previewing = () => previewOf;
/** The boxes are sized in screen pixels, so a zoom redraws them (the view is left where the person put it). */
export function refreshPreview(): void {
  const ed = ED(); if (!previewed || !ed || ed.zoom === lastZoom) return;
  const p = previewed; noScroll = true; try { showPreview(p); } finally { noScroll = false; }
}
let noScroll = false;

/**
 * Show what a proposal would do, on the canvas, without doing it: the new and changed items are
 * drawn from a scratch copy as a ghost over the sheet, and every touched item gets a box —
 * green for new, amber for changed, red for removed.
 */
export function showPreview(p: Proposal): void {
  clearPreview();
  const ed = ED(); const doc = ed?.kdoc; const g = layer(); const k = K(); if (!doc || !g || openEntry()?.docId !== p.docId) return;
  previewOf = p.id; previewed = p; lastZoom = ed.zoom;
  const scratch = Object.assign({}, doc, { items: new Map() });
  for (const c of p.changes) if (c.kind !== "REMOVED") { try { k.applyChange(scratch, c, ed.IU); } catch (e) { console.warn("assistant: preview item skipped", e); } }
  const boxes: { b: number[]; kind: keyof typeof COLOR }[] = [];
  const grow = (b: number[] | null, m: number) => (b ? [b[0] - m, b[1] - m, b[2] + m, b[3] + m] : null);
  for (const c of p.changes) {
    const now = doc.items.get(c.id), next: any = scratch.items.get(c.id);
    if (c.kind === "REMOVED") { const b = grow(now && now.bbox, 0.4); if (b) boxes.push({ b, kind: "remove" }); }
    else if (c.kind === "ADDED") { const b = grow(next && next.bbox, 0.4); if (b) boxes.push({ b, kind: "add" }); }
    else { const b = grow((next && next.bbox) || (now && now.bbox), 0.4); if (b) boxes.push({ b, kind: "modify" }); }
  }
  // the ghost: only what is new or changed, drawn by the same painter as the sheet
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of scratch.items.values() as Iterable<any>) if (it.bbox) { x0 = Math.min(x0, it.bbox[0]); y0 = Math.min(y0, it.bbox[1]); x1 = Math.max(x1, it.bbox[2]); y1 = Math.max(y1, it.bbox[3]); }
  if (isFinite(x0)) {
    try {
      const svg: string = k.renderSvg(scratch, { bbox: [x0 - 2, y0 - 2, x1 + 2, y1 + 2], background: null, frame: false, hidden: ed.hiddenLayers });
      const parsed = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
      const vb = (parsed.getAttribute("viewBox") || "").split(/\s+/).map(Number);
      if (vb.length === 4 && vb.every(isFinite)) {
        const ghost = document.importNode(parsed, true) as unknown as SVGSVGElement;
        ghost.setAttribute("x", String(vb[0])); ghost.setAttribute("y", String(vb[1])); ghost.setAttribute("width", String(vb[2])); ghost.setAttribute("height", String(vb[3]));
        ghost.setAttribute("opacity", "0.85"); g.appendChild(ghost);
      }
    } catch (e) { console.warn("assistant: ghost preview failed", e); }
  }
  const px = 1 / Math.max(0.5, (document.getElementById("world")?.getBoundingClientRect().width || 1000) / (ed.vb[2] / (ed.vbPerMm || 1)));
  for (const { b, kind } of boxes) {
    const r = document.createElementNS(NS, "rect");
    r.setAttribute("x", String(b[0])); r.setAttribute("y", String(b[1])); r.setAttribute("width", String(Math.max(b[2] - b[0], 0.2))); r.setAttribute("height", String(Math.max(b[3] - b[1], 0.2)));
    r.setAttribute("fill", COLOR[kind]); r.setAttribute("fill-opacity", "0.10"); r.setAttribute("stroke", COLOR[kind]); r.setAttribute("stroke-width", String(1.6 * px));
    r.setAttribute("stroke-dasharray", kind === "add" ? "" : `${5 * px} ${3 * px}`); r.setAttribute("rx", String(2 * px));
    g.appendChild(r);
  }
  // bring it into view when it is off screen
  if (boxes.length && !noScroll) {
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const { b } of boxes) { bx0 = Math.min(bx0, b[0]); by0 = Math.min(by0, b[1]); bx1 = Math.max(bx1, b[2]); by1 = Math.max(by1, b[3]); }
    const stage = document.getElementById("stage"), world = document.getElementById("world");
    if (stage && world) {
      const sr = stage.getBoundingClientRect(), wr = world.getBoundingClientRect(); const per = ed.vbPerMm || 1;
      const toX = (x: number) => wr.left + ((x - ed.vb[0] / per) / (ed.vb[2] / per)) * wr.width, toY = (y: number) => wr.top + ((y - ed.vb[1] / per) / (ed.vb[3] / per)) * wr.height;
      const cx = toX((bx0 + bx1) / 2), cy = toY((by0 + by1) / 2);
      if (cx < sr.left + 40 || cx > sr.right - 40 || cy < sr.top + 40 || cy > sr.bottom - 40) centreOn((bx0 + bx1) / 2, (by0 + by1) / 2);
    }
  }
}
