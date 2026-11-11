// Autorouter benchmark: strip the tracks of routed boards (or take boards as they are with --keep) and route them
// again, reporting how many connections complete and whether the editor's own DRC finds anything wrong with the
// result.   node scripts/router-bench.mjs [--keep] [--strip-zones] board.kicad_pcb...
import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module"; import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url); const here = path.dirname(fileURLToPath(import.meta.url)); const S = path.join(here, "..", "static");
require(path.join(S, "kicad-canvas.js")); require(path.join(S, "pcb-tools.js")); require(path.join(S, "dist", "autoroute.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, R = globalThis.PcbAutoRouter;
const args = process.argv.slice(2); const keep = args.includes("--keep"); const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
const opts = {}; for (const a of args) { const m = /^--(passes|pitch|timeMs)=(.+)$/.exec(a); if (m) opts[m[1]] = +m[2]; if (a === "--no-rip") opts.ripUp = false; if (a === "--no-vias") opts.allowVias = false; }
export function settingsFor(file, text) {
  const pro = file.replace(/\.kicad_pcb$/, ".kicad_pro");
  if (fs.existsSync(pro)) { try { return JSON.parse(fs.readFileSync(pro, "utf8")); } catch (e) { /* fall through */ } }
  return /\(net_class /.test(text) ? text : null;
}
let tot = 0, ok = 0;
for (const file of args.filter((a) => !a.startsWith("--") && a !== out)) {
  const text = fs.readFileSync(file, "utf8"); const doc = K.parseDoc(text, "kicad_pcb"); const settings = P.designSettings(settingsFor(file, text));
  if (!keep) for (const [id, it] of Array.from(doc.items)) if (it.kind === "segment" || it.kind === "arc" || it.kind === "via") doc.items.delete(id);
  const before = P.drc(doc, settings, { unconnected: false }).filter((m) => m.code === "clearance" || m.code === "copper_edge_clearance" || m.code === "shorting_items").length;
  const res = R.route(K, P, doc, settings, opts);
  for (const it of res.items) K.createItem(doc, it.node);
  const after = P.drc(doc, settings, { unconnected: true }); const viol = after.filter((m) => m.code === "clearance" || m.code === "copper_edge_clearance" || m.code === "shorting_items").length;
  const left = after.filter((m) => m.code === "unconnected_items").length;
  tot += res.total; ok += res.routed;
  console.log(`${path.basename(file).padEnd(40)} ${String(res.routed).padStart(4)}/${String(res.total).padEnd(4)} (${res.total ? (100 * res.routed / res.total).toFixed(1) : "100.0"}%)  vias ${String(res.vias).padStart(3)}  len ${res.length.toFixed(0).padStart(5)}mm  ${(res.ms / 1000).toFixed(1)}s  passes ${res.passes}  grid ${res.grid.pitch}mm ${res.grid.w}x${res.grid.h}  zone ends ${res.zoneEnds} covered ${res.zoneCovered}  new DRC errors ${viol - before}  still unconnected ${left}`);
  if (out) fs.writeFileSync(path.join(out, path.basename(file)), K.serializeDoc ? K.serializeDoc(doc) : "");
}
console.log(`total ${ok}/${tot} (${tot ? (100 * ok / tot).toFixed(1) : 100}%)`);
