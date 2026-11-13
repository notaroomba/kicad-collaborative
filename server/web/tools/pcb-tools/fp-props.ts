// pcb-tools/fp-props.ts — DIALOG_FOOTPRINT_PROPERTIES_FP_EDITOR (pcbnew/dialogs/dialog_footprint_properties_fp_editor.cpp)
// without its DOM: what the dialog reads from the footprint being edited, KiCad's Validate(), and the changes its
// TransferDataFromWindow() makes, as one "Edit Footprint Properties" step.
//
// The footprint is the document (canvas/footprint-doc.ts): its fields are items of kind "property", everything else
// the dialog edits (name, descr, tags, height, attr, clearances, zone_connect, stackup, private_layers,
// net_tie_pad_groups, duplicate_pad_numbers_are_jumpers, jumper_pad_groups, model) lives in the header, which travels
// as the change with id "footprint".  Only what the user changed is touched: a header key nobody edited keeps its
// node (and so its text in the file).
type SAtom = string | number | SNode;
import type { BoardDoc, PcbChange } from "./types";
import { K } from "./state";
import { addedChange, removedChange, replacedChange } from "./changes";
import { clone, isList, r6 } from "./util";

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const num = (v: unknown, d = 0) => (typeof v === "number" ? v : v !== undefined && v !== null && v !== "" && isFinite(Number(v)) ? Number(v) : d);
const yes = (n: SNode | null) => !!n && (n.length < 2 || str(n[1]) !== "no");

/** TEXT_MIN_SIZE_MM / TEXT_MAX_SIZE_MM (eda_text.h). */
export const TEXT_MIN_SIZE_MM = 0.001, TEXT_MAX_SIZE_MM = 250;
/** FOOTPRINT::StringLibNameInvalidChars( true ). */
export const LIB_NAME_INVALID = "\\ / : \" * ? < > |";
const INVALID_RE = /[\\/:"*?<>|]/;
/** ZONE_CONNECTION as the file writes it, in the dialog's choice order. */
export const ZONE_CHOICES: [string, string][] = [["", "Use zone setting"], ["2", "Solid"], ["1", "Thermal relief"], ["0", "None"]];
export const COPPER_COUNTS = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32];

export interface FpFieldRow {
  /** the field item's id ("" for a field added in the dialog) */
  id: string; name: string; value: string; show: boolean; w: number; h: number; thick: number; italic: boolean; layer: string;
  rot: number; unconstrained: boolean; x: number; y: number;
}
export interface Fp3DModel { file: string; show: boolean; opacity: number; offset: number[]; scale: number[]; rotate: number[] }
export interface FpPropsModel {
  name: string; descr: string; tags: string; height: number;
  type: "through_hole" | "smd" | ""; excludeFromSim: boolean; boardOnly: boolean; dnp: boolean; excludeFromBom: boolean; excludeFromPos: boolean;
  /** NaN: blank (the netclass / board value) */
  clearance: number; maskMargin: number; pasteMargin: number; pasteRatio: number;
  allowBridges: boolean; noCourtyard: boolean; zoneConnect: string;
  privateLayers: string[]; customStackup: boolean; copperCount: number; userLayers: string[];
  netTieGroups: string[]; dupPadsAreJumpers: boolean; jumperGroups: string[];
  models: Fp3DModel[];
  fields: FpFieldRow[];
  /** attr tokens this dialog does not edit (kept as they are) */
  otherAttrs: string[];
  /** PANEL_EMBEDDED_FILES: the footprint's (embedded_files (file (name …) …)) by name, and (embedded_fonts) */
  embeddedFiles: string[]; embedFonts: boolean;
}

const header = (doc: BoardDoc): SNode | null => { const st = (doc as unknown as { fpState?: { fp: SNode } }).fpState; return st ? st.fp : null; };
const fieldName = (n: SNode) => (n[0] === "fp_text" ? (n[1] === "reference" ? "Reference" : n[1] === "value" ? "Value" : str(n[1])) : str(n[1]));
const MANDATORY = ["Reference", "Value", "Datasheet", "Description"];

/** The fields of the footprint in KiCad's order: Reference, Value, Datasheet, Description, then the user fields as in the file. */
export function fieldItems(doc: BoardDoc): KItem[] {
  const all = Array.from(doc.items.values()).filter((i) => i.kind === "property");
  const rank = (it: KItem) => { const i = MANDATORY.indexOf(fieldName(it.node)); return i >= 0 ? i : MANDATORY.length; };
  return all.map((it, i) => ({ it, i })).sort((a, b) => rank(a.it) - rank(b.it) || a.i - b.i).map((x) => x.it);
}

function fieldRow(it: KItem): FpFieldRow {
  const p = it.node; const at = K.kid(p, "at") || []; const e = K.kid(p, "effects"); const f = e ? K.kid(e, "font") : null;
  const sz = f ? K.kid(f, "size") : null; const th = f ? K.kid(f, "thickness") : null;
  const hide = K.kid(p, "hide"); const hidden = hide ? yes(hide) : !!(e && (e.includes("hide") || yes(K.kid(e, "hide"))));
  const italic = !!(f && (f.includes("italic") || yes(K.kid(f, "italic"))));
  const unl = !!(at.includes("unlocked") || yes(K.kid(p, "unlocked")));
  return { id: it.id, name: fieldName(p), value: str(p[2]), show: !hidden, w: num(sz && sz[2], 1), h: num(sz && sz[1], 1), thick: num(th && th[1], 0.15), italic,
    layer: str((K.kid(p, "layer") || [])[1]) || "F.Fab", rot: num(at[3], 0), unconstrained: unl, x: num(at[1]), y: num(at[2]) };
}

function xyz(n: SNode | null, key: string, d: number): number[] { const k = n ? K.kid(n, key) : null; const v = k ? K.kid(k, "xyz") : null; return v ? [num(v[1], d), num(v[2], d), num(v[3], d)] : [d, d, d]; }

/** DIALOG_FOOTPRINT_PROPERTIES_FP_EDITOR::TransferDataToWindow. */
export function readFpProps(doc: BoardDoc): FpPropsModel {
  const h = header(doc) || ["footprint", ""];
  const one = (key: string) => K.kid(h, key);
  const attrs = (one("attr") || []).slice(1).map(str);
  const opt = (key: string) => { const k = one(key); return k ? num(k[1], NaN) : NaN; };
  const zc = one("zone_connect");
  const stack = one("stackup");
  const stackLayers = stack ? K.kids(stack, "layer").map((l: SNode) => str(l[1])) : [];
  const usedLayers = new Set<string>(); for (const it of doc.items.values()) { const l = K.kid(it.node, "layer"); if (l) usedLayers.add(str(l[1])); const ls = K.kid(it.node, "layers"); if (ls) ls.slice(1).forEach((x: SAtom) => usedLayers.add(str(x))); }
  const nt = one("net_tie_pad_groups");
  const jg = one("jumper_pad_groups");
  const known = ["through_hole", "smd", "board_only", "exclude_from_pos_files", "exclude_from_bom", "exclude_from_sim", "allow_missing_courtyard", "dnp", "allow_soldermask_bridges"];
  const models: Fp3DModel[] = K.kids(h, "model").filter((m: SNode) => typeof m[1] === "string").map((m: SNode) => {
    const hide = K.kid(m, "hide"); const op = K.kid(m, "opacity");
    return { file: str(m[1]), show: !(hide ? yes(hide) : m.includes("hide")), opacity: op ? num(op[1], 1) : 1, offset: xyz(m, "offset", 0), scale: xyz(m, "scale", 1), rotate: xyz(m, "rotate", 0) };
  });
  const cuCount = stack ? stackLayers.filter((l: string) => /\.Cu$/.test(l)).length : minimalCopperCount(usedLayers);
  return {
    name: str(h[1]), descr: str((one("descr") || [])[1]), tags: str((one("tags") || [])[1]), height: opt("height"),
    type: attrs.includes("through_hole") ? "through_hole" : attrs.includes("smd") ? "smd" : "",
    excludeFromSim: attrs.includes("exclude_from_sim"), boardOnly: attrs.includes("board_only"), dnp: attrs.includes("dnp"), excludeFromBom: attrs.includes("exclude_from_bom"), excludeFromPos: attrs.includes("exclude_from_pos_files"),
    clearance: opt("clearance"), maskMargin: opt("solder_mask_margin"), pasteMargin: opt("solder_paste_margin"), pasteRatio: one("solder_paste_margin_ratio") ? opt("solder_paste_margin_ratio") : opt("solder_paste_ratio"),
    allowBridges: attrs.includes("allow_soldermask_bridges"), noCourtyard: attrs.includes("allow_missing_courtyard"), zoneConnect: zc ? str(zc[1]) : "",
    privateLayers: (one("private_layers") || []).slice(1).map(str),
    customStackup: !!stack, copperCount: COPPER_COUNTS.includes(cuCount) ? cuCount : 2,
    userLayers: stack ? stackLayers.filter((l: string) => /^User\.\d+$/.test(l)) : Array.from(usedLayers).filter((l) => /^User\.\d+$/.test(l)),
    netTieGroups: nt ? nt.slice(1).map(str).filter(Boolean) : [], dupPadsAreJumpers: yes(one("duplicate_pad_numbers_are_jumpers")),
    jumperGroups: jg ? jg.slice(1).filter(isList).map((g: SNode) => g.map(str).join(", ")) : [],
    models, fields: fieldItems(doc).map(fieldRow), otherAttrs: attrs.filter((a: string) => !known.includes(a)),
    embeddedFiles: K.kids(one("embedded_files") || ["embedded_files"], "file").map((f: SNode) => str((K.kid(f, "name") || [])[1])).filter(Boolean),
    embedFonts: yes(one("embedded_fonts")),
  };
}

/** LAYER_UTILS::MinimalCopperLayerCount: the inner layers a footprint uses, rounded up to an even count. */
export function minimalCopperCount(used: Iterable<string>): number {
  let inner = 0; for (const l of used) { const m = /^In(\d+)\.Cu$/.exec(l); if (m) inner = Math.max(inner, Number(m[1])); }
  const n = inner + 2; return n % 2 ? n + 1 : n;
}

/** ClampTextPenSize (gr_text.cpp): a quarter of the smaller text dimension (bold allowed 1/4.0 too). */
export function clampTextPenSize(thick: number, w: number, h: number): number { const s = Math.min(Math.abs(w), Math.abs(h)); return Math.min(thick, s * 0.25); }

/** DIALOG_FOOTPRINT_PROPERTIES_FP_EDITOR::Validate (and the jumper-group check of TransferDataFromWindow): the first error, or null. */
export function validateFpProps(doc: BoardDoc, m: FpPropsModel, opts?: { fmt?: (mm: number) => string; libHas?: (name: string) => boolean }): { msg: string; page: number; row?: number; col?: string; fix?: () => void; overwrite?: string } | null {
  const fmt = (opts && opts.fmt) || ((v: number) => `${r6(v)} mm`);
  const name = m.name;
  if (!name) return { msg: "Footprint must have a name.", page: 0 };
  if (INVALID_RE.test(name)) return { msg: `Footprint name may not contain '${LIB_NAME_INVALID}'.`, page: 0 };
  for (let i = 0; i < m.fields.length; i++) {
    const f = m.fields[i];
    if (!f.name) return { msg: "Fields must have a name.", page: 0, row: i, col: "name" };
    if (!(f.w >= TEXT_MIN_SIZE_MM && f.w <= TEXT_MAX_SIZE_MM)) return { msg: `The text width must be between ${fmt(TEXT_MIN_SIZE_MM)} and ${fmt(TEXT_MAX_SIZE_MM)}.`, page: 0, row: i, col: "w" };
    if (!(f.h >= TEXT_MIN_SIZE_MM && f.h <= TEXT_MAX_SIZE_MM)) return { msg: `The text height must be between ${fmt(TEXT_MIN_SIZE_MM)} and ${fmt(TEXT_MAX_SIZE_MM)}.`, page: 0, row: i, col: "h" };
    const max = clampTextPenSize(f.thick, f.w, f.h);
    if (f.thick > max + 1e-9) return { msg: "The text thickness is too large for the text size.\nIt will be clamped.", page: 0, row: i, col: "thick", fix: () => { f.thick = r6(max); } };
  }
  const seen = new Set<string>();
  for (let i = 0; i < m.fields.length; i++) { const n = m.fields[i].name; if (seen.has(n)) return { msg: `Field name '${n}' already in use.`, page: 0, row: i, col: "name" }; seen.add(n); }
  if (isFinite(m.clearance) && m.clearance < 0) return { msg: "Pad clearance must be greater than or equal to 0 mm.", page: 2 };
  if (m.customStackup) {
    const allowed = new Set<string>(customLayerSet(m));
    const orphans = new Set<string>();
    for (const it of doc.items.values()) {
      const ls: string[] = []; const l = K.kid(it.node, "layer"); if (l) ls.push(str(l[1])); const lss = K.kid(it.node, "layers"); if (lss) ls.push(...lss.slice(1).map(str));
      for (const x of ls) if ((/\.Cu$/.test(x) || /^User\.\d+$/.test(x)) && !/^\*/.test(x) && !allowed.has(x)) orphans.add(x);
    }
    if (orphans.size) return { msg: `You are trying to remove layers that are used by the footprint: ${Array.from(orphans).join(", ")}.\nPlease remove the objects that use these layers first.`, page: 1 };
  }
  const pads = new Set<string>(); for (const it of doc.items.values()) if (it.kind === "pad") pads.add(str(it.node[1]));
  for (let i = 0; i < m.jumperGroups.length; i++) for (const t of splitPadList(m.jumperGroups[i])) if (!pads.has(t)) return { msg: `Pad '${t}' in jumper pad group ${i + 1} does not exist in this footprint.`, page: 3 };
  const orig = header(doc); const origName = orig ? str(orig[1]) : "";
  if (name !== origName && opts && opts.libHas && opts.libHas(name)) return { msg: "", page: 0, overwrite: name };
  return null;
}

/** The pad numbers of a jumper group cell (wxStringTokenizer on ", \t\r\n"). */
export function splitPadList(text: string): string[] { return text.split(/[,\s]+/).filter(Boolean); }

/** getCustomLayersFromControls: the copper count's layers plus the chosen user layers. */
export function customLayerSet(m: FpPropsModel): string[] {
  const n = m.copperCount; const out = ["F.Cu"]; for (let i = 1; i <= n - 2; i++) out.push(`In${i}.Cu`); out.push("B.Cu");
  return out.concat(m.userLayers);
}

/** The text the solder paste box shows: offset and ratio together ("-0.1 mm - 5%"), blank when neither is set. */
export function formatPaste(offset: number, ratio: number, fmt: (mm: number) => string): string {
  const parts: string[] = [];
  if (isFinite(offset)) parts.push(fmt(offset));
  if (isFinite(ratio)) { const pc = r6(ratio * 100); parts.push(parts.length ? `${pc < 0 ? "-" : "+"} ${Math.abs(pc)}%` : `${pc}%`); }
  return parts.join(" ");
}
/** PASTE margin binder: "-0.1mm", "-5%", "-0.1mm - 5%"; null for text it cannot read. */
export function parsePaste(text: string, parseLen: (t: string) => number): { offset: number; ratio: number } | null {
  const t = text.trim(); if (!t) return { offset: NaN, ratio: NaN };
  const m = /^(.*?)([+-]?)\s*([+-]?\d*[.,]?\d+)\s*%$/.exec(t);
  let lenPart = t, ratio = NaN;
  if (m) { const sign = m[2] === "-" ? -1 : 1; ratio = sign * Number(m[3].replace(",", ".")) / 100; lenPart = m[1].trim(); if (m[2] && !lenPart) ratio = sign * Math.abs(Number(m[3].replace(",", "."))) / 100; }
  if (!lenPart) return { offset: NaN, ratio };
  const off = parseLen(lenPart); if (!isFinite(off)) return null;
  return { offset: off, ratio };
}

/** A string atom KiCad writes quoted. */
export const qs = (v: string) => '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
/** A node from its text (the reader records which atoms are quoted, so it is written back the same way). */
const mk = (text: string): SNode => K.parse(text) as SNode;
/** Set (key …) in the header, at the end (the writer orders the header by format( FOOTPRINT )); null removes it. */
function setHeader(h: SNode, key: string, vals: SAtom[] | string | null): void {
  const i = h.findIndex((c, j) => j > 1 && isList(c) && c[0] === key);
  if (vals === null) { if (i > 0) h.splice(i, 1); return; }
  const node: SNode = typeof vals === "string" ? mk(`(${key} ${vals})`) : [key, ...vals];
  if (i > 0) { const cur = h[i] as SNode; if (K.serialize(cur) !== K.serialize(node)) h[i] = node; } else h.push(node);
}
const optNum = (h: SNode, key: string, v: number) => { const cur = K.kid(h, key); if (isFinite(v)) { if (!cur || num(cur[1], NaN) !== r6(v)) setHeader(h, key, [r6(v)]); } else if (cur) setHeader(h, key, null); };

function modelNode(m: Fp3DModel): SNode {
  const xyzT = (v: number[]) => `(xyz ${v.map(r6).join(" ")})`;
  return mk(`(model ${qs(m.file)}${m.show ? "" : " (hide yes)"}${m.opacity !== 1 ? ` (opacity ${m.opacity.toFixed(4)})` : ""} (offset ${xyzT(m.offset)}) (scale ${xyzT(m.scale)}) (rotate ${xyzT(m.rotate)}))`);
}
const modelSig = (m: Fp3DModel) => JSON.stringify([m.file, m.show, +m.opacity.toFixed(4), m.offset.map(r6), m.scale.map(r6), m.rotate.map(r6)]);

/** The new field's node: PCB_FIELD with the layer's text defaults (the caller fills the row from them). */
function newFieldNode(r: FpFieldRow): SNode {
  return mk(`(property ${qs(r.name)} ${qs(r.value)} (at ${r6(r.x)} ${r6(r.y)} ${r6(r.rot)}) (layer ${qs(r.layer)})${r.unconstrained ? " (unlocked yes)" : ""}${r.show ? "" : " (hide yes)"}`
    + ` (uuid ${qs(K.newUuid())}) (effects (font (size ${r6(r.h)} ${r6(r.w)}) (thickness ${r6(r.thick)})${r.italic ? " (italic yes)" : ""})))`);
}
/** Apply a row to a field node (a copy): only what differs is rewritten. */
function applyFieldRow(p: SNode, r: FpFieldRow, modern: boolean): void {
  const cur = fieldRow({ id: "", kind: "property", node: p } as KItem);
  if (p[0] === "fp_text") { if (r.value !== cur.value) p[2] = r.value; }
  else { if (r.name !== cur.name) p[1] = r.name; if (r.value !== cur.value) p[2] = r.value; }
  if (r.x !== cur.x || r.y !== cur.y || r.rot !== cur.rot) {
    const a = K.kid(p, "at"); const rest = a ? a.slice(4).filter((x: SAtom) => x !== "unlocked") : [];
    const na: SNode = ["at", r6(r.x), r6(r.y)]; if (r.rot || (a && a.length > 3 && typeof a[3] === "number")) na.push(r6(r.rot)); na.push(...rest);
    if (a) p[p.indexOf(a)] = na; else p.splice(2 + (p[0] === "fp_text" ? 1 : 1), 0, na);
  }
  if (r.layer !== cur.layer) { const l = K.kid(p, "layer"); if (l) l[1] = r.layer; }
  if (r.unconstrained !== cur.unconstrained) {
    const a = K.kid(p, "at"); if (a) { const i = a.indexOf("unlocked"); if (i > 0) a.splice(i, 1); }
    const u = K.kid(p, "unlocked"); if (u) p.splice(p.indexOf(u), 1);
    if (r.unconstrained) { const l = K.kid(p, "layer"); p.splice(l ? p.indexOf(l) + 1 : p.length, 0, ["unlocked", "yes"]); }
  }
  if (r.show !== cur.show) {
    const e = K.kid(p, "effects"); if (e) { const i = e.indexOf("hide"); if (i > 0) e.splice(i, 1); const hk = K.kid(e, "hide"); if (hk) e.splice(e.indexOf(hk), 1); }
    const hk = K.kid(p, "hide"); if (hk) p.splice(p.indexOf(hk), 1);
    if (!r.show) { const before = ["uuid", "effects"].map((k) => K.kid(p, k)).find(Boolean); p.splice(before ? p.indexOf(before) : p.length, 0, ["hide", "yes"]); }
  }
  if (r.w === cur.w && r.h === cur.h && r.thick === cur.thick && r.italic === cur.italic) return;
  let e = K.kid(p, "effects"); if (!e) { e = ["effects"]; p.push(e); }
  let f = K.kid(e, "font"); if (!f) { f = ["font"]; e.splice(1, 0, f); }
  if (r.w !== cur.w || r.h !== cur.h) { const s = K.kid(f, "size"); const ns: SNode = ["size", r6(r.h), r6(r.w)]; if (s) f[f.indexOf(s)] = ns; else f.splice(1, 0, ns); }
  if (r.thick !== cur.thick) { const t = K.kid(f, "thickness"); const nt: SNode = ["thickness", r6(r.thick)]; if (t) f[f.indexOf(t)] = nt; else { const s = K.kid(f, "size"); f.splice(s ? f.indexOf(s) + 1 : f.length, 0, nt); } }
  if (r.italic !== cur.italic) {
    const bi = f.indexOf("italic"); if (bi > 0) f.splice(bi, 1); const ik = K.kid(f, "italic"); if (ik) f.splice(f.indexOf(ik), 1);
    if (r.italic) { const c = K.kid(f, "color"); const v: SAtom = modern ? ["italic", "yes"] : "italic"; f.splice(c ? f.indexOf(c) : f.length, 0, v); }
  }
}

/** DIALOG_FOOTPRINT_PROPERTIES_FP_EDITOR::TransferDataFromWindow: the changes (empty when nothing differs). */
export function fpPropsChanges(doc: BoardDoc, m: FpPropsModel): PcbChange[] {
  const h0 = header(doc); if (!h0) return [];
  const before = readFpProps(doc);
  const h = clone(h0);
  if (m.name !== before.name) h[1] = m.name;
  if (m.descr !== before.descr) setHeader(h, "descr", m.descr ? qs(m.descr) : null);
  if (m.tags !== before.tags) setHeader(h, "tags", m.tags ? qs(m.tags) : null);
  if (!(isNaN(m.height) && isNaN(before.height)) && m.height !== before.height) setHeader(h, "height", isFinite(m.height) && m.height !== 0 ? [r6(m.height)] : null);
  // attributes, in the writer's token order
  const attrKeys: [keyof FpPropsModel, string][] = [["boardOnly", "board_only"], ["excludeFromPos", "exclude_from_pos_files"], ["excludeFromBom", "exclude_from_bom"], ["excludeFromSim", "exclude_from_sim"], ["noCourtyard", "allow_missing_courtyard"], ["dnp", "dnp"], ["allowBridges", "allow_soldermask_bridges"]];
  const attrChanged = m.type !== before.type || attrKeys.some(([k]) => m[k] !== before[k]);
  if (attrChanged) {
    const toks: string[] = []; if (m.type === "smd") toks.push("smd"); if (m.type === "through_hole") toks.push("through_hole");
    for (const [k, t] of attrKeys) if (m[k]) toks.push(t);
    toks.push(...m.otherAttrs);
    setHeader(h, "attr", toks.length ? toks : null);
  }
  optNum(h, "clearance", m.clearance); optNum(h, "solder_mask_margin", m.maskMargin); optNum(h, "solder_paste_margin", m.pasteMargin);
  if (!(isNaN(m.pasteRatio) && isNaN(before.pasteRatio)) && m.pasteRatio !== before.pasteRatio) {
    if (K.kid(h, "solder_paste_ratio")) setHeader(h, "solder_paste_ratio", null);
    setHeader(h, "solder_paste_margin_ratio", isFinite(m.pasteRatio) ? [r6(m.pasteRatio)] : null);
  }
  if (m.zoneConnect !== before.zoneConnect) setHeader(h, "zone_connect", m.zoneConnect === "" ? null : [Number(m.zoneConnect)]);
  if (m.customStackup !== before.customStackup || (m.customStackup && (m.copperCount !== before.copperCount || m.userLayers.join() !== before.userLayers.join()))) {
    if (!m.customStackup) setHeader(h, "stackup", null);
    else setHeader(h, "stackup", sortLayers(customLayerSet(m)).map((l) => `(layer ${qs(l)})`).join(" "));
  }
  if (m.privateLayers.join() !== before.privateLayers.join()) setHeader(h, "private_layers", m.privateLayers.length ? sortLayers(m.privateLayers).map(qs).join(" ") : null);
  const nt = m.netTieGroups.map((g) => g.trim()).filter(Boolean);
  if (nt.join("\n") !== before.netTieGroups.join("\n")) setHeader(h, "net_tie_pad_groups", nt.length ? nt.map(qs).join(" ") : null);
  if (m.dupPadsAreJumpers !== before.dupPadsAreJumpers) setHeader(h, "duplicate_pad_numbers_are_jumpers", [m.dupPadsAreJumpers ? "yes" : "no"]);
  const jg = m.jumperGroups.map((g) => Array.from(new Set(splitPadList(g))).sort()).filter((g) => g.length > 1);
  const jgBefore = before.jumperGroups.map((g) => Array.from(new Set(splitPadList(g))).sort());
  if (JSON.stringify(jg) !== JSON.stringify(jgBefore)) setHeader(h, "jumper_pad_groups", jg.length ? jg.map((g) => "(" + g.map(qs).join(" ") + ")").join(" ") : null);
  if (m.models.map(modelSig).join() !== before.models.map(modelSig).join()) {
    // the models keep the place of the first one (the writer orders the header anyway)
    const old = h.filter((c, j) => j > 1 && isList(c) && c[0] === "model" && typeof c[1] === "string") as SNode[];
    const oldBySig = new Map<string, SNode>(); old.forEach((n, i) => oldBySig.set(modelSig(before.models[i]), n));
    for (const n of old) h.splice(h.indexOf(n), 1);
    for (const mm of m.models.filter((x) => x.file)) h.push(oldBySig.get(modelSig(mm)) || modelNode(mm));
  }
  if (m.embedFonts !== before.embedFonts) setHeader(h, "embedded_fonts", [m.embedFonts ? "yes" : "no"]);
  if ((m.embeddedFiles || []).join("\n") !== before.embeddedFiles.join("\n")) {
    // only removal happens here: a file dropped from the list goes, and an empty list drops (embedded_files) as the writer does
    const ef = K.kid(h, "embedded_files"); const keepNames = new Set(m.embeddedFiles || []);
    if (ef) { for (let j = ef.length - 1; j >= 1; j--) { const c = ef[j]; if (isList(c) && c[0] === "file" && !keepNames.has(str((K.kid(c, "name") || [])[1]))) ef.splice(j, 1); }
      if (!K.kids(ef, "file").length) setHeader(h, "embedded_files", null); }
  }
  const changes: PcbChange[] = [];
  if (K.serialize(h) !== K.serialize(h0)) changes.push({ id: "footprint", kind: "MODIFIED", typeName: "FOOTPRINT", sexpr: K.serialize(h) } as PcbChange);
  // fields: FOOTPRINT::UpdateFields — reused by id, the rest added, the missing ones removed
  const modern = ((doc as unknown as { version?: number }).version || 20240108) >= 20230000;
  const keep = new Set<string>();
  for (const r of m.fields) {
    const it = r.id ? doc.items.get(r.id) : null;
    if (!it) { changes.push(addedChange(doc, newFieldNode(r))); continue; }
    keep.add(it.id);
    const n = clone(it.node); applyFieldRow(n, r, modern);
    if (K.serialize(n) !== K.serialize(it.node)) changes.push(replacedChange(it, n));
  }
  for (const it of fieldItems(doc)) if (!keep.has(it.id) && !changes.some((c) => c.id === it.id)) changes.push(removedChange(it));
  return changes;
}

/** LSET::Seq order: F.Cu, In*.Cu, B.Cu, then the technical / user layers in the board's id order. */
const LAYER_ORDER = ["F.Cu", ...Array.from({ length: 30 }, (_, i) => `In${i + 1}.Cu`), "B.Cu", "F.Mask", "B.Mask", "F.SilkS", "B.SilkS", "F.Adhes", "B.Adhes", "F.Paste", "B.Paste", "Dwgs.User", "Cmts.User", "Eco1.User", "Eco2.User", "Edge.Cuts", "Margin", "B.CrtYd", "F.CrtYd", "B.Fab", "F.Fab", ...Array.from({ length: 45 }, (_, i) => `User.${i + 1}`)];
export function sortLayers(ls: string[]): string[] { const r = (l: string) => { const i = LAYER_ORDER.indexOf(l); return i < 0 ? 999 : i; }; return Array.from(new Set(ls)).sort((a, b) => r(a) - r(b)); }

/** OnAddField: GetUserFieldName( n ) with the active layer when it is a technical one, else the last field's layer, and that layer's text defaults. */
export function newFieldRow(m: FpPropsModel, activeLayer: string, textStyle: (layer: string) => { w: number; h: number; thick: number; italic: boolean }): FpFieldRow {
  const tech = /^[FB]\.(SilkS|Mask|Adhes|Paste|CrtYd|Fab)$/.test(activeLayer);
  const layer = tech ? activeLayer : (m.fields.length ? m.fields[m.fields.length - 1].layer : "F.Fab");
  const s = textStyle(layer);
  let i = m.fields.length; let name = `Field${i}`;   // GetUserFieldName( m_fields->size() )
  const used = new Set(m.fields.map((f) => f.name)); while (used.has(name)) name = `Field${++i}`;
  return { id: "", name, value: "", show: true, w: s.w, h: s.h, thick: s.thick, italic: s.italic, layer, rot: 0, unconstrained: false, x: 0, y: 0 };
}
/** OnDeleteField: the mandatory fields (Reference, Value, Datasheet, Description) cannot go. */
export const isMandatoryName = (name: string) => MANDATORY.includes(name);

export const fpPropsApi = { readFpProps, validateFpProps, fpPropsChanges, newFieldRow, fieldItems, parsePaste, formatPaste, customLayerSet, sortLayers, minimalCopperCount, clampTextPenSize, splitPadList, ZONE_CHOICES, COPPER_COUNTS, isMandatoryName };
