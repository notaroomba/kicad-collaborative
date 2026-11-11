// Placement benchmark: take a finished board, forget where its parts are and all of its tracks, place the parts
// again (no hints), route, and compare with the board as people laid it out.
// Run: node scripts/place-bench.mjs [--keep-edge] demos/.../board.kicad_pcb …
import { createRequire } from "node:module"; import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url); const S = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "static");
require(path.join(S, "kicad-canvas.js")); require(path.join(S, "pcb-tools.js")); require(path.join(S, "dist", "autoroute.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, R = globalThis.PcbAutoRouter;
const args = process.argv.slice(2); const files = args.filter((a) => !a.startsWith("--")); const passes = +(args.find((a) => a.startsWith("--passes=")) || "--passes=2").slice(9);
const strip = (doc) => { for (const it of Array.from(doc.items.values())) if (["segment", "via", "arc", "zone"].includes(it.kind)) K.removeItem ? K.removeItem(doc, it.id) : doc.items.delete(it.id); };
const applyChanges = (doc, changes) => { for (const c of changes) { const node = K.parseDoc(c.sexpr, "kicad_pcb").items.values().next().value.node; K.removeItem ? (K.removeItem(doc, c.id), K.createItem(doc, node)) : (doc.items.get(c.id).node = node); } };
const errs = (doc) => P.drc(doc, null).filter((m) => m.severity === "error" && !/unconnected|courtyard|silk|edge/.test(m.code)).length;
for (const f of files) {
  const text = fs.readFileSync(f, "utf8"); const human = K.parseDoc(text, "kicad_pcb"); strip(human); const base = errs(human);
  const h = R.evaluate(K, P, human, null); let t = Date.now(); const hr = R.route(K, P, human, null, { passes, timeMs: 240000 }); const hms = Date.now() - t;
  const doc = K.parseDoc(text, "kicad_pcb"); strip(doc); t = Date.now(); const pl = R.place(K, P, doc, null, {}); const pms = Date.now() - t;
  applyChanges(doc, R.placementChanges(K, P, doc, pl.placements)); const a = R.evaluate(K, P, doc, null); const b0 = errs(doc);
  t = Date.now(); const ar = R.route(K, P, doc, null, { passes, timeMs: 240000 }); const ams = Date.now() - t; for (const i of ar.items) K.createItem(doc, i.node);
  console.log(`${path.basename(f)}: parts ${pl.placements.length} groups ${pl.groups.length} place ${pms}ms score ${JSON.stringify(pl.score)}`);
  console.log(`  human layout: ratsnest ${h.ratsnest.toFixed(0)}mm routed ${hr.routed}/${hr.total} vias ${hr.vias} len ${hr.length.toFixed(0)}mm ${(hms / 1000).toFixed(1)}s`);
  console.log(`  auto layout:  ratsnest ${a.ratsnest.toFixed(0)}mm routed ${ar.routed}/${ar.total} vias ${ar.vias} len ${ar.length.toFixed(0)}mm ${(ams / 1000).toFixed(1)}s  rule errors before ${b0} (human ${base}) after ${errs(doc)}`);
  const why = {}; for (const c of ar.connections) if (!c.routed) why[c.reason] = (why[c.reason] || 0) + 1; if (Object.keys(why).length) console.log("  failures:", JSON.stringify(why));
}
