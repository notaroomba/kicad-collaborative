// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/canvas/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { PCB_KINDS, SCH_KINDS, addItem } from "./doc";
import { buildGeom } from "./geom";
import { atOf, isList, kid, kids, num, parseAll, ptsOf, str, uuidOf } from "./sexpr";
import { shiftTable } from "./tables-images";
// ---------------------------------------------------------------- ops
export function fragmentItems(doc, sexpr) {
  const out = [];
  for (const tree of parseAll(sexpr)) {
    if (tree[0] === "kicad_sch" || tree[0] === "kicad_pcb") {
      const ls = kid(tree, "lib_symbols"); if (ls) for (const s of kids(ls, "symbol")) doc.lib.set(str(s[1]), s);
      for (const c of tree.slice(1)) if (isList(c) && (doc.type === "sch" ? SCH_KINDS.has(c[0]) : PCB_KINDS.has(c[0]))) out.push(c);
    } else if (tree[0] === "lib_symbols") { for (const s of kids(tree, "symbol")) doc.lib.set(str(s[1]), s); }
    else out.push(tree);
  }
  return out;
}

export function setAt(node, x, y, rot) {
  const t = kid(node, "transform");
  if (t) {
    let tr = kid(t, "translate"); if (!tr) { tr = ["translate", 0, 0]; t.push(tr); }
    let ro = kid(t, "rotate"); if (!ro) { ro = ["rotate", 0]; t.push(ro); }
    if (x !== undefined) tr[1] = x; if (y !== undefined) tr[2] = y; if (rot !== undefined) ro[1] = rot;
    return;
  }
  let a = kid(node, "at");
  if (!a) { a = ["at", 0, 0]; node.splice(2, 0, a); }
  if (x !== undefined) a[1] = x; if (y !== undefined) a[2] = y;
  if (rot !== undefined) { if (a.length >= 4) a[3] = rot; else a.push(rot); }
}

/** Apply one wire-format change {id, kind, sexpr?, itemSexpr?, properties?} (IU per mm given). */
export function applyChange(doc, change, IU) {
  const id = str(change.id), kind = str(change.kind).toUpperCase();
  if (kind === "REMOVED") return doc.items.delete(id);
  const frag = change.sexpr || change.itemSexpr;
  if (frag) {
    const nodes = fragmentItems(doc, frag);
    let applied = false;
    for (const node of nodes) {
      const nid = uuidOf(node) || id;
      if (nid !== id && nodes.length > 1) continue;
      if (!uuidOf(node)) node.push(["uuid", id]);
      doc.items.delete(nid);
      const it = addItem(doc, node); if (it) { applied = true; }
    }
    if (applied) return true;
  }
  const item = doc.items.get(id);
  if (!item) return false;
  if (kind === "MODIFIED" && Array.isArray(change.properties) && change.properties.length) {
    let nx, ny, nrot, changed = false;
    const p2 = ptsOf(item.node);
    for (const p of change.properties) {
      const after = p.after && p.after.v;
      if (after === undefined || after === null) continue;
      const v = Number(after);
      switch (p.name) {
      case "Position X": nx = v / IU; break;
      case "Position Y": ny = v / IU; break;
      case "Orientation": case "Rotation": nrot = v; break;
      case "Start X": if (p2[0]) { p2[0][0] = v / IU; changed = true; } break;
      case "Start Y": if (p2[0]) { p2[0][1] = v / IU; changed = true; } break;
      case "End X": if (p2[1]) { p2[1][0] = v / IU; changed = true; } break;
      case "End Y": if (p2[1]) { p2[1][1] = v / IU; changed = true; } break;
      case "Value": case "Reference": case "Text":
        if (doc.type === "sch" && item.kind === "symbol") { for (const pr of kids(item.node, "property")) if (str(pr[1]) === p.name) { pr[2] = String(after); changed = true; } }
        else if (typeof item.node[1] === "string") { item.node[1] = String(after); changed = true; }
        break;
      default: break;
      }
    }
    if (changed && p2.length) setPts(item.node, p2);
    if (nx !== undefined || ny !== undefined || nrot !== undefined) {
      const ox = item.x !== undefined ? item.x : atOf(item.node)[0], oy = item.y !== undefined ? item.y : atOf(item.node)[1];
      const dx = nx !== undefined ? nx - ox : 0, dy = ny !== undefined ? ny - oy : 0;
      if (item.kind === "table") shiftTable(item.node, dx, dy); else setAt(item.node, nx, ny, nrot);
      if (doc.type === "sch" && item.kind === "symbol" && (dx || dy)) for (const p of kids(item.node, "property")) { const a = kid(p, "at"); if (a) { a[1] = num(a[1]) + dx; a[2] = num(a[2]) + dy; } }
      changed = true;
    }
    if (changed) { buildGeom(doc, item); return true; }
  }
  return false;
}

export function setPts(node, pts) {
  let p = kid(node, "pts"); if (!p) { p = ["pts"]; node.splice(1, 0, p); }
  p.length = 1; for (const [x, y] of pts) p.push(["xy", +x.toFixed(4), +y.toFixed(4)]);
}
