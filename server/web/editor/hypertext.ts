// hypertext.ts — eeschema's hyperlink rollover (SCH_SELECTION_TOOL::Main) and click (SCH_NAVIGATE_TOOL::HypertextCommand).
//
// In the selection tool, with no modifier held, a single text or text box under the cursor that carries a link
// definition — (effects … (href "…")) — and is not selected becomes the rollover item: SCH_PAINTER draws it whole
// in LAYER_HOVERED, underlined, and the cursor turns to HAND.  A click on it follows the link instead of selecting:
// "#<page>" opens the sheet with that page number ("Page '%s' not found." otherwise), "HYPERTEXT_BACK" goes back,
// and anything else pops up a one-row menu "Open <href>" that opens it.
// (Following a link lives in hypertext-follow.ts, so that the hover path here imports nothing but the state.)
import { E } from "./state";

type Node = readonly unknown[];
const kid = (n: Node, key: string): Node | null => { for (let i = 1; i < n.length; i++) { const c = n[i]; if (Array.isArray(c) && c[0] === key) return c; } return null; };

/** The link definition of a schematic text or text box (EDA_TEXT::GetHyperlink), or "". */
export function hrefOf(item: { kind?: string; node?: unknown } | null | undefined): string {
  if (!item || (item.kind !== "text" && item.kind !== "text_box") || !Array.isArray(item.node)) return "";
  const eff = kid(item.node, "effects"); const h = eff && kid(eff, "href");
  return h && typeof h[1] === "string" ? h[1] : "";
}

/** EDA_TEXT::IsGotoPageHref: "#<page>" names a page of the hierarchy; the destination, or null. */
export function gotoPageOf(href: string): string | null { return href.startsWith("#") ? href.slice(1) : null; }

/** The rollover from the selection tool's hover pick (null clears it); true when it changed. */
export function setRollover(item: { id: string; kind?: string; node?: unknown } | null, mods: { shift: boolean; ctrl: boolean; alt: boolean }): boolean {
  const href = item && !mods.shift && !mods.ctrl && !mods.alt && !E.selection.has(item.id) ? hrefOf(item) : "";
  const next = href ? { id: item!.id, href } : null;
  const prev = E.hyperHover as { id: string; href: string } | null;
  if ((prev && prev.id) === (next && next.id) && (prev && prev.href) === (next && next.href)) return false;
  E.hyperHover = next;   // editor/view.ts passes it to the canvas pass as `rollover`
  return true;
}
