// web/fab/gerber — the Gerber (RS-274X, with X2 attributes) writer.
//
// One file per layer: format 4.6 in millimetres, absolute, leading zeros omitted — what KiCad's GERBER_PLOTTER
// writes.  The board's Y axis points down and Gerber's up, so every Y is negated, exactly as pcbnew plots
// (a board at y = 50 mm lands at Y-50000000).  Pads are flashes: a standard C / R / O aperture when the shape is
// axis aligned, an aperture macro otherwise (RoundRect, RotRect, HorizOval, FreePoly — KiCad's own macro
// names and bodies, so a CAM tool shows the same aperture table).  Tracks are draws with a round aperture,
// zone fills and filled graphics are G36 / G37 regions.
import { type Prim, type Pt, norm360, rot } from "./prims";

export interface GerberAttrs {
  /** %TF.FileFunction: "Copper,L1,Top", "Soldermask,Top", "Profile,NP" … */
  fileFunction: string;
  /** %TF.FilePolarity: "Positive" or "Negative"; empty for layers that have none (outline, drawings). */
  polarity: string;
}

export interface GerberOptions {
  /** X2 attributes as %TF…*% (true) or as G04 #@! comments (false, the X1-compatible form). */
  x2: boolean;
  /** Subtracted from every coordinate before the Y flip: the drill / place origin, or [0, 0]. */
  origin: Pt;
  software: string;
  /** ISO 8601 creation date. */
  date: string;
  /** %TF.ProjectId: name, GUID, revision. */
  project: { name: string; guid: string; rev: string };
  /** Decimal places of the coordinates in mm: 6 (KiCad's default) or 5. */
  precision?: 5 | 6;
}

/** A length in mm as a macro / aperture parameter: at most six decimals, no trailing zeros. */
export function mm(v: number): string {
  const s = (Math.round(v * 1e6) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" || s === "" ? "0" : s;
}

/** A field of a %TF attribute: commas, asterisks, percent signs and non-ASCII are not allowed in one. */
export function attrField(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, "_").replace(/[,*%\\]/g, "_").trim();
}

const AM_ROUNDRECT = `%AMRoundRect*
0 Rectangle with rounded corners*
0 $1 Rounding radius*
0 $2 $3 $4 $5 $6 $7 $8 $9 X,Y pos of 4 corners*
0 Add a 4 corners polygon primitive as box body*
4,1,4,$2,$3,$4,$5,$6,$7,$8,$9,$2,$3,0*
0 Add four circle primitives for the rounded corners*
1,1,$1+$1,$2,$3*
1,1,$1+$1,$4,$5*
1,1,$1+$1,$6,$7*
1,1,$1+$1,$8,$9*
0 Add four rect primitives between the rounded corners*
20,1,$1+$1,$2,$3,$4,$5,0*
20,1,$1+$1,$4,$5,$6,$7,0*
20,1,$1+$1,$6,$7,$8,$9,0*
20,1,$1+$1,$8,$9,$2,$3,0*%`;
const AM_ROTRECT = `%AMRotRect*
0 Rectangle, with rotation*
0 The origin of the aperture is its center*
0 $1 length*
0 $2 width*
0 $3 Rotation angle, in degrees counterclockwise*
0 Add horizontal line*
21,1,$1,$2,0,0,$3*%`;
const AM_HORIZOVAL = `%AMHorizOval*
0 Thick line with rounded ends*
0 $1 width*
0 $2 $3 position (X,Y) of the first rounded end (center of the circle)*
0 $4 $5 position (X,Y) of the second rounded end (center of the circle)*
0 Add line between two ends*
20,1,$1,$2,$3,$4,$5,0*
0 Add two circle primitives to create the rounded ends*
1,1,$1,$2,$3*
1,1,$1,$4,$5*%`;

/** One layer's Gerber file. */
export function writeGerber(prims: Prim[], attrs: GerberAttrs, opt: GerberOptions): string {
  const prec = opt.precision === 5 ? 5 : 6, scale = Math.pow(10, prec);
  const X = (x: number): number => Math.round((x - opt.origin[0]) * scale);
  const Y = (y: number): number => -Math.round((y - opt.origin[1]) * scale) || 0;
  const co = (x: number, y: number): string => "X" + X(x) + "Y" + Y(y);

  // ---- apertures
  const apertures = new Map<string, number>(); const apDefs: string[] = [];
  const macros = new Map<string, string>(); const macroDefs: string[] = [];
  let usesRoundRect = false, usesRotRect = false, usesOval = false;
  const aperture = (def: string): number => {
    let d = apertures.get(def);
    if (d === undefined) { d = 10 + apertures.size; apertures.set(def, d); apDefs.push(`%ADD${d}${def}*%`); }
    return d;
  };
  const freePoly = (pts: Pt[]): string => {
    // Gerber frame (Y up); closed by repeating the first point; the vertex count is the number of points after the first
    const body = pts.map((p) => mm(p[0]) + "," + mm(-p[1])).join(",\n");
    const first = pts[0];
    const key = "4,1," + pts.length + ",\n" + body + ",\n" + mm(first[0]) + "," + mm(-first[1]) + ",\n$1*%";
    let name = macros.get(key);
    if (!name) { name = "FreePoly" + macros.size; macros.set(key, name); macroDefs.push(`%AM${name}*\n${key}`); }
    return name;
  };
  const flashAperture = (p: Prim): number => {
    if (p.k === "circle") return aperture(`C,${mm(p.d)}`);
    if (p.k === "rect" || p.k === "oval") {
      const a = norm360(p.rot);
      const quarter = Math.abs(a - Math.round(a / 90) * 90) < 1e-6;
      if (quarter) {
        const turned = Math.round(a / 90) % 2 === 1;
        const w = turned ? p.h : p.w, h = turned ? p.w : p.h;
        return aperture(`${p.k === "rect" ? "R" : "O"},${mm(w)}X${mm(h)}`);
      }
      if (p.k === "rect") { usesRotRect = true; return aperture(`RotRect,${mm(p.w)}X${mm(p.h)}X${mm(a)}`); }
      // an oval at an angle: a thick line between the centres of its two round ends
      usesOval = true;
      const horiz = p.w >= p.h; const d = Math.min(p.w, p.h), half = (Math.max(p.w, p.h) - d) / 2;
      const e = rot(horiz ? half : 0, horiz ? 0 : half, a);
      return aperture(`HorizOval,${mm(d)}X${mm(-e[0])}X${mm(e[1])}X${mm(e[0])}X${mm(-e[1])}X0`);
    }
    if (p.k === "roundrect") {
      usesRoundRect = true;
      const hx = p.w / 2 - p.r, hy = p.h / 2 - p.r;
      const cs = ([[-hx, -hy], [-hx, hy], [hx, hy], [hx, -hy]] as Pt[]).map((c) => rot(c[0], c[1], p.rot));
      return aperture(`RoundRect,${mm(p.r)}X${cs.map((c) => mm(c[0]) + "X" + mm(-c[1])).join("X")}X0`);
    }
    if (p.k === "poly") return aperture(`${freePoly(p.pts)},0`);
    throw new Error("not a flash: " + p.k);
  };

  // ---- body
  const body: string[] = [];
  let current = -1, dark = true, lastX = NaN, lastY = NaN;
  const select = (d: number): void => { if (d !== current) { body.push(`D${d}*`); current = d; } };
  const polarity = (clear: boolean | undefined): void => { if (dark === !clear) return; dark = !clear; body.push(dark ? "%LPD*%" : "%LPC*%"); };
  const moveTo = (x: number, y: number): void => { const gx = X(x), gy = Y(y); if (gx === lastX && gy === lastY) return; body.push(`X${gx}Y${gy}D02*`); lastX = gx; lastY = gy; };
  const lineTo = (x: number, y: number): void => { const gx = X(x), gy = Y(y); body.push(`X${gx}Y${gy}D01*`); lastX = gx; lastY = gy; };

  for (const p of prims) {
    polarity(p.clear);
    if (p.k === "seg") {
      if (!(p.w > 0)) continue;
      select(aperture(`C,${mm(p.w)}`));
      moveTo(p.x1, p.y1); lineTo(p.x2, p.y2);
    } else if (p.k === "arc") {
      if (!(p.w > 0)) continue;
      select(aperture(`C,${mm(p.w)}`));
      const sx = p.cx + p.r * Math.cos(p.a0), sy = p.cy + p.r * Math.sin(p.a0);
      const ex = p.cx + p.r * Math.cos(p.a1), ey = p.cy + p.r * Math.sin(p.a1);
      const TAU = 2 * Math.PI; let sweep = p.acw ? p.a0 - p.a1 : p.a1 - p.a0; sweep = ((sweep % TAU) + TAU) % TAU;
      const full = sweep < 1e-9 && Math.abs(p.a1 - p.a0) > 1e-6;
      moveTo(sx, sy);
      if (!full && X(sx) === X(ex) && Y(sy) === Y(ey)) {
        // the two ends round to the same point: in G75 that would read as a full circle
        if (sweep > Math.PI) {
          // nearly a full turn — go by the far side in two halves
          const am = p.a0 + (p.acw ? -1 : 1) * sweep / 2, mx = p.cx + p.r * Math.cos(am), my = p.cy + p.r * Math.sin(am);
          body.push("G75*", `${p.acw ? "G03" : "G02"}*`, `${co(mx, my)}I${X(p.cx) - X(sx)}J${Y(p.cy) - Y(sy)}D01*`, `${co(ex, ey)}I${X(p.cx) - X(mx)}J${Y(p.cy) - Y(my)}D01*`, "G01*");
          lastX = X(ex); lastY = Y(ey);
        } else lineTo(ex, ey);
        continue;
      }
      // a clockwise turn on screen stays clockwise once Y is flipped (the picture is the same, only the axis is)
      body.push("G75*", `${p.acw ? "G03" : "G02"}*`, `${co(ex, ey)}I${X(p.cx) - X(sx)}J${Y(p.cy) - Y(sy)}D01*`, "G01*");
      lastX = X(ex); lastY = Y(ey);
    } else if (p.k === "region") {
      if (p.pts.length < 3) continue;
      body.push("G36*");
      lastX = NaN;
      moveTo(p.pts[0][0], p.pts[0][1]);
      for (let i = 1; i < p.pts.length; i++) { const q = p.pts[i]; if (X(q[0]) === lastX && Y(q[1]) === lastY) continue; lineTo(q[0], q[1]); }
      if (X(p.pts[0][0]) !== lastX || Y(p.pts[0][1]) !== lastY) lineTo(p.pts[0][0], p.pts[0][1]);
      body.push("G37*");
    } else {
      if (p.k === "circle" ? !(p.d > 0) : p.k === "poly" ? p.pts.length < 3 : !(p.w > 0 && p.h > 0)) continue;
      select(flashAperture(p));
      body.push(`${co(p.x, p.y)}D03*`);
      lastX = X(p.x); lastY = Y(p.y);
    }
  }
  if (!dark) body.push("%LPD*%");

  // ---- header
  const tf = (s: string): string => opt.x2 ? `%TF.${s}*%` : `G04 #@! TF.${s}*`;
  const out: string[] = [];
  out.push(tf(`GenerationSoftware,${opt.software}`));
  out.push(tf(`CreationDate,${opt.date}`));
  out.push(tf(`ProjectId,${attrField(opt.project.name) || "board"},${opt.project.guid},${attrField(opt.project.rev) || "rev?"}`));
  out.push(tf("SameCoordinates,Original"));
  out.push(tf(`FileFunction,${attrs.fileFunction}`));
  if (attrs.polarity) out.push(tf(`FilePolarity,${attrs.polarity}`));
  out.push(`%FSLAX4${prec}Y4${prec}*%`);
  out.push(`G04 Gerber Fmt 4.${prec}, Leading zero omitted, Abs format (unit mm)*`);
  out.push(`G04 Created by ${opt.software.replace(/,/g, " ")} date ${opt.date.replace("T", " ").replace(/[+-]\d\d:\d\d$|Z$/, "")}*`);
  out.push("%MOMM*%", "%LPD*%", "G01*");
  out.push("G04 APERTURE LIST*");
  if (usesRoundRect) out.push(AM_ROUNDRECT);
  if (usesRotRect) out.push(AM_ROTRECT);
  if (usesOval) out.push(AM_HORIZOVAL);
  for (const m of macroDefs) out.push(m);
  for (const a of apDefs) out.push(a);
  out.push("G04 APERTURE END LIST*");
  for (const l of body) out.push(l);
  out.push("M02*");
  return out.join("\n") + "\n";
}

/** A deterministic GUID-shaped id for %TF.ProjectId from the project name (KiCad hashes the file name the same way in spirit). */
export function projectGuid(name: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193, h3 = 0xdeadbeef, h4 = 0x41c6ce57;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193); h2 = Math.imul(h2 ^ c, 0x85ebca6b); h3 = Math.imul(h3 ^ c, 0xc2b2ae35); h4 = Math.imul(h4 ^ c, 0x27d4eb2f);
  }
  const hex = (v: number): string => (v >>> 0).toString(16).padStart(8, "0");
  const s = hex(h1) + hex(h2) + hex(h3) + hex(h4);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}
