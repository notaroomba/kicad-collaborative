// web/fab/gerber — the Gerber (RS-274X, with X2 attributes) writer.
//
// One file per layer: format 4.6 in millimetres, absolute, leading zeros omitted — what KiCad's GERBER_PLOTTER
// writes.  The board's Y axis points down and Gerber's up, so every Y is negated, exactly as pcbnew plots
// (a board at y = 50 mm lands at Y-50000000).  Pads are flashes: a standard C / R / O aperture when the shape is
// axis aligned, an aperture macro otherwise (RoundRect, RotRect, HorizOval, FreePoly — KiCad's own macro
// names and bodies, so a CAM tool shows the same aperture table).  Tracks are draws with a round aperture,
// zone fills and filled graphics are G36 / G37 regions.
import { type GbrMeta, type Prim, type Pt, norm360, rot } from "./prims";
import { primPolys } from "./poly";

export interface GerberAttrs {
  /** %TF.FileFunction: "Copper,L1,Top", "Soldermask,Top", "Profile,NP" … */
  fileFunction: string;
  /** %TF.FilePolarity: "Positive" or "Negative"; empty for layers that have none (outline, drawings). */
  polarity: string;
  /** a header line written in place of the FileFunction one, as is (the IPC-4761 protection files' "%TF,FileFunction,Other,…*%") */
  fileFunctionLine?: string;
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
  /** "Include netlist attributes": %TO.P / %TO.N / %TO.C on flashes, draws and regions (UseX2NetAttributes). */
  netAttributes?: boolean;
  /** "Disable aperture macros": rounded and rotated rectangles, rotated ovals and custom pads become regions. */
  disableMacros?: boolean;
}

/** FormatStringToGerber: the characters a Gerber field cannot hold, escaped as \\uXXXX (a backslash itself too). */
export function gerberString(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i), ch = s[i];
    if (c > 0x7f || ch === "%" || ch === "*" || ch === "," || ch === "\\") out += "\\u" + c.toString(16).toUpperCase().padStart(4, "0");
    else out += ch;
  }
  return out;
}

/** A length in mm as a macro / aperture parameter: at most six decimals, no trailing zeros. */
export function mm(v: number): string {
  const s = (Math.round(v * 1e6) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" || s === "" ? "0" : s;
}

/** A standard aperture's size as GERBER_PLOTTER::writeApertureList prints it: fmt's {:#f}, six decimals kept. */
export function f6(v: number): string {
  const s = (Math.round(v * 1e6) / 1e6).toFixed(6);
  return s === "-0.000000" ? "0.000000" : s;
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
  // the aperture function is part of an aperture's identity (GERBER_PLOTTER::GetOrCreateAperture)
  let curAf = "";
  const ta = (af: string): string => (opt.x2 ? `%TA.AperFunction,${af}*%` : `G04 #@! TA.AperFunction,${af}*`);
  const td = (what = ""): string => (opt.x2 ? `%TD${what}*%` : `G04 #@! TD${what}*`);
  const aperture = (def: string, plotting = false): number => {
    const key = def + "\u0000" + curAf + (plotting ? "\u0000pen" : "");
    let d = apertures.get(key);
    if (d === undefined) {
      d = 10 + apertures.size; apertures.set(key, d);
      if (curAf) apDefs.push(ta(curAf), `%ADD${d}${def}*%`, td()); else apDefs.push(`%ADD${d}${def}*%`);
    }
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
    if (p.k === "circle") return aperture(`C,${f6(p.d)}`);
    if (p.k === "rect" || p.k === "oval") {
      const a = norm360(p.rot);
      const quarter = Math.abs(a - Math.round(a / 90) * 90) < 1e-6;
      if (quarter) {
        const turned = Math.round(a / 90) % 2 === 1;
        const w = turned ? p.h : p.w, h = turned ? p.w : p.h;
        return aperture(`${p.k === "rect" ? "R" : "O"},${f6(w)}X${f6(h)}`);
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
  // the object attribute dictionary (FormatNetAttribute): only new or changed attributes are written; a
  // dropped one clears the whole dictionary first
  let dict = "";
  const pre = opt.x2 ? "%" : "G04 #@! ", eol = opt.x2 ? "*%" : "*";
  const objectAttrs = (m: GbrMeta | undefined): void => {
    if (!opt.netAttributes) return;
    const info = m && m.info ? m.info : 0;
    // an item without net information: what came before it no longer applies (the board plotter's EndBlock)
    if (!info) { if (dict) { body.push(td()); dict = ""; } return; }
    const padTxt = (v: string): string => (m!.rawPad ? v : gerberString(v));
    const padS = info & 1 ? `${pre}TO.P,${gerberString(m!.ref || "")},${m!.pad ? padTxt(m!.pad) + (m!.pinFn ? "," + padTxt(m!.pinFn) : "") : ""}${eol}` : "";
    const netS = info & 2 ? `${pre}TO.N,${m!.net ? gerberString(m!.net) : m!.notInNet ? "" : "N/C"}${eol}` : "";
    const cmpS = info & 4 && !(info & 1) ? `${pre}TO.C,${gerberString(m!.ref || "")}${eol}` : "";
    const full = padS + "\n" + netS + "\n" + cmpS;
    if (full !== dict) {
      const had = (k: string): boolean => dict.includes(k);
      const lead: string[] = [], add: string[] = [];
      let clear = false;
      // FormatNetAttribute: each attribute new, changed or dropped; a dropped one clears the dictionary, or only
      // itself when the item asks to keep the others
      if (had("TO.P,")) { if (!padS) { if (m!.keep) lead.unshift(`${pre}TO.P${eol}`); else clear = true; } else if (!dict.includes(padS)) add.push(padS); } else if (padS) add.push(padS);
      if (had("TO.N,")) { if (!netS) { if (m!.keep) lead.unshift(`${pre}TO.N${eol}`); else clear = true; } else if (!dict.includes(netS)) add.push(netS); } else if (netS) add.push(netS);
      if (had("TO.C,")) { if (!cmpS) { if (m!.keep) { if (!padS) lead.unshift(`${pre}TO.C${eol}`); } else clear = true; } else if (!dict.includes(cmpS)) add.push(cmpS); } else if (cmpS) add.push(cmpS);
      if (clear) { body.push(td()); for (const a of [padS, netS, cmpS]) if (a) body.push(a); }
      else body.push(...lead, ...add);
      dict = full;
    }
    if (opt.x2 && m!.extra) body.push(...m!.extra);
  };
  const select = (d: number): void => { if (d !== current) { body.push(`D${d}*`); current = d; } };
  const polarity = (clear: boolean | undefined): void => { if (dark === !clear) return; dark = !clear; body.push(dark ? "%LPD*%" : "%LPC*%"); };
  const moveTo = (x: number, y: number): void => { const gx = X(x), gy = Y(y); if (gx === lastX && gy === lastY) return; body.push(`X${gx}Y${gy}D02*`); lastX = gx; lastY = gy; };
  const lineTo = (x: number, y: number): void => { const gx = X(x), gy = Y(y); body.push(`X${gx}Y${gy}D01*`); lastX = gx; lastY = gy; };
  const regionOf = (pts: Pt[]): void => {
    body.push("G36*");
    lastX = NaN;
    moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) { const q = pts[i]; if (X(q[0]) === lastX && Y(q[1]) === lastY) continue; lineTo(q[0], q[1]); }
    if (X(pts[0][0]) !== lastX || Y(pts[0][1]) !== lastY) lineTo(pts[0][0], pts[0][1]);
    body.push("G37*");
  };
  /** a flash that needs an aperture macro: plotted as a region when macros are disabled */
  const macroShape = (p: Prim): boolean => {
    if (p.k === "roundrect" || p.k === "poly") return true;
    if (p.k === "rect" || p.k === "oval") { const a = norm360(p.rot); return Math.abs(a - Math.round(a / 90) * 90) >= 1e-6; }
    return false;
  };

  for (const p of prims) {
    if (p.k === "td") { body.push(td()); dict = ""; continue; }   // ClearAllAttributes
    polarity(p.clear);
    curAf = p.meta && p.meta.af ? p.meta.af : "";
    if (p.k === "seg") {
      if (!(p.w > 0)) continue;
      objectAttrs(p.meta);
      select(aperture(`C,${f6(p.w)}`, true));
      moveTo(p.x1, p.y1); lineTo(p.x2, p.y2);
    } else if (p.k === "arc") {
      if (!(p.w > 0)) continue;
      objectAttrs(p.meta);
      select(aperture(`C,${f6(p.w)}`, true));
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
    } else if (p.k === "region" || (opt.disableMacros && macroShape(p))) {
      const pts = p.k === "region" ? p.pts : (primPolys(p)[0] || []);
      if (pts.length < 3) continue;
      if (curAf) body.push(ta(curAf));
      objectAttrs(p.meta);
      regionOf(pts);
      if (curAf) body.push(td(".AperFunction"));
    } else {
      if (p.k === "rpoly") {
        select(aperture(`P,${f6(p.d)}X${p.n}X${f6(p.rot)}`));
        objectAttrs(p.meta);
        body.push(`${co(p.x, p.y)}D03*`); lastX = X(p.x); lastY = Y(p.y);
        continue;
      }
      if (p.k === "circle" ? !(p.d > 0) : p.k === "poly" ? p.pts.length < 3 : !(p.w > 0 && p.h > 0)) continue;
      // selectApertureWithAttributes: the aperture, then the object attributes, then the flash
      select(flashAperture(p));
      objectAttrs(p.meta);
      body.push(`${co(p.x, p.y)}D03*`);
      lastX = X(p.x); lastY = Y(p.y);
    }
  }
  if (!dark) body.push("%LPD*%");
  if (opt.netAttributes && dict) body.push(td());

  // ---- header
  const tf = (s: string): string => opt.x2 ? `%TF.${s}*%` : `G04 #@! TF.${s}*`;
  const out: string[] = [];
  out.push(tf(`GenerationSoftware,${opt.software}`));
  out.push(tf(`CreationDate,${opt.date}`));
  out.push(tf(`ProjectId,${attrField(opt.project.name) || "board"},${opt.project.guid},${attrField(opt.project.rev) || "rev?"}`));
  out.push(tf("SameCoordinates,Original"));
  out.push(attrs.fileFunctionLine !== undefined ? attrs.fileFunctionLine : tf(`FileFunction,${attrs.fileFunction}`));
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
