// pcb-tools/exchange.ts — the board side of the Footprint Editor, at the file level:
//
//   editableCopy(boardFp)     FOOTPRINT_EDIT_FRAME::findOrCreateFootprintInstanceTab (footprint_edit_frame.cpp:1247):
//                             the copy a board footprint is edited as — fresh uuids with a map back to the board's,
//                             unlocked, nets cleared, at the origin, back on the front, orientation 0, unit scale
//   exchangeFootprint(...)    BOARD::ExchangeFootprint (board_exchange_footprint.cpp:177) with the arguments
//                             SaveFootprintToBoard passes (match pad positions, every reset flag at its default)
//   footprintShift(...)       ComputeFootprintShift (footprint_utils.cpp:43): where the new footprint must sit so its
//                             uniquely numbered pads land where the old one's are (an anchor moved in the editor)
//   boardCopyFromEditor(...)  SaveFootprintToBoard's clone: the editor's uuids mapped back to the board's (new
//                             children get fresh ones)
//
// Everything is plain node editing (no DOM), so the node tests drive it.
import { flipFootprintNode, rotateFootprintNode, setFootprintAt } from "./footprint";
import { K } from "./state";
import { isList, r6, rotator } from "./util";

type Pt2 = [number, number];
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));

/** Every (uuid X) / (tstamp X) inside n (not n's own), depth first. */
function eachChildUuid(n: SNode, fn: (u: SNode) => void): void {
  for (let i = 1; i < n.length; i++) { const c = n[i]; if (!isList(c)) continue; if ((c[0] === "uuid" || c[0] === "tstamp") && c.length > 1) fn(c); else eachChildUuid(c, fn); }
}
/** A footprint's own (uuid …) (a direct child). */
function ownUuid(n: SNode): SNode | null { return K.kid(n, "uuid") || K.kid(n, "tstamp"); }

function setLocked(n: SNode, on: boolean): void {
  for (let i = n.length - 1; i > 0; i--) { const c = n[i]; if (c === "locked" || (isList(c) && c[0] === "locked")) n.splice(i, 1); }
  if (on) { const lay = K.kid(n, "layer"); n.splice(lay ? n.indexOf(lay) : 2, 0, ["locked", "yes"]); }
}
function stripNets(n: SNode): void { for (let i = n.length - 1; i > 0; i--) { const c = n[i]; if (isList(c) && c[0] === "net") n.splice(i, 1); } }

/** The footprint's transform scale [sx, sy] (1, 1 without one). */
function scaleOf(n: SNode): Pt2 { const t = K.kid(n, "transform"); const s = t && K.kid(t, "scale"); return s ? [K.num(s[1], 1) || 1, K.num(s[2], 1) || 1] : [1, 1]; }
function setScale(n: SNode, sx: number, sy: number): void { const t = K.kid(n, "transform"); if (!t) return; const s = K.kid(t, "scale"); if (s) { s[1] = sx; s[2] = sy; } else t.push(["scale", sx, sy]); }

export interface EditableCopy {
  /** the footprint as the editor holds it: (footprint "lib:name" (version …) …) at the origin */
  node: SNode;
  /** editor uuid -> board uuid, for every item that had one (the footprint's own included) */
  uuidMap: Record<string, string>;
  /** the board footprint's uuid (FOOTPRINT::GetLink of the copy) */
  link: string;
  reference: string;
}

/**
 * The editable copy of a board footprint (findOrCreateFootprintInstanceTab): Clone, SetLink(board uuid), unlocked,
 * every uuid replaced by a fresh one (the map remembers the board's), ClearAllNets, position (0, 0), flipped back to
 * the front if on the back, orientation 0 and scale 1 (FOOTPRINT_EDIT_FRAME: "Normalize placement to the
 * footprint-editor defaults so the editor view matches a library load").
 */
export function editableCopy(boardFp: SNode, boardVersion?: number): EditableCopy {
  const n = K.cloneNode(boardFp);
  const uuidMap: Record<string, string> = {};
  const own = ownUuid(n); const link = own ? str(own[1]) : "";
  const fresh = (u: SNode) => { const id = K.newUuid(); uuidMap[id] = str(u[1]); u[0] = "uuid"; u[1] = id; };
  if (own) fresh(own);
  // group members name children by uuid: remember the old -> new so the lists follow
  const back: Record<string, string> = {};
  eachChildUuid(n, (u) => { fresh(u); back[uuidMap[str(u[1])]] = str(u[1]); });
  for (const g of K.kids(n, "group")) { const m = K.kid(g, "members"); if (m) for (let i = 1; i < m.length; i++) { const nu = back[str(m[i])]; if (nu) m[i] = nu; } }
  setLocked(n, false);
  for (const c of n) if (isList(c) && c[0] === "pad") { setLocked(c, false); stripNets(c); }
  for (const c of n) if (isList(c) && c[0] === "zone") stripNets(c);
  const [, , rot] = K.atOf(n);
  setFootprintAt(n, 0, 0, rot);
  if (str((K.kid(n, "layer") || [])[1]) !== "F.Cu") flipFootprintNode(n);
  const a = K.atOf(n)[2]; if (a) rotateFootprintNode(n, -a);
  setScale(n, 1, 1);
  // a .kicad_mod carries its own version stamp: the board's, so the editor reads the children as the board did
  if (!K.kid(n, "version")) n.splice(2, 0, ["version", boardVersion || 20260728], ["generator", "pcbnew"]);
  const refP = K.kids(n, "property").find((p) => str(p[1]) === "Reference");
  return { node: n, uuidMap, link, reference: refP ? str(refP[2]) : "" };
}

/** ORTHO_ITEM_REALIGNER: the right-angle rotation and translation taking `from` onto `to` (null when none fits). */
export function orthoAlign(to: Pt2[], from: Pt2[], tol = 1e-4): { rot: number; t: Pt2 } | null {
  if (!to.length || to.length !== from.length) return null;
  for (const rot of [0, 90, 180, 270]) {
    const R = rotator(rot); const rf = from.map(([x, y]) => R(x, y));
    const t: Pt2 = [to[0][0] - rf[0][0], to[0][1] - rf[0][1]];
    if (rf.every((p, i) => Math.abs(p[0] + t[0] - to[i][0]) <= tol && Math.abs(p[1] + t[1] - to[i][1]) <= tol)) return { rot, t: [r6(t[0]), r6(t[1])] };
  }
  return null;
}

/** Pads with a number no other pad of the footprint has: number -> library-frame position. */
function uniquePads(fp: SNode): Map<string, Pt2> {
  const out = new Map<string, Pt2>(), dup = new Set<string>();
  for (const p of K.kids(fp, "pad")) {
    const num = str(p[1]); if (dup.has(num)) continue;
    if (out.has(num)) { out.delete(num); dup.add(num); continue; }
    const at = K.kid(p, "at"); out.set(num, [K.num(at && at[1]), K.num(at && at[2])]);
  }
  return out;
}

/**
 * ComputeFootprintShift: the position (board frame, already rotated by the existing orientation) and angle to add so
 * the new footprint's uniquely numbered pads sit on the old one's.  Both footprints are on the same side here.
 */
export function footprintShift(existing: SNode, aNew: SNode): { shift: Pt2; angle: number } | null {
  const a = uniquePads(existing), b = uniquePads(aNew); const ex: Pt2[] = [], nw: Pt2[] = [];
  for (const [num, p] of a) { const q = b.get(num); if (q) { ex.push(p); nw.push(q); } }
  const tr = orthoAlign(ex, nw); if (!tr) return null;
  const [, , orient] = K.atOf(existing);
  const s = rotator(orient)(tr.t[0], tr.t[1]);
  return { shift: [r6(s[0]), r6(s[1])], angle: tr.rot };
}

/**
 * SaveFootprintToBoard's copy: the editor's footprint with each uuid that came from the board mapped back (fixUuid),
 * the others fresh, and the editor-only version / generator stamps gone.
 */
export function boardCopyFromEditor(editorFp: SNode, uuidMap: Record<string, string> | null): SNode {
  const n = K.cloneNode(editorFp);
  const fix = (u: SNode) => { const id = str(u[1]); u[0] = "uuid"; u[1] = uuidMap && uuidMap[id] ? uuidMap[id] : K.newUuid(); };
  const own = ownUuid(n); if (own) fix(own);
  const back: Record<string, string> = {};
  eachChildUuid(n, (u) => { const was = str(u[1]); fix(u); back[was] = str(u[1]); });
  for (const g of K.kids(n, "group")) { const m = K.kid(g, "members"); if (m) for (let i = 1; i < m.length; i++) { const nu = back[str(m[i])]; if (nu) m[i] = nu; } }
  for (let i = n.length - 1; i > 1; i--) { const c = n[i]; if (isList(c) && (c[0] === "version" || c[0] === "generator" || c[0] === "generator_version")) n.splice(i, 1); }
  return n;
}

const field = (fp: SNode, name: string) => K.kids(fp, "property").find((p) => str(p[1]) === name) || K.kids(fp, "fp_text").find((p) => str(p[1]) === name.toLowerCase()) || null;
const COPPER = /(^|\*|\.)Cu$|^\*\.Cu$|^F&B\.Cu$/;
const MANDATORY = ["Reference", "Value", "Datasheet", "Description"];
const SHAPES = /^fp_(line|rect|circle|arc|poly|curve)$/;
/** The footprint's fields (property nodes, legacy reference / value fp_text) other than Reference and Value and the ki_ hidden ones. */
const isField = (c: SNode) => c[0] === "property" || (c[0] === "fp_text" && (str(c[1]) === "reference" || str(c[1]) === "value"));
const fieldName = (c: SNode) => (c[0] === "fp_text" ? (str(c[1]) === "reference" ? "Reference" : "Value") : str(c[1]));
const isRefOrValue = (c: SNode) => isField(c) && (fieldName(c) === "Reference" || fieldName(c) === "Value");
const extraFields = (fp: SNode) => (fp.filter((c) => isList(c) && isField(c as SNode) && !isRefOrValue(c as SNode) && !/^ki_/.test(fieldName(c as SNode))) as SNode[]);
/** GraphicalItems(): footprint texts, text boxes, shapes, dimensions, images (fields, pads, zones and groups are kept apart). */
const graphical = (fp: SNode) => (fp.filter((c) => isList(c) && ((c[0] === "fp_text" && !isField(c as SNode)) || c[0] === "fp_text_box" || SHAPES.test(String(c[0])) || c[0] === "dimension" || c[0] === "image" || c[0] === "table")) as SNode[]);
/** KICAD_T of a footprint child: every fp_ shape is one PCB_SHAPE_T. */
const typeOf = (c: SNode) => (SHAPES.test(String(c[0])) ? "shape" : String(c[0]));

/** The text a text-like node shows: (fp_text user "x" …) / (property "Name" "x" …). */
const textOf = (n: SNode) => str(n[2]);
/** Levenshtein ratio EDA_TEXT::Levenshtein: 1 - distance / longer length. */
export function levenshteinRatio(a: string, b: string): number {
  const m = a.length, n = b.length; if (!m && !n) return 1;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return 1 - prev[n] / Math.max(m, n);
}
const atXY = (n: SNode): Pt2 => { const a = K.kid(n, "at"); return [K.num(a && a[1]), K.num(a && a[2])]; };
const atAngle = (n: SNode) => { const a = K.kid(n, "at"); return K.num(a && a[3]); };
/** EDA_TEXT::Similarity: attributes (effects and angle), position, then the Levenshtein ratio of the texts. */
function textSimilarity(a: SNode, b: SNode): number {
  let s = 1;
  if (kidText(a, "effects") !== kidText(b, "effects") || atAngle(a) !== atAngle(b) || !!K.kid(a, "unlocked") !== !!K.kid(b, "unlocked")) s *= 0.9;
  const pa = atXY(a), pb = atXY(b); if (Math.abs(pa[0] - pb[0]) > 1e-6 || Math.abs(pa[1] - pb[1]) > 1e-6) s *= 0.9;
  return s * levenshteinRatio(textOf(a), textOf(b));
}
/** PCB_FIELD::Similarity: the same name is a match; a mandatory field only matches itself; otherwise the text's similarity. */
function fieldSimilarity(a: SNode, b: SNode): number {
  const na = fieldName(a), nb = fieldName(b);
  if (MANDATORY.includes(na) || MANDATORY.includes(nb)) return na === nb ? 1 : 0;
  return na === nb ? 1 : textSimilarity(a, b);
}
/** BOARD_ITEM::Similarity of the other footprint children: 0.9 for each property (direct child) that differs. */
function itemSimilarity(a: SNode, b: SNode): number {
  if (typeOf(a) !== typeOf(b)) return 0;
  if (a[0] === "fp_text" || a[0] === "fp_text_box") return textSimilarity(a, b);
  let s = a[0] === b[0] ? 1 : 0.9;
  const keys = new Set<string>();
  for (const n of [a, b]) for (const c of n) if (isList(c) && c[0] !== "uuid" && c[0] !== "tstamp") keys.add(String(c[0]));
  for (const k of keys) if (kidText(a, k) !== kidText(b, k)) s *= 0.9;
  return s;
}
/** matchItemsBySimilarity (board_exchange_footprint.cpp): every pair scored, taken greedily from the best down. */
function matchBySimilarity(olds: SNode[], news: SNode[], score: (a: SNode, b: SNode) => number): [SNode, SNode][] {
  const cand: { o: number; w: number; s: number }[] = [];
  olds.forEach((a, o) => news.forEach((b, w) => { const s = score(a, b); if (s > 0) cand.push({ o, w, s }); }));
  cand.sort((x, y) => y.s - x.s || x.o - y.o || x.w - y.w);
  const uo = new Set<number>(), uw = new Set<number>(), out: [SNode, SNode][] = [];
  for (const c of cand) { if (uo.has(c.o) || uw.has(c.w)) continue; uo.add(c.o); uw.add(c.w); out.push([olds[c.o], news[c.w]]); }
  return out;
}

/** Replace (or add / drop) the direct child `key` of n with a copy of `from`'s, keeping its place. */
function copyKid(n: SNode, from: SNode, key: string, before = "uuid"): void {
  const src = K.kid(from, key), cur = K.kid(n, key);
  if (cur && src) { n[n.indexOf(cur)] = K.cloneNode(src); return; }
  if (cur) { n.splice(n.indexOf(cur), 1); return; }
  if (src) { const at = K.kid(n, before); n.splice(at ? n.indexOf(at) : n.length, 0, K.cloneNode(src)); }
}
const layerName = (n: SNode) => str((K.kid(n, "layer") || [])[1]);
const knockout = (n: SNode) => (K.kid(n, "layer") || []).slice(2).includes("knockout");
function setKnockout(n: SNode, on: boolean): void { const l = K.kid(n, "layer"); if (!l) return; const i = l.indexOf("knockout"); if (on && i < 0) l.push("knockout"); else if (!on && i > 1) l.splice(i, 1); }
function setLayerName(n: SNode, name: string): void { const l = K.kid(n, "layer"); if (l) l[1] = name; else { const at = K.kid(n, "uuid"); n.splice(at ? n.indexOf(at) : n.length, 0, ["layer", name]); } }
/** Hidden: (hide yes) on a field (or a legacy bare hide / (effects … hide)). */
function hidden(n: SNode): boolean {
  const h = K.kid(n, "hide"); if (h) return str(h[1]) !== "no";
  if (n.includes("hide")) return true;
  const e = K.kid(n, "effects"); return !!e && (e.includes("hide") || str((K.kid(e, "hide") || ["", "no"])[1]) === "yes");
}
function setHidden(n: SNode, on: boolean): void {
  for (let i = n.length - 1; i > 0; i--) { const c = n[i]; if (c === "hide" || (isList(c) && c[0] === "hide")) n.splice(i, 1); }
  const e = K.kid(n, "effects"); if (e) for (let i = e.length - 1; i > 0; i--) { const c = e[i]; if (c === "hide" || (isList(c) && c[0] === "hide")) e.splice(i, 1); }
  if (on) { const at = K.kid(n, "uuid") || K.kid(n, "effects"); n.splice(at ? n.indexOf(at) : n.length, 0, ["hide", "yes"]); }
}
const font = (n: SNode) => { const e = K.kid(n, "effects"); return e ? K.kid(e, "font") : null; };
const justify = (n: SNode) => { const e = K.kid(n, "effects"); return e ? kidText(e, "justify") : ""; };
function setAtXYA(n: SNode, x: number, y: number, a: number): void {
  let at = K.kid(n, "at"); if (!at) { at = ["at", 0, 0]; const l = K.kid(n, "layer"); n.splice(l ? n.indexOf(l) : 3, 0, at); }
  const had = at.length >= 4; at[1] = r6(x); at[2] = r6(y); if (a || had) at[3] = a; else at.length = 3;
}
const norm360 = (a: number) => ((a % 360) + 360) % 360;
const isLockedText = (n: SNode) => { const l = K.kid(n, "locked"); return !!l && str(l[1]) !== "no"; };

interface TextCtx { posShift: Pt2; angleShift: number; updated: boolean }
/**
 * processTextItem: what of the board text aSrc (the existing footprint's) survives on aDest (the library's) for the
 * reset flags; a reset flag keeps the library's own value and only notes the difference in aUpdated.
 */
function processTextItem(src: SNode, dest: SNode, c: TextCtx, resetText: boolean, resetLayers: boolean, resetEffects: boolean, resetPositions: boolean): void {
  if (resetText) c.updated = c.updated || textOf(src) !== textOf(dest);
  else dest[2] = src[2];
  if (resetLayers) c.updated = c.updated || layerName(src) !== layerName(dest) || hidden(src) !== hidden(dest);
  else { setLayerName(dest, layerName(src)); setHidden(dest, hidden(src)); }
  const origPos = atXY(dest);
  if (resetEffects) {
    const fs = font(src), fd = font(dest);
    c.updated = c.updated || justify(src) !== justify(dest) || (fs ? kidText(fs, "size") : "") !== (fd ? kidText(fd, "size") : "")
      || (fs ? kidText(fs, "thickness") : "") !== (fd ? kidText(fd, "thickness") : "") || knockout(src) !== knockout(dest);
  } else {
    // SetAttributes( aSrc ) keeps the text's own angle (a keep-upright text already turned 180 is turned back)
    let origAngle = norm360(atAngle(dest));
    copyKid(dest, src, "effects", "");
    copyKid(dest, src, "unlocked", "layer");
    if (origAngle >= 180 && !K.kid(dest, "unlocked")) origAngle -= 180;
    setAtXYA(dest, origPos[0], origPos[1], origAngle);
    setKnockout(dest, knockout(src));
  }
  if (resetPositions) {
    const sp = atXY(src); c.updated = c.updated || Math.abs(sp[0] - origPos[0]) > 1e-6 || Math.abs(sp[1] - origPos[1]) > 1e-6 || atAngle(src) !== atAngle(dest);
    setAtXYA(dest, origPos[0], origPos[1], atAngle(dest));
  } else {
    const sp = atXY(src); const p = rotator(-c.angleShift)(sp[0] - c.posShift[0], sp[1] - c.posShift[1]);
    setAtXYA(dest, p[0], p[1], atAngle(src));
  }
  // SetLocked( aSrc.IsLocked() ), SetUuid( aSrc.m_Uuid )
  for (let i = dest.length - 1; i > 0; i--) { const k = dest[i]; if (isList(k) && k[0] === "locked") dest.splice(i, 1); }
  if (isLockedText(src)) { const at = K.kid(dest, "at"); dest.splice(at ? dest.indexOf(at) : 3, 0, ["locked", "yes"]); }
  setUuidFrom(dest, src);
}
function setUuidFrom(dest: SNode, src: SNode): void { const su = ownUuid(src); if (!su) return; const du = ownUuid(dest); if (du) { du[0] = "uuid"; du[1] = su[1]; } else dest.push(["uuid", su[1]]); }
function freshUuid(n: SNode): void { const u = ownUuid(n); if (u) u[1] = K.newUuid(); }
/** A footprint's own transform scale onto n, writing (transform …) in place of (at …) when n has none. */
function applyScale(n: SNode, sx: number, sy: number): void {
  if (K.kid(n, "transform")) { setScale(n, sx, sy); return; }
  if (sx === 1 && sy === 1) return;
  const [x, y, a] = K.atOf(n); const at = K.kid(n, "at"); const i = at ? n.indexOf(at) : 3;
  if (at) n.splice(i, 1);
  n.splice(i, 0, ["transform", ["translate", x, y], ["rotate", a], ["scale", sx, sy]]);
}
/** The footprint's (attr …) flags, allow_soldermask_bridges apart (it is a clearance override). */
const attrFlags = (n: SNode) => (K.kid(n, "attr") || []).slice(1).map(str).filter((f) => f !== "allow_soldermask_bridges").sort().join(" ");
const maskBridges = (n: SNode) => (K.kid(n, "attr") || []).slice(1).map(str).includes("allow_soldermask_bridges");
function setAttr(n: SNode, flags: string[]): void {
  const cur = K.kid(n, "attr");
  if (!flags.length) { if (cur) n.splice(n.indexOf(cur), 1); return; }
  const node: SNode = ["attr", ...flags];
  if (cur) { n[n.indexOf(cur)] = node; return; }
  const before = n.findIndex((c, i) => i > 1 && isList(c) && ["fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "fp_curve", "fp_text", "fp_text_box", "pad", "zone", "group", "model", "embedded_files"].includes(String(c[0])));
  n.splice(before > 0 ? before : n.length, 0, node);
}
const FP_CLEARANCE = ["clearance", "solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "solder_paste_ratio", "zone_connect"];
const PAD_CLEARANCE = ["clearance", "solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "solder_paste_ratio", "zone_connect", "thermal_bridge_width", "thermal_width", "thermal_gap"];
const ITEM_KEYS = new Set(["fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "fp_curve", "fp_text", "fp_text_box", "pad", "zone", "group", "model", "embedded_files", "dimension", "image", "table", "point"]);
/** Where a footprint-level kid goes: before the first item. */
function insertFpKid(n: SNode, kid: SNode): void { const i = n.findIndex((c, j) => j > 1 && isList(c) && ITEM_KEYS.has(String(c[0]))); n.splice(i > 0 ? i : n.length, 0, kid); }
function copyFpKid(n: SNode, from: SNode, key: string): void {
  const src = K.kid(from, key), cur = K.kid(n, key);
  if (cur && src) n[n.indexOf(cur)] = K.cloneNode(src); else if (cur) n.splice(n.indexOf(cur), 1); else if (src) insertFpKid(n, K.cloneNode(src));
}
/** A canonical form of a footprint for FootprintNeedsUpdate: its children's texts, order aside. */
/** A child of a footprint as text with the order of its own properties aside (deeper lists, like points, keep theirs). */
function canon(n: unknown, depth = 0): string {
  if (!isList(n)) return JSON.stringify(n);
  const l = n as SNode;
  if (l[0] === "at" && l.length === 4 && K.num(l[3]) === 0) return canon(l.slice(0, 3), depth);
  if (depth > 0) return K.serialize(l);
  const atoms = l.filter((c) => !isList(c)).map((c) => canon(c)), lists = l.filter((c) => isList(c)).map((c) => canon(c, depth + 1)).sort();
  return "(" + atoms.concat(lists).join(" ") + ")";
}
function canonical(n: SNode): string { return n.slice(2).filter((c) => !(isList(c) && (c[0] === "version" || c[0] === "generator" || c[0] === "generator_version"))).map((c) => canon(c)).sort().join("\n"); }

export interface ExchangeOptions {
  matchPadPositions?: boolean; deleteExtraTexts?: boolean; resetTextLayers?: boolean; resetTextEffects?: boolean; resetTextPositions?: boolean;
  resetTextContent?: boolean; resetFabricationAttrs?: boolean; resetClearanceOverrides?: boolean; reset3DModels?: boolean; resetTransform?: boolean;
}
/** BOARD::ExchangeFootprint's default arguments (board.h). */
export const EXCHANGE_DEFAULTS: Required<ExchangeOptions> = { matchPadPositions: true, deleteExtraTexts: true, resetTextLayers: true, resetTextEffects: true, resetTextPositions: true,
  resetTextContent: true, resetFabricationAttrs: true, resetClearanceOverrides: true, reset3DModels: true, resetTransform: false };

/**
 * BOARD::ExchangeFootprint( aExisting, aNew, commit, flipDirection, aMatchPadPositions, aDeleteExtraTexts,
 * aResetTextLayers, aResetTextEffects, aResetTextPositions, aResetTextContent, aResetFabricationAttrs,
 * aResetClearanceOverrides, aReset3DModels, aResetTransform, aUpdated, aShifted) (board_exchange_footprint.cpp:177).
 * The new footprint takes the old one's place, orientation, side, lock, uuid, height, (unless reset) scale, the
 * Reference / Value uuids; pads, drawings, zones, groups and fields matched by similarity keep their uuids; matched pads
 * keep pin function, pin type, net (on copper) and, unless reset, their clearance overrides; texts and fields follow
 * processTextItem for the reset flags; extra texts of the old footprint are dropped or kept; fabrication attributes,
 * clearance overrides and 3D models are the library's or the old ones; path, sheet, filters, component class,
 * variants and units are the old footprint's.  Returns the node to store under the existing footprint's uuid,
 * `shifted` (moved / turned to match pad positions) and `updated` (the result differs from what was there).
 */
export function exchangeFootprint(existing: SNode, aNew: SNode, o: ExchangeOptions = {}): { node: SNode; shifted: boolean; updated: boolean } {
  const opt = Object.assign({}, EXCHANGE_DEFAULTS, o);
  const n = K.cloneNode(aNew);
  const tc: TextCtx = { posShift: [0, 0], angleShift: 0, updated: false };
  const [ex, ey, eo] = K.atOf(existing);
  // new footprint onto the existing one's side first: pads of opposite sides are mirror images in the library frame
  if (layerName(n) !== layerName(existing)) flipFootprintNode(n);
  let px = ex, py = ey, orient = eo, shifted = false;
  if (opt.matchPadPositions) {
    const s = footprintShift(existing, n);
    if (s) { tc.posShift = s.shift; tc.angleShift = s.angle; px = r6(px + s.shift[0]); py = r6(py + s.shift[1]); orient += s.angle; shifted = !!(s.shift[0] || s.shift[1] || s.angle); }
  }
  const [, , no] = K.atOf(n);
  setFootprintAt(n, px, py, no);
  if (orient - no) rotateFootprintNode(n, orient - no);
  if (!opt.resetTransform) { const [sx, sy] = scaleOf(existing), [nx, ny] = scaleOf(n); if (sx !== nx || sy !== ny) applyScale(n, sx, sy); }
  setLocked(n, !!(K.kid(existing, "locked") || existing.includes("locked")) && str((K.kid(existing, "locked") || ["", "yes"])[1]) !== "no");
  const eu = ownUuid(existing), nu = ownUuid(n);
  if (eu) { if (nu) nu[1] = eu[1]; else n.push(["uuid", eu[1]]); }
  const oldRef = field(existing, "Reference"), newRef = field(n, "Reference");
  const oldVal = field(existing, "Value"), newVal = field(n, "Value");
  copyFpKid(n, existing, "height");

  // pads: matchItemsBySimilarity, +2 for the same number
  const pairs = matchPads(K.kids(existing, "pad"), K.kids(n, "pad"), K.atOf(existing), K.atOf(n));
  const matched = new Set<SNode>();
  for (const [op, np] of pairs) {
    matched.add(np);
    setUuidFrom(np, op);
    for (const key of ["pinfunction", "pintype"]) copyKid(np, op, key);
    if (!opt.resetClearanceOverrides) for (const key of PAD_CLEARANCE) if (K.kid(op, key) || K.kid(np, key)) copyKid(np, op, key);
    stripNets(np);
    const onCopper = (K.kid(np, "layers") || []).slice(1).some((l) => COPPER.test(str(l)));
    const onet = K.kid(op, "net");
    if (onCopper && onet) { const pf = K.kid(np, "pinfunction") || K.kid(np, "pintype") || K.kid(np, "uuid"); np.splice(pf ? np.indexOf(pf) : np.length, 0, K.cloneNode(onet)); }
  }
  for (const np of K.kids(n, "pad")) if (!matched.has(np)) { stripNets(np); freshUuid(np); }

  // drawings, zones and groups: matched ones keep the old uuid, the others get fresh ones
  const oldDraw = graphical(existing), newDraw = graphical(n);
  const drawPairs = matchBySimilarity(oldDraw, newDraw, itemSimilarity);
  const oldToNewText = new Map<SNode, SNode>();
  for (const [a, b] of drawPairs) { setUuidFrom(b, a); if (a[0] === "fp_text" && b[0] === "fp_text") oldToNewText.set(a, b); }
  for (const b of newDraw) if (!drawPairs.some((pp) => pp[1] === b)) freshUuid(b);
  for (const key of ["zone", "group", "point"]) {
    const prs = matchBySimilarity(K.kids(existing, key), K.kids(n, key), itemSimilarity);
    for (const [a, b] of prs) setUuidFrom(b, a);
    for (const b of K.kids(n, key)) if (!prs.some((pp) => pp[1] === b)) freshUuid(b);
  }
  // fields other than Reference / Value
  const oldFields = extraFields(existing), newFields = extraFields(n);
  const fieldPairs = matchBySimilarity(oldFields, newFields, fieldSimilarity);
  const oldToNewField = new Map<SNode, SNode>();
  for (const [a, b] of fieldPairs) { oldToNewField.set(a, b); setUuidFrom(b, a); }
  for (const b of newFields) if (!fieldPairs.some((pp) => pp[1] === b)) freshUuid(b);

  // texts: the matched ones per the reset flags, the extra ones dropped or carried over
  const handled = new Set<SNode>();
  const insertItem = (c: SNode) => { const i = n.findIndex((k, j) => j > 1 && isList(k) && (k[0] === "pad" || k[0] === "zone" || k[0] === "group" || k[0] === "model" || k[0] === "embedded_files")); n.splice(i > 0 ? i : n.length, 0, c); };
  for (const ot of oldDraw) {
    if (ot[0] !== "fp_text") continue;
    const nt = oldToNewText.get(ot);
    if (nt) { handled.add(nt); processTextItem(ot, nt, tc, opt.resetTextContent, opt.resetTextLayers, opt.resetTextEffects, opt.resetTextPositions); }
    else if (opt.deleteExtraTexts) tc.updated = true;
    else { const c = K.cloneNode(ot); handled.add(c); insertItem(c); }
  }
  if (graphical(n).some((c) => c[0] === "fp_text" && !handled.has(c))) tc.updated = true;
  // Reference: the initial text is always kept; Value: reset only when it just named the footprint
  if (oldRef && newRef) processTextItem(oldRef, newRef, tc, false, opt.resetTextLayers, opt.resetTextEffects, opt.resetTextPositions);
  const libName = str(existing[1]).split(":").pop();
  if (oldVal && newVal) processTextItem(oldVal, newVal, tc, textOf(oldVal) === libName, opt.resetTextLayers, opt.resetTextEffects, opt.resetTextPositions);
  const handledFields = new Set<SNode>();
  const insertField = (c: SNode) => { let last = -1; n.forEach((k, j) => { if (isList(k) && isField(k as SNode)) last = j; }); n.splice(last > 0 ? last + 1 : n.length, 0, c); };
  for (const of of oldFields) {
    const nf = oldToNewField.get(of);
    if (nf) { handledFields.add(nf); processTextItem(of, nf, tc, opt.resetTextContent, opt.resetTextLayers, opt.resetTextEffects, opt.resetTextPositions); }
    else if (opt.deleteExtraTexts) tc.updated = true;
    else { const c = K.cloneNode(of); freshUuid(c); handledFields.add(c); insertField(c); }   // the old field stays on the board until the swap: a new uuid
  }
  if (extraFields(n).some((c) => !handledFields.has(c))) tc.updated = true;

  // fabrication attributes
  if (opt.resetFabricationAttrs) { if (attrFlags(n) !== attrFlags(existing)) tc.updated = true; }
  else { const flags = (K.kid(existing, "attr") || []).slice(1).map(str).filter((f) => f !== "allow_soldermask_bridges"); if (maskBridges(n)) flags.push("allow_soldermask_bridges"); setAttr(n, flags); }
  // clearance overrides
  if (opt.resetClearanceOverrides) {
    if (maskBridges(existing) !== maskBridges(n) || FP_CLEARANCE.some((k) => kidText(existing, k) !== kidText(n, k))) tc.updated = true;
  } else {
    for (const k of FP_CLEARANCE) copyFpKid(n, existing, k);
    const flags = (K.kid(n, "attr") || []).slice(1).map(str).filter((f) => f !== "allow_soldermask_bridges"); if (maskBridges(existing)) flags.push("allow_soldermask_bridges"); setAttr(n, flags);
  }
  // 3D models (and extruded bodies, and the embedded model files)
  const models = (fp: SNode) => K.kids(fp, "model");
  if (opt.reset3DModels) {
    const a = models(n).map((m) => K.serialize(m)), b = models(existing).map((m) => K.serialize(m));
    if (a.length !== b.length || a.some((t, i) => t !== b[i])) tc.updated = true;
  } else {
    for (let i = n.length - 1; i > 1; i--) { const c = n[i]; if (isList(c) && c[0] === "model") n.splice(i, 1); }
    for (const m of models(existing)) n.push(K.cloneNode(m));
    const ee = K.kid(existing, "embedded_files");
    if (ee) {
      let ne = K.kid(n, "embedded_files"); if (!ne) { ne = ["embedded_files"]; n.push(ne); }
      const fileName = (f: SNode) => str((K.kid(f, "name") || [])[1]);
      const isModel = (f: SNode) => str((K.kid(f, "type") || [])[1]) === "model";
      for (const f of K.kids(ee, "file")) { if (!isModel(f)) continue; const name = fileName(f); for (let i = ne.length - 1; i > 0; i--) { const c = ne[i]; if (isList(c) && c[0] === "file" && fileName(c) === name) ne.splice(i, 1); } ne.push(K.cloneNode(f)); }
    }
  }
  // updating other parameters: path, sheet, filters, component class, variants, units
  for (const key of ["path", "sheetname", "sheetfile", "component_classes", "variants", "units"]) copyFpKid(n, existing, key);
  const filt = (fp: SNode) => K.kids(fp, "property").find((p) => str(p[1]) === "ki_fp_filters") || null;
  const of = filt(existing), nf = filt(n);
  if (nf && of) n[n.indexOf(nf)] = K.cloneNode(of); else if (nf) n.splice(n.indexOf(nf), 1); else if (of) insertField(K.cloneNode(of));
  // FootprintNeedsUpdate: pads, graphics, zones … differ
  const updated = tc.updated || canonical(n) !== canonical(existing);
  return { node: n, shifted, updated };
}

const NEEDS_UPDATE_ATTRS = ["through_hole", "smd", "board_only", "exclude_from_pos_files", "exclude_from_bom", "exclude_from_sim", "dnp"];
/**
 * The attribute and override half of FOOTPRINT::FootprintNeedsUpdate( aLibFP ) (drc_test_provider_library_parity.cpp),
 * which processFootprint seeds `updated` with before ExchangeFootprint: footprint type, mask bridges, the fabrication
 * attributes, a board-level clearance / mask / paste / zone-connection override that differs from the library's, and
 * net tie pad groups.  The geometry half is exchangeFootprint's own comparison of the result.
 */
export function footprintAttrsNeedUpdate(board: SNode, lib: SNode): boolean {
  const flags = (n: SNode) => new Set((K.kid(n, "attr") || []).slice(1).map(str));
  const a = flags(board), b = flags(lib);
  if (NEEDS_UPDATE_ATTRS.some((f) => a.has(f) !== b.has(f))) return true;
  if (maskBridges(board) !== maskBridges(lib)) return true;
  for (const k of FP_CLEARANCE) if (K.kid(board, k) && kidText(board, k) !== kidText(lib, k)) return true;
  return kidText(board, "net_tie_pad_groups") !== kidText(lib, "net_tie_pad_groups");
}

export interface ExchangeJob {
  /** Update Footprints (each footprint from its own library id) or Change Footprints (to newFpid) */
  updateMode: boolean;
  newFpid?: string;
  /** isMatch for the chosen match mode */
  match(fp: SNode, id: string): boolean;
  opts: ExchangeOptions;
  /** PCB_BASE_FRAME::LoadFootprint: the library footprint as a board footprint (fresh uuids, at the origin), null when not found */
  library(fpid: string): SNode | null;
}
export interface ExchangeLine { severity: "error" | "warning" | "action" | "info"; text: string }
/** LIB_ID::Parse + IsValid: "lib:name" or "name", a name required, no illegal characters. */
export function validFpid(id: string): boolean {
  const t = id.trim(); if (!t) return false;
  const i = t.indexOf(":"); const name = i >= 0 ? t.slice(i + 1) : t;
  return !!name.trim() && !/[\r\n\t]/.test(t);
}
/**
 * DIALOG_EXCHANGE_FOOTPRINTS::processMatchingFootprints: every matching footprint, from the last, exchanged for its
 * library footprint (update) or for newFpid (change), with KiCad's report line for each.
 */
export function planExchange(fps: { id: string; node: SNode }[], job: ExchangeJob): { modified: [string, SNode][]; report: ExchangeLine[]; ids: string[] } {
  const out = { modified: [] as [string, SNode][], report: [] as ExchangeLine[], ids: [] as string[] };
  if (!fps.length) return out;
  if (!job.updateMode && !validFpid(job.newFpid || "")) return out;
  for (const fp of fps.slice().reverse()) {
    if (!job.match(fp.node, fp.id)) continue;
    const oldId = str(fp.node[1]), newId = job.updateMode ? oldId : (job.newFpid || "").trim();
    const refN = field(fp.node, "Reference"); const ref = refN ? textOf(refN) : "";
    let msg = job.updateMode ? `Updated footprint ${ref} (${oldId}): ` : `Changed footprint ${ref} from '${oldId}' to '${newId}': `;
    const lib = job.library(newId);
    if (!lib) { out.report.push({ severity: "error", text: msg + "*** library footprint not found ***" }); continue; }
    // bool updated = !m_updateMode || aFootprint->FootprintNeedsUpdate( newFootprint ), then ExchangeFootprint( …, &updated, &shifted )
    const r = exchangeFootprint(fp.node, lib, job.opts);
    if (job.updateMode && footprintAttrsNeedUpdate(fp.node, lib)) r.updated = true;
    out.ids.push(fp.id);
    if (canonical(r.node) !== canonical(fp.node)) out.modified.push([fp.id, r.node]);
    if (job.updateMode && !r.updated) { msg += r.shifted ? ": (shifted/rotated to match pad positions)" : ": (no changes)"; out.report.push({ severity: "info", text: msg }); }
    else { msg += ": OK"; out.report.push({ severity: "action", text: msg }); }
  }
  return out;
}

/** WildCompareString( pattern, string, case-insensitive ): * and ? wildcards. */
export function wildCompare(pattern: string, text: string): boolean {
  const re = new RegExp("^" + pattern.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "s");
  return re.test(text.toLowerCase());
}

const kidText = (n: SNode, key: string) => { const k = K.kid(n, key); return k ? K.serialize(k) : ""; };
const padLayerSet = (p: SNode) => (K.kid(p, "layers") || []).slice(1).map(str).sort().join(" ");
/** PADSTACK::Similarity: 0.9 for each property that differs (mode, layers, orientation, mask props, drill, copper shape). */
function padstackSimilarity(a: SNode, b: SNode): number {
  let s = 1;
  const differ = (x: string, y: string) => { if (x !== y) s *= 0.9; };
  differ(kidText(a, "padstack") ? str((K.kid(K.kid(a, "padstack")!, "mode") || [])[1]) : "", kidText(b, "padstack") ? str((K.kid(K.kid(b, "padstack")!, "mode") || [])[1]) : "");
  differ(padLayerSet(a), padLayerSet(b));
  differ(String(K.num((K.kid(a, "at") || [])[3])), String(K.num((K.kid(b, "at") || [])[3])));
  differ(["solder_mask_margin", "tenting"].map((k) => kidText(a, k)).join(), ["solder_mask_margin", "tenting"].map((k) => kidText(b, k)).join());
  differ(kidText(a, "remove_unused_layers") + kidText(a, "keep_end_layers"), kidText(b, "remove_unused_layers") + kidText(b, "keep_end_layers"));
  differ(kidText(a, "options"), kidText(b, "options"));
  differ(kidText(a, "drill"), kidText(b, "drill"));
  // COPPER_LAYER_PROPS::Similarity of the copper shape
  for (const k of ["size", "rect_delta", "roundrect_rratio", "chamfer_ratio", "chamfer", "primitives"]) differ(kidText(a, k), kidText(b, k));
  differ(str(a[3]), str(b[3]));
  return s;
}
/** PAD::Similarity (both pads in the same footprint frame): position, attribute, then the padstack. */
export function padSimilarity(a: SNode, b: SNode, fa: [number, number, number] = [0, 0, 0], fb: [number, number, number] = [0, 0, 0]): number {
  let s = 1;
  // GetPosition: the board position (the footprint's position plus the pad's offset turned by its orientation)
  const pos = (p: SNode, f: [number, number, number]) => { const at = K.kid(p, "at") || []; const r = rotator(f[2])(K.num(at[1]), K.num(at[2])); return [f[0] + r[0], f[1] + r[1]]; };
  const pa = pos(a, fa), pb = pos(b, fb);
  if (Math.abs(pa[0] - pb[0]) > 1e-6 || Math.abs(pa[1] - pb[1]) > 1e-6) s *= 0.9;
  if (str(a[2]) !== str(b[2])) s *= 0.9;
  return s * padstackSimilarity(a, b);
}
/** matchItemsBySimilarity for pads (board_exchange_footprint.cpp): [old, new] pairs. */
export function matchPads(oldPads: SNode[], newPads: SNode[], fOld: [number, number, number] = [0, 0, 0], fNew: [number, number, number] = [0, 0, 0]): [SNode, SNode][] {
  const cand: { o: number; w: number; score: number }[] = [];
  oldPads.forEach((op, o) => newPads.forEach((np, w) => {
    const score = padSimilarity(op, np, fOld, fNew) + (str(op[1]) === str(np[1]) ? 2 : 0);
    if (score > 0) cand.push({ o, w, score });
  }));
  cand.sort((x, y) => y.score - x.score || x.o - y.o || x.w - y.w);
  const usedO = new Set<number>(), usedW = new Set<number>(), out: [SNode, SNode][] = [];
  for (const c of cand) { if (usedO.has(c.o) || usedW.has(c.w)) continue; usedO.add(c.o); usedW.add(c.w); out.push([oldPads[c.o], newPads[c.w]]); }
  return out;
}

/** The node tests reach these through PcbTools.exchange. */
export const exchangeApi = { editableCopy, exchangeFootprint, EXCHANGE_DEFAULTS, wildCompare, levenshteinRatio, planExchange, footprintAttrsNeedUpdate, validFpid, footprintShift, boardCopyFromEditor, orthoAlign, matchPads, padSimilarity };
