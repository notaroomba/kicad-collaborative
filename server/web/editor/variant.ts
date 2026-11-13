// editor/variant — the session's current design variant (PCB_EDIT_FRAME / SCH_EDIT_FRAME SetCurrentVariant).
//
// The aux toolbar's "Current variant" combo (PCB_ACTION_TOOLBAR_CONTROLS::currentVariant,
// toolbars_pcb_editor.cpp UpdateVariantSelectionCtrl / onVariantSelected; toolbars_sch_editor.cpp:290-370) lists
// GetVariantNamesForUI — "< Default >" first, then the variant names by StrNumCmp — and in the schematic editor a
// "---" separator and "Add New Design Variant...".  The choice lives for the session only (KiCad does not save it);
// each client has its own.  Choosing one:
//   - feeds ${VARIANT} / ${VARIANT_DESC} to the drawing sheet and the text variables;
//   - drops every item's render cache (the geometry is rebuilt) and redraws, so DNP marks and field texts show the
//     variant's (the display goes through footprintViewForVariant / symbolViewForVariant);
//   - refreshes the Properties panel and the message panel;
//   - the attribute toggles and the Footprint / Symbol Properties dialogs then edit the variant (canvas/variant-model).
import { E } from "./state";
import { store } from "./appstore";
import { requestRender } from "./view";
import * as VM from "../canvas/variant-model";
import { currentInstance } from "./schnets";

export const ADD_VARIANT_ENTRY = "Add New Design Variant...";
export const VARIANT_SEPARATOR = "---";

type Editor = "pcb" | "sch";
const editorOf = (): Editor => (E.kdoc && E.kdoc.type === "sch" ? "sch" : "pcb");
const byEditor: Record<Editor, string> = { pcb: "", sch: "" };
let names: Record<Editor, string[]> = { pcb: [VM.DEFAULT_VARIANT_NAME], sch: [VM.DEFAULT_VARIANT_NAME] };
let descriptions: Record<Editor, Record<string, string>> = { pcb: {}, sch: {} };

/** The current variant of the open editor ("" for the default). */
export function currentVariant(): string { return byEditor[editorOf()] || ""; }
(E as { currentVariantOf?: () => string }).currentVariantOf = currentVariant;

function publish(): void {
  const ed = editorOf();
  E.currentVariant = byEditor[ed] || "";
  store.set({ variant: { current: byEditor[ed] || "", names: names[ed].slice(), sch: ed === "sch" } } as never);
}

/** The board's (variants …) section as the open board has it. */
function boardVariantsNode(): SNode | null {
  const d = E.kdoc as (KDoc & { boardSetup?: { variants?: SNode | null }; variantsNode?: SNode | null }) | null;
  if (!d) return null;
  return (d.boardSetup && d.boardSetup.variants) || d.variantsNode || null;
}

/** The schematic's registry (.kicad_pro schematic.variants [{name, description}]). */
function proVariants(pro: Record<string, unknown> | null): { name: string; description: string }[] {
  const sch = pro && typeof pro.schematic === "object" ? (pro.schematic as Record<string, unknown>) : null;
  const list = sch && Array.isArray(sch.variants) ? (sch.variants as unknown[]) : [];
  return list.filter((e): e is { name: string; description?: string } => !!e && typeof e === "object" && typeof (e as { name?: unknown }).name === "string")
    .map((e) => ({ name: e.name, description: typeof e.description === "string" ? e.description : "" }));
}

/** UpdateVariantSelectionCtrl: re-read the names (the board header, or the sheets plus the .kicad_pro). */
export function refreshVariantNames(schNames?: string[]): void {
  const ed = editorOf();
  if (ed === "pcb") {
    const v = boardVariantsNode();
    names.pcb = VM.boardVariantNamesForUI(v);
    descriptions.pcb = {}; for (const n of names.pcb.slice(1)) descriptions.pcb[n] = VM.boardVariantDescription(v, n);
  } else {
    let pro: Record<string, unknown> | null = null;
    try { pro = E.proSettings ? JSON.parse(E.proSettings) : null; } catch (e) { pro = null; }
    const reg = proVariants(pro);
    const set = new Set<string>(schNames ? schNames.filter((n) => !VM.isDefaultVariant(n)) : []);
    if (!schNames && E.kdoc) for (const it of (E.kdoc as KDoc).items.values()) {
      if (it.kind !== "symbol" && it.kind !== "sheet") continue;
      for (const p of VM.symbolInstancePaths(it.node)) for (const c of p) if (Array.isArray(c) && c[0] === "variant") { const nm = (c as SNode).find((x) => Array.isArray(x) && x[0] === "name") as SNode | undefined; if (nm && nm[1]) set.add(String(nm[1])); }
    }
    for (const r of reg) set.add(r.name);
    names.sch = [VM.DEFAULT_VARIANT_NAME, ...[...set].sort(VM.strNumCmp)];
    descriptions.sch = {}; for (const r of reg) descriptions.sch[r.name] = r.description;
  }
  // a variant that went away (a peer removed it) falls back to the default
  if (byEditor[ed] && !names[ed].some((n) => n.toLowerCase() === byEditor[ed].toLowerCase())) { setCurrentVariant(""); return; }
  publish();
}

/** The variant names for the UI (the default first). */
export function variantNamesForUI(): string[] { return names[editorOf()].slice(); }
/** GetVariantDescription. */
export function variantDescription(name: string): string { return descriptions[editorOf()][name] || ""; }

/** Hand the variant to the document's drawing-sheet context. */
export function applyVariantToDoc(doc: KDoc | null): void {
  if (!doc) return;
  const d = doc as KDoc & { variantName?: string; variantDesc?: string };
  const ed: Editor = doc.type === "sch" ? "sch" : "pcb", v = byEditor[ed] || "";
  d.variantName = v; d.variantDesc = v ? descriptions[ed][v] || "" : "";
}

/** SetCurrentVariant: "" (or "< Default >") for the default. */
export function setCurrentVariant(name: string): void {
  const ed = editorOf(); const v = VM.isDefaultVariant(name) ? "" : name;
  const changed = (byEditor[ed] || "") !== v;
  byEditor[ed] = v; variantCache.clear(); lastView = null;
  publish();
  if (!changed) return;
  const doc = E.kdoc as KDoc | null;
  if (doc) {
    applyVariantToDoc(doc);
    // every text may hold ${VARIANT}, ${REF:FIELD} or a variant field: drop the render caches
    for (const it of doc.items.values()) { try { (KiCadCanvas.buildGeom as (d: KDoc, i: KItem) => void)(doc, it); } catch (e) { /* keep the old look */ } }
  }
  requestRender();
  try { if (CollabTools.props && CollabTools.props.refresh) CollabTools.props.refresh(); } catch (e) { console.warn(e); }
  const bump = store.get().document; store.slice("document", { version: (bump.version || 0) + 1 });
}

// ---------------------------------------------------------------- the display through the variant
const variantCache = new Map<string, { node: SNode; variant: string; path: string | null; item: KItem }>();
let lastView: { doc: KDoc; variant: string; path: string | null; items: Map<string, KItem>; view: KDoc } | null = null;
/** The open sheet's instance path ("/root/…/sheet"): GetCurrentSheet(), the instance whose variant data shows. */
export function currentSheetPath(): string | null {
  if (!E.kdoc || E.kdoc.type !== "sch") return null;
  try { const inst = currentInstance(); return inst && inst.uuidPath.length ? "/" + inst.uuidPath.join("/") : null; } catch (e) { return null; }
}
(E as { currentSheetPathOf?: () => string | null }).currentSheetPathOf = currentSheetPath;

/** The item as the variant shows it (the same item when the variant changes nothing). */
function shownItem(doc: KDoc, it: KItem, variant: string, path: string | null): KItem {
  if (it.kind !== "footprint" && it.kind !== "symbol") return it;
  const c = variantCache.get(it.id);
  if (c && c.node === it.node && c.variant === variant && c.path === path) return c.item;
  const node = it.kind === "footprint" ? VM.footprintViewForVariant(it.node, variant) : VM.symbolViewForVariant(it.node, variant, path, doc.version);
  let item = it;
  if (node !== it.node) {
    item = Object.assign({}, it, { node, geom: [], bbox: it.bbox }) as KItem;
    try { (KiCadCanvas.buildGeom as (d: KDoc, i: KItem) => void)(doc, item); } catch (e) { item = it; }
  }
  variantCache.set(it.id, { node: it.node, variant, path, item });
  return item;
}

/** The document as the current variant shows it (the document itself without a variant).  The same object comes
 *  back while nothing changed, so the painter's layer cache holds. */
export function variantView(doc: KDoc | null): KDoc | null {
  const v = currentVariant(); if (!doc || !v) return doc;
  const path = doc.type === "sch" ? currentSheetPath() : null;
  let same = !!lastView && lastView.doc === doc && lastView.variant === v && lastView.path === path && lastView.items.size === doc.items.size;
  const items = new Map<string, KItem>();
  for (const [id, it] of doc.items) { const s = shownItem(doc, it, v, path); items.set(id, s); if (same && lastView!.items.get(id) !== s) same = false; }
  if (same) return lastView!.view;
  const view = Object.create(doc) as KDoc & { items: Map<string, KItem> };
  view.items = items;
  lastView = { doc, variant: v, path, items, view };
  return view;
}

/** The parts of the variant model the dialogs and tools use. */
export { VM };
