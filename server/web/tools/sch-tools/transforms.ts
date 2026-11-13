import type { Anchor, BreakCut, BreakJob, SchCtx, SchDrag, Pt, Box } from "./types";
import { root } from "../root";
import { symbolLibId } from "./autoplace";
import { canFollow } from "./clipboard";
import { cursorOf, editable, selectedItems, setSelectionIds, snapCursor } from "./commands";
import { junctionAt, needsJunction } from "./connect";
import { DRAG_KINDS, LABEL_KINDS, announceModes, applyDrag, cleanupAt, connPoints, endDrag, isNetLine, restoreNode } from "./drag";
import { hitNonSymbol, rectOf } from "./hit";
import { PIN_SIDE, SHEET_FILE_OFF, SHEET_NAME_OFF, corners, flagFieldAt, fontNode, junctionNode, lineNode } from "./nodes";
import { SCREEN_OP, anchorOf, mirrorNode, orientSymbol, setTextRot, shiftAt, shiftNode, symOrient } from "./orient";
import { mmPerPx } from "./snap";
import { K, LINE_KINDS, POINT_KINDS, S, TEXT_KINDS, atOf, kid, kids, num, ptsOf, setAt, setPts, str } from "./state";
import { addNode, deep, dropKid, modChange, r4, removeChange, replaceKid, same } from "./util";
import "../../components/kselect";   // <k-select>, the themed drop-down these use in place of <select>

// ---------------------------------------------------------------- group transforms: rotate / mirror about the selection centre, swap, align, move exactly
export const HALF_GRID = 0.635;
export const halfGrid = (v: number) => r4(Math.round(v / HALF_GRID) * HALF_GRID);
export function itemsBox(items: KItem[]) { let b: Box | null = null; for (const it of items) { const r = it.bbox || rectOf(it); if (!r) continue; b = b ? [Math.min(b[0], r[0]), Math.min(b[1], r[1]), Math.max(b[2], r[2]), Math.max(b[3], r[3])] : r.slice(); } return b; }
export function selectionCentre(items: KItem[]): Pt { const b = itemsBox(items); return b ? [halfGrid((b[0] + b[2]) / 2), halfGrid((b[1] + b[3]) / 2)] : [0, 0]; }
// SCH_EDIT_TOOL::Rotate's pivot: a lone connectable item turns about its position, anything else about its
// half-grid box centre; a multi-selection about the selection centre.
export function rotationCentre(items: KItem[]) {
  if (items.length !== 1) return selectionCentre(items);
  if (items[0].kind === "table") return tableCentre(items[0].node);
  const it = items[0], own = it.kind === "symbol" || LABEL_KINDS.has(it.kind) || POINT_KINDS.has(it.kind) || TEXT_KINDS.has(it.kind);
  return own ? anchorOf(it.kind, it.node) : selectionCentre(items);
}
/** SCH_TABLE::GetCenter: the centre of the box of its cells' starts and ends. */
export function tableRawCentre(node: SNode): Pt {
  const M = K.tableModel; let b: Box | null = null;
  for (const c of M.tableInfo(node).cells) { const { s, e } = M.cellStartEnd(c, false); for (const p of [s, e]) b = b ? [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])] : [p[0], p[1], p[0], p[1]]; }
  return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [0, 0];
}
/** A lone table turns about GetNearestHalfGridPosition( SCH_TABLE::GetCenter() ). */
export function tableCentre(node: SNode): Pt { const c = tableRawCentre(node); return [halfGrid(c[0]), halfGrid(c[1])]; }
// op: "ccw" | "cw" | "x" (KiCad's Mirror Vertically: y flips) | "y" (Mirror Horizontally: x flips)
export function mapPoint(op: string, C: Pt, p: Pt): Pt { const [dx, dy] = SCREEN_OP[op](p[0] - C[0], p[1] - C[1]); return [r4(C[0] + dx), r4(C[1] + dy)]; }
export function setFlagRot(node: SNode, rot: number) {
  rot = ((rot % 360) + 360) % 360; const a = kid(node, "at"); if (!a) return; if (a.length >= 4) a[3] = rot; else a.push(rot);
  const p = [num(a[1]), num(a[2])]; for (const pr of kids(node, "property")) replaceKid(pr, flagFieldAt(p, rot));
}
export function sideOfEdge(p: Pt, box: Box) { const d: [string, number][] = [["left", Math.abs(p[0] - box[0])], ["right", Math.abs(p[0] - box[2])], ["top", Math.abs(p[1] - box[1])], ["bottom", Math.abs(p[1] - box[3])]]; d.sort((a, b) => a[1] - b[1]); return d[0][0]; }
/**
 * Rotate / mirror one item about C.  `lone`: the item is the selection's only principal item (SCH_EDIT_TOOL::Rotate's
 * principalItemCount == 1), which a table turns about its own centre instead of C.
 */
export function transformNode(kind: string, node: SNode, op: string, C: Pt, lone = false) {
  const rot = op === "ccw" || op === "cw";
  const mapAt = (n: SNode) => { const a = kid(n, "at"); if (!a) return; const q = mapPoint(op, C, [num(a[1]), num(a[2])]); a[1] = q[0]; a[2] = q[1]; };
  const mapPts = (n: SNode) => setPts(n, ptsOf(n).map((p) => mapPoint(op, C, p)));
  const moveTo = (p0: Pt) => { const p1 = mapPoint(op, C, p0); shiftNode(kind, node, r4(p1[0] - p0[0]), r4(p1[1] - p0[1])); };
  switch (kind) {
  case "symbol": { const p0 = anchorOf(kind, node); orientSymbol(node, op); moveTo(p0); return true; }
  case "label": case "global_label": case "hierarchical_label": case "text": {
    const p0 = anchorOf(kind, node);
    if (rot) setTextRot(kind, node, atOf(node)[2] + (op === "cw" ? 270 : 90)); else mirrorNode(kind, node, op);
    moveTo(p0); return true;
  }
  case "netclass_flag": case "directive_label": {
    const p0 = anchorOf(kind, node), r0 = atOf(node)[2] || 0;
    if (rot) setFlagRot(node, r0 + (op === "cw" ? 270 : 90)); else { const flip: Record<number, number> = op === "y" ? { 0: 180, 180: 0 } : { 90: 270, 270: 90 }; if (flip[r0] !== undefined) setFlagRot(node, flip[r0]); }
    moveTo(p0); return true;
  }
  case "junction": case "no_connect": case "image": mapAt(node); return true;
  case "bus_entry": { mapAt(node); const s = kid(node, "size"); if (s) { const [dx, dy] = SCREEN_OP[op](num(s[1]), num(s[2])); s[1] = r4(dx); s[2] = r4(dy); } return true; }
  case "wire": case "bus": case "polyline": case "bezier": mapPts(node); return true;
  case "rule_area": for (const pl of kids(node, "polyline")) mapPts(pl); return true;
  case "rectangle": { const a = kid(node, "start")!, b = kid(node, "end")!; const [x0, y0, x1, y1] = corners(mapPoint(op, C, [num(a[1]), num(a[2])]), mapPoint(op, C, [num(b[1]), num(b[2])])); a[1] = x0; a[2] = y0; b[1] = x1; b[2] = y1; return true; }
  case "circle": { const c = kid(node, "center")!; const p = mapPoint(op, C, [num(c[1]), num(c[2])]); c[1] = p[0]; c[2] = p[1]; return true; }
  case "ellipse": case "ellipse_arc": {
    // EDA_SHAPE::rotate: the centre turns and Rotation -= angle (a quarter turn on screen); ELLIPSE::Mirror: the centre
    // mirrors, Rotation = -Rotation, and the arc's parametric angles go to [pi - e, pi - s] (left-right) or [-e, -s]
    const c = kid(node, "center")!; const p = mapPoint(op, C, [num(c[1]), num(c[2])]); c[1] = p[0]; c[2] = p[1];
    const ra = kid(node, "rotation_angle"), phi = ra ? num(ra[1]) : 0;
    const set = (key: string, v: number) => { const k = kid(node, key); v = r4(v); if (k) k[1] = v; else node.push([key, v]); };
    if (rot) set("rotation_angle", phi + (op === "ccw" ? -90 : 90));
    else {
      set("rotation_angle", -phi);
      if (kind === "ellipse_arc") { const s = num((kid(node, "start_angle") || [])[1], 0), e = num((kid(node, "end_angle") || [])[1], 0); if (op === "y") { set("start_angle", 180 - e); set("end_angle", 180 - s); } else { set("start_angle", -e); set("end_angle", -s); } }
    }
    return true;
  }
  case "arc": { for (const key of ["start", "mid", "end"]) { const k = kid(node, key); if (k) { const p = mapPoint(op, C, [num(k[1]), num(k[2])]); k[1] = p[0]; k[2] = p[1]; } } return true; }
  case "text_box": {
    const [x, y, a] = atOf(node), s = kid(node, "size"); if (!s) return false;
    const [x0, y0, x1, y1] = corners(mapPoint(op, C, [x, y]), mapPoint(op, C, [x + num(s[1]), y + num(s[2])]));
    const vertical = a === 90 || a === 270;
    setAt(node, x0, y0, rot ? (vertical ? 0 : 90) : a); s[1] = r4(x1 - x0); s[2] = r4(y1 - y0);
    if (!rot && ((op === "y" && !vertical) || (op === "x" && vertical))) { const ef = kid(node, "effects"), j = ef && kid(ef, "justify"); if (j) { const i = j.indexOf("left") > 0 ? j.indexOf("left") : j.indexOf("right"); if (i > 0) j[i] = j[i] === "left" ? "right" : "left"; } }
    return true;
  }
  case "table": {
    // SCH_TABLE::Rotate: every cell (an SCH_TEXTBOX) turns its start and end about the pivot and swaps its text angle
    // between horizontal and vertical, then Normalize lays the cells out again from cell 0.  SCH_EDIT_TOOL::Rotate
    // then moves the table back: a lone table about rotPoint = GetNearestHalfGridPosition( GetCenter() ) by
    // rotPoint - GetNearestHalfGridPosition( GetCenter() ), one of several so its old centre lands where the
    // rotation takes it.  SCH_TABLE's MirrorHorizontally / MirrorVertically do nothing ("doesn't seem useful"), so a
    // mirror leaves the table alone.
    const cells = kid(node, "cells"); if (!cells || !rot) return false;
    if (lone) C = tableCentre(node);
    const before = tableRawCentre(node);
    for (const c of kids(cells, "table_cell")) {
      const a = kid(c, "at"), sz = kid(c, "size"); if (!a || !sz) continue;
      const p0: Pt = [num(a[1]), num(a[2])], p1: Pt = [p0[0] + num(sz[1]), p0[1] + num(sz[2])];
      const q0 = mapPoint(op, C, p0), q1 = mapPoint(op, C, p1), na = num(a[3]) === 90 ? 0 : 90;
      a[1] = q0[0]; a[2] = q0[1]; if (a.length >= 4) a[3] = na; else a.push(na);
      sz[1] = r4(q1[0] - q0[0]); sz[2] = r4(q1[1] - q0[1]);
    }
    K.tableModel.normalizeTable(node, false);
    const now = tableRawCentre(node);
    const to: Pt = lone ? C : mapPoint(op, C, before), from: Pt = lone ? [halfGrid(now[0]), halfGrid(now[1])] : now;
    const dx = r4(to[0] - from[0]), dy = r4(to[1] - from[1]);
    if (dx || dy) K.shiftTable(node, dx, dy);   // SCH_TABLE::Move
    return true;
  }
  case "sheet": {
    const [x, y] = atOf(node), s = kid(node, "size"); if (!s) return false;
    const [x0, y0, x1, y1] = corners(mapPoint(op, C, [x, y]), mapPoint(op, C, [x + num(s[1]), y + num(s[2])]));
    setAt(node, x0, y0); s[1] = r4(x1 - x0); s[2] = r4(y1 - y0);
    for (const pin of kids(node, "pin")) {
      const pp = mapPoint(op, C, atOf(pin).slice(0, 2)), [prot, just] = PIN_SIDE[sideOfEdge(pp, [x0, y0, x1, y1])];
      setAt(pin, pp[0], pp[1], prot); let ef = kid(pin, "effects"); if (!ef) { ef = ["effects", fontNode(1.27)]; pin.push(ef); } replaceKid(ef, ["justify", just]);
    }
    const auto = kid(node, "fields_autoplaced") && str(kid(node, "fields_autoplaced")![1]) !== "no";
    for (const pr of kids(node, "property")) {
      const name = str(pr[1]);
      if (auto && name === "Sheetname") replaceKid(pr, ["at", x0, r4(y0 - SHEET_NAME_OFF), 0]);
      else if (auto && name === "Sheetfile") replaceKid(pr, ["at", x0, r4(y1 + SHEET_FILE_OFF), 0]);
      else shiftAt(pr, r4(x0 - x), r4(y0 - y));
    }
    return true;
  }
  default: return false;
  }
}
// MODIFIED changes for the items transformed about C, plus the junction / merge cleanup around every connection point.
export function transformChanges(ctx: SchCtx, items: KItem[], op: string, C: Pt, times?: number) {
  const doc = ctx.doc, out: KChange[] = [], touched: Pt[] = [], keep = new Set<string>();
  for (const it of items) {
    if (!DRAG_KINDS.has(it.kind)) continue;
    const n = deep(it.node); let ok = true;
    for (let k = 0; k < (times || 1) && ok; k++) ok = transformNode(it.kind, n, op, C, items.length === 1) !== false;
    if (!ok) continue;
    for (const p of connPoints(doc, it)) touched.push(p);
    for (const p of connPoints(doc, { kind: it.kind, node: n, id: it.id })) touched.push(p);
    out.push(modChange(doc, it, n)); keep.add(it.id);
  }
  if (!out.length) return out;
  const extra = cleanupAt(doc, out, touched, keep, ctx.IU || 1e4);
  for (const c of extra) if (c.kind === "ADDED") doc.items.delete(c.id);   // commit re-adds them from the fragments
  return out.concat(extra);
}
export function transformSelected(ctx: SchCtx, op: string, items: KItem[], centre?: Pt) {
  if (!editable(ctx)) return false;
  items = items || selectedItems(ctx); if (!items.length) return false;
  const C = centre || selectionCentre(items);
  const changes = transformChanges(ctx, items, op, C);
  if (!changes.length) return false;
  ctx.commit(changes, op === "x" || op === "y" ? "mirror" : "rotate");
  return true;
}
export function moveExactChanges(ctx: SchCtx, items: KItem[], dx: number, dy: number, rot: number) {
  const doc = ctx.doc, turns = ((Math.round((rot || 0) / 90) % 4) + 4) % 4, C = rotationCentre(items);
  const out: KChange[] = [], touched: Pt[] = [], keep = new Set<string>();
  for (const it of items) {
    if (!DRAG_KINDS.has(it.kind)) continue;
    const n = deep(it.node); let ok = true;
    for (let k = 0; k < turns && ok; k++) ok = transformNode(it.kind, n, "ccw", C, items.length === 1) !== false;
    if (!ok) continue;
    shiftNode(it.kind, n, r4(dx || 0), r4(dy || 0));
    for (const p of connPoints(doc, it)) touched.push(p);
    for (const p of connPoints(doc, { kind: it.kind, node: n, id: it.id })) touched.push(p);
    out.push(modChange(doc, it, n)); keep.add(it.id);
  }
  if (!out.length) return out;
  const extra = cleanupAt(doc, out, touched, keep, ctx.IU || 1e4);
  for (const c of extra) if (c.kind === "ADDED") doc.items.delete(c.id);
  return out.concat(extra);
}
export function moveExactly(ctx: SchCtx, opts?: { dx?: number; dy?: number; rot?: number } | null) {
  if (!editable(ctx)) return false;
  const items = selectedItems(ctx); if (!items.length) return false;
  const apply = (dx: number, dy: number, rot: number) => { const changes = moveExactChanges(ctx, items, dx, dy, rot); if (changes.length) ctx.commit(changes, "move exactly"); return changes.length > 0; };
  if (opts && (opts.dx !== undefined || opts.dy !== undefined || opts.rot !== undefined)) return apply(num(opts.dx), num(opts.dy), num(opts.rot));
  const KD = typeof root.KDialogs !== "undefined" ? root.KDialogs : null; if (!KD) return false;
  KD.open({ title: "Move Exactly", width: 360,
    build(body) { body.innerHTML = '<div class="kv"><label>Move X (mm)</label><input id="kd-mx" type="number" step="0.01" value="0"><label>Move Y (mm)</label><input id="kd-my" type="number" step="0.01" value="0"><label>Rotate (°)</label><k-select id="kd-mr"><option value="0">0</option><option value="90">90</option><option value="180">180</option><option value="270">270</option></k-select></div><p class="kd-note">Rotation is about the centre of the selection, counterclockwise.</p>'; },
    ok() { const g = (id: string) => document.getElementById(id) as HTMLInputElement; apply(num(g("kd-mx").value), num(g("kd-my").value), num(g("kd-mr").value)); } });
  return true;
}
// Swap the positions of the selected items pairwise in selection order (SCH_EDIT_TOOL::Swap).
export function swapNodes(items: KItem[]) {
  const nodes = items.map((it: KItem) => deep(it.node));
  if (items.length < 2) return nodes;
  for (let i = 0; i < items.length - 1; i++) {
    const A = nodes[i], B = nodes[i + 1], ka = items[i].kind, kb = items[i + 1].kind;
    const pa = anchorOf(ka, A), pb = anchorOf(kb, B);
    shiftNode(ka, A, r4(pb[0] - pa[0]), r4(pb[1] - pa[1])); shiftNode(kb, B, r4(pa[0] - pb[0]), r4(pa[1] - pb[1]));
    if (ka !== kb) continue;
    if (TEXT_KINDS.has(ka)) { const ra = atOf(A)[2] || 0, rb = atOf(B)[2] || 0; setTextRot(ka, A, rb); setTextRot(kb, B, ra); }
    else if (ka === "symbol" && symbolLibId(A) === symbolLibId(B)) {
      const oa = symOrient(A), ob = symOrient(B);
      for (const [n, o] of [[A, ob], [B, oa]] as [SNode, { rot: number; mirror: string }][]) { setAt(n, undefined, undefined, o.rot); dropKid(n, "mirror"); if (o.mirror) { const ai = n.findIndex((c) => Array.isArray(c) && c[0] === "at"); n.splice(ai + 1, 0, ["mirror", o.mirror]); } }
    }
  }
  return nodes;
}
export function swapChanges(doc: KDoc, items: KItem[]) { if (items.length < 2) return []; const nodes = swapNodes(items); return items.map((it: KItem, i: number) => modChange(doc, it, nodes[i])); }
export function swapSelection(ctx: SchCtx) {
  if (!editable(ctx)) return false;
  const items = selectedItems(ctx).filter((it) => DRAG_KINDS.has(it.kind));
  if (items.length < 2) { ctx.toast("Select two or more items to swap"); return false; }
  const doc = ctx.doc, nodes = swapNodes(items), changes = items.map((it, i) => modChange(doc, it, nodes[i])), touched: Pt[] = [];
  items.forEach((it, i) => { touched.push(...connPoints(doc, it), ...connPoints(doc, { kind: it.kind, node: nodes[i], id: it.id })); });
  const extra = cleanupAt(doc, changes, touched, new Set(items.map((it) => it.id)), ctx.IU || 1e4);
  for (const c of extra) if (c.kind === "ADDED") doc.items.delete(c.id);
  ctx.commit(changes.concat(extra), "swap"); return true;
}
// Align to grid (SCH_MOVE_TOOL::AlignToGrid): pins, line ends and anchors land on the grid; sheets by their corners.
export function alignToGridChanges(ctx: SchCtx, items: KItem[]) {
  const doc = ctx.doc, out: KChange[] = [], touched: Pt[] = [], keep = new Set<string>();
  const snap = (p: Pt) => ctx.snap([p[0], p[1]]).map(r4);
  for (const it of items) {
    if (!DRAG_KINDS.has(it.kind)) continue;
    const n = deep(it.node);
    if (LINE_KINDS.has(it.kind) || it.kind === "bezier") setPts(n, ptsOf(n).map(snap));
    else if (it.kind === "sheet") {
      const [x, y] = atOf(n), s = kid(n, "size")!, tl = snap([x, y]), br = snap([x + num(s[1]), y + num(s[2])]);
      setAt(n, tl[0], tl[1]); s[1] = r4(br[0] - tl[0]); s[2] = r4(br[1] - tl[1]);
      for (const pr of kids(n, "property")) shiftAt(pr, r4(tl[0] - x), r4(tl[1] - y));
      for (const pin of kids(n, "pin")) { const [px, py, prot] = atOf(pin), q = snap([px, py]); const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v)); if (prot === 180) setAt(pin, tl[0], clamp(q[1], tl[1], br[1])); else if (prot === 0) setAt(pin, br[0], clamp(q[1], tl[1], br[1])); else if (prot === 90) setAt(pin, clamp(q[0], tl[0], br[0]), tl[1]); else setAt(pin, clamp(q[0], tl[0], br[0]), br[1]); }
    } else {
      const pins = it.kind === "symbol" ? connPoints(doc, it) : [];
      const a = pins[0] || anchorOf(it.kind, n), q = snap(a);
      shiftNode(it.kind, n, r4(q[0] - a[0]), r4(q[1] - a[1]));
    }
    if (JSON.stringify(n) === JSON.stringify(it.node)) continue;
    for (const p of connPoints(doc, it)) touched.push(p);
    for (const p of connPoints(doc, { kind: it.kind, node: n, id: it.id })) touched.push(p);
    out.push(modChange(doc, it, n)); keep.add(it.id);
  }
  if (!out.length) return out;
  const extra = cleanupAt(doc, out, touched, keep, ctx.IU || 1e4);
  for (const c of extra) if (c.kind === "ADDED") doc.items.delete(c.id);
  return out.concat(extra);
}
export function alignToGrid(ctx: SchCtx) {
  if (!editable(ctx)) return false;
  const items = selectedItems(ctx); if (!items.length) return false;
  const changes = alignToGridChanges(ctx, items); if (!changes.length) { ctx.toast("Already on the grid"); return true; }
  ctx.commit(changes, "align to grid"); return true;
}
// Edge alignment (sch_align_tool.cpp): every item's box edge moves to the extreme edge of the selection.
export function alignEdgeChanges(ctx: SchCtx, items: KItem[], which: string) {
  const doc = ctx.doc, boxes = items.map((it: KItem) => it.bbox || rectOf(it)).filter(Boolean) as Box[]; if (boxes.length < 2) return [];
  const target = which === "top" ? Math.min(...boxes.map((b) => b[1])) : which === "bottom" ? Math.max(...boxes.map((b) => b[3])) : which === "left" ? Math.min(...boxes.map((b) => b[0])) : which === "right" ? Math.max(...boxes.map((b) => b[2]))
    : which === "centerX" ? boxes.reduce((t, b) => t + (b[0] + b[2]) / 2, 0) / boxes.length : boxes.reduce((t, b) => t + (b[1] + b[3]) / 2, 0) / boxes.length;
  const out: KChange[] = [], touched: Pt[] = [], keep = new Set<string>();
  for (const it of items) {
    const b = it.bbox || rectOf(it); if (!b || !DRAG_KINDS.has(it.kind)) continue;
    const cur = which === "top" ? b[1] : which === "bottom" ? b[3] : which === "left" ? b[0] : which === "right" ? b[2] : which === "centerX" ? (b[0] + b[2]) / 2 : (b[1] + b[3]) / 2;
    const d = (ctx.snap as SchCtx["snap"] | undefined) ? r4(K.snap(target - cur, ctx.gridPitch || 1.27)) : r4(target - cur); if (!d) continue;
    const n = deep(it.node); shiftNode(it.kind, n, which === "left" || which === "right" || which === "centerX" ? d : 0, which === "top" || which === "bottom" || which === "centerY" ? d : 0);
    for (const p of connPoints(doc, it)) touched.push(p);
    for (const p of connPoints(doc, { kind: it.kind, node: n, id: it.id })) touched.push(p);
    out.push(modChange(doc, it, n)); keep.add(it.id);
  }
  if (!out.length) return out;
  const extra = cleanupAt(doc, out, touched, keep, ctx.IU || 1e4);
  for (const c of extra) if (c.kind === "ADDED") doc.items.delete(c.id);
  return out.concat(extra);
}
export function alignEdges(ctx: SchCtx, which: string) {
  if (!editable(ctx)) return false;
  const items = selectedItems(ctx); if (items.length < 2) { ctx.toast("Select two or more items"); return false; }
  const changes = alignEdgeChanges(ctx, items, which); if (!changes.length) return true;
  ctx.commit(changes, "align " + which.toLowerCase()); return true;
}
// Break the wire under the cursor (or the selected one) into two at the grid point.
export function breakWireChanges(doc: KDoc, item: KItem, p: Pt) {
  if (!isNetLine(item.kind)) return [];
  const pts = ptsOf(item.node); if (pts.length !== 2) return [];
  const q = closestOnSeg(p, pts[0], pts[1]); if (same(q, pts[0]) || same(q, pts[1])) return [];
  const a = deep(item.node); setPts(a, [pts[0], q]);
  const b = addNode(doc, lineNode(item.kind, q, pts[1])); doc.items.delete(b.item.id);
  return [modChange(doc, item, a), b.change];
}
export function closestOnSeg(p: Pt, a: Pt, b: Pt): Pt { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); return [r4(a[0] + t * dx), r4(a[1] + t * dy)]; }
/**
 * SCH_MOVE_TOOL in BREAK / SLICE mode (KiCad 10).  preprocessBreakOrSliceSelection breaks the selected line at
 * the cursor (several selected lines each at their midpoint) inside the move's local commit, and the move loop
 * carries the cut: for BREAK the new corner (both halves' shared end) follows the cursor, for SLICE the first
 * half's end alone, opening the gap.  Nothing reaches the document (or a peer) until the operation ends.
 * SLICE: a click finishes.  BREAK: each click breaks the dragged tail again at the corner and keeps going; a
 * double click finishes, and so does Esc once at least one click has broken (the corner in flight stays where the
 * cursor left it).  Esc before that, Ctrl+Z or a peer's edit of the sheet put everything back, with no redo entry
 * (localCommit.Revert()).  The commit is one "Break Wire" / "Slice Wire" step with the junctions the new corners
 * need.  Outside a session with a pointer (tests, headless) the break is committed where it was made.
 */
export function breakWire(ctx: SchCtx, mode: string) {
  if (!editable(ctx)) return false;
  mode = mode === "slice" ? "slice" : "break";
  const c = cursorOf(ctx); let lines = selectedItems(ctx).filter((x) => isNetLine(x.kind) && ptsOf(x.node).length === 2);
  if (!lines.length) { const hit = hitNonSymbol(ctx.doc, c[0], c[1], Math.max(0.3, 5 * mmPerPx(ctx))); if (hit && isNetLine(hit.kind)) lines = [hit]; }
  if (!lines.length) return false;
  const doc = ctx.doc, label = mode === "slice" ? "Slice Wire" : "Break Wire";
  const atFor = (it: KItem) => { const q = ptsOf(it.node); return lines.length === 1 ? snapCursor(ctx) : [r4((q[0][0] + q[1][0]) / 2), r4((q[0][1] + q[1][1]) / 2)]; };
  if (!canFollow(ctx)) {
    const changes: KChange[] = [], cuts: { head: string; tail: string }[] = [];
    for (const it of lines) { const ch = breakWireChanges(doc, it, atFor(it)); if (!ch.length) continue; changes.push(...ch); cuts.push({ head: it.id, tail: ch[1].id }); }
    if (!changes.length) return false;
    ctx.commit(changes, label);
    setSelectionIds(ctx, mode === "break" ? cuts.flatMap((x) => [x.head, x.tail]) : cuts.map((x) => x.head));
    return true;
  }
  if (S.drag) endDrag(ctx, false);
  const brk: BreakJob = { mode, label, orig: new Map(), local: new Set(), clicks: 0 }, cuts: BreakCut[] = [];
  for (const it of lines) { const cut = splitLocal(doc, brk, it, atFor(it)); if (cut) cuts.push(cut); }
  if (!cuts.length) return false;
  const p0 = cuts[0].p;
  S.drag = { items: [], item: cuts[0].head, kind: "wire", orig: null, anchor0: p0, grab: [0, 0], last: [0, 0], applied: [0, 0], moved: true, byPointer: false,
    riders: [], anchors: breakAnchors(cuts, mode), preview: [], mode, brk, restoreMode: S.dragMode };
  S.dragMode = "drag"; announceModes(ctx);
  setSelectionIds(ctx, mode === "break" ? cuts.flatMap((x) => [x.head.id, x.tail.id]) : cuts.map((x) => x.head.id));
  return true;
}
// SCH_LINE::BreakAt on this client only: the line keeps its start and ends at q, a copy (same stroke) runs on from q.
export function splitLocal(doc: KDoc, brk: BreakJob, item: KItem, at: Pt, force?: boolean): BreakCut | null {
  const pts = ptsOf(item.node); if (pts.length !== 2) return null;
  const q = force ? [r4(at[0]), r4(at[1])] : closestOnSeg(at, pts[0], pts[1]);
  if (!force && (same(q, pts[0]) || same(q, pts[1]))) return null;
  if (!brk.orig.has(item.id) && !brk.local.has(item.id)) brk.orig.set(item.id, deep(item.node));
  const tailNode = deep(item.node); dropKid(tailNode, "uuid"); setPts(tailNode, [q, pts[1]]);
  setPts(item.node, [pts[0], q]); K.replaceChange(doc, item);
  const tail = addNode(doc, tailNode).item; brk.local.add(tail.id);
  return { head: item, tail, p: q };
}
export function breakAnchors(cuts: BreakCut[], mode: string): Anchor[] {
  return cuts.map((cut) => {
    const ends = [{ item: cut.head, index: 1, orig: ptsOf(cut.head.node).map((v) => v.slice()) }];
    if (mode === "break") ends.push({ item: cut.tail, index: 0, orig: ptsOf(cut.tail.node).map((v) => v.slice()) });
    return { p: cut.p, ends, stub: null, followers: [] };
  });
}
// A click in BREAK mode: the corner stays where it is and the dragged tail breaks again there, so the next
// corner follows the cursor (preprocessBreakOrSliceSelection on the IS_NEW tail only).
export function breakAgain(ctx: SchCtx) {
  const d = S.drag; if (!d || !d.brk || d.brk.mode !== "break") return false;
  const doc = ctx.doc, cuts: BreakCut[] = [];
  for (const a of d.anchors) {
    const tailEnd = a.ends.find((e) => e.index === 0); if (!tailEnd) continue;
    const tail = tailEnd.item, pts = ptsOf(tail.node);
    const cut = splitLocal(doc, d.brk, tail, pts[0], true); if (cut) cuts.push(cut);
  }
  if (!cuts.length) return false;
  d.brk.clicks++;
  d.anchors = breakAnchors(cuts, "break"); d.anchor0 = cuts[0].p; d.last = [0, 0]; d.applied = [0, 0];
  setSelectionIds(ctx, cuts.flatMap((x) => [x.head.id, x.tail.id]));
  ctx.requestRender();
  return true;
}
// Lines broken locally go back to what they were, the local pieces go.
export function restoreBreak(doc: KDoc, brk: BreakJob) {
  for (const id of brk.local) doc.items.delete(id);
  for (const [id, orig] of brk.orig) { const it = doc.items.get(id); if (it) { restoreNode(it.node, orig!); K.replaceChange(doc, it); } }
}
export function endBreak(ctx: SchCtx, d: SchDrag, commit: boolean) {
  const doc = ctx.doc, brk = d.brk!;
  if (!commit && d.cancel !== "undo" && brk.mode === "break" && brk.clicks > 0) commit = true;   // Esc after a break keeps the breaks
  if (commit) applyDrag(doc, d, d.last[0], d.last[1]);
  const finals = new Map<string, { kind: string; node: SNode }>();
  for (const id of [...brk.orig.keys(), ...brk.local]) { const it = doc.items.get(id); if (it) finals.set(id, { kind: it.kind, node: deep(it.node) }); }
  restoreBreak(doc, brk);
  if (!commit) { setSelectionIds(ctx, []); return; }
  const zero = (n: SNode) => { const q = ptsOf(n); return q.length === 2 && same(q[0], q[1]); };
  const changes: KChange[] = [], added: string[] = [], touched: Pt[] = [];
  for (const [id] of brk.orig) {
    const it = doc.items.get(id), f = finals.get(id); if (!it || !f) continue;
    if (zero(f.node)) { changes.push(removeChange(it)); continue; }
    changes.push(modChange(doc, it, f.node)); touched.push(...ptsOf(f.node));
  }
  for (const id of brk.local) {
    const f = finals.get(id); if (!f || zero(f.node)) continue;
    const r = addNode(doc, f.node); changes.push(r.change); added.push(r.item.id); touched.push(...ptsOf(f.node));
  }
  // the junctions the moved corners need (finalizeMoveOperation's AddJunctionsIfNeeded), on a dry run
  const saved = new Map<string, KItem | null>(); for (const c of changes) if (!saved.has(c.id)) saved.set(c.id, doc.items.get(c.id) || null);
  const extra: KChange[] = [];
  try {
    for (const c of changes) K.applyChange(doc, c, ctx.IU || 1e4);
    const seen = new Set<string>();
    for (const p of touched) {
      const k = r4(p[0]) + "," + r4(p[1]); if (seen.has(k)) continue; seen.add(k);
      if (!junctionAt(doc, p[0], p[1]) && (needsJunction(doc, p[0], p[1], "wire") || needsJunction(doc, p[0], p[1], "bus"))) extra.push(addNode(doc, junctionNode(p)).change);
    }
  } finally { for (const [id, obj] of saved) { if (obj) doc.items.set(id, obj); else doc.items.delete(id); } for (const c of extra) doc.items.delete(c.id); }
  for (const id of added) doc.items.delete(id);
  const keepSel = d.anchors.flatMap((a) => a.ends.map((e) => e.item.id));
  ctx.commit(changes.concat(extra), brk.label);
  setSelectionIds(ctx, keepSel.filter((id: string) => doc.items.has(id)));
}
export const fragOf = (change: KChange) => { const t = K.parseAll(change.sexpr!); return t.find((n) => Array.isArray(n) && n[0] !== "lib_symbols") || t[0]; };
