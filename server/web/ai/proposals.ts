// proposals.ts — how the assistant changes a design: it doesn't.  `propose_changes` turns the
// model's structured edits into ordinary collaboration changes (the same ADDED / MODIFIED /
// REMOVED records the editor's own tools produce), validates them against the live document and
// parks them as a proposal.  A person accepts it — then the changes go through commitChanges(),
// i.e. the normal op pipeline as one undo step — or rejects it, and nothing happens.
//
// Building a proposal never touches the document: nodes are cloned before they are edited, and
// new items are serialised without being added.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { ED, K, ToolError, centreOn, fieldsOf, findByRef, openEntry, schNets } from "./design";

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

function modified(doc: any, it: any, node: any): any {
  if (doc.type === "sch") { const s = SCH(); return { id: it.id, kind: "MODIFIED", typeName: s._.typeNameFor(it), sexpr: s._.itemSexpr(doc, it.kind, node) }; }
  const P = PCB(); const shell = { id: it.id, kind: it.kind, node, docType: "pcb" };
  return K().boardChangeExtras(doc, shell, { id: it.id, kind: "MODIFIED", typeName: P.typeNameOf(shell), sexpr: P.wrapBoard(node) });
}
function added(doc: any, node: any): any {
  const k = K(); if (!k.uuidOf(node)) node.push(["uuid", k.newUuid()]);
  const id = k.uuidOf(node); const shell = { id, kind: node[0], node, docType: doc.type };
  if (doc.type === "sch") { const s = SCH(); return { id, kind: "ADDED", typeName: s._.typeNameFor(shell), sexpr: s._.itemSexpr(doc, node[0], node) }; }
  const P = PCB();
  return k.boardChangeExtras(doc, shell, { id, kind: "ADDED", typeName: P.typeNameOf(shell), sexpr: P.wrapBoard(node) });
}
function removed(doc: any, it: any): any {
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

function moveItem(doc: any, it: any, x: number, y: number, rot: number | undefined): any {
  const k = K(); const node = k.cloneNode(it.node);
  if (doc.type === "sch" && (it.kind === "wire" || it.kind === "bus" || it.kind === "polyline")) {
    const pts = k.ptsOf(node); if (!pts.length) throw new ToolError("that line has no points");
    const dx = x - pts[0][0], dy = y - pts[0][1]; k.setPts(node, pts.map((p: number[]) => [p[0] + dx, p[1] + dy]));
    return modified(doc, it, node);
  }
  if (!k.kid(node, "at")) throw new ToolError(`a ${it.kind} has no single position; remove it and add it again where it should go`);
  const [ox, oy, orot] = k.atOf(node); const dx = x - ox, dy = y - oy;
  if (doc.type === "pcb" && it.kind === "footprint") {
    k.setAt(node, r4(x), r4(y));
    if (rot !== undefined && rot !== orot) PCB().rotateFootprintNode(node, rot - orot);
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

function addSymbol(doc: any, e: Edit, taken: Set<string>): { change: any; ref: string } {
  const s = SCH(); const k = K(); const libId = text(e.lib_id, "lib_id");
  if (!k.resolveLib(doc, libId)) throw new ToolError(`symbol ${libId} is not on this sheet yet; the symbols available here are: ${Array.from(doc.lib.keys()).sort().join(", ") || "(none)"}`);
  const rot = e.rotation === undefined ? 0 : num(e.rotation, "rotation");
  if (![0, 90, 180, 270].includes(((rot % 360) + 360) % 360)) throw new ToolError("a symbol's rotation is 0, 90, 180 or 270");
  const node = s._.symbolNode(doc, libId, [num(e.x, "x"), num(e.y, "y")], ((rot % 360) + 360) % 360, e.mirror || "");
  const prop = (name: string) => k.kids(node, "property").find((q: any) => k.str(q[1]) === name);
  const refP = prop("Reference"); let ref = typeof e.reference === "string" && e.reference ? e.reference : "";
  if (ref && findByRef(doc, ref).length) throw new ToolError(`reference ${ref} is already used on this sheet`);
  if (!ref) { const cur = refP ? k.str(refP[2]) : "U?"; ref = /^#/.test(cur) ? cur : nextRef(doc, cur.replace(/\?$/, "") || "U", taken); } else taken.add(ref);
  if (refP) refP[2] = ref;
  if (typeof e.value === "string" && e.value) { const v = prop("Value"); if (v) v[2] = e.value; }
  for (const [name, value] of Object.entries(e.fields || {})) {
    const p = prop(name);
    if (p) p[2] = String(value);
    else { const [x, y] = k.atOf(node); const np = ["property", name, String(value), ["at", r4(x), r4(y), 0], ["hide", "yes"], ["effects", ["font", ["size", 1.27, 1.27]]]]; const at = node.findIndex((c: any) => Array.isArray(c) && (c[0] === "pin" || c[0] === "instances")); if (at >= 0) node.splice(at, 0, np); else node.push(np); }
  }
  return { change: added(doc, node), ref };
}

function points(e: Edit): number[][] {
  const pts = e.points;
  if (!Array.isArray(pts) || pts.length < 2 || pts.some((p: any) => !Array.isArray(p) || p.length !== 2 || p.some((v: any) => typeof v !== "number" || !isFinite(v)))) throw new ToolError("points must be a list of at least two [x, y] pairs");
  return pts;
}

function boardNet(doc: any, name: string): any {
  const n = PCB().boardNets(doc).find((x: any) => x.name === name);
  if (!n) throw new ToolError(`there is no net "${name}" on the board`);
  return n;
}

/** Turn the model's edits into changes plus a line of plain words for each.  Throws ToolError naming the edit at fault. */
export function buildProposal(input: { title?: string; rationale?: string; edits?: Edit[] }): Proposal {
  const ed = ED(); const doc = ed?.kdoc; const open = openEntry();
  if (!doc || !open) throw new ToolError("No document is open in the editor, so there is nothing to change.");
  const edits = input.edits; if (!Array.isArray(edits) || !edits.length) throw new ToolError("edits must be a non-empty list.");
  if (edits.length > 400) throw new ToolError("That is too many edits for one proposal; split it into steps a person can review.");
  const isSch = doc.type === "sch"; const k = K();
  const changes: any[] = [], lines: EditLine[] = [], basis: Record<string, string> = {}, problems: string[] = []; const details: unknown[] = [];
  const touched = new Map<string, string>(); const taken = new Set<string>();
  const touch = (it: any, op: string) => { const prev = touched.get(it.id); if (prev) throw new ToolError(`${nameOf(it)} is already changed by an earlier edit (${prev}); combine them or split the proposal`); touched.set(it.id, op); basis[it.id] = k.serialize(it.node); };
  const schOnly = (op: string) => { if (!isSch) throw new ToolError(`${op} is a schematic edit and the board is open`); };
  const pcbOnly = (op: string) => { if (isSch) throw new ToolError(`${op} is a board edit and a schematic sheet is open`); };

  edits.forEach((e, i) => {
    try {
      if (!e || typeof e !== "object" || typeof e.op !== "string") throw new ToolError("needs an op");
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
          changes.push(moveItem(doc, it, x, y, rot));
          lines.push({ kind: "modify", text: `Move ${nameOf(it)} to (${fmt(x)}, ${fmt(y)})${rot !== undefined ? `, rotated ${rot}°` : ""}`, ids: [it.id] });
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
          const c = added(doc, SCH()._.labelNode(kind, text(e.text, "text"), [num(e.x, "x"), num(e.y, "y")], e.rotation || 0)); changes.push(c);
          lines.push({ kind: "add", text: `Add ${kind.replace("_", " ")} "${e.text}" at (${fmt(e.x)}, ${fmt(e.y)})`, ids: [c.id] });
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
          const c = added(doc, node); changes.push(c);
          lines.push({ kind: "add", text: `Add text "${t.length > 40 ? t.slice(0, 40) + "…" : t}" at (${fmt(x)}, ${fmt(y)})`, ids: [c.id] });
          break;
        }
        case "add_track": {
          pcbOnly(e.op); const P = PCB(); const pts = points(e); const net = boardNet(doc, text(e.net, "net")); const layer = text(e.layer, "layer");
          if (!doc.copper.includes(layer)) throw new ToolError(`${layer} is not a copper layer of this board (${doc.copper.join(", ")})`);
          const s = P.designSettings(ed.proSettings || null); const width = e.width === undefined ? s.trackWidth : num(e.width, "width");
          if (!(width > 0)) throw new ToolError("width must be positive"); const ids: string[] = [];
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
        case "autoroute": {
          pcbOnly(e.op); const P = PCB(); const R = (window as any).PcbAutoRouter;
          if (!R || !R.route) throw new ToolError("the autorouter is not loaded in this editor");
          if (e.nets !== undefined && (!Array.isArray(e.nets) || !e.nets.length)) throw new ToolError("nets must be a non-empty list of net names, or left out for every unrouted net");
          const nets: string[] | null = e.nets ? e.nets.map((n: unknown) => boardNet(doc, text(n, "net")).name) : null;
          const res = R.route(k, P, doc, P.designSettings(ed.proSettings || null), { nets, layers: Array.isArray(e.layers) && e.layers.length ? e.layers : null, allowVias: e.allow_vias !== false, timeMs: 12000 });
          const failed = (res.failed || []).map((f: any) => ({ net: f.net, from: f.a.map(r4), to: f.b.map(r4) }));
          if (!res.total) throw new ToolError(`nothing to route: every connection ${nets ? "of " + nets.join(", ") : "on the board"} is already made`);
          if (!res.items.length) throw new ToolError(`the autorouter could not make any of the ${res.total} missing connection${res.total === 1 ? "" : "s"} within the design rules: ${JSON.stringify(failed.slice(0, 12))}`);
          const ids: string[] = [];
          for (const it of res.items) { const c = added(doc, it.node); if (!c.netName && it.netName) c.netName = it.netName; changes.push(c); ids.push(c.id); }   // not P.addedChange: that one inserts into the live board
          details.push({ autoroute: { connections: res.total, routed: res.routed, unrouted: failed.slice(0, 40), segments: res.segments, vias: res.vias, length_mm: r4(res.length) } });
          lines.push({ kind: "add", text: `Autoroute ${nets ? nets.join(", ") : "all unrouted nets"}: ${res.routed} of ${res.total} connection${res.total === 1 ? "" : "s"}, ${res.segments} track segment${res.segments === 1 ? "" : "s"}, ${res.vias} via${res.vias === 1 ? "" : "s"}, ${Math.round(res.length * 10) / 10} mm${failed.length ? ` (${failed.length} left unrouted)` : ""}`, ids });
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
        default: throw new ToolError(`unknown op "${e.op}"`);
      }
    } catch (err) {
      if (!(err instanceof ToolError)) console.warn("assistant: edit failed", e, err);
      problems.push(`edit ${i + 1} (${e && e.op}): ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  if (problems.length) throw new ToolError(`No proposal was shown, because ${problems.length === 1 ? "an edit is" : "some edits are"} invalid:\n- ${problems.join("\n- ")}`);
  return { id: "p" + Math.random().toString(36).slice(2, 9), title: String(input.title || "Proposed change").slice(0, 120), rationale: String(input.rationale || "").slice(0, 600),
    docId: open.docId, docPath: open.path, lines, changes, basis, status: "pending", details: details.length ? details : undefined, connectivity: isSch ? connectivityDiff(doc, changes) : undefined };
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

/** Apply an accepted proposal through the editor's own commit path: local apply, op to the server, one undo step. */
export function applyProposal(p: Proposal): { ok: boolean; reason?: string } {
  const ed = ED();
  if (ed.viewOnly) return { ok: false, reason: "You have view-only access to this project." };
  const stale = staleReason(p); if (stale) return { ok: false, reason: stale };
  ed.api.commitChanges(p.changes, "AI: " + p.title);
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
