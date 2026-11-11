// Fit the autorouter's scoring weights on boards people routed.
//
//   node scripts/router-train.mjs boards.json [--write] [--max=150]
//
// boards.json: [{ "name", "file", "source", "license" }].  For every simple pad-to-pad track on a board (no branches,
// no arcs) the script asks the router which routes it would consider between the same two pads on the same board,
// and then moves the weights until the route the designer actually drew costs no more than the alternatives.  The
// track length weight is fixed at 1 per mm, so the others read as "millimetres of detour this is worth".  --write
// puts the result into web/router/weights.ts, with the list of boards it came from.
import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module"; import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url); const here = path.dirname(fileURLToPath(import.meta.url)); const S = path.join(here, "..", "static");
require(path.join(S, "kicad-canvas.js")); require(path.join(S, "pcb-tools.js")); require(path.join(S, "dist", "autoroute.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, R = globalThis.PcbAutoRouter;
const args = process.argv.slice(2); const list = JSON.parse(fs.readFileSync(args[0], "utf8")); const write = args.includes("--write");
const MAX = +((args.find((a) => a.startsWith("--max=")) || "--max=150").slice(6));
let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const key = (p) => Math.round(p[0] * 1000) + "," + Math.round(p[1] * 1000);
const gapPt = (shape, p) => P.shapeGap(shape, { t: "circle", x: p[0], y: p[1], r: 0 });

/** Simple pad-to-pad tracks of a board: [{ net, a: pad, b: pad, nodes: [{ p, l }] }]. */
function chains(doc, nl, copper) {
  const out = []; const seen = new Set();
  for (const net of nl.nets.values()) {
    if (net.pads.length < 2 || net.tracks.some((t) => t.kind === "arc")) continue;
    const segs = net.tracks.filter((t) => t.kind === "segment"); if (!segs.length) continue;
    const ends = new Map(); segs.forEach((s, i) => s.anchors.forEach((p, e) => { const k = key(p); (ends.get(k) || ends.set(k, []).get(k)).push([i, e]); }));
    const vias = new Set(net.vias.map((v) => key(v.anchors[0])));
    const layerOf = (s) => copper.indexOf(s.layers.values().next().value);
    const padAt = (p, l) => net.pads.find((pad) => pad.layers.has(copper[l]) && Math.abs(pad.pad.x - p[0]) < 3 && Math.abs(pad.pad.y - p[1]) < 3 && gapPt(pad.shape, p) <= 1e-3);
    for (let i = 0; i < segs.length; i++) for (let e = 0; e < 2; e++) {
      const l0 = layerOf(segs[i]); if (l0 < 0) continue; const start = padAt(segs[i].anchors[e], l0); if (!start) continue;
      const nodes = [{ p: [start.pad.x, start.pad.y], l: l0 }]; if (key(segs[i].anchors[e]) !== key(nodes[0].p)) nodes.push({ p: segs[i].anchors[e], l: l0 });
      let cur = segs[i].anchors[1 - e], l = l0, prev = i, end = null; const used = [i];
      for (let n = 0; n < 200; n++) {
        nodes.push({ p: cur, l });
        const pad = padAt(cur, l); if (pad) { if (pad !== start) end = pad; break; }
        const here = (ends.get(key(cur)) || []).filter(([j]) => j !== prev); const via = vias.has(key(cur));
        const same = here.filter(([j]) => layerOf(segs[j]) === l), other = via ? here.filter(([j]) => layerOf(segs[j]) !== l) : [];
        if (same.length + other.length !== 1) break;
        const [j, je] = (same[0] || other[0]); const lj = layerOf(segs[j]); if (lj < 0) break;
        if (lj !== l) { nodes.push({ p: cur, l: lj }); l = lj; }
        prev = j; used.push(j); cur = segs[j].anchors[1 - je];
      }
      if (!end) continue;
      const last = nodes[nodes.length - 1]; if (key(last.p) !== key([end.pad.x, end.pad.y])) nodes.push({ p: [end.pad.x, end.pad.y], l: last.l });
      const sig = net.key + ":" + used.slice().sort((a, b) => a - b).join(","); if (seen.has(sig)) continue; seen.add(sig);
      out.push({ net: net.key, a: start, b: end, nodes });
    }
  }
  return out;
}
/** The same five features the router scores its candidates on, for a track given in millimetres. */
function featuresOfTrack(nodes, pref) {
  const f = { length: 0, vias: 0, b45: 0, b90: 0, wrong: 0, diag: [] }; let prev = null, prevLen = 0, prevDiag = false;
  for (let i = 0; i + 1 < nodes.length; i++) {
    const a = nodes[i], b = nodes[i + 1];
    if (a.l !== b.l) { f.vias++; prev = null; continue; }
    const dx = b.p[0] - a.p[0], dy = b.p[1] - a.p[1], len = Math.hypot(dx, dy); if (len < 0.02) continue;
    const ang = Math.atan2(dy, dx); f.length += len; const p = pref[a.l] || 0; const ax = Math.abs(dx) / len, ay = Math.abs(dy) / len;
    f.wrong += ay < 0.2 ? len * Math.max(0, -p) : ax < 0.2 ? len * Math.max(0, p) : len * Math.abs(p) / 2;
    const diag = ax > 0.38 && ay > 0.38;
    if (prev !== null) { let d = Math.abs(ang - prev) * 180 / Math.PI; if (d > 180) d = 360 - d; if (d > 10) { if (d <= 67.5) f.b45++; else f.b90 += d > 112.5 ? 2 : 1; } }
    if (prevDiag && !diag) f.diag.push(prevLen);
    prev = ang; prevLen = len; prevDiag = diag;
  }
  return f;
}

const samples = []; const boards = []; const mitres = [];
for (const b of list) {
  const t0 = Date.now(); let doc;
  try { doc = K.parseDoc(fs.readFileSync(b.file, "utf8"), "kicad_pcb"); } catch (e) { console.log(`${b.name}: cannot read (${e.message})`); continue; }
  const pro = b.file.replace(/\.kicad_pcb$/, ".kicad_pro"); let src = null; try { if (fs.existsSync(pro)) src = JSON.parse(fs.readFileSync(pro, "utf8")); } catch (e) { /* defaults */ }
  const settings = P.designSettings(src); const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  const nl = P.netlist(doc); let ch = chains(doc, nl, copper); const found = ch.length;
  if (!found) { console.log(`${b.name}: no simple tracks found (${doc.items.size} items)`); continue; }
  for (let i = ch.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ch[i], ch[j]] = [ch[j], ch[i]]; } ch = ch.slice(0, MAX);
  const r = new R.Router(K, P, doc, settings, { zones: false }); let used = 0;
  // the widths in the file are what the designer routed with: a candidate must be allowed where the track ran
  for (const c of ch) {
    const idx = (set) => Array.from(set).map((l) => copper.indexOf(l)).filter((i) => i >= 0);
    const conn = r.adhoc(c.net, { p: [c.a.pad.x, c.a.pad.y], layers: idx(c.a.layers), shape: c.a.shape }, { p: [c.b.pad.x, c.b.pad.y], layers: idx(c.b.layers), shape: c.b.shape });
    const cands = []; let res = null; try { res = r.find(conn, false, cands); } catch (e) { if (!r.warned) { r.warned = true; console.log("  search failed:", e.stack.split("\n").slice(0, 3).join(" | ")); } res = null; }
    if (!res || cands.length < 2) continue;
    const h = featuresOfTrack(c.nodes, r.pref); mitres.push(...h.diag);
    samples.push({ board: b.name, h, cands }); used++;
  }
  boards.push({ name: b.name, source: b.source, license: b.license, connections: used });
  console.log(`${b.name}: ${found} simple tracks, ${used} used, layers ${copper.length}, habit ${r.pref.map((v) => v.toFixed(2)).join(" ")}, grid ${r.G.g} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
if (!samples.length) { console.log("nothing to fit"); process.exit(1); }

// ---- fit: length is the unit; the rest are learned, kept positive
const DIM = ["via", "bend45", "bend90", "wrongDir"]; const F = (f) => [f.vias, f.b45, f.b90, f.wrong];
const cost = (f, w) => f.length + f.vias * w[0] + f.b45 * w[1] + f.b90 * w[2] + f.wrong * w[3];
const LO = [1, 0.05, 0.1, 0], HI = [40, 6, 12, 3];
const D = R.DEFAULT_WEIGHTS; let w = [D.via, D.bend45, D.bend90, D.wrongDir];
const agreement = (w) => { let ok = 0; for (const s of samples) { let best = s.cands[0], bc = Infinity; for (const c of s.cands) { const v = cost(c, w); if (v < bc) { bc = v; best = c; } } if (best.vias === s.h.vias && Math.abs(best.length - s.h.length) <= 0.1 * s.h.length + 0.2) ok++; } return ok / samples.length; };
const loss = (w) => { let L = 0; for (const s of samples) { const ch = cost(s.h, w); for (const c of s.cands) { const d = ch - cost(c, w); if (d > 0) L += d / s.cands.length; } } return L / samples.length; };
console.log(`\n${samples.length} connections from ${boards.length} boards`);
console.log(`before: weights ${w.map((v) => v.toFixed(2)).join(" ")}  loss ${loss(w).toFixed(4)}  first choice matches the designer's on ${(100 * agreement(w)).toFixed(1)}%`);
for (let ep = 0; ep < 400; ep++) {
  const g = [0, 0, 0, 0]; const lr = 0.5 / (1 + ep / 40);
  for (const s of samples) { const ch = cost(s.h, w), fh = F(s.h); for (const c of s.cands) { if (ch - cost(c, w) <= 0) continue; const fc = F(c); for (let k = 0; k < 4; k++) g[k] += (fh[k] - fc[k]) / s.cands.length; } }
  for (let k = 0; k < 4; k++) w[k] = Math.min(HI[k], Math.max(LO[k], w[k] - lr * g[k] / samples.length * (k === 3 ? 0.2 : 1)));
}
const agree = agreement(w);
console.log(`after:  weights ${w.map((v) => v.toFixed(2)).join(" ")}  loss ${loss(w).toFixed(4)}  first choice matches the designer's on ${(100 * agree).toFixed(1)}%`);
mitres.sort((a, b) => a - b); const mitre = mitres.length ? mitres[Math.floor(mitres.length / 2)] : D.mitre;
const hv = samples.reduce((a, s) => { a.len += s.h.length; a.vias += s.h.vias; a.b45 += s.h.b45; a.b90 += s.h.b90; return a; }, { len: 0, vias: 0, b45: 0, b90: 0 });
console.log(`designers' tracks: ${(hv.len / samples.length).toFixed(1)} mm, ${(hv.vias / samples.length).toFixed(2)} vias, ${(hv.b45 / samples.length).toFixed(2)} 45° and ${(hv.b90 / samples.length).toFixed(2)} 90° corners per connection; median chamfer ${mitre.toFixed(2)} mm`);
const r2 = (v) => +v.toFixed(2);
const W = { length: 1, via: r2(w[0]), bend45: r2(w[1]), bend90: r2(w[2]), wrongDir: r2(w[3]), viaLevel: Math.max(1, Math.min(4, Math.round(w[0] / Math.max(w[2], 1)))), extraLevels: D.extraLevels, mitre: r2(Math.min(3, Math.max(0.3, mitre))) };
console.log("weights", JSON.stringify(W));
if (write) {
  const file = path.join(here, "..", "web", "router", "weights.ts"); let text = fs.readFileSync(file, "utf8");
  const block = `// <trained>\nexport const TRAINED: Weights = ${JSON.stringify(W)};\nexport const PROVENANCE: Provenance = ${JSON.stringify({ boards, fitted: new Date().toISOString().slice(0, 10), agreement: r2(agree) }, null, 2)};\n// </trained>`;
  text = text.replace(/\/\/ <trained>[\s\S]*\/\/ <\/trained>/, block); fs.writeFileSync(file, text); console.log("wrote", file);
}
