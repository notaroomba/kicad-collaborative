// web/fab/pnp — Gerber X3 placement files, as PLACEFILE_GERBER_WRITER (pcbnew/exporters/gerber_placefile_writer.cpp)
// writes them: <board>-pnp_top.gbr and <board>-pnp_bottom.gbr, %TF.FileFunction,Component,L1,Top (Ln,Bot).
// Per footprint on the side: a 0.3 mm ComponentMain flash at its position carrying %TO.C and the P&P records
// (%TO.CFtp, CVal, CLbN, CMnt, CRot); its courtyard (or, when it has none, the box of its pads) drawn with a
// 0.1 mm ComponentOutline pen; a 0.36 mm diamond ComponentPin on pad 1 / A1 and a 0.1 mm ComponentPin flash on
// every other pad of that side; then %TD*%.  The board outline follows when asked.
import { arcFrom3, atOf, isList, kid, num, ptsOf, str } from "../canvas/sexpr";
import { projectGuid, writeGerber } from "./gerber";
import { type FabContext, VERSION_SUFFIX, modelOf, projectNameOf } from "./index";
import type { BoardModel, Footprint, Node } from "./model";
import { PlotLog, plotFile } from "./plot";
import { isoDateTime } from "./plotter";
import { MAX_ERROR } from "./poly";
import { type GbrMeta, type Prim, type Pt, arcPoints, circlePoints, rot } from "./prims";

export interface PnpOptions {
  /** "F.Cu" or "B.Cu" */
  side: string;
  includeBoardEdge: boolean; excludeDnp: boolean; excludeBom: boolean;
  /** the board plot settings' Use drill/place file origin (CreatePlaceFile reads GetPlotOptions) */
  useAuxOrigin: boolean;
}

/** ConvertNotAllowedCharsInGerber with UTF-8 allowed and no quotes: , * % \ as \uXXXX. */
export function gerberField(s: string): string {
  let out = "";
  for (const ch of s) { const c = ch.charCodeAt(0); out += ch === "\\" || ch === "%" || ch === "*" || ch === "," ? "\\u" + c.toString(16).toUpperCase().padStart(4, "0") : ch; }
  return out;
}

/** wxString << double: printf's %g. */
export function fmtG(v: number): string {
  if (v === 0) return "0";
  const e = Math.floor(Math.log10(Math.abs(v)));
  if (e < -5 || e >= 6) { const s = v.toExponential(5).replace(/\.?0+e/, "e"); return s.replace(/e([+-])(\d)$/, "e$10$2"); }
  return String(Number(v.toPrecision(6)));
}

/** mapRotationAngle: the footprint's orientation, + 180 (folded into (-180, 180]) on the bottom side. */
export function pnpRotation(deg: number, flipped: boolean): number {
  let a = deg % 360; if (a > 180) a -= 360; if (a <= -180) a += 360;
  if (!flipped) return a;
  let g = 180 + a;
  if (g <= -180) g += 360; else if (g > 180) g -= 360;
  return g;
}

/** FOOTPRINT::BuildCourtyardCaches for one side: the courtyard drawings chained into closed outlines, or null
 *  when they do not close (MALFORMED_COURTYARD), or [] when the side has none. */
export function courtyardLoops(fp: Footprint, layer: string): Pt[][] | null {
  const loops: Pt[][] = [], open: Pt[][] = [];
  for (const g of fp.node) {
    if (!isList(g)) continue;
    const t = String(g[0]);
    if (!/^fp_(line|rect|circle|arc|poly)$/.test(t)) continue;
    const l = kid(g as Node, "layer"); if (!l || str(l[1]) !== layer) continue;
    const P = (key: string): Pt | null => { const k = kid(g as Node, key); return k ? fp.tf(num(k[1]), num(k[2])) : null; };
    if (t === "fp_line") { const a = P("start"), b = P("end"); if (a && b) open.push([a, b]); }
    else if (t === "fp_rect") {
      const s = kid(g as Node, "start"), e = kid(g as Node, "end"); if (!s || !e) continue;
      const [x0, y0, x1, y1] = [num(s[1]), num(s[2]), num(e[1]), num(e[2])];
      loops.push([fp.tf(x0, y0), fp.tf(x1, y0), fp.tf(x1, y1), fp.tf(x0, y1)]);
    } else if (t === "fp_circle") {
      const c = P("center"), e = P("end"); if (!c || !e) continue;
      loops.push(circlePoints(c[0], c[1], Math.hypot(e[0] - c[0], e[1] - c[1]), MAX_ERROR));
    } else if (t === "fp_arc") {
      const a = P("start"), m = P("mid"), b = P("end"); if (!a || !m || !b) continue;
      const arc = arcFrom3(a, m, b) as { x: number; y: number; r: number; a0: number; a1: number; anticlockwise: boolean } | null;
      open.push(arc ? arcPoints(arc.x, arc.y, arc.r, arc.a0, arc.a1, arc.anticlockwise, MAX_ERROR) : [a, b]);
    } else {
      const pts = (ptsOf(g as Node) as Pt[]).map((q) => fp.tf(q[0], q[1]));
      if (pts.length > 2) loops.push(pts);
    }
  }
  // chain the open pieces end to end (0.02 mm, the courtyard chaining epsilon)
  const eps = 0.02, near = (a: Pt, b: Pt): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) <= eps;
  const pool = open.slice();
  while (pool.length) {
    let chain = pool.shift()!.slice();
    for (let grew = true; grew && !near(chain[0], chain[chain.length - 1]);) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const c = pool[i], end = chain[chain.length - 1];
        if (near(end, c[0])) chain = chain.concat(c.slice(1));
        else if (near(end, c[c.length - 1])) chain = chain.concat(c.slice(0, -1).reverse());
        else continue;
        pool.splice(i, 1); grew = true; break;
      }
    }
    if (chain.length < 3 || !near(chain[0], chain[chain.length - 1])) return null;
    loops.push(chain.slice(0, -1));
  }
  return loops;
}

/** GetFpPadsLocalBbox: the pads' box in the footprint's own frame (orientation 0, not flipped). */
function padsLocalBox(fp: Footprint): [number, number, number, number] | null {
  let b: [number, number, number, number] | null = null;
  for (const p of fp.pads) {
    const [px, py, prot] = atOf(p.node) as [number, number, number];
    const s = p.base, local = (prot || 0) - fp.rot;
    const corners: Pt[] = s.shape === "circle" ? [[-s.w / 2, -s.w / 2], [s.w / 2, s.w / 2]].map((c) => [c[0] + s.offset[0], c[1] + s.offset[1]] as Pt).map((c) => [px + c[0], py + c[1]] as Pt)
      : ([[-s.w / 2, -s.h / 2], [s.w / 2, -s.h / 2], [s.w / 2, s.h / 2], [-s.w / 2, s.h / 2]] as Pt[]).map((c) => { const q = rot(c[0] + s.offset[0], c[1] + s.offset[1], local); return [px + q[0], py + q[1]] as Pt; });
    for (const c of corners) b = b ? [Math.min(b[0], c[0]), Math.min(b[1], c[1]), Math.max(b[2], c[0]), Math.max(b[3], c[1])] : [c[0], c[1], c[0], c[1]];
  }
  return b;
}

const ref1 = (fp: Footprint): string => gerberField(fp.ref);
const version = (ctx: FabContext): string => String((ctx.doc as unknown as { kicadVersion?: string }).kicadVersion || "10.99") + VERSION_SUFFIX;

/** GetPlaceFileName: <board>-pnp_top.gbr / -pnp_bottom.gbr. */
export const pnpFileName = (board: string, side: string): string => `${board}-pnp_${side === "B.Cu" ? "bottom" : "top"}.gbr`;

/** CreatePlaceFile: the file and its component count. */
export function pnpGerber(ctx: FabContext, o: PnpOptions): { text: string; count: number } {
  const date = isoDateTime(ctx.date || new Date());
  const m: BoardModel = modelOf(ctx);
  const back = o.side === "B.Cu";
  const list = m.footprints.filter((fp) => !fp.excludeFromPos && !(o.excludeDnp && fp.dnp) && !(o.excludeBom && fp.excludeFromBom) && fp.side === o.side);
  const prims: Prim[] = [];
  for (const fp of list) {
    const ref = ref1(fp);
    const mount = fp.throughHole ? "TH" : fp.smd ? "SMD" : "Other";
    const extra: string[] = [];
    const field = (k: string, v: string): void => { if (v) extra.push(`%TO.${k},${v}*%`); };
    const colon = fp.lib.indexOf(":");
    field("CFtp", gerberField(colon >= 0 ? fp.lib.slice(colon + 1) : fp.lib));
    field("CVal", gerberField(fp.value));
    field("CLbN", gerberField(colon >= 0 ? fp.lib.slice(0, colon) : ""));
    extra.push(`%TO.CMnt,${mount}*%`, `%TO.CRot,${fmtG(pnpRotation(fp.rot, back))}*%`);
    prims.push({ k: "circle", x: fp.x, y: fp.y, d: 0.3, meta: { af: "ComponentMain", info: 4, ref, extra } });
    const keepCmp: GbrMeta = { info: 4, ref, keep: true };
    const outline = (pts: Pt[], af: string): void => {
      const ring = pts.concat([pts[0]]);
      for (let i = 0; i + 1 < ring.length; i++) prims.push({ k: "seg", x1: ring[i][0], y1: ring[i][1], x2: ring[i + 1][0], y2: ring[i + 1][1], w: 0.1, meta: Object.assign({ af }, keepCmp) });
    };
    const loops = courtyardLoops(fp, back ? "B.CrtYd" : "F.CrtYd");
    let usePads = true;
    if (loops) for (const l of loops) { if (!l.length) continue; usePads = false; outline(l, "ComponentOutline,Courtyard"); }
    if (usePads) {
      const b = padsLocalBox(fp);
      if (b) {
        // the box of the unflipped footprint, Y negated on the bottom: the stored frame again, corners in KiCad's order
        const [l, t, r, btm] = b;
        const corners: Pt[] = back ? [[l, btm], [l, t], [r, t], [r, btm]] : [[l, t], [l, btm], [r, btm], [r, t]];
        outline(corners.map((c) => fp.tf(c[0], c[1])), "ComponentOutline,Footprint");
      }
    }
    const onSide = fp.pads.filter((p) => p.layers.has(o.side));
    const ones = onSide.filter((p) => p.number === "1" || p.number === "A1");
    const pinFn = (p: Footprint["pads"][number]): string => { const k = kid(p.node, "pinfunction"); return k ? gerberField(str(k[1])) : ""; };
    for (const p of ones) prims.push({ k: "rpoly", x: p.x, y: p.y, d: 0.36, n: 4, rot: 0, meta: { af: "ComponentPin", info: 1, ref, pad: gerberField(p.number), pinFn: pinFn(p), rawPad: true, keep: true } });
    for (const p of onSide) if (!ones.includes(p)) prims.push({ k: "circle", x: p.x, y: p.y, d: 0.1, meta: { af: "ComponentPin", info: 1, ref, pad: gerberField(p.number), pinFn: pinFn(p), rawPad: true, keep: true } });
    prims.push({ k: "td" });
  }
  if (o.includeBoardEdge) {
    const edge = plotFile(m, "Edge.Cuts", { plotReference: false, plotValue: false, subtractMaskFromSilk: false }, new PlotLog());
    for (const p of edge) prims.push(Object.assign({}, p, { meta: Object.assign({}, p.meta || {}, { info: 0 }) }) as Prim);
  }
  const board = projectNameOf(ctx);
  const text = writeGerber(prims, { fileFunction: `Component,L${back ? m.copper.length : 1},${back ? "Bot" : "Top"}`, polarity: "Positive" },
    { x2: true, origin: o.useAuxOrigin ? m.settings.auxOrigin : [0, 0], software: `KiCad,Pcbnew,${version(ctx)}`, date, precision: 6, netAttributes: true,
      project: { name: board, guid: projectGuid(board + ".kicad_pcb"), rev: (ctx.doc.titleBlock && ctx.doc.titleBlock.rev) || "rev?" } });
  return { text, count: list.length };
}
