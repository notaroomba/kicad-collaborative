// web/fab/vrml — pcbnew's VRML exporter (pcbnew/exporters/exporter_vrml.cpp) over the board as the editor holds it.
//
// The file is laid out as pcbnew writes it with "copy 3D model files": a WorldInfo, one Transform carrying the world
// scale, in it one Transform per placed 3D model (rotation, translation, scale, an Inline naming the model's own .wrl
// file) and then ten Shapes in pcbnew's order: the board body, top copper, top paste, top solder mask, bottom copper,
// bottom paste, bottom solder mask, the plated hole barrels, top silkscreen, bottom silkscreen.  A program that reads
// pcbnew's file by that order (Blender's pcb2blender importer does) finds the same things in the same places.
//
// The geometry is the editor's own: the plotters' primitives of each layer (plot.ts) merged with Clipper2, cut to the
// board outline, the drilled holes taken out, and ear-clipped (mapbox's earcut, as three.js carries it).  The triangles are therefore not pcbnew's triangles,
// but they cover the same shapes.  A part's model is the mesh the 3D viewer tessellated from its STEP file, written
// as a VRML file in the unit KiCad's own .wrl models use (0.1 inch).
//
// Pure: no DOM.  The caller hands in the meshes (the browser's model store has them; a test passes its own).
import { FillRule, intersectD, type PathsD } from "clipper2-ts";
import { Earcut } from "three/src/extras/Earcut.js";
import { boardHoles, boardShape, type Hole } from "../viewer3d/outline";
import { footprintModels, type ModelMesh, type ModelRef } from "../viewer3d/models";
import { type BoardModel } from "./model";
import { PlotLog, plotLayer, type PlotOptions } from "./plot";
import { inflate, primPolys, subtract, union } from "./poly";
import { type Pt, area } from "./prims";

/** exporter_vrml.h: the gap between stacked artwork layers, mm, and the plating's thickness in VRML units. */
const ART_OFFSET = 0.025, PLATE_OFFSET = 0.005;
const PRECISION = 6;

export interface VrmlOptions {
  /** aMMtoWRMLunit: 1 for millimetres, 0.001 for metres, 1 / 25.4 for inches */
  unit: number;
  /** aExport3DFiles: each model in a file of its own, named from the board file by an Inline; otherwise in the board file */
  separateModels: boolean;
  /** aUseRelativePaths and a3D_Subdir: how the board file names the model files */
  relativePaths: boolean; subdir: string;
  /** the board point that becomes the origin, mm */
  xref: number; yref: number;
  includeUnspecified: boolean; includeDnp: boolean;
  /** the board file's own name, for the title */
  fileName: string;
}

export interface VrmlResult {
  /** the board file */
  text: string;
  /** the model files of `separateModels`, named without a folder */
  models: { name: string; text: string }[];
  /** what was written, for the caller's log */
  stats: { triangles: number[]; placed: number; missing: string[]; fallbackOutline: boolean };
}

interface Color { diffuse: [number, number, number]; spec: [number, number, number]; ambient: number; transp: number; shiny: number }
/** toVRMLColor: the diffuse colour, a specular one brightened by `spec`, emissive black. */
function color(r: number, g: number, b: number, a: number, spec: number, ambient: number, shiny: number): Color {
  const up = (v: number): number => v + (1 - v) * spec;
  return { diffuse: [r, g, b], spec: [up(r), up(g), up(b)], ambient, transp: 1 - a, shiny };
}
// the colours of a board whose stackup names none (initStaticColorList's defaults)
const SILK = color(0.94, 0.94, 0.94, 1, 0.1, 0.7, 0.02), MASK = color(0.08, 0.20, 0.14, 0.83, 0.3, 0.8, 0.30), PASTE = color(0.50, 0.50, 0.50, 1, 0.6, 0.7, 0.70),
  COPPER = color(0.75, 0.61, 0.23, 1, 0.6, 0.7, 0.90), BODY = color(0.43, 0.45, 0.30, 0.90, 0.1, 0.7, 0.01);

const f = (v: number): string => { const t = Number(v.toPrecision(PRECISION)); return Object.is(t, -0) ? "0" : String(t); };
const f3 = (v: number): string => String(Number(v.toFixed(3)));

/** A flat polygon set (outers one way, holes the other) in the file's frame, as vertices and triangles. */
interface Tess { pts: Pt[]; tris: [number, number, number][]; contours: number[][] }

/**
 * Triangulate a Clipper union result.  Every corner of the contours becomes a vertex once; the contours are kept as
 * index loops (outers anticlockwise, holes clockwise, seen from above) for the walls of a solid.
 */
function tessellate(polys: Pt[][]): Tess {
  // on the numbers as the file will carry them, so a face is turned the way its written corners say
  const r6 = (v: number): number => Number(v.toPrecision(PRECISION));
  polys = polys.map((p) => p.map((q) => [r6(q[0]), r6(q[1])] as Pt));
  const pts: Pt[] = []; const at = new Map<string, number>();
  const idx = (x: number, y: number): number => { const k = x.toFixed(PRECISION) + "," + y.toFixed(PRECISION); let i = at.get(k); if (i === undefined) { i = pts.length; pts.push([x, y]); at.set(k, i); } return i; };
  const contours: number[][] = [];
  // the outers are the contours of the larger total area's winding; they run anticlockwise here, the holes clockwise
  const signed = (p: Pt[]): number => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return a / 2; };
  const areas = polys.map(signed); let pos = 0, neg = 0; for (const a of areas) { if (a > 0) pos += a; else neg -= a; }
  const outer = pos >= neg ? 1 : -1;
  polys.forEach((p, i) => {
    if (p.length < 3) return; const loop = p.map((q) => idx(q[0], q[1]));
    const isOuter = Math.sign(areas[i]) === outer;
    if ((areas[i] > 0) !== isOuter) loop.reverse();
    contours.push(loop);
  });
  // each outer with the holes that lie in it (the smallest outer around a hole's first corner), ear-clipped
  const tris: [number, number, number][] = [];
  const inside = (p: Pt[], x: number, y: number): boolean => { let on = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) if ((p[i][1] > y) !== (p[j][1] > y) && x < (p[j][0] - p[i][0]) * (y - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0]) on = !on; return on; };
  const outers: { p: Pt[]; a: number; holes: Pt[][] }[] = []; const holes: Pt[][] = [];
  polys.forEach((p, i) => { if (p.length < 3) return; if (Math.sign(areas[i]) === outer) outers.push({ p, a: Math.abs(areas[i]), holes: [] }); else holes.push(p); });
  outers.sort((x, y) => x.a - y.a);
  for (const h of holes) { const o = outers.find((c) => inside(c.p, h[0][0], h[0][1])); if (o) o.holes.push(h); }
  for (const o of outers) {
    const data: number[] = []; const starts: number[] = []; const ids: number[] = [];
    const put = (p: Pt[]): void => { for (const q of p) { data.push(q[0], q[1]); ids.push(idx(q[0], q[1])); } };
    put(o.p); for (const h of o.holes) { starts.push(data.length / 2); put(h); }
    const cut = Earcut.triangulate(data, starts, 2);
    for (let i = 0; i + 2 < cut.length; i += 3) {
      let a = ids[cut[i]], b = ids[cut[i + 1]]; const c = ids[cut[i + 2]];
      if (a === b || b === c || a === c) continue;
      // anticlockwise seen from above
      const s = (pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) - (pts[b][1] - pts[a][1]) * (pts[c][0] - pts[a][0]);
      if (Math.abs(s) < 1e-9) continue;       // a sliver between corners in line
      if (s < 0) { const k = a; a = b; b = k; }
      tris.push([a, b, c]);
    }
  }
  return { pts, tris, contours };
}

function material(c: Color): string {
  return `              diffuseColor ${f3(c.diffuse[0])} ${f3(c.diffuse[1])} ${f3(c.diffuse[2])}\n` +
    `              specularColor ${f3(c.spec[0])} ${f3(c.spec[1])} ${f3(c.spec[2])}\n` +
    "              emissiveColor 0 0 0\n" +
    `              ambientIntensity ${f3(c.ambient)}\n              transparency ${f3(c.transp)}\n              shininess ${f3(c.shiny)}\n`;
}

/** write_triangle_bag: the nodes pcbnew writes around every layer ("blender sometimes chokes without them"). */
function shape(c: Color, points: string[], faces: string[]): string {
  const rows = (items: string[], per: number): string => { const out: string[] = []; for (let i = 0; i < items.length; i += per) out.push(items.slice(i, i + per).join(", ")); return out.join(",\n"); };
  return "Transform {\n  children [\n    Group {\n      children [\n        Shape {\n          appearance Appearance {\n            material Material {\n" + material(c) +
    "            }\n          }\n          geometry IndexedFaceSet {\n            solid TRUE\n            coord Coordinate {\n              point [\n" + rows(points, 4) +
    "\n              ]\n            }\n            coordIndex [\n" + rows(faces, 6) + "\n            ]\n          }\n        }\n      ]\n    }\n  ]\n}\n";
}

/** A flat layer at height z, facing up (`top`) or down. */
function plane(c: Color, t: Tess, z: number, top: boolean, count: number[]): string {
  count.push(t.tris.length);
  return shape(c, t.pts.map((p) => `${f(p[0])} ${f(p[1])} ${f(z)}`), t.tris.map((k) => (top ? `${k[0]}, ${k[1]}, ${k[2]}, -1` : `${k[1]}, ${k[0]}, ${k[2]}, -1`)));
}

/** A solid between two heights: both faces (unless `wallsOnly`) and a wall along every contour, facing out of the material. */
function shell(c: Color, t: Tess, zTop: number, zBottom: number, wallsOnly: boolean, count: number[]): string {
  const n = t.pts.length; const faces: string[] = [];
  if (!wallsOnly) { for (const k of t.tris) faces.push(`${k[0]}, ${k[1]}, ${k[2]}, -1`); for (const k of t.tris) faces.push(`${k[1] + n}, ${k[0] + n}, ${k[2] + n}, -1`); }
  const wall = (a: number, b: number): void => { faces.push(`${a}, ${a + n}, ${b + n}, -1`, `${a}, ${b + n}, ${b}, -1`); };
  if (wallsOnly) { for (const loop of t.contours) for (let i = 0; i < loop.length; i++) wall(loop[i], loop[(i + 1) % loop.length]); }
  else {
    // the rim of the triangles themselves (an edge no neighbour runs back along), so the solid is closed whatever
    // corners the triangulation kept
    const edges = new Set<string>(); for (const k of t.tris) for (let i = 0; i < 3; i++) edges.add(k[i] + ">" + k[(i + 1) % 3]);
    for (const k of t.tris) for (let i = 0; i < 3; i++) { const a = k[i], b = k[(i + 1) % 3]; if (!edges.has(b + ">" + a)) wall(a, b); }
  }
  count.push(faces.length);
  return shape(c, t.pts.map((p) => `${f(p[0])} ${f(p[1])} ${f(zTop)}`).concat(t.pts.map((p) => `${f(p[0])} ${f(p[1])} ${f(zBottom)}`)), faces);
}

function intersect(a: Pt[][], b: Pt[][]): Pt[][] {
  if (!a.length || !b.length) return [];
  const to = (ps: Pt[][]): PathsD => ps.map((p) => p.map((q) => ({ x: q[0], y: q[1] })));
  return intersectD(to(a), to(b), FillRule.NonZero, PRECISION).map((p) => p.map((q) => [q.x, q.y] as Pt)).filter((p) => p.length >= 3);
}

// quaternions, as exporter_vrml.cpp composes a model's rotation
type Quat = [number, number, number, number];
const quat = (x: number, y: number, z: number, a: number): Quat => { const s = Math.sin(a / 2); return [x * s, y * s, z * s, Math.cos(a / 2)]; };
const compose = (q1: Quat, q2: Quat): Quat => [
  q2[3] * q1[0] + q2[0] * q1[3] + q2[1] * q1[2] - q2[2] * q1[1],
  q2[3] * q1[1] + q2[1] * q1[3] + q2[2] * q1[0] - q2[0] * q1[2],
  q2[3] * q1[2] + q2[2] * q1[3] + q2[0] * q1[1] - q2[1] * q1[0],
  q2[3] * q1[3] - q2[0] * q1[0] - q2[1] * q1[1] - q2[2] * q1[2]];

/** The models a board's footprints name, for the caller to have their meshes ready: one entry per file. */
export function vrmlModels(m: BoardModel): ModelRef[] {
  const seen = new Set<string>(); const out: ModelRef[] = [];
  for (const fp of m.footprints) for (const r of footprintModels(fp.node)) if (!seen.has(r.url)) { seen.add(r.url); out.push(r); }
  return out;
}

/** wxFileName::GetName of the model: the file's name without folder or extension. */
const stemOf = (r: ModelRef): string => r.name.replace(/^.*[\/\\]/, "").replace(/\.(step|stp|wrl|wrz)$/i, "").replace(/[^A-Za-z0-9_.+\- ]/g, "_");

/**
 * A tessellated model as VRML shapes, one per colour, scaled by `k` (1 / 2.54 for a model file of its own: KiCad's .wrl
 * models are in tenths of an inch).  The mesh is millimetres with Z up, as the footprint's (model …) expects.
 */
export function meshShapes(mesh: ModelMesh, k: number, indent = ""): string {
  const groups = new Map<string, number[]>();
  for (let t = 0; t + 2 < mesh.idx.length; t += 3) {
    const v = mesh.idx[t]; const key = `${f3(mesh.col[v * 3])} ${f3(mesh.col[v * 3 + 1])} ${f3(mesh.col[v * 3 + 2])}`;
    let g = groups.get(key); if (!g) { g = []; groups.set(key, g); } g.push(t);
  }
  let out = "";
  for (const [key, tris] of groups) {
    const remap = new Map<number, number>(); const points: string[] = []; const faces: string[] = [];
    for (const t of tris) {
      const ids: number[] = [];
      for (let j = 0; j < 3; j++) {
        const v = mesh.idx[t + j]; let i = remap.get(v);
        if (i === undefined) { i = points.length; remap.set(v, i); points.push(`${f(mesh.pos[v * 3] * k)} ${f(mesh.pos[v * 3 + 1] * k)} ${f(mesh.pos[v * 3 + 2] * k)}`); }
        ids.push(i);
      }
      faces.push(`${ids[0]}, ${ids[1]}, ${ids[2]}, -1`);
    }
    const rows = (items: string[], per: number): string => { const o: string[] = []; for (let i = 0; i < items.length; i += per) o.push(indent + "      " + items.slice(i, i + per).join(", ")); return o.join(",\n"); };
    out += `${indent}Shape {\n${indent}  appearance Appearance {\n${indent}    material Material {\n${indent}      diffuseColor ${key}\n${indent}      specularColor 0.2 0.2 0.2\n${indent}      ambientIntensity 0.3\n${indent}      shininess 0.2\n${indent}    }\n${indent}  }\n` +
      `${indent}  geometry IndexedFaceSet {\n${indent}    solid FALSE\n${indent}    coord Coordinate {\n${indent}      point [\n${rows(points, 4)}\n${indent}      ]\n${indent}    }\n${indent}    coordIndex [\n${rows(faces, 6)}\n${indent}    ]\n${indent}  }\n${indent}}\n`;
  }
  return out;
}

/** One model file, as KiCad's own library keeps them. */
export function meshVrml(mesh: ModelMesh, name: string): string {
  return `#VRML V2.0 utf8\n#${name}, tessellated from its STEP file by the web editor's 3D viewer; unit 0.1 inch\n` + meshShapes(mesh, 1 / 2.54);
}

/**
 * The board as pcbnew's File → Export → VRML writes it.  `meshOf` gives a model's mesh by ModelRef.url, or nothing when
 * the model could not be had: pcbnew leaves out a model it cannot resolve, and so does this (it is named in `missing`).
 */
export function writeVrml(m: BoardModel, o: VrmlOptions, meshOf: (url: string) => ModelMesh | null | undefined): VrmlResult {
  if (!(o.unit >= 0.001 && o.unit <= 10)) throw new Error("WorldScale out of range (valid range is 0.001 to 10.0)");
  const world = o.unit * 2.54;           // the file's unit is always 2.54 mm; the outer Transform brings it to the unit asked for
  const s = 1 / 2.54;
  const X = (x: number): number => (x - o.xref) * s, Y = (y: number): number => -(y - o.yref) * s;
  const doc = m.doc; const thickness = Math.max(0.1, Number((doc as unknown as { thickness?: number }).thickness) || 1.6);
  const half = thickness / 2 * s, eps = ART_OFFSET * s;
  const zTop = half, zBottom = -half;

  // the outline with its cut-outs, and everything drilled through it
  const shapeOf = boardShape(doc);
  const outline = union(shapeOf.outlines.map((ol) => clockwiseOn(ol.contour, true)).concat(shapeOf.outlines.flatMap((ol) => ol.cutouts.map((c) => clockwiseOn(c, false)))));
  const holes: Hole[] = boardHoles(doc);
  // a plated hole is cut wider by the plating, which the barrel then fills
  const cut = union(holes.map((h) => clockwiseOn(h.plated && !h.via ? inflate([clockwiseOn(h.pts, true)], PLATE_OFFSET / s)[0] || h.pts : h.pts, true)));
  const frame = (polys: Pt[][]): Pt[][] => polys.map((p) => p.map((q) => [X(q[0]), Y(q[1])] as Pt).reverse());

  const opt: PlotOptions = { plotReference: true, plotValue: true, subtractMaskFromSilk: false };
  const log = new PlotLog();
  const layerPolys = (layer: string): Pt[][] => {
    let have: Pt[][] = [];
    // a knock-out clears what was drawn before it, so the primitives are merged in the order they were plotted
    let add: Pt[][] = [];
    const flush = (): void => { if (add.length) { have = union(have.concat(add)); add = []; } };
    for (const p of plotLayer(m, layer, opt, log)) {
      const polys = primPolys(p); if (!polys.length) continue;
      if (p.clear) { flush(); have = subtract(have, union(polys)); } else add.push(...polys);
    }
    flush(); return have;
  };
  const onBoard = (polys: Pt[][]): Tess => tessellate(frame(subtract(intersect(polys, outline), cut)));

  const count: number[] = [];
  let layers = "";
  layers += shell(BODY, tessellate(frame(subtract(outline, cut))), zTop - eps / 2, -(zTop - eps / 2), false, count);
  layers += plane(COPPER, onBoard(layerPolys("F.Cu")), zTop, true, count);
  layers += plane(PASTE, onBoard(layerPolys("F.Paste")), zTop + eps / 2, true, count);
  layers += plane(MASK, tessellate(frame(subtract(subtract(outline, layerPolys("F.Mask")), cut))), zTop + eps / 2, true, count);
  layers += plane(COPPER, onBoard(layerPolys("B.Cu")), zBottom, false, count);
  layers += plane(PASTE, onBoard(layerPolys("B.Paste")), zBottom - eps / 2, false, count);
  layers += plane(MASK, tessellate(frame(subtract(subtract(outline, layerPolys("B.Mask")), cut))), zBottom - eps / 2, false, count);
  // the barrels: a wall around every plated hole, seen from inside it
  const barrels = tessellate(frame(holes.filter((h) => h.plated).map((h) => clockwiseOn(h.pts, true))));
  barrels.tris = []; for (const loop of barrels.contours) loop.reverse();
  layers += shell(PASTE, barrels, zTop + eps / 2, zBottom - eps / 2, true, count);
  layers += plane(SILK, onBoard(layerPolys("F.SilkS")), half + eps * 3, true, count);
  layers += plane(SILK, onBoard(layerPolys("B.SilkS")), -half - eps * 3, false, count);

  // the parts
  let parts = ""; const files = new Map<string, string>(); const missing: string[] = []; let placed = 0;
  const rad = Math.PI / 180;
  for (const fp of m.footprints) {
    if (!o.includeUnspecified && !fp.smd && !fp.throughHole) continue;
    if (!o.includeDnp && fp.dnp) continue;
    const flipped = fp.side === "B.Cu";
    for (const ref of footprintModels(fp.node)) {
      const mesh = meshOf(ref.url);
      if (!mesh) { if (!missing.includes(ref.name)) missing.push(ref.name); continue; }
      let rx = -ref.rotate[0], ry = -ref.rotate[1], rz = -ref.rotate[2];
      if (flipped) { rx += 180; ry = -ry; rz = -rz; }
      let q = compose(quat(1, 0, 0, rx * rad), quat(0, 1, 0, ry * rad));
      q = compose(q, quat(0, 0, 1, rz * rad));
      q = compose(q, quat(0, 0, 1, fp.rot * rad));
      const angle = Math.acos(Math.max(-1, Math.min(1, q[3]))) * 2; const sin = Math.sin(angle / 2);
      let ox = ref.offset[0], oy = ref.offset[1], oz = ref.offset[2];
      if (flipped) oz = -oz; else oy = -oy;
      // RotatePoint by the footprint's orientation, in pcbnew's frame (Y down)
      const a = fp.rot * rad; const px = ox * Math.cos(a) + oy * Math.sin(a), py = oy * Math.cos(a) - ox * Math.sin(a);
      const tx = X(px + fp.x), ty = Y(py + fp.y), tz = oz * s + (flipped ? zBottom : zTop);
      let t = "Transform {\n";
      if (Math.abs(angle) > 0.0001745) t += `  rotation ${f(q[0] / sin)} ${f(q[1] / sin)} ${f(q[2] / sin)} ${f(angle)}\n`;
      t += `  translation ${f(tx)} ${f(ty)} ${f(tz)}\n  scale ${f(ref.scale[0])} ${f(ref.scale[1])} ${f(ref.scale[2])}\n`;
      if (o.separateModels) {
        const name = stemOf(ref) + ".wrl";
        if (!files.has(name)) files.set(name, meshVrml(mesh, ref.name));
        const dir = o.relativePaths ? o.subdir.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^.*\//, "") : o.subdir.replace(/\\/g, "/").replace(/\/+$/, "");
        t += `  children [\n    Inline {\n      url "${dir ? dir + "/" : ""}${name}"\n    } ]\n  }\n`;
      } else t += "  children [\n" + meshShapes(mesh, 1 / 2.54, "    ") + "  ]\n}\n";
      parts += t; placed++;
    }
  }

  const text = `#VRML V2.0 utf8\nWorldInfo {\n  title "${o.fileName.replace(/\\/g, "/").replace(/"/g, "'")} - Generated by Pcbnew"\n}\nTransform {\n  scale ${f(world)} ${f(world)} ${f(world)}\n  children [\n` + parts + layers + "]\n}\n";
  return { text, models: Array.from(files, ([name, t]) => ({ name, text: t })), stats: { triangles: count, placed, missing, fallbackOutline: shapeOf.fallback } };
}

/** A contour wound for a union: an outline one way, a cut-out the other, whatever way it was drawn. */
function clockwiseOn(pts: Pt[], solid: boolean): Pt[] { return (area(pts) < 0) === solid ? pts.slice().reverse() : pts; }
