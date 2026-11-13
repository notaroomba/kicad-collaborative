// viewer3d/models.ts — the real 3D models of the parts on a board.
//
// A footprint names its model the way KiCad does: (model "${KICAD10_3DMODEL_DIR}/Button_Switch_SMD.3dshapes/
// SW_Push_SPST_NO_Alps_SKRK.step" (offset (xyz …)) (scale (xyz …)) (rotate (xyz …))).  The path's library and
// name are looked up in KiCad's own 3D library first (the server's /api/kicad-lib/model reads the STEP file from
// where the KiCad project publishes it); a vendor part's footprint points at ${KICAD_COLLAB_3DMODELS} and its
// model comes from the vendor through /api/parts/model.step.  A STEP file is solid geometry, not triangles, so it
// is tessellated here by OpenCascade compiled to WebAssembly (occt-import-js), in a worker, on first use.
// A footprint whose model cannot be had keeps the stand-in solids of parts.ts.
//
// footprintModels / placeMesh are pure (no DOM), for the node tests; ModelStore is the browser half.

export type V3 = [number, number, number];

/** One (model …) of a footprint. */
export interface ModelRef {
  /** where the STEP file is read from; also the key the tessellated mesh is kept under */
  url: string;
  /** "kicad" for KiCad's 3D library, "vendor" for a vendor part's model */
  source: "kicad" | "vendor";
  /** Library/Name as the footprint wrote it, for messages */
  name: string;
  offset: V3; scale: V3; rotate: V3;
}

/** A tessellated model in its own frame: millimetres, Z up, per-vertex normals and colours (linear 0..1 RGB as in the file). */
export interface ModelMesh { pos: Float32Array; nrm: Float32Array; col: Float32Array; idx: Uint32Array }

const VENDOR_FIELDS: [string, string][] = [["LCSC", "lcsc"], ["Mouser", "mouser"], ["DigiKey", "digikey"]];
const num = (v: unknown, d = 0): number => { const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN; return isFinite(n) ? n : d; };
const kid = (node: SNode, name: string): SNode | null => { for (const c of node) if (Array.isArray(c) && c[0] === name) return c as SNode; return null; };
function xyzOf(node: SNode, name: string, d: number): V3 {
  const k = kid(node, name); const v = k ? kid(k, "xyz") : null;
  return v ? [num(v[1], d), num(v[2], d), num(v[3], d)] : [d, d, d];
}
function fieldOf(node: SNode, name: string): string {
  for (const c of node) if (Array.isArray(c) && c[0] === "property" && String(c[1]).toLowerCase() === name.toLowerCase()) return String(c[2] ?? "").trim();
  return "";
}

/** The models a footprint names, in file order; hidden ones and paths that name no library file are left out. */
export function footprintModels(node: SNode): ModelRef[] {
  const out: ModelRef[] = [];
  for (const c of node) {
    if (!Array.isArray(c) || c[0] !== "model") continue;
    const hide = kid(c as SNode, "hide"); if (hide && String(hide[1]) !== "no") continue;
    const path = String(c[1] ?? "");
    const m = /([^\/\\${}]+)\.3dshapes[\/\\]([^\/\\]+)\.(?:step|stp|wrl)$/i.exec(path); if (!m) continue;
    const ref = { name: `${m[1]}/${m[2]}`, offset: xyzOf(c as SNode, "offset", 0), scale: xyzOf(c as SNode, "scale", 1), rotate: xyzOf(c as SNode, "rotate", 0) };
    if (/KICAD_COLLAB_3DMODELS/.test(path)) {
      const hit = VENDOR_FIELDS.map(([f, v]) => [v, fieldOf(node, f)]).find(([, id]) => id); if (!hit) continue;
      out.push({ ...ref, source: "vendor", url: `/api/parts/model.step?vendor=${hit[0]}&id=${encodeURIComponent(hit[1])}` });
    } else out.push({ ...ref, source: "kicad", url: `/api/kicad-lib/model?lib=${encodeURIComponent(m[1])}&name=${encodeURIComponent(m[2])}` });
  }
  return out;
}

/** Where a footprint stands, for placeMesh: model space is millimetres with Y up and Z out of the front face. */
export interface Placement { x: number; y: number; z: number; rot: number; back: boolean }

/**
 * A model's vertices and normals where KiCad's viewer puts them (3d-viewer/3d_rendering: the footprint's matrix is
 * translate · rotateZ(orientation) · [flipped: rotateY(180°) · rotateZ(180°)], the model's is translate(offset) ·
 * rotateZ(-rz) · rotateY(-ry) · rotateX(-rx) · scale).  `each` receives every vertex as (x, y, z, nx, ny, nz, i).
 */
export function placeMesh(mesh: ModelMesh, ref: ModelRef, at: Placement, each: (x: number, y: number, z: number, nx: number, ny: number, nz: number, i: number) => void): void {
  const rad = Math.PI / 180;
  const rx = -ref.rotate[0] * rad, ry = -ref.rotate[1] * rad, rz = -ref.rotate[2] * rad, ro = at.rot * rad;
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz), co = Math.cos(ro), so = Math.sin(ro);
  const turn = (x: number, y: number, z: number): V3 => {
    let t = y * cx - z * sx; z = y * sx + z * cx; y = t;            // about X
    t = x * cy + z * sy; z = -x * sy + z * cy; x = t;               // about Y
    t = x * cz - y * sz; y = x * sz + y * cz; x = t;                // about Z
    return [x, y, z];
  };
  const stand = (x: number, y: number, z: number): V3 => {
    if (at.back) { y = -y; z = -z; }                                // rotateY(180°) · rotateZ(180°): half a turn about X
    return [x * co - y * so, x * so + y * co, z];
  };
  const [sxk, syk, szk] = ref.scale; const p = mesh.pos, n = mesh.nrm;
  for (let i = 0; i < p.length / 3; i++) {
    let [x, y, z] = turn(p[i * 3] * sxk, p[i * 3 + 1] * syk, p[i * 3 + 2] * szk);
    [x, y, z] = stand(x + ref.offset[0], y + ref.offset[1], z + ref.offset[2]);
    // a normal under a non-uniform scale takes the inverse scale; then the same turns
    let [nx, ny, nz] = turn(n[i * 3] / (sxk || 1), n[i * 3 + 1] / (syk || 1), n[i * 3 + 2] / (szk || 1));
    [nx, ny, nz] = stand(nx, ny, nz);
    const l = Math.hypot(nx, ny, nz) || 1;
    each(x + at.x, y + at.y, z + at.z, nx / l, ny / l, nz / l, i);
  }
}

/** occt-import-js's result for one STEP file, flattened into one mesh. */
export function flattenOcct(result: { success?: boolean; meshes?: any[] }): ModelMesh | null {
  if (!result || !result.success || !Array.isArray(result.meshes)) return null;
  let nv = 0, ni = 0;
  for (const m of result.meshes) { nv += m.attributes.position.array.length / 3; ni += m.index.array.length; }
  if (!nv || !ni) return null;
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), col = new Float32Array(nv * 3), idx = new Uint32Array(ni);
  let v0 = 0, i0 = 0;
  for (const m of result.meshes) {
    const p = m.attributes.position.array, n = m.attributes.normal ? m.attributes.normal.array : null, ix = m.index.array; const count = p.length / 3;
    pos.set(p, v0 * 3); if (n) nrm.set(n, v0 * 3);
    const base: number[] = Array.isArray(m.color) ? m.color : [0.6, 0.6, 0.62];
    for (let i = 0; i < count; i++) { col[(v0 + i) * 3] = base[0]; col[(v0 + i) * 3 + 1] = base[1]; col[(v0 + i) * 3 + 2] = base[2]; }
    // a face of the solid with a colour of its own: its triangles' corners take it (faces do not share corners)
    for (const f of m.brep_faces || []) {
      if (!Array.isArray(f.color)) continue;
      for (let t = f.first; t <= f.last; t++) for (let k = 0; k < 3; k++) { const vi = v0 + ix[t * 3 + k]; col[vi * 3] = f.color[0]; col[vi * 3 + 1] = f.color[1]; col[vi * 3 + 2] = f.color[2]; }
    }
    for (let i = 0; i < ix.length; i++) idx[i0 + i] = v0 + ix[i];
    v0 += count; i0 += ix.length;
  }
  return { pos, nrm, col, idx };
}

// ---------------------------------------------------------------- the browser half

const RUNTIME = "/static/pyodide/";
const WORKER = `
let occt = null;
self.onmessage = async (e) => {
  const { id, bytes, base } = e.data;
  try {
    if (!occt) { importScripts(base + "occt-import-js.js"); occt = await occtimportjs({ locateFile: (f) => base + f }); }
    const r = occt.ReadStepFile(new Uint8Array(bytes), { linearUnit: "millimeter", linearDeflectionType: "absolute_value", linearDeflection: 0.02, angularDeflection: 0.5 });
    self.postMessage({ id, result: r });
  } catch (err) { self.postMessage({ id, error: String(err && err.message || err) }); }
};`;

export type ModelState = ModelMesh | "missing";

/** Fetches and tessellates models, one at a time, and keeps them for the life of the page. */
export class ModelStore {
  private have = new Map<string, ModelState>();
  private asked = new Map<string, Promise<void>>();
  private worker: Worker | null = null;
  private waiting = new Map<number, (r: { result?: any; error?: string }) => void>();
  private seq = 0;
  private dead = false;
  private listeners = new Set<() => void>();

  /** `fn` is called each time a model asked for has come in or turned out to be missing; returns the way to stop. */
  listen(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }

  /** The mesh when it is here, "missing" when it cannot be had, undefined while unknown or on its way. */
  get(url: string): ModelState | undefined { return this.have.get(url); }

  /** Ask for these models; those not seen before are fetched in the background. */
  want(refs: ModelRef[]): void {
    for (const r of refs) if (!this.have.has(r.url) && !this.asked.has(r.url)) this.asked.set(r.url, this.load(r.url));
  }

  /** Resolves when everything asked for so far has arrived or failed. */
  async settled(): Promise<void> { while (this.asked.size) await Promise.all(Array.from(this.asked.values())); }

  private async load(url: string): Promise<void> {
    let state: ModelState = "missing";
    try {
      const resp = await fetch(url, { credentials: "same-origin" });
      if (resp.ok) {
        const bytes = await resp.arrayBuffer();
        const mesh = flattenOcct(await this.tessellate(bytes));
        if (mesh) state = mesh;
      }
    } catch { /* stays missing: the stand-in solid is drawn */ }
    this.have.set(url, state); this.asked.delete(url);
    for (const fn of Array.from(this.listeners)) fn();
  }

  private tessellate(bytes: ArrayBuffer): Promise<any> {
    if (this.dead) return Promise.resolve(null);
    if (!this.worker) {
      try {
        const blob = new Blob([WORKER], { type: "application/javascript" });
        this.worker = new Worker(URL.createObjectURL(blob));
        this.worker.onmessage = (e: MessageEvent) => { const done = this.waiting.get(e.data.id); if (done) { this.waiting.delete(e.data.id); done(e.data); } };
        this.worker.onerror = () => { this.dead = true; for (const done of this.waiting.values()) done({ error: "worker" }); this.waiting.clear(); };
      } catch { this.dead = true; return Promise.resolve(null); }
    }
    const id = ++this.seq; const base = new URL(RUNTIME, location.href).href;
    return new Promise((resolve) => {
      this.waiting.set(id, (r) => resolve(r.error ? null : r.result));
      this.worker!.postMessage({ id, bytes, base }, [bytes]);
    });
  }
}

let shared: ModelStore | null = null;
/** The page's one model store (models are the same for every board and every rebuild). */
export function modelStore(): ModelStore { return shared || (shared = new ModelStore()); }
