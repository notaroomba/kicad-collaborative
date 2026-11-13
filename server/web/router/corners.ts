// Right-angle (and sharper) track corners: where two track segments of one net meet end to end on a layer and turn
// by 90° or more.  The person's rule: no square corners anywhere Junction routes, except on antenna and RF nets
// where a right angle is drawn on purpose.  The router chamfers them (Router.unsquare); review_design and run_checks
// report any that are left, wherever they came from.
import { pointGap, Pt, Shape } from "./grid";
import { netKind } from "./route";

/** Interior angles at or below this (degrees) count as square.  135° is the usual 45° bend. */
export const SQUARE_MAX = 91;

export interface Corner { net: string; layer: string; x: number; y: number; angle: number; ids: string[] }
export interface CornerSeg { id: string; net: string; layer: string; a: Pt; b: Pt }

const key = (layer: string, net: string, p: Pt) => `${layer}\n${net}\n${p[0].toFixed(3)},${p[1].toFixed(3)}`;

/** Interior angle in degrees between two legs leaving point v towards p and q. */
export function cornerAngle(v: Pt, p: Pt, q: Pt): number {
  const ux = p[0] - v[0], uy = p[1] - v[1], wx = q[0] - v[0], wy = q[1] - v[1]; const lu = Math.hypot(ux, uy), lw = Math.hypot(wx, wy);
  if (lu < 1e-6 || lw < 1e-6) return 180;
  return Math.acos(Math.max(-1, Math.min(1, (ux * wx + uy * wy) / (lu * lw)))) * 180 / Math.PI;
}

/**
 * The square corners among a set of track segments.  A corner is a point where exactly two segments of a net meet
 * on a layer (a tee, where three or more meet, is a junction, not a corner) and the interior angle is SQUARE_MAX or
 * less.  `covered(net, layer, p)` says the point sits on a pad or via of the net: a bend hidden under copper is not
 * a corner anyone etches.  `exempt(net)` is true for antenna and RF nets.
 */
export function findSquareCorners(segs: CornerSeg[], covered: (net: string, layer: string, p: Pt) => boolean, exempt: (net: string) => boolean): Corner[] {
  const ends = new Map<string, { s: CornerSeg; at: Pt; other: Pt }[]>();
  for (const s of segs) {
    if (!s.net || Math.hypot(s.a[0] - s.b[0], s.a[1] - s.b[1]) < 1e-4) continue;
    for (const [at, other] of [[s.a, s.b], [s.b, s.a]] as [Pt, Pt][]) { const k = key(s.layer, s.net, at); let l = ends.get(k); if (!l) ends.set(k, l = []); l.push({ s, at, other }); }
  }
  const out: Corner[] = [];
  for (const l of ends.values()) {
    if (l.length !== 2) continue; const [e1, e2] = l; const net = e1.s.net, layer = e1.s.layer;
    if (exempt(net)) continue;
    const angle = cornerAngle(e1.at, e1.other, e2.other); if (angle > SQUARE_MAX) continue;
    if (covered(net, layer, e1.at)) continue;
    out.push({ net, layer, x: +e1.at[0].toFixed(3), y: +e1.at[1].toFixed(3), angle: Math.round(angle), ids: [e1.s.id, e2.s.id] });
  }
  return out;
}

const ANTENNA_REF = /^(AE|ANT)\d/i, RF_NAME = /(^|[/_\-])(RF|ANT|ANTENNA|LNA|PA_OUT|RFIO|RF_?IN|RF_?OUT)(\d|_|$|[/_\-])/i;
const GROUND = /^\/?(.*\/)?[ADP]?GND\w*$|^\/?(.*\/)?VSS\w*$/i;

/** The square corners on a board document, with the board's own pads and vias as cover and antenna/RF nets exempt. */
export function boardSquareCorners(doc: any, P: any, isRf?: (net: string) => boolean): Corner[] {
  const conds: any[] = P.conductors(doc); const segs: CornerSeg[] = []; const cover = new Map<string, Shape[]>(); const rf = new Set<string>();
  const addCover = (net: string, layer: string, s: Shape) => { const k = layer + "\n" + net; let l = cover.get(k); if (!l) cover.set(k, l = []); l.push(s); };
  for (const c of conds) {
    if (!c.net) continue;
    if (c.kind === "segment" && c.shape && c.shape.t === "seg") { for (const l of c.layers) segs.push({ id: c.item.id, net: c.net, layer: l, a: c.shape.a, b: c.shape.b }); }
    else if (c.kind === "pad" || c.kind === "via") { for (const l of c.layers) addCover(c.net, l, c.shape); if (c.kind === "pad" && ANTENNA_REF.test(c.item.ref || "") && !GROUND.test(c.net)) rf.add(c.net); }
  }
  return findSquareCorners(segs, (net, layer, p) => (cover.get(layer + "\n" + net) || []).some((s) => pointGap(s, p[0], p[1]) <= 1e-6), (net) => rf.has(net) || RF_NAME.test(net.replace(/^\/(.*\/)?/, "")) || netKind(net) === "rf" || !!(isRf && isRf(net)));
}
