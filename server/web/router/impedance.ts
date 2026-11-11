// Controlled impedance: what a track's width (and a pair's gap) has to be on this board's stackup to present a given
// impedance.  Closed-form models — Hammerstad's microstrip with Wheeler's thickness correction for the outer layers,
// the IPC-2141 stripline for the inner ones, and the IPC edge-coupled factors for pairs.  They agree with a field
// solver to a few percent over the usual range (0.1 < w/h < 3); a fab's own calculator has the last word.

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface StackLayer { name: string; copper: boolean; thickness: number; er: number }
export interface Stackup { layers: StackLayer[]; assumed: boolean }
/** The geometry a track on one layer sees: over one plane (microstrip) or between two (stripline). */
export interface Trace { kind: "microstrip" | "stripline"; h: number; b: number; t: number; er: number; layer: string; reference: string[] }

const num = (K: any, n: any, key: string, d: number): number => { const c = n && K.kid(n, key); return c ? K.num(c[1], d) : d; };

/** The board's stackup: Board Setup > Physical Stackup when the file carries one, else the usual build for the
 *  number of copper layers and the board thickness (FR4; 4 layers and up: 0.2 mm prepreg under the outer layers). */
export function stackupOf(K: any, doc: any): Stackup {
  const st = doc.stackup || null; const copperNames: string[] = (doc.copper && doc.copper.length ? doc.copper : Array.from(doc.layers ? doc.layers.keys() : []).filter((l: any) => /\.Cu$/.test(l))) as string[];
  if (st) {
    const layers: StackLayer[] = [];
    for (const l of K.kids(st, "layer")) {
      const name = K.str(l[1]), type = K.str((K.kid(l, "type") || [0, ""])[1]);
      if (type === "copper") layers.push({ name, copper: true, thickness: num(K, l, "thickness", 0.035), er: 1 });
      else if (/core|prepreg|dielectric/i.test(type) || /^dielectric/i.test(name)) layers.push({ name, copper: false, thickness: num(K, l, "thickness", 0.2), er: num(K, l, "epsilon_r", 4.5) });
    }
    if (layers.filter((l) => l.copper).length >= 2) return { layers, assumed: false };
  }
  const total = doc.thickness > 0 ? doc.thickness : 1.6; const n = Math.max(2, copperNames.length); const t = 0.035; const layers: StackLayer[] = [];
  const names = copperNames.length >= 2 ? copperNames : ["F.Cu", "B.Cu"]; const gaps = n - 1;
  const pre = n > 2 ? Math.min(0.2, (total - n * t) / gaps) : 0; const core = n > 2 ? Math.max(0.1, (total - n * t - 2 * pre) / Math.max(1, gaps - 2)) : total - 2 * t;
  names.forEach((name, i) => { layers.push({ name, copper: true, thickness: t, er: 1 }); if (i < n - 1) layers.push({ name: "dielectric " + (i + 1), copper: false, thickness: n > 2 && (i === 0 || i === n - 2) ? pre : core, er: n > 2 && (i === 0 || i === n - 2) ? 4.4 : 4.5 }); });
  return { layers, assumed: true };
}

/** What a track on a copper layer runs over: the nearest copper layer below (above) it is taken to be its plane. */
export function traceOn(stack: Stackup, layer: string): Trace | null {
  const L = stack.layers; const i = L.findIndex((l) => l.copper && l.name === layer); if (i < 0) return null;
  const reach = (dir: number) => { let h = 0, er = 0; for (let j = i + dir; j >= 0 && j < L.length; j += dir) { if (L[j].copper) return { h, er: h ? er / h : 4.5, name: L[j].name }; h += L[j].thickness; er += L[j].thickness * L[j].er; } return null; };
  const up = reach(-1), down = reach(1); const t = L[i].thickness;
  if (up && down) return { kind: "stripline", h: Math.min(up.h, down.h), b: up.h + down.h + t, t, er: (up.er * up.h + down.er * down.h) / (up.h + down.h), layer, reference: [up.name, down.name] };
  const one = up || down; if (!one) return null;
  return { kind: "microstrip", h: one.h, b: one.h, t, er: one.er, layer, reference: [one.name] };
}

/** Single-ended impedance of a track of width w (mm). */
export function z0(tr: Trace, w: number): number {
  if (tr.kind === "stripline") return 60 / Math.sqrt(tr.er) * Math.log(4 * tr.b / (0.67 * Math.PI * (0.8 * w + tr.t)));
  const h = tr.h, t = tr.t; const we = t > 0 ? w + t / Math.PI * (1 + Math.log(w / h > 1 / (2 * Math.PI) ? 2 * h / t : 4 * Math.PI * w / t)) : w; const u = we / h;
  const ee = (tr.er + 1) / 2 + (tr.er - 1) / 2 * (1 / Math.sqrt(1 + 12 / u) + (u < 1 ? 0.04 * (1 - u) * (1 - u) : 0));
  return u <= 1 ? 60 / Math.sqrt(ee) * Math.log(8 / u + u / 4) : 120 * Math.PI / (Math.sqrt(ee) * (u + 1.393 + 0.667 * Math.log(u + 1.444)));
}
/** Differential impedance of an edge-coupled pair: tracks of width w, s apart. */
export function zdiff(tr: Trace, w: number, s: number): number {
  return tr.kind === "stripline" ? 2 * z0(tr, w) * (1 - 0.347 * Math.exp(-2.9 * s / tr.b)) : 2 * z0(tr, w) * (1 - 0.48 * Math.exp(-0.96 * s / tr.h));
}
/** The width that presents the target impedance (single-ended, or differential at gap s); null when no width between
 *  0.05 and 6 mm does. */
export function widthFor(tr: Trace, target: number, s?: number): number | null {
  const f = (w: number) => (s === undefined ? z0(tr, w) : zdiff(tr, w, s)) - target; let lo = 0.05, hi = 6;
  if (f(lo) < 0 || f(hi) > 0) return null;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (f(m) > 0) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

/** The impedance a net is usually held to, from its name: USB pairs 90 Ω; HDMI, Ethernet, LVDS, MIPI and the like
 *  100 Ω; antenna and RF feeds 50 Ω single-ended.  0 when the name says nothing. */
export function usualImpedance(net: string, paired: boolean): number {
  if (paired) { if (/USB|(^|[\/_(])D[+\-PM]\)?$/i.test(net)) return 90; if (/HDMI|TMDS|ETH|MDI|ENET|RGMII|LVDS|MIPI|DSI|CSI|SATA|TX|RX|TD|RD|CLK|CK/i.test(net)) return 100; return 0; }
  return /(^|[\/_\-(])(ANT|ANTENNA|RF|RFIO|RF_?IN|RF_?OUT)([_\-\d)]|$)/i.test(net) ? 50 : 0;
}
