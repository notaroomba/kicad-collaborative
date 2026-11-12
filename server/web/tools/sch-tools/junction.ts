import type { PreviewLine, SchCtx, SchWire, UnfoldJob, Pt } from "./types";
import { symbolPins } from "./autoplace";
import { junctionAt, lineMidsAt } from "./connect";
import { connPoints, isNetLine } from "./drag";
import { junctionNode, lineNode } from "./nodes";
import { K, S, atOf, kid, kids, num, ptsOf, setAt, setPts, str } from "./state";
import { addNode, deep, modChange, r4, removeChange, replaceKid, same, segDist, segs } from "./util";
import { type Seg, mergeOverlap, segNull, simplifyWireList, twoSegments, wireNode } from "./wire";

// ---------------------------------------------------------------- JUNCTION_HELPERS::AnalyzePoint (eeschema/junction_helpers.cpp)
export const angleKey = (from: Pt, to: Pt) => Math.round(Math.atan2(to[1] - from[1], to[0] - from[0]) * 1800 / Math.PI);
export const BUS_TEXT = /\[.*\.\..*\]|\{.*\}/;
/**
 * What meets at p: { isJunction, hasDot, hasBusEntry, hasBusAtPoint, allows } — three or more distinct
 * exit directions on the wire or the bus layer make a junction.  Collinear wires through the point are
 * merged first (unless a dot is there, crossings are being broken or three stubs already meet), so two
 * wires meeting end to end do not count as two exits.  `extra` adds lines that are not in the document
 * (a wire being drawn: [{ kind, a, b }]), `skip` leaves items out (ids).
 */
export function analyzePoint(doc: KDoc, p: Pt, breakCrossings: boolean, extra?: PreviewLine[] | null, skip?: Set<string> | null) {
  const info = { isJunction: false, hasDot: false, hasBusEntry: false, hasBusAtPoint: false, multiWires: false, multiBuses: false, allows: false };
  const lines: { layer: string; a: Pt; b: Pt }[] = [], others: KItem[] = [];
  const onLine = (a: Pt, b: Pt) => segDist(p, a, b) <= 1e-3;
  for (const it of doc.items.values()) {
    if (skip && skip.has(it.id)) continue;
    if (it.kind === "wire" || it.kind === "bus") { for (const [a, b] of segs(it)) if (onLine(a, b)) lines.push({ layer: it.kind, a, b }); }
    else if (it.kind === "junction") { if (same(atOf(it.node), p)) { info.hasDot = true; } }
    else if (it.kind === "bus_entry") { if (connPoints(doc, it).some((q) => same(q, p))) { info.hasBusEntry = true; others.push(it); } }
    else if (it.kind === "symbol" || it.kind === "sheet" || it.kind === "label" || it.kind === "global_label" || it.kind === "hierarchical_label") others.push(it);
  }
  for (const e of extra || []) if ((e.kind === "wire" || e.kind === "bus") && !same(e.a, e.b) && onLine(e.a, e.b)) lines.push({ layer: e.kind, a: e.a, b: e.b });
  const isEnd = (l: { a: Pt; b: Pt }) => same(l.a, p) || same(l.b, p);
  const pre: Record<string, Set<number>> = { wire: new Set(), bus: new Set() };
  for (const l of lines) if (!same(l.a, l.b) && isEnd(l)) pre[l.layer].add(angleKey(p, same(l.a, p) ? l.b : l.a));
  const keepStub = pre.wire.size >= 3 || pre.bus.size >= 3;
  if (!info.hasDot && !breakCrossings && !keepStub) {
    for (let merged = true; merged;) {
      merged = false;
      for (let i = 0; i < lines.length && !merged; i++) for (let j = i + 1; j < lines.length; j++) {
        if (lines[i].layer !== lines[j].layer) continue;
        const m = mergeOverlap([lines[i].a, lines[i].b], [lines[j].a, lines[j].b], null);
        if (m) { lines[i] = { layer: lines[i].layer, a: m[0], b: m[1] }; lines.splice(j, 1); merged = true; break; }
      }
    }
  }
  const exits: Record<string, Set<number>> = { wire: new Set(), bus: new Set() }, brk: Record<string, boolean> = { wire: false, bus: false }, mids: Record<string, { a: Pt; b: Pt }[]> = { wire: [], bus: [] };
  let unique = 100000, entryBus = 0, busEnds = 0;
  for (const l of lines) {
    if (same(l.a, l.b)) continue;
    if (isEnd(l)) { brk[l.layer] = true; exits[l.layer].add(angleKey(p, same(l.a, p) ? l.b : l.a)); if (l.layer === "bus") busEnds++; }
    else { if (breakCrossings) brk[l.layer] = true; mids[l.layer].push(l); }
    if (l.layer === "bus") info.hasBusAtPoint = true;
  }
  for (const it of others) {
    if (it.kind === "bus_entry") { brk.bus = true; exits.bus.add(unique++); entryBus++; brk.wire = true; exits.wire.add(unique++); info.hasBusEntry = true; }
    else if (it.kind === "symbol") { if (symbolPins(doc, it).some((q) => q.type !== "no_connect" && same([q.x, q.y], p))) { brk.wire = true; exits.wire.add(unique++); } }
    else if (it.kind === "sheet") { if (kids(it.node, "pin").some((pin) => same(atOf(pin), p))) { brk.wire = true; exits.wire.add(unique++); } }
    else if (same(atOf(it.node), p)) {
      if (it.kind === "label" && BUS_TEXT.test(str(it.node[1]))) brk.bus = true; else brk.wire = true;
    }
  }
  for (const layer of ["wire", "bus"]) if (brk[layer]) for (const l of mids[layer]) { exits[layer].add(angleKey(p, l.b)); exits[layer].add(angleKey(p, l.a)); }
  if (info.hasBusEntry) { info.multiWires = exits.wire.size > 2 && exits.bus.size === 1; info.multiBuses = exits.bus.size - entryBus >= 3 && busEnds >= 1; }
  info.isJunction = exits.wire.size >= 3 || exits.bus.size >= 3;
  info.allows = info.isJunction && (!info.hasBusEntry || info.multiWires || info.multiBuses);
  return info;
}
export const isJunctionPoint = (doc: KDoc, p: Pt) => analyzePoint(doc, p, false).isJunction;                                   // SCH_SCREEN::IsJunction
export const explicitJunctionNeeded = (doc: KDoc, p: Pt, extra?: PreviewLine[] | null, skip?: Set<string> | null) => { const i = analyzePoint(doc, p, false, extra, skip); return i.allows && !i.hasDot; };
export const explicitJunctionAllowed = (doc: KDoc, p: Pt) => analyzePoint(doc, p, true).allows;
// Every connection point of the items on the sheet (SCH_SCREEN::GetConnections).
export function screenConnections(doc: KDoc) {
  const out: Pt[] = [], seen = new Set<string>();
  for (const it of doc.items.values()) for (const p of connPoints(doc, it)) { const k = r4(p[0]) + "," + r4(p[1]); if (!seen.has(k)) { seen.add(k); out.push(p); } }
  return out;
}
// JUNCTION_HELPERS::PreviewJunctions: where junction dots would appear if the preview lines were committed.
export function previewJunctions(doc: KDoc, lines: PreviewLine[], skip?: Set<string> | null) {
  const extra = lines.filter((l) => !same(l.a, l.b)), pts: Pt[] = [], seen = new Set<string>();
  if (!extra.length) return [];
  const conns = screenConnections(doc);
  const push = (p: Pt) => { const k = r4(p[0]) + "," + r4(p[1]); if (!seen.has(k)) { seen.add(k); pts.push(p); } };
  for (const l of extra) { push(l.a); push(l.b); for (const c of conns) if (segDist(c, l.a, l.b) <= 1e-3) push(c); }
  return pts.filter((p) => analyzePoint(doc, p, false, extra, skip).allows);
}

// A dry-run edit of the sheet: changes are applied to the document as they are made (so the analysis sees
// them) and restore() puts every touched item back, ready for ctx.commit to apply the change set itself.
export function editTxn(doc: KDoc, IU: number) {
  const saved = new Map<string, KItem | null>(), out = new Map<string, KChange>();
  const keep = (id: string, obj: KItem | null) => { if (!saved.has(id)) saved.set(id, obj || null); };
  return {
    add(node: SNode) { const { item, change } = addNode(doc, node); keep(item.id, null); out.set(item.id, change); return item; },
    modify(item: KItem, node: SNode) {
      keep(item.id, item);
      const prev = out.get(item.id); let c = modChange(doc, item, node);
      if (prev && prev.kind === "ADDED") c = Object.assign({}, c, { kind: "ADDED" });
      out.set(item.id, c); K.applyChange(doc, c, IU || 1e4); return doc.items.get(item.id)!;
    },
    remove(item: KItem) {
      keep(item.id, item);
      const prev = out.get(item.id);
      if (prev && prev.kind === "ADDED") out.delete(item.id); else out.set(item.id, removeChange(item));
      doc.items.delete(item.id);
    },
    restore() { for (const [id, obj] of saved) { if (obj) doc.items.set(id, obj); else doc.items.delete(id); } },
    changes() { return Array.from(out.values()); },
    has(id: string) { return out.has(id); },
    isNew(id: string) { const c = out.get(id); return !!(c && c.kind === "ADDED"); },
  };
}
/** An edit transaction (editTxn). */
export type EditTxn = ReturnType<typeof editTxn>;
export const segOf = (it: KItem): Seg | null => { const p = ptsOf(it.node); return p.length === 2 ? [p[0], p[1]] : null; };
// AddJunction: the junction plus BreakSegments at the point (every wire and bus running through it splits).
export function txnAddJunction(t: EditTxn, doc: KDoc, p: Pt) {
  for (const kd of ["wire", "bus"]) for (const it of lineMidsAt(doc, p[0], p[1], kd)) {
    const s = segOf(it); if (!s) continue;
    const a = deep(it.node); setPts(a, [s[0], [r4(p[0]), r4(p[1])]]); t.modify(it, a);
    const tail = lineNode(it.kind, p, s[1]), st = kid(it.node, "stroke"); if (st) replaceKid(tail, deep(st)); t.add(tail);
  }
  return t.add(junctionNode(p));
}
/**
 * SCHEMATIC::CleanUp, limited to the lines `seed` names and the ones they reach: identical lines go,
 * collinear overlapping or touching lines of a layer merge (not across a junction point), junctions that
 * are no longer allowed at `points` go.  The web keeps the rest of the sheet as the user left it.
 */
export function txnCleanUp(t: EditTxn, doc: KDoc, seed: Iterable<string>, points: Pt[] | null) {
  const live = new Set(seed);
  for (const p of points || []) {
    const j = junctionAt(doc, p[0], p[1]);
    if (j && !t.has(j.id) && !explicitJunctionAllowed(doc, p)) t.remove(j);
  }
  for (let changed = true, guard = 0; changed && guard < 200; guard++) {
    changed = false;
    outer: for (const id of Array.from(live)) {
      const A = doc.items.get(id); if (!A || !isNetLine(A.kind)) { live.delete(id); continue; }
      const sa = segOf(A); if (!sa) continue;
      if (same(sa[0], sa[1])) { t.remove(A); live.delete(id); changed = true; break; }
      for (const B of Array.from(doc.items.values())) {
        if (B === A || B.kind !== A.kind) continue;
        const sb = segOf(B); if (!sb) continue;
        if (Math.max(Math.min(sa[0][0], sa[1][0]), Math.min(sb[0][0], sb[1][0])) > Math.min(Math.max(sa[0][0], sa[1][0]), Math.max(sb[0][0], sb[1][0])) + 1e-6) continue;
        if (Math.max(Math.min(sa[0][1], sa[1][1]), Math.min(sb[0][1], sb[1][1])) > Math.min(Math.max(sa[0][1], sa[1][1]), Math.max(sb[0][1], sb[1][1])) + 1e-6) continue;
        const sameStroke = K.serialize(kid(A.node, "stroke") || []) === K.serialize(kid(B.node, "stroke") || []);
        if (!sameStroke) continue;
        // keep the line that was already on the sheet: the new one is the one that goes
        const [keepIt, dropIt] = t.isNew(A.id) && !t.isNew(B.id) ? [B, A] : [A, B];
        if ((same(sa[0], sb[0]) && same(sa[1], sb[1])) || (same(sa[0], sb[1]) && same(sa[1], sb[0]))) { t.remove(dropIt); live.delete(dropIt.id); live.add(keepIt.id); changed = true; break outer; }
        const m = mergeOverlap(sa, sb, (q: Pt) => isJunctionPoint(doc, q) || !!junctionAt(doc, q[0], q[1]));
        if (!m) continue;
        const n = deep(keepIt.node); setPts(n, m); t.remove(dropIt); t.modify(keepIt, n);
        live.delete(dropIt.id); live.add(keepIt.id); changed = true; break outer;
      }
    }
  }
  return live;
}
// SCH_EDIT_FRAME::TrimWire: a wire drawn across both pins of a two-pin symbol loses the part between them.
export function txnTrimWire(t: EditTxn, doc: KDoc, a: Pt, b: Pt, only: Set<string> | null) {
  if (same(a, b)) return false;
  for (const it of Array.from(doc.items.values())) {
    if (it.kind !== "wire" || (only && !only.has(it.id))) continue;
    const s = segOf(it); if (!s) continue;
    if (segDist(a, s[0], s[1]) > 1e-3 || segDist(b, s[0], s[1]) > 1e-3) continue;
    if ((same(s[0], a) && same(s[1], b)) || (same(s[0], b) && same(s[1], a))) continue;   // a whole wire stays
    const da = Math.hypot(a[0] - s[0][0], a[1] - s[0][1]), db = Math.hypot(b[0] - s[0][0], b[1] - s[0][1]);
    const [near, far] = da <= db ? [a, b] : [b, a];
    const st = kid(it.node, "stroke");
    if (!same(s[0], near)) { const n = deep(it.node); setPts(n, [s[0], near]); t.modify(it, n); } else t.remove(it);
    if (!same(far, s[1])) { const tail = lineNode("wire", far, s[1]); if (st) replaceKid(tail, deep(st)); t.add(tail); }
    return true;
  }
  return false;
}
/**
 * finishSegments: backtracks merge away, the segments are added, CleanUp merges them with the lines they
 * continue, a wire across both pins of a two-pin symbol is trimmed, and every new end — plus every existing
 * connection point lying on a new segment — gets the junction IsExplicitJunctionNeeded asks for.
 */
export function finishWire(ctx: SchCtx) {
  const w = S.wire; S.wire = null; if (!w) return;
  const list = simplifyWireList(w.segs);
  const unfold = S.unfold; S.unfold = null;
  const doc = ctx.doc, held = unfold ? dropUnfold(doc, unfold) : null;
  if (!list.length) { ctx.requestRender(); if (w.quitOnDraw) switchTool(ctx, "select"); return; }
  const t = editTxn(doc, ctx.IU), unfoldIds: string[] = [];
  if (held && unfold!.placed) for (const n of held) unfoldIds.push(t.add(n).id);   // finishSegments: entry and label join the wires' commit
  const conns = w.kind === "polyline" ? [] : screenConnections(doc), newEnds: Pt[] = [], added: string[] = [];
  for (const s of list) {
    newEnds.push(s[0], s[1]);
    for (const c of conns) if (segDist(c, s[0], s[1]) <= 1e-3) newEnds.push(c);
    added.push(t.add(wireNode(w, s[0], s[1])).id);
  }
  try {
    if (w.kind !== "polyline") {
      const live = txnCleanUp(t, doc, added, []);
      for (const it of Array.from(doc.items.values())) {
        if (it.kind !== "symbol") continue;
        const pts = connPoints(doc, it); if (pts.length > 2) continue;
        for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) txnTrimWire(t, doc, pts[i], pts[j], live);
      }
      const seen = new Set<string>();
      for (const p of newEnds) {
        const k = r4(p[0]) + "," + r4(p[1]); if (seen.has(k)) continue; seen.add(k);
        if (explicitJunctionNeeded(doc, p)) txnAddJunction(t, doc, p);
      }
    }
  } finally { t.restore(); }
  const changes = t.changes();
  ctx.commit(changes, "Draw Wires");                         // doDrawSegments pushes "Draw Wires" for wires, buses and lines
  // SaveCopyForRepeatItem( m_wires[0] ) + AddCopyForRepeatItem for the rest: Insert repeats the whole wire
  S.lastPlaced = list.map((s) => ({ kind: w.kind, node: wireNode(w, s[0], s[1]) }));
  if (held && unfold!.placed) S.lastPlaced = held.map((n) => ({ kind: n[0] as string, node: deep(n) })).concat(S.lastPlaced);
  ctx.requestRender();
  if (w.quitOnDraw) switchTool(ctx, "select");
}
// Esc while drawing: the segments go; a wire started from a pin by the selection tool also ends its tool.
export function cancelWire(ctx: SchCtx) {
  const w = S.wire; S.wire = null;
  if (S.unfold) dropUnfold(ctx.doc, S.unfold); S.unfold = null;            // doDrawSegments' cleanup(): the entry and label go too
  ctx.requestRender(); if (w && w.quitOnDraw) switchTool(ctx, "select");
}
// The bus unfold's entry and label live on this client only until the wire is finished; take them out of the
// document and hand back their nodes.
export function dropUnfold(doc: KDoc, u: UnfoldJob) {
  const out: SNode[] = [];
  for (const id of [u.entryId, u.labelId]) { const it = doc.items.get(id); if (it) { out.push(deep(it.node)); doc.items.delete(id); } }
  return out;
}
// doDrawSegments' motion handling before the first click: the entry flips towards the cursor (the wire starts
// from its new end) and the label ghost sits on the cursor.
export function unfoldFollow(ctx: SchCtx, w: SchWire, p: Pt) {
  const u = S.unfold!, doc = ctx.doc, en = doc.items.get(u.entryId), lb = doc.items.get(u.labelId); if (!en || !lb) return;
  const sz = kid(en.node, "size"), sx = p[0] - u.origin[0] < 0 ? -1 : 1, sy = p[1] - u.origin[1] < 0 ? -1 : 1;
  if (sz && (Math.sign(num(sz[1])) !== sx || Math.sign(num(sz[2])) !== sy)) {
    sz[1] = r4(Math.abs(num(sz[1])) * sx); sz[2] = r4(Math.abs(num(sz[2])) * sy); K.replaceChange(doc, en);
    const end = [r4(u.origin[0] + num(sz[1])), r4(u.origin[1] + num(sz[2]))];
    w.segs[0][0] = end.slice(); if (twoSegments() && w.segs.length >= 2 && segNull(w.segs[0])) w.segs[1][0] = end.slice();
  }
  setAt(lb.node, r4(p[0]), r4(p[1])); K.replaceChange(doc, lb);
}
// Tool changes made by this module itself (a carried duplicate rides into the place tool, a wire auto-started
// from a pin goes back to select) are not the user activating another tool mid-operation.
export function switchTool(ctx: SchCtx, id: string) { S.internalSwitch = true; try { ctx.setTool(id); } finally { S.internalSwitch = false; } }
