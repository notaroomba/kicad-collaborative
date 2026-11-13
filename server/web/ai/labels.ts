// labels.ts — plain net labels on wire ends turned into global labels with a direction shape.
//
// A plain label is text: a reader cannot tell whether it names the wire or sends the net somewhere else.  The
// house rule (Greenberg, Actually Useful Schematics) is that a net which continues elsewhere by name ends in a
// global (or hierarchical) label whose shape says which way the signal goes.  A name in the middle of a wire that
// carries on to more parts stays a plain label: that is a named wire.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { K, ToolError, schNets } from "./design";

const W = window as any;
const SCH = (): any => (W.CollabTools && W.CollabTools.sch) || null;
const key = (x: number, y: number) => `${Math.round(x * 100)},${Math.round(y * 100)}`;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** The direction shape for a label from the pins on its piece of wire, then from the rest of its net. */
export function shapeFor(here: string[], rest: string[]): string {
  const has = (l: string[], ...t: string[]) => l.some((x) => t.includes(x));
  if (has(here, "output", "power_out") && has(here, "input") ) return "bidirectional";
  if (has(here, "bidirectional", "tri_state", "open_collector", "open_emitter")) return "bidirectional";
  if (has(here, "output", "power_out")) return "output";
  if (has(here, "input", "power_in")) return "input";
  if (has(rest, "bidirectional", "tri_state", "open_collector", "open_emitter")) return "bidirectional";
  if (has(rest, "output", "power_out")) return "input";      // the driver is elsewhere: the signal arrives here
  if (has(rest, "input")) return "output";
  return "passive";
}

export function globalizeLabels(doc: any, h: { added: (doc: any, node: any) => any; removed: (doc: any, it: any) => any }, opts: { names?: string[]; all?: boolean } = {}): { changes: any[]; converted: string[]; ids: string[] } {
  const s = SCH(), k = K(); if (!s) throw new ToolError("The schematic tools are not loaded.");
  const wires: { it: any; a: number[]; b: number[] }[] = [], labels: any[] = [], pinAt = new Map<string, { ref: string; type: string }[]>(), junctions = new Set<string>(); let sheets = 0;
  for (const it of doc.items.values() as Iterable<any>) {
    if (it.kind === "wire") { const pts = k.ptsOf(it.node); if (pts.length === 2) wires.push({ it, a: pts[0], b: pts[1] }); }
    else if (it.kind === "label" || it.kind === "global_label" || it.kind === "hierarchical_label") labels.push(it);
    else if (it.kind === "junction") { const a = k.atOf(it.node); junctions.add(key(a[0], a[1])); }
    else if (it.kind === "sheet") sheets++;
    else if (it.kind === "symbol") for (const p of s._.symbolPins(doc, it)) { const kk = key(p.x, p.y); const l = pinAt.get(kk); const row = { ref: it.ref || "", type: /^#/.test(it.ref || "") ? "" : p.type }; if (l) l.push(row); else pinAt.set(kk, [row]); }
  }
  const pinCount = new Map<string, number>(); for (const l of pinAt.values()) for (const p of l) pinCount.set(p.ref, (pinCount.get(p.ref) || 0) + 1);
  const count = new Map<string, number>(); for (const l of labels) { const t = k.str(l.node[1]); count.set(t, (count.get(t) || 0) + 1); }
  const want = opts.names && opts.names.length ? new Set(opts.names) : null;
  // pieces of wire that are joined, and the pin types on each
  const par = wires.map((_, i) => i); const find = (i: number): number => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  const on = (p: number[], w: { a: number[]; b: number[] }) => Math.abs((w.b[0] - w.a[0]) * (p[1] - w.a[1]) - (w.b[1] - w.a[1]) * (p[0] - w.a[0])) < 1e-3 && p[0] >= Math.min(w.a[0], w.b[0]) - 1e-3 && p[0] <= Math.max(w.a[0], w.b[0]) + 1e-3 && p[1] >= Math.min(w.a[1], w.b[1]) - 1e-3 && p[1] <= Math.max(w.a[1], w.b[1]) + 1e-3;
  wires.forEach((w, i) => wires.forEach((v, j) => { if (i < j && (on(w.a, v) || on(w.b, v) || on(v.a, w) || on(v.b, w))) par[find(i)] = find(j); }));
  const typesOf = new Map<number, string[]>();
  for (const [kk, l] of pinAt) { const [x, y] = kk.split(",").map((v) => Number(v) / 100); wires.forEach((w, i) => { if (on([x, y], w)) { const g = find(i); const t = typesOf.get(g) || []; for (const p of l) if (p.type) t.push(p.type); typesOf.set(g, t); } }); }
  const netTypes = new Map<string, string[]>(); for (const n of schNets(doc)) for (const name of n.labels.concat(n.name)) netTypes.set(name, n.pins.map((p) => p.type));

  // A plain label and a global label of the same name are two different nets, so a name is converted everywhere or
  // nowhere: one that also names a drawn-through wire somewhere keeps its plain labels.
  const fixedNames = new Set<string>();
  for (const l of labels) {
    if (l.kind !== "label") continue; const at = k.atOf(l.node); const P = [at[0], at[1]]; const pk = key(P[0], P[1]);
    const touching = wires.filter((w) => on(P, w)); const endsHere = touching.filter((w) => key(w.a[0], w.a[1]) === pk || key(w.b[0], w.b[1]) === pk);
    const stays = touching.length > 1 || junctions.has(pk) || (touching.length === 1 && (!endsHere.length || pinAt.has(pk))) || (!touching.length && !pinAt.has(pk));
    if (stays) fixedNames.add(k.str(l.node[1]));
  }
  const changes: any[] = [], converted: string[] = [], ids: string[] = [];
  for (const l of labels) {
    if (l.kind !== "label") continue; const text = k.str(l.node[1]); if ((want && !want.has(text)) || fixedNames.has(text)) continue;
    if (!opts.all && !want && (count.get(text) || 0) < 2 && !sheets) continue;      // a name used once on a single sheet goes nowhere: it names its wire
    const at = k.atOf(l.node); const P = [at[0], at[1]]; const rot = ((Math.round(at[2] || 0) % 360) + 360) % 360; const pk = key(P[0], P[1]);
    const touching = wires.map((w, i) => ({ w, i })).filter(({ w }) => on(P, w));
    const endsHere = touching.filter(({ w }) => key(w.a[0], w.a[1]) === pk || key(w.b[0], w.b[1]) === pk);
    if (touching.length > 1 || junctions.has(pk) || (touching.length === 1 && !endsHere.length)) continue;     // a name on a wire that carries on
    let place = P, turn = rot, here: string[] = (pinAt.get(pk) || []).map((p) => p.type).filter(Boolean);
    if (touching.length === 1) {
      const { w, i } = touching[0]; if (pinAt.has(pk)) continue;        // the wire ends on a pin here: the name is on a wired pin
      here = typesOf.get(find(i)) || [];
      const Q = key(w.a[0], w.a[1]) === pk ? w.b : w.a; const horizontal = Math.abs(Q[1] - P[1]) < 1e-3;
      const back = horizontal && ((rot === 0 && Q[0] > P[0]) || (rot === 180 && Q[0] < P[0]));     // the name lies back over its wire
      if (back) {
        const d = P[0] > Q[0] ? 1 : -1; const len = Math.abs(P[0] - Q[0]);
        const tw = Math.ceil((k.textWidth(text, 1.27, 0) + 0.6) / 1.27) * 1.27; const big = (pinAt.get(key(Q[0], Q[1])) || []).some((p) => (pinCount.get(p.ref) || 0) > 2);
        const cut = Math.min(tw + (big ? 1.27 : 0), len);     // a global label's outline is wider than its text: on an IC or connector pin it starts at the pin, beside a small part it leaves that part's value room
        place = [r4(P[0] - d * cut), P[1]]; turn = d > 0 ? 0 : 180;
        changes.push(h.removed(doc, w.it)); ids.push(w.it.id);
        if (len - cut > 1e-3) { const c = h.added(doc, s._.lineNode("wire", Q, place)); changes.push(c); ids.push(c.id); }
      }
    } else if (!here.length) continue;      // a label in free space
    const rest = (netTypes.get(text) || []).slice(); for (const t of here) { const j = rest.indexOf(t); if (j >= 0) rest.splice(j, 1); }
    const node = s._.labelNode("global_label", text, place, turn); const sh = node.find((c: any) => Array.isArray(c) && c[0] === "shape"); if (sh) sh[1] = shapeFor(here, rest);
    changes.push(h.removed(doc, l)); const c = h.added(doc, node); changes.push(c); ids.push(l.id, c.id); converted.push(text);
  }
  return { changes, converted, ids };
}
