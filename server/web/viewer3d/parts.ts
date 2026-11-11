// viewer3d/parts.ts — placeholder 3D shapes per footprint class.  The web has no 3D models, so a footprint
// is recognised by its library name (KiCad's library naming conventions: R_Axial_DIN0207_L6.3mm_D2.5mm…,
// DIP-40_W15.24mm, SOIC-20W_7.5x12.8mm_P1.27mm, CP_Radial_D8.0mm, PinHeader_1x05_P2.54mm_Vertical, TO-220-3…)
// and its pads, and drawn as a few solids with the proportions and colours of KiCad's own library models:
// axial parts as cylinders along their leads, DIPs with a notch, gull-wing ICs flat with their leads, chip
// passives with tinned ends, electrolytics as sleeved cans, headers as a plastic strip with gold posts.
// Pure geometry: no DOM, no three.js.  Heights are measured from the face the part sits on, away from the board.
import type { RGBA } from "./colors";
import type { Pt } from "./outline";

export type Solid =
  /** a vertical prism over a footprint-local outline (round: shaded smoothly), from z0 to z1, its top edge bevelled */
  | { k: "prism"; pts: Pt[]; z0: number; z1: number; color: RGBA; round?: boolean; bevel?: number }
  /** a horizontal cylinder between two footprint-local points, axis at height z */
  | { k: "cyl"; a: Pt; b: Pt; r: number; z: number; color: RGBA };

// colours after KiCad's library models (3dmodels/*.wrl materials), toned down a little
const C = {
  black: [0.10, 0.10, 0.11, 1] as RGBA,
  plastic: [0.14, 0.14, 0.15, 1] as RGBA,
  pin1: [0.55, 0.55, 0.57, 1] as RGBA,
  tin: [0.74, 0.74, 0.76, 1] as RGBA,
  gold: [0.80, 0.66, 0.30, 1] as RGBA,
  resistor: [0.80, 0.70, 0.52, 1] as RGBA,
  glass: [0.74, 0.33, 0.20, 1] as RGBA,
  ceramic: [0.70, 0.57, 0.38, 1] as RGBA,
  disc: [0.80, 0.50, 0.20, 1] as RGBA,
  axialCap: [0.30, 0.42, 0.62, 1] as RGBA,
  sleeve: [0.12, 0.15, 0.28, 1] as RGBA,
  can: [0.78, 0.78, 0.80, 1] as RGBA,
  led: [0.80, 0.20, 0.16, 1] as RGBA,
  ledSmd: [0.90, 0.88, 0.80, 1] as RGBA,
  tantalum: [0.84, 0.62, 0.20, 1] as RGBA,
  inductor: [0.30, 0.30, 0.32, 1] as RGBA,
  terminal: [0.20, 0.45, 0.26, 1] as RGBA,
  zif: [0.20, 0.23, 0.30, 1] as RGBA,
  shell: [0.40, 0.41, 0.43, 1] as RGBA,
  trimmer: [0.22, 0.32, 0.58, 1] as RGBA,
};
export const PART_COLORS = C;

/** One pad in footprint-local millimetres. */
export interface LocalPad { num: string; x: number; y: number; w: number; h: number; drill: boolean }
interface Box { x0: number; y0: number; x1: number; y1: number }

const num = (v: unknown, d = 0): number => { const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN; return isFinite(n) ? n : d; };
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const mmIn = (name: string, key: string): number | null => { const m = new RegExp(`(?:^|_)${key}(\\d+(?:\\.\\d+)?)mm`).exec(name); return m ? parseFloat(m[1]) : null; };

/** The pads of a footprint node, in its own frame. */
export function localPads(node: SNode): LocalPad[] {
  const out: LocalPad[] = [];
  for (const c of node) {
    if (!Array.isArray(c) || c[0] !== "pad") continue;
    let x = 0, y = 0, w = 0, h = 0, drill = false;
    for (const k of c) {
      if (!Array.isArray(k)) continue;
      if (k[0] === "at") { x = num(k[1]); y = num(k[2]); }
      else if (k[0] === "size") { w = num(k[1]); h = num(k[2], w); }
      else if (k[0] === "drill") drill = true;
    }
    out.push({ num: typeof c[1] === "string" ? c[1] : String(c[1]), x, y, w, h, drill });
  }
  return out;
}

export const rectPts = (b: Box): Pt[] => [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]];
export function circlePts(x: number, y: number, r: number, n = 28): Pt[] { const out: Pt[] = []; for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; out.push([x + r * Math.cos(a), y + r * Math.sin(a)]); } return out; }
const boxOf = (pts: { x: number; y: number }[], grow = 0): Box => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x0: x0 - grow, y0: y0 - grow, x1: x1 + grow, y1: y1 + grow };
};
const centred = (cx: number, cy: number, w: number, l: number): Box => ({ x0: cx - w / 2, y0: cy - l / 2, x1: cx + w / 2, y1: cy + l / 2 });
const bw = (b: Box) => b.x1 - b.x0, bl = (b: Box) => b.y1 - b.y0;
const prism = (b: Box, z0: number, z1: number, color: RGBA, bevel?: number): Solid => ({ k: "prism", pts: rectPts(b), z0, z1, color, bevel });
const disc = (x: number, y: number, r: number, z0: number, z1: number, color: RGBA, bevel?: number): Solid => ({ k: "prism", pts: circlePts(x, y, r), z0, z1, color, round: true, bevel });

/** The two pads farthest apart (the lead axis of an axial or a two-terminal part). */
function farthest(pads: LocalPad[]): [LocalPad, LocalPad] | null {
  if (pads.length < 2) return null;
  let best: [LocalPad, LocalPad] = [pads[0], pads[1]], d = -1;
  for (let i = 0; i < pads.length; i++) for (let j = i + 1; j < pads.length; j++) { const e = Math.hypot(pads[i].x - pads[j].x, pads[i].y - pads[j].y); if (e > d) { d = e; best = [pads[i], pads[j]]; } }
  return best;
}
/** How many different values (to 0.01 mm): 2 for the coordinate across a two-row package. */
const distinct = (vs: number[]): number => new Set(vs.map((v) => Math.round(v * 100))).size;
const padOne = (pads: LocalPad[]): LocalPad => pads.find((p) => p.num === "1") || pads[0];

/** Thin tinned leads standing in the drilled pads, up to height z. */
function thtLeads(pads: LocalPad[], z: number, out: Solid[], size = 0.5, color = C.tin): void {
  for (const p of pads) if (p.drill) out.push(prism(centred(p.x, p.y, size, size), 0, z, color));
}

/** A footprint's placeholder solids (footprint-local), or null when its name says nothing we model. */
export function partSolids(lib: string, ref: string, pads: LocalPad[], fab: Box | null, fabCircle: { x: number; y: number; r: number } | null, smd: boolean): Solid[] | null {
  const name = (lib.split(":").pop() || "").trim();
  if (!name || pads.length < 2) return null;
  const out: Solid[] = [];
  const pbox = boxOf(pads);
  const prefix = (/^[A-Za-z]+/.exec(ref || "") || [""])[0].toUpperCase();

  // ---- axial two-terminal parts lying along their leads
  const axial = /Axial|DO-35|DO-34|DO-41|DO-15|DO-201|SOD27|SOD68|SOD57|SOD64|SOD81/i.test(name) && !/Vertical/i.test(name);
  if (axial && !smd) {
    const ends = farthest(pads); if (!ends) return null;
    const [p0, p1] = ends; const span = Math.hypot(p1.x - p0.x, p1.y - p0.y); if (span < 1) return null;
    const ux = (p1.x - p0.x) / span, uy = (p1.y - p0.y) / span;
    const isDiode = /^D_|Diode|DO-|SOD/i.test(name) || prefix === "D";
    const isCap = /^C_|^CP_/i.test(name) || prefix === "C";
    let L = mmIn(name, "L"), D = mmIn(name, "D");
    if (/DIN0207/i.test(name)) { L = L || 6.3; D = D || 2.5; } else if (/DIN0204/i.test(name)) { L = L || 3.6; D = D || 1.6; } else if (/DIN0309/i.test(name)) { L = L || 9; D = D || 3.2; }
    if (/DO-35|SOD27/i.test(name)) { L = L || 4; D = D || 2; } else if (/DO-34|SOD68/i.test(name)) { L = L || 3; D = D || 1.6; } else if (/DO-41|SOD81/i.test(name)) { L = L || 5.2; D = D || 2.7; } else if (/DO-15/i.test(name)) { L = L || 7.6; D = D || 3.6; } else if (/DO-201/i.test(name)) { L = L || 9.5; D = D || 5.3; }
    if (!L && fab) L = Math.abs(ux) > Math.abs(uy) ? bw(fab) : bl(fab);
    if (!D && fab) D = Math.abs(ux) > Math.abs(uy) ? bl(fab) : bw(fab);
    L = clamp(L || span * 0.6, 1, span - 1); D = clamp(D || 2.5, 0.8, 12);
    const r = D / 2, z = r + 0.15, mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
    const a: Pt = [mx - ux * L / 2, my - uy * L / 2], b: Pt = [mx + ux * L / 2, my + uy * L / 2];
    const glass = /DO-35|DO-34|SOD27|SOD68/i.test(name);
    const body = isDiode ? (glass ? C.glass : C.black) : isCap ? (/^CP_/i.test(name) ? C.sleeve : C.axialCap) : C.resistor;
    out.push({ k: "cyl", a, b, r, z, color: body });
    if (isDiode) {   // the cathode band at pad 1's end (KiCad diodes: pad 1 = K)
      const k = padOne(pads) === p0 ? a : b, dir = k === a ? 1 : -1, w = Math.min(0.6, L * 0.15);
      out.push({ k: "cyl", a: [k[0] + dir * ux * 0.25 * w, k[1] + dir * uy * 0.25 * w], b: [k[0] + dir * ux * 1.25 * w, k[1] + dir * uy * 1.25 * w], r: r * 1.03, z, color: glass ? C.black : C.pin1 });
    }
    // the leads: bent down into both pads
    const lr = 0.25;
    out.push({ k: "cyl", a: [p0.x, p0.y], b: a, r: lr, z, color: C.tin }, { k: "cyl", a: b, b: [p1.x, p1.y], r: lr, z, color: C.tin });
    thtLeads([p0, p1], z, out);
    return out;
  }

  // ---- DIP packages and their sockets; ZIF sockets
  if (/(^|_)(PDIP|CERDIP|DIP)-?\d+/i.test(name) && !smd) {
    // KiCad's DIPs: the two rows along Y, W apart in X (as placed, possibly turned: whichever axis has two pad columns)
    const W = distinct(pads.map((p) => p.x)) === 2 ? "x" : distinct(pads.map((p) => p.y)) === 2 ? "y" : bw(pbox) <= bl(pbox) ? "x" : "y";
    const body: Box = W === "x" ? { x0: pbox.x0 + 0.65, x1: pbox.x1 - 0.65, y0: pbox.y0 - 1.27, y1: pbox.y1 + 1.27 } : { x0: pbox.x0 - 1.27, x1: pbox.x1 + 1.27, y0: pbox.y0 + 0.65, y1: pbox.y1 - 0.65 };
    const socket = /Socket/i.test(name); const base = socket ? 3.2 : 0.5;
    if (socket) out.push(prism({ x0: body.x0 - 0.6, x1: body.x1 + 0.6, y0: body.y0 - 0.4, y1: body.y1 + 0.4 }, 0, base, C.plastic, 0.2));
    out.push(prism(body, base, base + 3.3, C.black, 0.25));
    // the notch at pin 1's end: a dark half-disc sunk into the top
    const p1 = padOne(pads); const nr = Math.min(0.9, (W === "x" ? bw(body) : bl(body)) * 0.14);
    const nx = W === "x" ? (body.x0 + body.x1) / 2 : (Math.abs(p1.x - body.x0) < Math.abs(p1.x - body.x1) ? body.x0 : body.x1);
    const ny = W === "x" ? (Math.abs(p1.y - body.y0) < Math.abs(p1.y - body.y1) ? body.y0 : body.y1) : (body.y0 + body.y1) / 2;
    out.push(disc(nx, ny, nr, base + 3.3, base + 3.32, C.plastic));
    thtLeads(pads, base + 0.4, out, 0.45);
    return out;
  }
  if (/tex|ZIF/i.test(name) && !smd) {
    const b = fab && bw(fab) > bw(pbox) ? fab : { x0: pbox.x0 - 2, x1: pbox.x1 + 2, y0: pbox.y0 - 3, y1: pbox.y1 + 3 };
    out.push(prism(b, 0, 8.5, C.zif, 0.4));
    thtLeads(pads, 0.6, out);
    return out;
  }

  // ---- gull-wing / leadless ICs
  const icM = /(^|_)(SOIC|SO|SOP|SSOP|TSSOP|MSOP|VSSOP|HTSSOP|QSOP|TSOP|LQFP|TQFP|PQFP|QFP|VQFP|PLCC|QFN|DFN|VQFN|WQFN|BGA|LGA|SOT-?\d*|SC-70|TO-252|TO-263|TO-268|SOD-?\d+|SMA|SMB|SMC|MiniMELF|MELF)([-_]|\d|$)/i.exec(name);
  if (icM && smd) {
    const fam = icM[2].toUpperCase();
    const dims = /_(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(?:x(\d+(?:\.\d+)?))?mm/.exec(name);
    let body: Box;
    if (fab && bw(fab) > 0.3 && bl(fab) > 0.3) body = fab;
    else if (dims) {
      // the name's W x L: L runs along the pin rows (two rows of fixed X: L along Y; of fixed Y: along X)
      let w = parseFloat(dims[1]), l = parseFloat(dims[2]);
      const nx = distinct(pads.map((p) => p.x)), ny = distinct(pads.map((p) => p.y));
      if (nx === 2 ? false : ny === 2 ? true : (bw(pbox) > bl(pbox)) !== (w > l)) [w, l] = [l, w];
      body = centred((pbox.x0 + pbox.x1) / 2, (pbox.y0 + pbox.y1) / 2, w, l);
    }
    else body = centred((pbox.x0 + pbox.x1) / 2, (pbox.y0 + pbox.y1) / 2, Math.max(0.6, bw(pbox) * 0.7), Math.max(0.6, bl(pbox) * 0.7));
    const H = dims && dims[3] ? parseFloat(dims[3]) : /PQFP|PLCC/.test(fam) ? 3.2 : /TQFP|TSSOP|MSOP|VSSOP|HTSSOP|TSOP/.test(fam) ? 1.05 : /QFN|DFN|LGA/.test(fam) ? 0.85 : /BGA/.test(fam) ? 1.2 : /SOT/.test(fam) ? (bw(body) * bl(body) > 20 ? 1.65 : 1.0) : /TO-2/.test(fam) ? 2.3 : /SOD|SM[ABC]|MELF/.test(fam) ? 1.1 : /SSOP|QSOP/.test(fam) ? 1.5 : /QFP/.test(fam) ? 1.45 : 1.5;
    const stand = /QFN|DFN|LGA|BGA/.test(fam) ? 0 : 0.1;
    const color = /MELF/.test(fam) ? C.glass : C.black;
    out.push(prism(body, stand, stand + H, color, Math.min(0.25, H * 0.2)));
    // leads: from the body edge out to each pad that lies outside it (gull wings, J-leads, SOT legs)
    if (!/QFN|DFN|LGA|BGA/.test(fam)) for (const p of pads) {
      const lw = Math.max(0.15, Math.min(p.w, p.h) * 0.55);
      let lb: Box | null = null;
      if (p.x < body.x0 || p.x > body.x1) { const e = p.x < body.x0 ? body.x0 : body.x1; lb = { x0: Math.min(e, p.x), x1: Math.max(e, p.x), y0: p.y - lw / 2, y1: p.y + lw / 2 }; }
      else if (p.y < body.y0 || p.y > body.y1) { const e = p.y < body.y0 ? body.y0 : body.y1; lb = { y0: Math.min(e, p.y), y1: Math.max(e, p.y), x0: p.x - lw / 2, x1: p.x + lw / 2 }; }
      if (lb) out.push(prism(lb, 0, Math.min(0.35, stand + H * 0.4), C.tin));
    }
    // pin 1: a dimple near its corner
    if (pads.length > 3 && !/SOT|SOD|SM[ABC]|MELF|TO-2/.test(fam)) {
      const p1 = padOne(pads), r = clamp(Math.min(bw(body), bl(body)) * 0.07, 0.2, 0.6);
      const x = p1.x < (body.x0 + body.x1) / 2 ? body.x0 + 2.2 * r : body.x1 - 2.2 * r, y = p1.y < (body.y0 + body.y1) / 2 ? body.y0 + 2.2 * r : body.y1 - 2.2 * r;
      out.push(disc(x, y, r, stand + H, stand + H + 0.01, C.pin1));
    }
    return out;
  }

  // ---- chip passives (R_0805_2012Metric, C_1206_3216Metric, LED_0603…, tantalum CP_EIA-3528)
  const chip = /^(R|C|L|D|LED|Fuse|F|CP|FB)_(\d{4})_(\d{2})(\d{2})Metric/i.exec(name);
  const tant = /^CP_EIA-(\d{2})(\d{2})-(\d{2})/i.exec(name);
  if ((chip || tant) && smd && pads.length === 2) {
    const [p0, p1] = pads; const span = Math.hypot(p1.x - p0.x, p1.y - p0.y); if (span < 0.1) return null;
    const L = chip ? parseInt(chip[3], 10) / 10 : parseInt((tant as RegExpExecArray)[1], 10) / 10, W = chip ? parseInt(chip[4], 10) / 10 : parseInt((tant as RegExpExecArray)[2], 10) / 10;
    const kind = tant ? "T" : (chip as RegExpExecArray)[1].toUpperCase();
    const H = tant ? parseInt(tant[3], 10) / 10 : kind === "R" || kind === "FB" ? clamp(0.3 * W, 0.3, 0.6) : kind === "C" || kind === "CP" ? clamp(0.6 * W, 0.45, 1.6) : kind === "LED" || kind === "D" ? clamp(0.5 * W, 0.4, 1.2) : clamp(0.7 * W, 0.5, 2);
    const along = Math.abs(p1.x - p0.x) >= Math.abs(p1.y - p0.y);
    const cx = (p0.x + p1.x) / 2, cy = (p0.y + p1.y) / 2;
    const body = along ? centred(cx, cy, L, W) : centred(cx, cy, W, L);
    const end = Math.min(L * 0.2, 0.6);
    const color = tant ? C.tantalum : kind === "R" || kind === "FB" ? C.black : kind === "C" || kind === "CP" ? C.ceramic : kind === "LED" ? C.ledSmd : kind === "D" ? C.black : C.inductor;
    if (along) {
      out.push(prism({ x0: body.x0 + end, x1: body.x1 - end, y0: body.y0, y1: body.y1 }, 0, H, color, Math.min(0.08, H * 0.15)));
      out.push(prism({ x0: body.x0, x1: body.x0 + end, y0: body.y0, y1: body.y1 }, 0, H, C.tin), prism({ x0: body.x1 - end, x1: body.x1, y0: body.y0, y1: body.y1 }, 0, H, C.tin));
    } else {
      out.push(prism({ y0: body.y0 + end, y1: body.y1 - end, x0: body.x0, x1: body.x1 }, 0, H, color, Math.min(0.08, H * 0.15)));
      out.push(prism({ y0: body.y0, y1: body.y0 + end, x0: body.x0, x1: body.x1 }, 0, H, C.tin), prism({ y0: body.y1 - end, y1: body.y1, x0: body.x0, x1: body.x1 }, 0, H, C.tin));
    }
    return out;
  }

  // ---- radial cans: electrolytics, radial capacitors, LEDs, radial inductors
  if (/CP_Radial|C_Radial|CP_THT|LED_D\d|L_Radial|Radial_D/i.test(name) && !smd) {
    const D = mmIn(name, "D") || (fabCircle ? 2 * fabCircle.r : Math.max(3, bw(pbox) + 2));
    const x = fabCircle ? fabCircle.x : (pbox.x0 + pbox.x1) / 2, y = fabCircle ? fabCircle.y : (pbox.y0 + pbox.y1) / 2, r = D / 2;
    if (/LED/i.test(name)) {
      const H = D <= 3.2 ? 5.3 : D <= 5.2 ? 8.6 : 1.6 * D;
      out.push(disc(x, y, r * 1.1, 0.8, 1.8, C.led), disc(x, y, r, 1.8, H, C.led, r * 0.6));
      thtLeads(pads, 0.8, out);
    } else if (/^L_/i.test(name)) {
      out.push(disc(x, y, r, 0.3, 0.9 * D + 3, C.inductor, 0.4));
    } else {
      const H = D <= 8 ? 11 : clamp(12.5 + (D - 10) * 1.6, 12.5, 40);
      out.push(disc(x, y, r, 0.4, H, C.sleeve, Math.min(0.6, r * 0.2)), disc(x, y, r * 0.82, H, H + 0.02, C.can));
      thtLeads(pads, 0.4, out);
    }
    return out;
  }
  // ceramic discs: a disc standing between its leads
  const discM = /C_Disc_D(\d+(?:\.\d+)?)mm_W(\d+(?:\.\d+)?)mm/i.exec(name);
  if (discM && !smd) {
    const ends = farthest(pads); if (!ends) return null;
    const [p0, p1] = ends; const D = parseFloat(discM[1]), W = parseFloat(discM[2]);
    const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2, d = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
    const nx = -(p1.y - p0.y) / d, ny = (p1.x - p0.x) / d;   // the disc's axis: across the lead line
    const z = D / 2 + 1.5;
    out.push({ k: "cyl", a: [mx - nx * W / 2, my - ny * W / 2], b: [mx + nx * W / 2, my + ny * W / 2], r: D / 2, z, color: C.disc });
    thtLeads([p0, p1], 1.6, out);
    return out;
  }

  // ---- TO-220 / TO-92 transistors and regulators
  if (/TO-220|TO-247|TO-3P/i.test(name) && !smd) {
    const along = bw(pbox) >= bl(pbox);
    const cx = (pbox.x0 + pbox.x1) / 2, cy = (pbox.y0 + pbox.y1) / 2;
    if (/Horizontal/i.test(name) && fab) {
      // lying on the board: the plastic body next to the leads, the metal tab beyond it
      const far = along ? (Math.abs(fab.y0 - cy) > Math.abs(fab.y1 - cy) ? fab.y0 : fab.y1) : (Math.abs(fab.x0 - cx) > Math.abs(fab.x1 - cx) ? fab.x0 : fab.x1);
      const near = along ? (far === fab.y0 ? fab.y1 : fab.y0) : (far === fab.x0 ? fab.x1 : fab.x0);
      const split = near + (far - near) * 0.55;
      const pb: Box = along ? { x0: fab.x0, x1: fab.x1, y0: Math.min(near, split), y1: Math.max(near, split) } : { y0: fab.y0, y1: fab.y1, x0: Math.min(near, split), x1: Math.max(near, split) };
      const tb: Box = along ? { x0: fab.x0, x1: fab.x1, y0: Math.min(split, far), y1: Math.max(split, far) } : { y0: fab.y0, y1: fab.y1, x0: Math.min(split, far), x1: Math.max(split, far) };
      out.push(prism(tb, 0, 1.3, C.tin), prism(pb, 0, 4.4, C.black, 0.25));
      thtLeads(pads, 1.5, out);
    } else {
      const w = 10.2, t = 4.5;
      const body = along ? centred(cx, cy, w, t) : centred(cx, cy, t, w);
      const tab = along ? { x0: body.x0, x1: body.x1, y0: body.y1 - 1.3, y1: body.y1 } : { y0: body.y0, y1: body.y1, x0: body.x1 - 1.3, x1: body.x1 };
      out.push(prism(body, 3, 12.2, C.black, 0.25), prism(tab, 3, 18.5, C.tin));
      thtLeads(pads, 3, out);
    }
    return out;
  }
  if (/TO-92/i.test(name) && !smd) {
    const along = bw(pbox) >= bl(pbox), cx = (pbox.x0 + pbox.x1) / 2, cy = (pbox.y0 + pbox.y1) / 2, r = 2.4;
    // the D-shaped body: a half disc with its flat face on the pad row
    const pts: Pt[] = [];
    for (let i = 0; i <= 16; i++) { const a = Math.PI * i / 16; pts.push(along ? [cx + r * Math.cos(a), cy - 0.6 + r * Math.sin(a)] : [cx - 0.6 + r * Math.sin(a), cy + r * Math.cos(a)]); }
    out.push({ k: "prism", pts, z0: 2.5, z1: 7.3, color: C.black, bevel: 0.2 });
    thtLeads(pads, 2.5, out, 0.42);
    return out;
  }

  // ---- crystals in HC-18/U, HC-49 cans
  if (/Crystal_HC|HC-?49|HC-?18/i.test(name) && !smd) {
    if (/Horizontal/i.test(name) && fab) out.push(prism(fab, 0, 4.65, C.can, 0.3));
    else {
      const along = bw(pbox) >= bl(pbox), cx = (pbox.x0 + pbox.x1) / 2, cy = (pbox.y0 + pbox.y1) / 2;
      out.push(prism(along ? centred(cx, cy, 11, 4.65) : centred(cx, cy, 4.65, 11), 0, 13.2, C.can, 0.5));
    }
    return out;
  }

  // ---- pin headers, pin sockets, SIP networks
  const pitch = mmIn(name, "P") || 2.54;
  if (/PinHeader|Pin_Header|^Header_/i.test(name) && !smd) {
    const b = boxOf(pads, pitch / 2);
    out.push(prism(b, 0, 2.5, C.plastic, 0.15));
    for (const p of pads) out.push(prism(centred(p.x, p.y, 0.64, 0.64), 0, 8.5, C.gold, 0.08));
    return out;
  }
  if (/PinSocket|Socket_Strip|SIP_Socket/i.test(name) && !smd) {
    out.push(prism(boxOf(pads, pitch / 2), 0, 8.5, C.plastic, 0.2));
    for (const p of pads) out.push(prism(centred(p.x, p.y, 0.9, 0.9), 8.5, 8.51, C.black));
    return out;
  }
  if (/SIP\d|_SIP|R_Array_SIP/i.test(name) && !smd) {
    const along = bw(pbox) >= bl(pbox);
    const b: Box = along ? { x0: pbox.x0 - 1.3, x1: pbox.x1 + 1.3, y0: pbox.y0 - 1.25, y1: pbox.y0 + 1.25 } : { y0: pbox.y0 - 1.3, y1: pbox.y1 + 1.3, x0: pbox.x0 - 1.25, x1: pbox.x0 + 1.25 };
    out.push(prism(b, 1, 6, C.plastic, 0.3));
    thtLeads(pads, 1, out, 0.45);
    return out;
  }

  // ---- connectors: D-sub, terminal blocks, the rest as boxes over their outline
  if (/DSUB|D-Sub|DB\d+/i.test(name) && fab) { out.push(prism(fab, 0, Math.min(12.5, 0.45 * Math.min(bw(fab), bl(fab)) + 6), C.shell, 0.4)); return out; }
  if (/TerminalBlock/i.test(name) && fab) { out.push(prism(fab, 0, 10, C.terminal, 0.4)); return out; }
  if (/Potentiometer|Trimmer/i.test(name) && fab) { out.push(prism(fab, 0.3, /Vertical/i.test(name) ? 5 : 3, C.trimmer, 0.25)); return out; }
  if (/^Conn|Connector|^JST|Molex|USB|RJ45|BarrelJack/i.test(name) && fab) { out.push(prism(fab, 0, clamp(0.6 * Math.min(bw(fab), bl(fab)), 3, 9), C.plastic, 0.3)); return out; }
  return null;
}
