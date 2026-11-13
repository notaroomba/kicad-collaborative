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

type TextG = { t: string; text: string; raw?: string; field?: string; x: number; y: number; rot?: number; mirror?: boolean; size: number; sizeX?: number; h: string; v: string };
type UrlApi = { urlRunAt(g: TextG, p: readonly number[]): { start: number; end: number; url: string } | null; isUrlText(s: string): boolean };
const canvasApi = (): UrlApi | null => { const K = (globalThis as { KiCadCanvas?: Partial<UrlApi> }).KiCadCanvas; return K && K.urlRunAt && K.isUrlText ? K as UrlApi : null; };
const textGeoms = (item: { geom?: unknown } | null | undefined): TextG[] => (item && Array.isArray(item.geom) ? (item.geom as TextG[]).filter((g) => g && g.t === "text") : []);

/** The hovered hypertext: the item, the link a click follows, and the text line and url run drawn hovered (none: the whole item). */
export interface HyperHover { id: string; href: string; geom?: object; run?: { start: number; end: number } }

/**
 * SCH_ITEM::HasHoveredHypertext for the item under the cursor (null when none):
 * - a text / text box with a link definition is hovered whole;
 * - a text / text box whose text contains a url (SCH_TEXT::HasHypertext → containsURL) is hovered only while the
 *   cursor is on that url (FONT::drawMarkup's url node), and the click follows that url;
 * - a field whose shown text is a url (SCH_FIELD::HasHypertext → IsURL) is hovered whenever it is rolled over and
 *   the click opens the whole text; the url node under the cursor is the part drawn hovered.
 */
export function hoveredHypertext(item: { id: string; kind?: string; node?: unknown; geom?: unknown } | null, mm: readonly number[] | null, field: string | null): HyperHover | null {
  if (!item) return null;
  if (field) {
    const K = canvasApi(); if (!K) return null;
    const lines = textGeoms(item).filter((g) => g.field === field); if (!lines.length) return null;
    const shown = lines.map((g) => g.text).join("\n"); if (!K.isUrlText(shown)) return null;
    for (const g of lines) { const r = mm && K.urlRunAt(g, mm); if (r) return { id: item.id, href: shown, geom: g, run: { start: r.start, end: r.end } }; }
    return { id: item.id, href: shown, geom: lines[0], run: { start: 0, end: 0 } };   // hovered, nothing under the cursor drawn hovered
  }
  const href = hrefOf(item); if (href) return { id: item.id, href };
  if ((item.kind !== "text" && item.kind !== "text_box") || !mm) return null;
  const K = canvasApi(); if (!K) return null;
  for (const g of textGeoms(item)) { if (g.field) continue; const r = K.urlRunAt(g, mm); if (r) return { id: item.id, href: r.url, geom: g, run: { start: r.start, end: r.end } }; }
  return null;
}

/** The rollover from the selection tool's hover pick (null clears it); true when it changed. */
export function setRollover(item: { id: string; kind?: string; node?: unknown; geom?: unknown } | null, mods: { shift: boolean; ctrl: boolean; alt: boolean }, mm?: readonly number[] | null, field?: string | null): boolean {
  const next = item && !mods.shift && !mods.ctrl && !mods.alt && !E.selection.has(item.id) ? hoveredHypertext(item, mm || null, field || null) : null;
  const prev = E.hyperHover as HyperHover | null;
  const same = (a: HyperHover | null, b: HyperHover | null) => a === b || (!!a && !!b && a.id === b.id && a.href === b.href && a.geom === b.geom
    && (a.run ? a.run.start + ":" + a.run.end : "") === (b.run ? b.run.start + ":" + b.run.end : ""));
  if (same(prev, next)) return false;
  E.hyperHover = next;   // editor/view.ts passes it to the canvas pass as `rollover` / `rolloverGeom` / `rolloverRun`
  return true;
}
