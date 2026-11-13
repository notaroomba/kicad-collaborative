// design.ts — what the assistant's read tools see: the open document (or another sheet / the board
// of the project) turned into plain facts.  Nothing here changes the design.
//
// The numbers come from the same code the editor uses — kicad-canvas for parsing and item
// geometry, sch-tools for pins, connectivity and ERC, pcb-tools for the board netlist, ratsnest
// and DRC — so what the assistant is told agrees with what the person sees on the canvas.

import { footprintModels } from "../viewer3d/models";
import { modelNames } from "./library";
import { silkBoxes } from "./silkscreen";
import { applySeverities } from "../dialogs/erc-rules";

/* eslint-disable @typescript-eslint/no-explicit-any */
const W = window as any;
export const K = (): any => W.KiCadCanvas;
export const ED = (): any => W.CollabEditor;
const SCH = (): any => (W.CollabTools && W.CollabTools.sch) || null;
const PCB = (): any => W.PcbTools || null;

export interface DocRef { doc: any; path: string; docId: string; open: boolean }

export class ToolError extends Error {}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const baseName = (p: string) => p.split("/").pop() || p;

export function projectDocs(): { docId: string; path: string; docType: string }[] {
  const st = ED()?.api?.state; return (st && st.docs) || [];
}
export function openEntry(): { docId: string; path: string; docType: string } | null {
  const st = ED()?.api?.state; return (st && st.doc) || null;
}

/** Find a project document by what the model called it: its path, its file name, or "board". */
export function findDoc(name: string): { docId: string; path: string; docType: string } | null {
  const docs = projectDocs(); const q = name.trim().toLowerCase();
  return docs.find((d) => d.path.toLowerCase() === q)
    || docs.find((d) => baseName(d.path).toLowerCase() === q)
    || docs.find((d) => baseName(d.path).toLowerCase().replace(/\.kicad_(sch|pcb)$/, "") === q.replace(/\.kicad_(sch|pcb)$/, ""))
    || (/^(board|pcb|the board)$/.test(q) ? docs.find((d) => d.docType === "kicad_pcb") || null : null);
}

const cache = new Map<string, { at: number; doc: any }>();
/** Forget the parsed copies of the project's other documents (the harness changes them between two reads). */
export function forgetDocs(): void { cache.clear(); }

/**
 * The document a tool should read.  The open one is the live in-memory document; any other is
 * the server's current copy, parsed here and kept for a few seconds so a burst of tool calls
 * about the same sheet reads it once.
 */
export async function resolveDoc(name?: string): Promise<DocRef> {
  const open = openEntry(); const live = ED()?.kdoc;
  if (!name || (open && findDoc(name)?.docId === open.docId)) {
    if (!open || !live) throw new ToolError("No document is open in the editor yet.");
    return { doc: live, path: open.path, docId: open.docId, open: true };
  }
  const entry = findDoc(name);
  if (!entry) throw new ToolError(`There is no document "${name}" in this project. The documents are: ${projectDocs().map((d) => d.path).join(", ") || "(none)"}.`);
  const hit = cache.get(entry.docId);
  if (hit && Date.now() - hit.at < 8000) return { doc: hit.doc, path: entry.path, docId: entry.docId, open: false };
  const r = await fetch(`/api/docs/${entry.docId}/content?v=${Date.now()}`);
  if (!r.ok) throw new ToolError(`Could not read ${entry.path} (${r.status}).`);
  let doc: any;
  try { doc = K().parseDoc(await r.text(), entry.docType); } catch { throw new ToolError(`${entry.path} could not be parsed.`); }
  // the snapshot is as old as the last save: bring it up to now with the edits made since
  const seq = Number(r.headers.get("x-snapshot-seq"));
  if (isFinite(seq)) {
    try {
      const o = await fetch(`/api/docs/${entry.docId}/ops?since=${seq}`, { credentials: "same-origin" });
      if (o.ok) for (const op of (await o.json()).ops || []) for (const c of op.changes || []) { try { K().applyChange(doc, c, ED()?.IU); } catch (e) { console.warn("assistant: an edit could not be replayed on", entry.path, e); } }
    } catch { /* the snapshot alone is still better than nothing */ }
  }
  cache.set(entry.docId, { at: Date.now(), doc });
  return { doc, path: entry.path, docId: entry.docId, open: false };
}

// ---------------------------------------------------------------- fields

export function fieldsOf(node: any): Record<string, string> {
  const k = K(); const out: Record<string, string> = {};
  for (const p of k.kids(node, "property")) out[k.str(p[1])] = k.str(p[2]);
  return out;
}
const PART_FIELD = /^(mpn|mfr|mfg|manufacturer|manufacturer[ _-]?part.*|part[ _-]?(number|no)|pn|lcsc.*|jlc.*|digi-?key.*|mouser.*|farnell.*|rs.*part.*|supplier.*|vendor.*|sku|description)$/i;
const usableUrl = (s: string) => /^https?:\/\/\S+$/i.test(s.trim());

function isPower(doc: any, it: any): boolean {
  const s = SCH();
  try { return !!(s && s._.isPowerSymbol(doc, it.lib || "")); } catch { return /^power:/i.test(it.lib || ""); }
}
const components = (doc: any): any[] => Array.from(doc.items.values()).filter((it: any) => it.kind === (doc.type === "sch" ? "symbol" : "footprint"));
const refKey = (r: string) => { const m = /^(\D*)(\d*)(.*)$/.exec(r) || []; return [m[1] || "", Number(m[2] || 0), m[3] || ""] as const; };
const byRef = (a: any, b: any) => { const x = refKey(a.ref || ""), y = refKey(b.ref || ""); return x[0].localeCompare(y[0]) || x[1] - y[1] || x[2].localeCompare(y[2]); };

export function findByRef(doc: any, ref: string): any[] {
  const q = ref.trim().toLowerCase();
  return components(doc).filter((it) => (it.ref || "").toLowerCase() === q);
}

// ---------------------------------------------------------------- nets

interface SchNet { name: string; /** the name KiCad gives it on the board: a local or hierarchical label carries its sheet path */ board: string; named: boolean; pins: { ref: string; number: string; name: string; type: string }[]; labels: string[]; ids: string[] }

/** The sheet's nets with a name for each, the way KiCad names them: a label wins, else Net-(REF-Pad). */
export function schNets(doc: any): SchNet[] {
  const s = SCH(); if (!s) throw new ToolError("The schematic tools are not loaded.");
  const { nets } = s._.ercNets(doc); const out: SchNet[] = [];
  for (const n of nets) {
    const pins: SchNet["pins"] = []; const labels = new Set<string>(); let best = "", rank = 0;
    for (const t of n.terms) {
      const key: string = t.key || "";
      const m = /^(global|hier|local):(.*)$/.exec(key);
      if (m) { const rk = m[1] === "global" ? 3 : m[1] === "hier" ? 2 : 1; labels.add(m[2]); if (rk > rank || (rk === rank && m[2] < best)) { rank = rk; best = m[2]; } }
      if (t.pin && t.item.kind === "symbol" && !t.power) pins.push({ ref: t.item.ref || "?", number: t.pin.number, name: t.pin.name === "~" ? "" : t.pin.name, type: t.pin.type });
    }
    if (!pins.length && !labels.size) continue;   // a stray wire with nothing on it
    pins.sort((a, b) => byRef(a, b) || a.number.localeCompare(b.number, undefined, { numeric: true }));
    // An unnamed net takes its name from one of its pins, the way KiCad's connection graph picks it: a pin with a
    // real name beats a bare pad number, then the smaller name; a pin on its own is "unconnected-(…)" on the board.
    const auto = pins.map((p) => (p.name && p.name !== p.number ? `Net-(${p.ref}-${p.name})` : `Net-(${p.ref}-Pad${p.number})`))
      .sort((a, b) => Number(a.includes("-Pad")) - Number(b.includes("-Pad")) || (a < b ? -1 : a > b ? 1 : 0))[0];
    const first = pins[0];
    const name = best || auto || "(unnamed)";
    const alone = !best && pins.length === 1 ? `unconnected-(${first.ref}-${first.name && first.name !== first.number ? first.name.replace(/\//g, "{slash}") + "-" : ""}Pad${first.number})` : "";
    out.push({ name, board: best && rank < 3 ? "/" + best : alone || name, named: !!best, pins, labels: Array.from(labels), ids: Array.from(n.ids) });
  }
  return out.sort((a, b) => Number(b.named) - Number(a.named) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- tools

export function overview(): unknown {
  const ed = ED(); const st = ed?.api?.state; const doc = ed?.kdoc; const open = openEntry();
  if (!st || !st.project) throw new ToolError("No project is open.");
  const out: any = {
    project: st.project.name, your_role: st.role || "guest",
    documents: projectDocs().map((d) => ({ path: d.path, type: d.docType === "kicad_pcb" ? "board" : "schematic", open: !!open && d.docId === open.docId })),
  };
  if (!doc || !open) { out.open_document = null; return out; }
  const comps = components(doc); const kinds: Record<string, number> = {};
  for (const it of doc.items.values()) kinds[it.kind] = (kinds[it.kind] || 0) + 1;
  const od: any = { path: open.path, type: doc.type === "sch" ? "schematic" : "board", title_block: doc.titleBlock || {}, item_counts: kinds };
  if (doc.type === "sch") {
    const real = comps.filter((it) => !isPower(doc, it));
    od.page_mm = doc.page.map(r3); od.components = real.length; od.power_symbols = comps.length - real.length;
    od.sheet_name = doc.sheetName || ""; od.libraries = Array.from(doc.lib.keys()).sort();
    od.sub_sheets = Array.from(doc.items.values()).filter((it: any) => it.kind === "sheet").map((it: any) => ({ name: it.name, file: it.file }));
    try { od.nets = schNets(doc).length; } catch { /* tools not loaded */ }
  } else {
    od.footprints = comps.length; od.copper_layers = doc.copper.slice(); od.bounds_mm = (doc.bbox || []).map(r3);
    try { od.nets = PCB().netlist(doc).nets.size; } catch { /* tools not loaded */ }
  }
  out.open_document = od; out.selection = selectionSummary();
  return out;
}

function selectionSummary(): unknown {
  const ed = ED(); const doc = ed?.kdoc; if (!doc) return [];
  const ids: string[] = Array.from(ed.selection || []); if (!ids.length && ed.selected) ids.push(ed.selected.id);
  return ids.slice(0, 50).map((id) => { const it = doc.items.get(id); return it ? { id, kind: it.kind, ref: it.ref || undefined, value: it.value || undefined } : { id }; });
}

export async function listComponents(input: { doc?: string; filter?: string; include_power?: boolean }): Promise<unknown> {
  const { doc, path } = await resolveDoc(input.doc); const q = (input.filter || "").toLowerCase();
  const rows = components(doc).filter((it) => input.include_power || doc.type !== "sch" || !isPower(doc, it)).sort(byRef).map((it) => {
    const f = fieldsOf(it.node);
    const row: any = { ref: it.ref || "", value: it.value || "", x: r3(it.x || 0), y: r3(it.y || 0), rotation: it.rot || 0 };
    if (doc.type === "sch") { row.lib_id = it.lib || ""; row.footprint = f.Footprint || ""; if (it.unit && it.unit > 1) row.unit = it.unit; }
    else { row.footprint = it.lib || ""; row.side = it.layer === "B.Cu" ? "back" : "front"; }
    row.datasheet = usableUrl(f.Datasheet || "") ? "yes" : "no";
    const part = Object.keys(f).filter((n) => PART_FIELD.test(n) && f[n] && n !== "Description"); if (part.length) row.part_fields = part;
    if (f["Net names"]) row.net_names = f["Net names"];   // names of nets wired without a label, by pin (kicad_harness build)
    if (it.id) row.id = it.id;
    return row;
  }).filter((r) => !q || [r.ref, r.value, r.footprint, r.lib_id || ""].some((s: string) => s.toLowerCase().includes(q)));
  const cap = 400;
  return { document: path, count: rows.length, components: rows.slice(0, cap), truncated: rows.length > cap ? `showing ${cap} of ${rows.length}; narrow with filter` : undefined };
}

export async function getComponent(input: { ref: string; doc?: string }): Promise<unknown> {
  const { doc, path } = await resolveDoc(input.doc); const k = K();
  const hits = findByRef(doc, String(input.ref || ""));
  if (!hits.length) throw new ToolError(`No component with reference ${input.ref} in ${path}.`);
  if (doc.type === "sch") {
    const s = SCH(); const nets = schNets(doc); const netOf = new Map<string, string>();
    for (const n of nets) for (const p of n.pins) netOf.set(`${p.ref}\u0000${p.number}`, n.name);
    const units = hits.map((it) => {
      const m = k.kid(it.node, "mirror");
      return { id: it.id, unit: it.unit || 1, x: r3(it.x), y: r3(it.y), rotation: it.rot || 0, mirror: m ? k.str(m[1]) : undefined,
        pins: s._.symbolPins(doc, it).map((p: any) => ({ number: p.number, name: p.name === "~" ? "" : p.name, type: p.type, x: r3(p.x), y: r3(p.y), hidden: p.hidden || undefined,
          net: netOf.get(`${it.ref}\u0000${p.number}`) || (p.hidden && p.type === "power_in" ? p.name : "(unconnected)") })) };
    });
    const it = hits[0];
    return { document: path, ref: it.ref, lib_id: it.lib, fields: fieldsOf(it.node), in_bom: flag(it.node, "in_bom"), on_board: flag(it.node, "on_board"), dnp: flag(it.node, "dnp", false), units };
  }
  const it = hits[0]; const P = PCB(); const NT = P.netTable(doc);
  return { document: path, ref: it.ref, id: it.id, footprint: it.lib, side: it.layer === "B.Cu" ? "back" : "front", x: r3(it.x), y: r3(it.y), rotation: it.rot || 0, fields: fieldsOf(it.node),
    pads: P.padsOf(it).map((p: any) => ({ number: p.number, type: p.type, shape: p.shape, x: r3(p.x), y: r3(p.y), size: [r3(p.w), r3(p.h)], layers: p.layers, net: NT.key(p.net) || "(no net)" })) };
}
function flag(node: any, name: string, dflt = true): boolean { const k = K(); const n = k.kid(node, name); return n ? k.str(n[1]) !== "no" : dflt; }

export async function listNets(input: { doc?: string; filter?: string }): Promise<unknown> {
  const { doc, path } = await resolveDoc(input.doc); const q = (input.filter || "").toLowerCase(); const cap = 300;
  if (doc.type === "sch") {
    const rows = schNets(doc).map((n) => ({ name: n.name, pins: n.pins.map((p) => `${p.ref}.${p.number}${p.name ? `(${p.name})` : ""}`), also_labelled: n.labels.filter((l) => l !== n.name).length ? n.labels.filter((l) => l !== n.name) : undefined }))
      .filter((n) => !q || n.name.toLowerCase().includes(q) || n.pins.some((p) => p.toLowerCase().includes(q)));
    return { document: path, count: rows.length, nets: rows.slice(0, cap), truncated: rows.length > cap ? `showing ${cap} of ${rows.length}; narrow with filter` : undefined };
  }
  const P = PCB(); const nl = P.netlist(doc); const rows: any[] = [];
  for (const n of nl.nets.values()) {
    const pads = n.pads.map((c: any) => `${c.item.ref || "?"}.${c.pad.number}`).sort((a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }));
    let len = 0; for (const t of n.tracks) len += t.length || 0;
    rows.push({ name: n.name, pads, tracks: n.tracks.length, vias: n.vias.length, zones: n.zones.length || undefined, routed_length_mm: r3(len), unrouted_connections: n.unconnected || 0, shorted: n.shorts.length ? true : undefined });
  }
  const out = rows.filter((n) => !q || n.name.toLowerCase().includes(q) || n.pads.some((p: string) => p.toLowerCase().includes(q))).sort((a, b) => a.name.localeCompare(b.name));
  return { document: path, count: out.length, nets: out.slice(0, cap), truncated: out.length > cap ? `showing ${cap} of ${out.length}; narrow with filter` : undefined };
}

/**
 * Where everything is, in one compact answer, for code that computes wires and positions itself (the Python
 * harness): each part with its pins or pads as rows, and on a sheet the wire segments, labels and junctions.
 * Rows are arrays to keep the answer small: pins [number, name, type, x, y, side, net], pads [number, x, y, net].
 */
export async function geometry(input: { doc?: string; silk?: boolean }): Promise<unknown> {
  const { doc, path } = await resolveDoc(input.doc); const k = K();
  if (doc.type === "sch") {
    const s = SCH(); if (!s) throw new ToolError("The schematic tools are not loaded.");
    const netOf = new Map<string, string>(); for (const n of schNets(doc)) for (const p of n.pins) netOf.set(`${p.ref}\u0000${p.number}`, n.name);
    const parts: any[] = [], wires: number[][] = [], labels: any[] = [], junctions: number[][] = [], noConnects: number[][] = [];
    for (const it of doc.items.values() as Iterable<any>) {
      if (it.kind === "symbol") {
        const power = isPower(doc, it);
        parts.push({ ref: it.ref || "", id: it.id, lib_id: it.lib || "", value: it.value || "", unit: it.unit || 1, x: r3(it.x), y: r3(it.y), rotation: it.rot || 0, power: power || undefined, box: it.bbox ? it.bbox.map(r3) : undefined,
          pins: s._.symbolPins(doc, it).map((p: any) => [p.number, p.name === "~" ? "" : p.name, p.type, r3(p.x), r3(p.y), p.side, power ? it.value || "" : netOf.get(`${it.ref}\u0000${p.number}`) || "", p.hidden ? 1 : 0]) });
      } else if (it.kind === "wire" || it.kind === "bus") { const pts = k.ptsOf(it.node); for (let i = 1; i < pts.length; i++) wires.push([r3(pts[i - 1][0]), r3(pts[i - 1][1]), r3(pts[i][0]), r3(pts[i][1])]); }
      else if (it.kind === "label" || it.kind === "global_label" || it.kind === "hierarchical_label") { const [x, y] = k.atOf(it.node); labels.push([k.str(it.node[1]), r3(x), r3(y), it.kind]); }
      else if (it.kind === "junction") { const [x, y] = k.atOf(it.node); junctions.push([r3(x), r3(y)]); }
      else if (it.kind === "no_connect") { const [x, y] = k.atOf(it.node); noConnects.push([r3(x), r3(y)]); }
    }
    return { document: path, type: "schematic", page: (doc.page || []).map(r3), parts, wires, labels, junctions, no_connects: noConnects };
  }
  const P = PCB(); if (!P) throw new ToolError("The board tools are not loaded."); const NT = P.netTable(doc);
  const parts: any[] = []; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of doc.items.values() as Iterable<any>) {
    if (it.edge && it.bbox) { x0 = Math.min(x0, it.bbox[0]); y0 = Math.min(y0, it.bbox[1]); x1 = Math.max(x1, it.bbox[2]); y1 = Math.max(y1, it.bbox[3]); }
    if (it.kind !== "footprint") continue;
    // the courtyard's box, as placed: what has to stay clear of the next part
    let cb: number[] | undefined; try { const cy = P.courtyards({ node: it.node }); let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const k of Object.keys(cy)) for (const loop of cy[k]) for (const q of loop) { a = Math.min(a, q[0]); b = Math.min(b, q[1]); c = Math.max(c, q[0]); d = Math.max(d, q[1]); } if (a <= c) cb = [r3(a), r3(b), r3(c), r3(d)]; } catch { /* no courtyard maths */ }
    parts.push({ ref: it.ref || "", id: it.id, value: it.value || "", footprint: it.lib || "", x: r3(it.x), y: r3(it.y), rotation: it.rot || 0, side: it.layer === "B.Cu" ? "back" : "front", box: it.bbox ? it.bbox.map(r3) : undefined, courtyard: cb,
      pads: P.padsOf(it).map((p: any) => [p.number, r3(p.x), r3(p.y), NT.key(p.net) || ""]) });
  }
  return { document: path, type: "board", outline: isFinite(x0) ? [r3(x0), r3(y0), r3(x1), r3(y1)] : null, copper_layers: doc.copper.slice(), parts, silk: input.silk ? silkBoxes(doc) : undefined };
}

/** The ERC as the editor's Run ERC runs it: the project's Pin Conflicts Map and rule severities (Schematic Setup > Electrical Rules). */
export function projectErc(doc: any, extra?: Record<string, unknown>): any[] {
  const s = SCH(); if (!s || !s.ercCheck) throw new ToolError("The ERC is not available.");
  let erc: any = {}; try { const pro = ED().proSettings ? JSON.parse(ED().proSettings) : null; erc = (pro && pro.erc) || {}; } catch { erc = {}; }
  const marks = s.ercCheck(doc, Object.assign({ pinMap: Array.isArray(erc.pin_map) ? erc.pin_map : undefined }, extra || {}));
  return applySeverities(marks, erc.rule_severities && typeof erc.rule_severities === "object" ? erc.rule_severities : null);
}

export async function runChecks(input: { doc?: string }): Promise<unknown> {
  const { doc, path } = await resolveDoc(input.doc);
  let markers: any[];
  if (doc.type === "sch") markers = projectErc(doc);
  else { const P = PCB(); if (!P || !P.drc) throw new ToolError("The DRC is not available."); markers = P.drc(doc, P.designSettings(ED().proSettings || null), {}); }
  const refs = (ids: string[]) => Array.from(new Set((ids || []).map((id) => doc.items.get(id)).filter(Boolean).map((it: any) => it.ref).filter(Boolean)));
  const rows = markers.map((m) => ({ severity: m.severity, code: m.code, message: m.text, x: r3(m.x), y: r3(m.y), refs: refs(m.ids) }));
  if (doc.type !== "sch") {   // Junction's own rule on top of KiCad's DRC: no square track corners except on antenna and RF nets
    try { const R = W.PcbAutoRouter; if (R && R.boardSquareCorners) for (const c of R.boardSquareCorners(doc, PCB())) rows.push({ severity: "error", code: "track_right_angle", message: `Track of net '${c.net}' turns ${c.angle}° on ${c.layer}: use 45° corners (antenna and RF nets are exempt)`, x: r3(c.x), y: r3(c.y), refs: [] }); } catch { /* router not loaded */ }
  }
  const errors = rows.filter((m) => m.severity === "error").length; const cap = 200;
  return { document: path, check: doc.type === "sch" ? "ERC" : "DRC", errors, warnings: rows.length - errors, violations: rows.slice(0, cap), truncated: rows.length > cap ? `showing ${cap} of ${rows.length}` : undefined,
    note: doc.type === "sch" ? "This ERC covers the one sheet; nets that leave it through hierarchical or global labels are treated as driven elsewhere." : "This DRC is the editor's subset: clearance, edge clearance, unconnected items, shorts, dangling tracks, annular width, courtyards, plus Junction's own track_right_angle (no square corners outside antenna and RF nets)." };
}

export async function boardInfo(): Promise<unknown> {
  const entry = projectDocs().find((d) => d.docType === "kicad_pcb");
  if (!entry) throw new ToolError("This project has no board.");
  const { doc, path } = await resolveDoc(entry.path); const P = PCB(); if (!P) throw new ToolError("The board tools are not loaded.");
  const st = P.boardStatistics(doc); const s = P.designSettings(ED().proSettings || null); const nl = P.netlist(doc);
  const widths = new Map<number, number>(), vias = new Map<string, number>(); const k = K();
  for (const it of doc.items.values()) {
    if (it.kind === "segment" || it.kind === "arc") { const w = k.kid(it.node, "width"); if (w) { const v = r3(k.num(w[1])); widths.set(v, (widths.get(v) || 0) + 1); } }
    if (it.kind === "via") { const sz = k.kid(it.node, "size"), dr = k.kid(it.node, "drill"); const key = `${sz ? r3(k.num(sz[1])) : "?"}/${dr ? r3(k.num(dr[1])) : "?"}`; vias.set(key, (vias.get(key) || 0) + 1); }
  }
  let unrouted = 0; for (const n of nl.nets.values()) unrouted += n.unconnected || 0;
  let layout: unknown; try { const R = W.PcbAutoRouter; if (R && R.evaluate) { const ev = R.evaluate(K(), P, doc, s, {}); layout = { ratsnest_mm: r3(ev.ratsnest), unrouted: ev.unrouted, vias: ev.vias, track_length_mm: r3(ev.trackLength), routed_nets: ev.routedNets, worst_detours: (ev.worstDetours || []).slice(0, 10) }; } } catch { /* engine not loaded */ }
  let outlined = false; for (const it of doc.items.values()) if (it.edge) { outlined = true; break; }
  return { document: path, size_mm: outlined ? { width: st.width, height: st.height, area_mm2: st.area } : null, outline: outlined ? undefined : "No board outline is drawn on Edge.Cuts yet, so the board has no size.", copper_layers: doc.copper.slice(), statistics: st, layout,
    track_widths_in_use_mm: Object.fromEntries(Array.from(widths.entries()).sort((a, b) => a[0] - b[0]).map(([w, n]) => [String(w), n])),
    via_sizes_in_use_mm: Object.fromEntries(vias), nets: nl.nets.size, unrouted_connections: unrouted,
    models_3d: await boardModels(doc),
    design_rules: { clearance: s.clearance, edge_clearance: s.edgeClearance, min_track_width: s.minTrackWidth, min_via_diameter: s.minViaDiameter, min_via_drill: s.minThroughDrill, net_classes: s.netclasses } };
}

/**
 * Which parts the 3D view can show as their real model: the footprint names one (KiCad's 3D library, or the vendor's
 * for a vendor part) and that library has it.  The rest are drawn as a plain stand-in shape and are listed with the reason.
 */
async function boardModels(doc: any): Promise<unknown> {
  let parts = 0, kicad = 0, vendor = 0, own = 0, unchecked = 0; const missing: { ref: string; footprint: string; reason: string }[] = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "footprint") continue;
    let pads = 0; for (const c of it.node) if (Array.isArray(c) && c[0] === "pad") pads++;
    const attr = (it.node as any[]).find((c) => Array.isArray(c) && c[0] === "attr") as any[] | undefined;
    if (pads < 2 || (attr && (attr.includes("board_only") || attr.includes("dnp")))) continue;   // no component: a mounting hole, a test point, a logo
    parts++;
    const refs = footprintModels(it.node); const named = (it.node as any[]).some((c) => Array.isArray(c) && c[0] === "model");
    if (!refs.length) { missing.push({ ref: it.ref || "?", footprint: it.lib || "", reason: named ? "its model path names no library file, or is hidden" : "the footprint names no 3D model" }); continue; }
    let found = false, unknown = false, why = "";
    for (const r of refs) {
      if (r.source === "vendor") { found = true; vendor++; break; }
      if (r.source === "project") { found = true; own++; break; }
      const [lib, name] = r.name.split("/"); const names = await modelNames(lib);
      if (!names) unknown = true; else if (names.has(name)) { found = true; kicad++; break; } else why = `KiCad's 3D library has no ${lib}.3dshapes/${name}`;
    }
    if (found) continue;
    if (unknown) unchecked++; else missing.push({ ref: it.ref || "?", footprint: it.lib || "", reason: why });
  }
  missing.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  return { parts, from_kicad_library: kicad, from_vendor: vendor, from_project: own || undefined, not_checked: unchecked || undefined, without_model: missing,
    note: unchecked ? "KiCad's 3D library could not be listed from here, so those parts were not checked." : missing.length ? "Parts without a model are drawn as a plain stand-in shape in the 3D view." : undefined };
}

export function getSelection(): unknown {
  const ed = ED(); const doc = ed?.kdoc; const open = openEntry(); if (!doc || !open) throw new ToolError("No document is open in the editor yet.");
  const ids: string[] = Array.from(ed.selection || []); if (!ids.length && ed.selected) ids.push(ed.selected.id);
  if (!ids.length) return { document: open.path, selected: [], note: "Nothing is selected." };
  const k = K();
  return { document: open.path, count: ids.length, selected: ids.slice(0, 60).map((id) => {
    const it = doc.items.get(id); if (!it) return { id };
    const row: any = { id, kind: it.kind };
    if (it.ref) row.ref = it.ref; if (it.x !== undefined) { row.x = r3(it.x); row.y = r3(it.y); }
    if (it.kind === "symbol" || it.kind === "footprint") row.fields = fieldsOf(it.node); else row.sexpr = clip(k.serialize(it.node), 600);
    return row;
  }) };
}
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + ` … (${s.length - n} more characters)` : s);

export async function getItems(input: { doc?: string; kinds?: string[]; ids?: string[]; near?: { x: number; y: number; radius: number }; net?: string }): Promise<unknown> {
  const { doc, path } = await resolveDoc(input.doc); const k = K();
  if (!input.kinds && !input.ids && !input.near && !input.net) throw new ToolError("Give at least one of kinds, ids, near or net.");
  const kinds = input.kinds ? new Set(input.kinds) : null; const ids = input.ids ? new Set(input.ids) : null; const near = input.near;
  let NT: any = null; if (input.net && doc.type === "pcb") NT = PCB().netTable(doc);
  const rows: any[] = []; let total = 0, budget = 60000;
  for (const it of doc.items.values()) {
    if (kinds && !kinds.has(it.kind)) continue; if (ids && !ids.has(it.id)) continue;
    if (near) { const b = it.bbox; if (!b || b[2] < near.x - near.radius || b[0] > near.x + near.radius || b[3] < near.y - near.radius || b[1] > near.y + near.radius) continue; }
    if (input.net) { if (!NT) continue; const own = NT.key(PCB().netOf(it.node)); const pad = it.kind === "footprint" && k.kids(it.node, "pad").some((p: any) => NT.key(PCB().netOf(p)) === input.net); if (own !== input.net && !pad) continue; }
    total++;
    if (rows.length >= 150 || budget <= 0) continue;
    // a footprint or symbol is mostly drawing data: its fields say more in less
    const big = it.kind === "footprint" || it.kind === "symbol" || it.kind === "zone";
    const row: any = { id: it.id, kind: it.kind }; if (it.ref) row.ref = it.ref; if (it.bbox) row.bbox = it.bbox.map(r3);
    if (it.kind === "footprint" || it.kind === "symbol") row.fields = fieldsOf(it.node);
    row.sexpr = clip(k.serialize(it.node), big && !ids ? 400 : 4000); budget -= row.sexpr.length;
    rows.push(row);
  }
  return { document: path, count: total, items: rows, truncated: total > rows.length ? `showing ${rows.length} of ${total}; filter more narrowly` : undefined };
}

export async function findDatasheets(input: { doc?: string; refs?: string[] }): Promise<unknown> {
  const { doc, path } = await resolveDoc(input.doc); const want = input.refs && input.refs.length ? new Set(input.refs.map((r) => r.toLowerCase())) : null;
  const groups = new Map<string, any>();
  for (const it of components(doc).sort(byRef)) {
    if (doc.type === "sch" && isPower(doc, it)) continue; if (!it.ref || (want && !want.has(it.ref.toLowerCase()))) continue;
    const f = fieldsOf(it.node); const ds = (f.Datasheet || "").trim(); const part: Record<string, string> = {};
    for (const [n, v] of Object.entries(f)) if (PART_FIELD.test(n) && v && v !== "~") part[n] = v;
    const key = [it.value, doc.type === "sch" ? it.lib : it.lib, ds, JSON.stringify(part)].join("\u0000");
    let g = groups.get(key);
    if (!g) { g = { refs: [], value: it.value || "", [doc.type === "sch" ? "lib_id" : "footprint"]: it.lib || "", footprint: doc.type === "sch" ? f.Footprint || "" : it.lib || "", datasheet: usableUrl(ds) ? ds : null, part_fields: Object.keys(part).length ? part : undefined }; groups.set(key, g); }
    if (!g.refs.includes(it.ref)) g.refs.push(it.ref);
  }
  const parts = Array.from(groups.values());
  const missing = parts.filter((p) => !p.datasheet).length;
  return { document: path, parts, with_datasheet_link: parts.length - missing, without: missing,
    note: missing ? "Parts without a link can usually be found by searching for the value or part number plus \"datasheet\". Generic passives (resistors, capacitors) rarely need one." : undefined };
}

/** Centre the view on a point (mm) without changing the zoom. */
export function centreOn(x: number, y: number): void {
  const ed = ED(); const stage = document.getElementById("stage"), world = document.getElementById("world"); if (!ed || !stage || !world) return;
  const per = ed.vbPerMm || 1; const mmW = ed.vb[2] / per, mmH = ed.vb[3] / per, x0 = ed.vb[0] / per, y0 = ed.vb[1] / per;
  const w = world.clientWidth, h = w * mmH / mmW;
  ed.panX = stage.clientWidth / 2 - ((x - x0) / mmW) * w * ed.zoom; ed.panY = stage.clientHeight / 2 - ((y - y0) / mmH) * h * ed.zoom; ed.viewTouched = true;
  ed.api.applyView(); ed.api.requestRender();
}

export function focusView(input: { refs?: string[]; x?: number; y?: number }): unknown {
  const ed = ED(); const doc = ed?.kdoc; if (!doc) throw new ToolError("No document is open in the editor yet.");
  const found: any[] = [], missing: string[] = [];
  for (const r of input.refs || []) { const hits = findByRef(doc, r); if (hits.length) found.push(...hits); else missing.push(r); }
  if (found.length) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of found) { const b = it.bbox || [it.x, it.y, it.x, it.y]; x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); }
    centreOn((x0 + x1) / 2, (y0 + y1) / 2);
    ed.api.toolCtx().setSelection(found.map((it) => it.id));
  } else if (typeof input.x === "number" && typeof input.y === "number") centreOn(input.x, input.y);
  else if (missing.length) throw new ToolError(`Not on the open document: ${missing.join(", ")}.`);
  else throw new ToolError("Give refs, or x and y.");
  return { shown: found.map((it) => it.ref), not_on_this_document: missing.length ? missing : undefined };
}

export async function openDocument(input: { doc: string }): Promise<unknown> {
  const entry = findDoc(String(input.doc || ""));
  if (!entry) throw new ToolError(`There is no document "${input.doc}" in this project. The documents are: ${projectDocs().map((d) => d.path).join(", ") || "(none)"}.`);
  const ed = ED(); if (openEntry()?.docId === entry.docId) return { open: entry.path, note: "Already open." };
  await ed.api.openDoc(entry);
  for (let i = 0; i < 50 && !(ed.kdoc && openEntry()?.docId === entry.docId); i++) await new Promise((r) => setTimeout(r, 100));
  if (!ed.kdoc) throw new ToolError(`${entry.path} did not load.`);
  return { open: entry.path };
}

/** The context line that opens each user message: what is on screen right now. */
export function contextBlock(): string {
  const ed = ED(); const st = ed?.api?.state; const open = openEntry(); const doc = ed?.kdoc;
  if (!st || !st.project) return "";
  const lines = [`Project: ${st.project.name}`];
  if (open && doc) {
    lines.push(`Open document: ${open.path} (${doc.type === "sch" ? "schematic sheet" : "board"})`);
    const ids: string[] = Array.from(ed.selection || []); if (!ids.length && ed.selected) ids.push(ed.selected.id);
    const names = ids.map((id) => doc.items.get(id)).filter(Boolean).map((it: any) => it.ref || it.kind);
    lines.push(names.length ? `Selected: ${names.slice(0, 12).join(", ")}${names.length > 12 ? ` and ${names.length - 12} more` : ""}` : "Selected: nothing");
  } else lines.push("Open document: none");
  if (ed.viewOnly) lines.push("This person has view-only access: they can read the design but cannot accept proposals.");
  return `<editor_context>\n${lines.join("\n")}\n</editor_context>`;
}
