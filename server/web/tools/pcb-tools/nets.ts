// pcb-tools/nets.ts — nets as items reference them.
import type { NetRef } from "./types";
import { K } from "./state";

// ---------------------------------------------------------------- nets
// Boards from this build reference nets by name — (net "GND") — while older
// ones carry (net 3 "GND") on pads and (net 3) on tracks; both are understood
// and new items are written in the document's own style.
export function netOf(node: SNode | null | undefined): NetRef {
  const n = node && K.kid(node, "net"); if (!n) return { code: 0, name: "" };
  if (typeof n[1] === "number") return { code: n[1], name: n.length > 2 ? K.str(n[2]) : "" };
  return { code: -1, name: K.str(n[1]) };
}
export const NET_STYLE = new WeakMap<KDoc, string>();
export function netStyle(doc: KDoc) {
  if (NET_STYLE.has(doc)) return NET_STYLE.get(doc);
  let style: string | null = null;
  for (const it of doc.items.values()) {
    const probe = it.kind === "footprint" ? K.kid(it.node, "pad") : (it.kind === "segment" || it.kind === "via" || it.kind === "arc") ? it.node : null;
    const n = probe && K.kid(probe, "net"); if (!n) continue;
    style = typeof n[1] === "number" ? "code" : "name"; break;
  }
  if (!style) return "name";   // nothing on a net yet: this build's own form, and not remembered, so the first netted item decides
  NET_STYLE.set(doc, style); return style;
}
export function netNode(doc: KDoc, net: NetRef | null | undefined): SNode { return netStyle(doc) === "name" ? ["net", net && net.name ? net.name : ""] : ["net", net && net.code > 0 ? net.code : 0]; }
export const hasNet = (n: NetRef | null | undefined): n is NetRef => !!(n && (n.name || n.code > 0));
export const sameNet = (a: NetRef | null | undefined, b: NetRef | null | undefined) => hasNet(a) && hasNet(b) && (a.name && b.name ? a.name === b.name : a.code === b.code);
