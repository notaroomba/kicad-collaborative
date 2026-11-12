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
const isRefOrValue = (p: SNode) => (p[0] === "property" && (str(p[1]) === "Reference" || str(p[1]) === "Value")) || (p[0] === "fp_text" && (str(p[1]) === "reference" || str(p[1]) === "value"));
const COPPER = /(^|\*|\.)Cu$|^\*\.Cu$|^F&B\.Cu$/;

/**
 * BOARD::ExchangeFootprint( aExisting, aNew, commit, flipDirection, aMatchPadPositions = true ) with the default reset
 * flags: the new footprint takes the old one's place, orientation, side, lock, uuid, transform scale, Reference text and
 * the Reference / Value uuids; Value keeps the old text unless it only named the footprint; matched pads keep their
 * uuid, pin function, pin type and (on copper) net; everything else — texts, fields, attributes, clearances, models —
 * is the new footprint's.  Returns the board node to store under the existing footprint's uuid.
 */
export function exchangeFootprint(existing: SNode, aNew: SNode, opts: { matchPadPositions?: boolean } = {}): { node: SNode; shifted: boolean } {
  const n = K.cloneNode(aNew);
  const [ex, ey, eo] = K.atOf(existing);
  // new footprint onto the existing one's side first: pads of opposite sides are mirror images in the library frame
  if (str((K.kid(n, "layer") || [])[1]) !== str((K.kid(existing, "layer") || [])[1])) flipFootprintNode(n);
  let px = ex, py = ey, orient = eo, shifted = false;
  if (opts.matchPadPositions !== false) {
    const s = footprintShift(existing, n);
    if (s) { px = r6(px + s.shift[0]); py = r6(py + s.shift[1]); orient += s.angle; shifted = !!(s.shift[0] || s.shift[1] || s.angle); }
  }
  const [, , no] = K.atOf(n);
  setFootprintAt(n, px, py, no);
  if (orient - no) rotateFootprintNode(n, orient - no);
  const [sx, sy] = scaleOf(existing); setScale(n, sx, sy);
  setLocked(n, !!(K.kid(existing, "locked") || existing.includes("locked")) && str((K.kid(existing, "locked") || ["", "yes"])[1]) !== "no");
  const eu = ownUuid(existing), nu = ownUuid(n);
  if (eu) { if (nu) nu[1] = eu[1]; else n.push(["uuid", eu[1]]); }
  // Reference and Value: their uuids are the existing ones; the reference text is always kept, the value only when it
  // was not just the footprint's name
  const oldRef = field(existing, "Reference"), newRef = field(n, "Reference");
  const oldVal = field(existing, "Value"), newVal = field(n, "Value");
  const keepUuid = (o: SNode | null, w: SNode | null) => { if (!o || !w) return; const ou = ownUuid(o), wu = ownUuid(w); if (ou && wu) wu[1] = ou[1]; else if (ou) w.push(["uuid", ou[1]]); };
  keepUuid(oldRef, newRef); keepUuid(oldVal, newVal);
  if (oldRef && newRef) newRef[2] = oldRef[2];
  const libName = str(existing[1]).split(":").pop();
  if (oldVal && newVal && str(oldVal[2]) !== libName) newVal[2] = oldVal[2];
  // pads: matchItemsBySimilarity — every (old, new) pair scored by PAD::Similarity plus 2 for the same number, taken
  // greedily from the best score down (so a pad keeps its number's net and pin function wherever it moved)
  const pairs = matchPads(K.kids(existing, "pad"), K.kids(n, "pad"), K.atOf(existing), K.atOf(n));
  const newPads = K.kids(n, "pad");
  for (const [op, np] of pairs) {
    const ou = ownUuid(op), wu = ownUuid(np); if (ou) { if (wu) wu[1] = ou[1]; else np.push(["uuid", ou[1]]); }
    for (const key of ["pinfunction", "pintype"]) {
      const o = K.kid(op, key), w = K.kid(np, key);
      if (w) np.splice(np.indexOf(w), 1);
      if (o) { const at = K.kid(np, "uuid"); np.splice(at ? np.indexOf(at) : np.length, 0, K.cloneNode(o)); }
    }
    stripNets(np);
    const onCopper = (K.kid(np, "layers") || []).slice(1).some((l) => COPPER.test(str(l)));
    const onet = K.kid(op, "net");
    if (onCopper && onet) { const pf = K.kid(np, "pinfunction") || K.kid(np, "pintype") || K.kid(np, "uuid"); np.splice(pf ? np.indexOf(pf) : np.length, 0, K.cloneNode(onet)); }
  }
  // an unmatched pad keeps its own uuid unless a matched pad now carries it
  const taken = new Set(pairs.map(([, np]) => str((ownUuid(np) || [])[1])));
  for (const np of newPads) if (!pairs.some((pp) => pp[1] === np)) { stripNets(np); const u = ownUuid(np); if (u && taken.has(str(u[1]))) u[1] = K.newUuid(); }
  // texts and fields other than Reference / Value: aDeleteExtraTexts and the reset flags — the new footprint's own
  void isRefOrValue;
  return { node: n, shifted };
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
export const exchangeApi = { editableCopy, exchangeFootprint, footprintShift, boardCopyFromEditor, orthoAlign, matchPads, padSimilarity };
