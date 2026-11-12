// ---------------------------------------------------------------- auto-rotate on placement (global / hierarchical labels)
// SCH_SCREEN::GetLabelOrientationForPoint and SCH_EDIT_FRAME::AutoRotateItem.  The flag (the label dialog's
// "Auto" checkbox, SCH_LABEL_BASE::m_autoRotateOnPlacement) is not saved in the file: it lives with the item on
// this page, and the last value is remembered for the next label (m_lastAutoLabelRotateOnPlacement).
import type { Pt } from "./types";
import { symbolPins } from "./autoplace";
import { K, S, atOf, kid, num, ptsOf } from "./state";
import { modChange } from "./util";

/** SPIN_STYLE as the web keeps it: the label's angle / 90 — 0 RIGHT, 1 UP, 2 LEFT, 3 BOTTOM. */
export type Spin = 0 | 1 | 2 | 3;
export const SPIN_RIGHT: Spin = 0, SPIN_UP: Spin = 1, SPIN_LEFT: Spin = 2, SPIN_BOTTOM: Spin = 3;
const autoIds = (): Set<string> => (S.autoRotateIds = S.autoRotateIds || new Set<string>());
export function autoRotateOf(id: string): boolean { return autoIds().has(id); }
export function setAutoRotate(id: string, on: boolean): void { if (on) autoIds().add(id); else autoIds().delete(id); }
export const supportsAutoRotate = (kind: string): boolean => kind === "global_label" || kind === "hierarchical_label";

const eq = (a: Pt, b: Pt): boolean => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
/** SCH_LINE's bounding box (Overlapping): the segment's box grown by half its width. */
function overlapsLine(a: Pt, b: Pt, w: number, p: Pt): boolean {
  const m = w / 2 + 1e-6;
  return p[0] >= Math.min(a[0], b[0]) - m && p[0] <= Math.max(a[0], b[0]) + m && p[1] >= Math.min(a[1], b[1]) - m && p[1] <= Math.max(a[1], b[1]) + m;
}
const lineW = (n: SNode, kind: string): number => { const s = kid(n, "stroke"), w = s && kid(s, "width"); const v = w ? num(w[1]) : 0; return v > 0 ? v : kind === "bus" ? 0.3048 : 0.1524; };
/** EDA_ANGLE( end - start ) == 90° / 0° exactly, as GetLabelOrientationForPoint tests a bus. */
const angleIs = (a: Pt, b: Pt, deg: 0 | 90): boolean => deg === 90 ? Math.abs(a[0] - b[0]) < 1e-9 && b[1] > a[1] : Math.abs(a[1] - b[1]) < 1e-9 && b[0] > a[0];
function onSegment(p: Pt, a: Pt, b: Pt): boolean {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]); if (Math.abs(cross) > 1e-6) return false;
  return p[0] >= Math.min(a[0], b[0]) - 1e-6 && p[0] <= Math.max(a[0], b[0]) + 1e-6 && p[1] >= Math.min(a[1], b[1]) - 1e-6 && p[1] <= Math.max(a[1], b[1]) + 1e-6;
}

/**
 * GetLabelOrientationForPoint: the spin a label at `p` takes from what it sits on — a bus entry's bus side, the
 * direction of a wire / bus / line end (its end point faces RIGHT or BOTTOM, its start LEFT or UP), or the pin's
 * spin style.  Items are visited in document order and the last one that applies wins.
 */
export function labelOrientationForPoint(doc: KDoc, p: Pt, dflt: Spin, skipId?: string): Spin {
  let ret = dflt;
  for (const it of doc.items.values()) {
    if (it.id === skipId) continue;
    const n = it.node;
    if (it.kind === "bus_entry") {
      const [x, y] = atOf(n); const sz = kid(n, "size"); const dx = sz ? num(sz[1]) : 2.54, dy = sz ? num(sz[2]) : 2.54;
      const e0: Pt = [x, y], e1: Pt = [x + dx, y + dy];
      if (!overlapsLine(e0, e1, 0, p)) continue;
      // m_connected_bus_item: the bus one of the entry's ends lies on
      let bus: Pt[] | null = null;
      for (const o of doc.items.values()) { if (o.kind !== "bus") continue; const q = ptsOf(o.node); if (q.length >= 2 && (onSegment(e0, q[0], q[1]) || onSegment(e1, q[0], q[1]))) { bus = q; break; } }
      if (!bus) continue;
      if (angleIs(bus[0], bus[1], 90)) { if (p[0] < bus[0][0]) ret = SPIN_LEFT; else if (p[0] > bus[0][0]) ret = SPIN_RIGHT; }
      else if (angleIs(bus[0], bus[1], 0)) { if (p[1] < bus[0][1]) ret = SPIN_UP; else if (p[1] > bus[0][1]) ret = SPIN_BOTTOM; }
    } else if (it.kind === "wire" || it.kind === "bus" || it.kind === "polyline") {
      const q = ptsOf(n); if (q.length !== 2) continue;                       // SCH_LINE (a multi-point polyline is a shape)
      const [s, e] = q; if (!overlapsLine(s, e, lineW(n, it.kind), p)) continue;
      // Angle().Normalize90(): -90 < a <= 90
      let ang = Math.atan2(e[1] - s[1], e[0] - s[0]) * 180 / Math.PI; while (ang > 90) ang -= 180; while (ang <= -90) ang += 180;
      if (-45 < ang && ang <= 45) ret = s[0] <= e[0] ? (eq(e, p) ? SPIN_RIGHT : SPIN_LEFT) : (eq(e, p) ? SPIN_LEFT : SPIN_RIGHT);
      else ret = s[1] <= e[1] ? (eq(e, p) ? SPIN_BOTTOM : SPIN_UP) : (eq(e, p) ? SPIN_UP : SPIN_BOTTOM);
    } else if (it.kind === "symbol") {
      for (const pin of symbolPins(doc, it)) if (eq([pin.x, pin.y], p)) {
        // GetPinSpinStyle: away from the body, in the symbol's own transform
        ret = pin.side === "right" ? SPIN_RIGHT : pin.side === "left" ? SPIN_LEFT : pin.side === "top" ? SPIN_UP : SPIN_BOTTOM;
        break;
      }
    }
  }
  return ret;
}
export const spinOfNode = (n: SNode): Spin => { const r = ((Math.round(atOf(n)[2]) % 360) + 360) % 360; return (Math.round(r / 90) % 4) as Spin; };
/** SCH_LABEL_BASE::SetSpinStyle on a node: the angle and the justification it implies. */
export function setSpinOfNode(kind: string, n: SNode, spin: Spin): void {
  const a = kid(n, "at"); if (a) a[3] = spin * 90;
  const e = kid(n, "effects"); if (!e) return;
  const right = spin === SPIN_LEFT || spin === SPIN_BOTTOM;
  const j = kid(e, "justify"); const mirror = !!j && j.includes("mirror");
  const jv: SNode = ["justify", right ? "right" : "left"]; if (kind === "label") jv.push("bottom"); if (mirror) jv.push("mirror");
  if (j) e[e.indexOf(j)] = jv; else e.push(jv);
}
/**
 * AutoRotateItem on a node about to be committed: the new spin when the label wants it and it changes, else null.
 * (A changed spin also re-autoplaces the same-named global labels' fields in KiCad; the web keeps their positions.)
 */
export function autoRotateNode(doc: KDoc, kind: string, n: SNode, id: string | null, force?: boolean): SNode | null {
  if (!supportsAutoRotate(kind) || !(force || (id && autoRotateOf(id)))) return null;
  const cur = spinOfNode(n), [x, y] = atOf(n);
  const spin = labelOrientationForPoint(doc, [x, y], cur, id || undefined);
  if (spin === cur) return null;
  const out = K.cloneNode(n); setSpinOfNode(kind, out, spin); return out;
}
/**
 * SCH_MOVE_TOOL's AutoRotateItem for every moved label that wants it, evaluated on a dry run of the move's changes
 * (so the wires that moved with the label count where they land): the changes with those labels' spins set.
 */
export function autoRotateChanges(doc: KDoc, changes: KChange[], IU: number): KChange[] {
  const want = changes.filter((c) => c.kind === "MODIFIED" && autoRotateOf(c.id) && supportsAutoRotate((doc.items.get(c.id) || { kind: "" }).kind));
  if (!want.length) return changes;
  const saved = new Map<string, KItem | null>(); for (const c of changes) if (!saved.has(c.id)) saved.set(c.id, doc.items.get(c.id) || null);
  const swap = new Map<string, KChange>();
  try {
    for (const c of changes) K.applyChange(doc, c, IU);
    for (const c of want) {
      const it = doc.items.get(c.id); if (!it) continue;
      const n = autoRotateNode(doc, it.kind, it.node, it.id); if (n) swap.set(c.id, modChange(doc, it, n));
    }
  } finally {
    for (const [id, obj] of saved) { if (obj) doc.items.set(id, obj); else doc.items.delete(id); }
  }
  return swap.size ? changes.map((c) => swap.get(c.id) || c) : changes;
}
