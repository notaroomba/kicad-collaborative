// place.ts — put a fetched vendor part into the open schematic or board.
//
// The editor's library module (window.KiCadLibrary, web/editor/library.ts) owns placing
// library items; when it is loaded this hands the symbol or footprint to it.  Until then
// the same result is reached through what the tool modules already offer: the schematic
// module's carry-on-the-cursor placement and the board module's paste.
import type { Part } from "./api";
import { footprintExtent } from "./preview";

interface LibraryApi {
  placeSymbol(a: { libId: string; symbol: string; fields?: Record<string, string>; unit?: number }): Promise<void>;
  placeFootprint(a: { fpid: string; footprint: string; fields?: Record<string, string> }): Promise<void>;
  registerSource?(src: unknown): void;
}
const W = window as unknown as { KiCadLibrary?: LibraryApi; CollabTools?: CollabToolsApi; KiCadCanvas?: KiCadCanvasApi };

export function canPlace(ctx: ToolCtx | null, part: Part | null): string | null {
  if (!ctx || !ctx.doc) return "Open a schematic or a board to place parts.";
  if (ctx.viewOnly) return "This project is view-only for you.";
  if (!part || !part.cad) return "No symbol or footprint is available for this part.";
  if (ctx.isSch && !part.cad.symbol) return "This part has no schematic symbol.";
  if (!ctx.isSch && !part.cad.footprint) return "This part has no footprint.";
  return null;
}

/** The next free reference designator with this prefix on the board ("U" → "U3"). */
function nextRef(doc: KDoc, prefix: string): string {
  let max = 0;
  for (const it of doc.items.values()) { const m = it.kind === "footprint" && it.ref ? /^([A-Za-z#]+)(\d+)$/.exec(it.ref) : null; if (m && m[1] === prefix) max = Math.max(max, +m[2]); }
  return prefix + (max + 1);
}

/** A quoted s-expression string. */
const qs = (v: string) => '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';

/**
 * A library footprint (.kicad_mod form) as the text of a board item: named by its library id,
 * with ids, at the origin.  Built as text because which atoms are quoted lives beside the parsed
 * nodes, and a rebuilt node would lose it.
 */
function boardFootprint(K: KiCadCanvasApi, part: Part, ref: string): string | null {
  const fp = part.cad!.footprint!; const node = K.parse(fp.sexpr);
  if (!node || node[0] !== "footprint") return null;
  const withId = (c: SNode): string => { const t = K.serialize(c); return K.kid(c, "uuid") ? t : t.slice(0, -1) + ` (uuid ${qs(K.newUuid())}))`; };
  const out: string[] = [];
  for (const c of node.slice(2)) {
    if (!Array.isArray(c)) continue;
    if (c[0] === "version" || c[0] === "generator" || c[0] === "generator_version") continue;
    if (c[0] === "layer") { out.push(K.serialize(c), `(uuid ${qs(K.newUuid())})`, "(at 0 0)"); continue; }
    if (c[0] === "property") {
      if (c[1] === "Reference") c[2] = ref;                 // in place: the node keeps its quoting
      if (c[1] === "Datasheet" && part.datasheet) c[2] = part.datasheet;
      out.push(withId(c)); continue;
    }
    out.push(c[0] === "pad" || String(c[0]).startsWith("fp_") ? withId(c) : K.serialize(c));
  }
  // the vendor fields ride along as hidden properties, as on the symbol
  for (const [k, v] of Object.entries(part.fields)) {
    if (!v) continue;
    out.push(`(property ${qs(k)} ${qs(v)} (at 0 0 0) (layer "F.Fab") (hide yes) (uuid ${qs(K.newUuid())}) (effects (font (size 1 1) (thickness 0.15))))`);
  }
  return `(footprint ${qs(fp.fpid)} ${out.join(" ")})`;
}

let cancelPending: (() => void) | null = null;

/** Wait for a click on the stage with the footprint's outline under the cursor; Escape or right-click cancels. */
function clickOnBoard(ctx: ToolCtx, sizeMm: { w: number; h: number; cx: number; cy: number }, label: string): Promise<[number, number] | null> {
  if (cancelPending) cancelPending();
  return new Promise((resolve) => {
    const stage = ctx.stage; const ghost = document.createElement("div");
    ghost.className = "kp-ghost"; ghost.textContent = label;
    const px = ctx.pxPerMm || 4; ghost.style.width = Math.max(10, sizeMm.w * px) + "px"; ghost.style.height = Math.max(10, sizeMm.h * px) + "px";
    document.body.appendChild(ghost);
    const move = (ev: PointerEvent) => { ghost.style.left = ev.clientX + (sizeMm.cx - sizeMm.w / 2) * px + "px"; ghost.style.top = ev.clientY + (sizeMm.cy - sizeMm.h / 2) * px + "px"; ghost.style.display = "flex"; };
    const done = (at: [number, number] | null) => {
      stage.removeEventListener("pointerdown", down, true); window.removeEventListener("pointermove", move, true);
      document.removeEventListener("keydown", key, true); stage.removeEventListener("contextmenu", menu, true);
      ghost.remove(); stage.style.cursor = ""; cancelPending = null; resolve(at);
    };
    const down = (ev: PointerEvent) => {
      ev.stopImmediatePropagation(); ev.preventDefault();
      if (ev.button !== 0) { done(null); return; }
      const mm = ctx.worldMm(ev); done(ctx.snapOn ? ctx.snap(mm) : mm);
    };
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.stopImmediatePropagation(); ev.preventDefault(); done(null); } };
    const menu = (ev: Event) => { ev.preventDefault(); ev.stopImmediatePropagation(); done(null); };
    cancelPending = () => done(null);
    stage.addEventListener("pointerdown", down, true); window.addEventListener("pointermove", move, true);
    document.addEventListener("keydown", key, true); stage.addEventListener("contextmenu", menu, true);
    stage.style.cursor = "crosshair";
  });
}

/** Place `part` in the document behind `ctx`.  Resolves true once the item is on the cursor or placed. */
export async function placePart(ctx: ToolCtx, part: Part): Promise<boolean> {
  const why = canPlace(ctx, part); if (why) { ctx.toast(why, 3500); return false; }
  const cad = part.cad!; const K = ctx.K; const doc = ctx.doc!;
  const fields = { ...part.fields, ...(part.datasheet ? { Datasheet: part.datasheet } : {}) };

  if (ctx.isSch) {
    const sym = cad.symbol!;
    if (W.KiCadLibrary && W.KiCadLibrary.placeSymbol) { await W.KiCadLibrary.placeSymbol({ libId: sym.lib_id, symbol: sym.sexpr, fields: { Value: part.mpn || sym.name, Footprint: cad.footprint ? cad.footprint.fpid : "", ...fields } }); return true; }
    const sch = W.CollabTools && W.CollabTools.sch; const h = sch && (sch._ as Record<string, (...a: unknown[]) => unknown>);
    if (!h || !h.symbolNode || !h.startCarry) { ctx.toast("Placing symbols is not available in this editor build.", 3500); return false; }
    // In a sheet's lib_symbols the top symbol is named by its library id; its units keep the bare name.
    const node = K.parse(sym.sexpr); if (!node) { ctx.toast("The part's symbol could not be read.", 3500); return false; }
    node[1] = sym.lib_id;
    if (!doc.lib.has(sym.lib_id)) doc.lib.set(sym.lib_id, node);          // the sheet's own copy wins, as on paste
    const at = (ctx as unknown as { cursor?: [number, number] }).cursor || [doc.page[0] / 2, doc.page[1] / 2];
    h.startCarry(ctx, "symbol", h.symbolNode(doc, sym.lib_id, ctx.snap(at), 0, ""), at);
    ctx.setTool("place");                                                  // the place tool sees the carry and skips its picker
    ctx.toast(`Click to place ${part.mpn || sym.name}  ·  R rotates, Esc cancels`, 3500);
    return true;
  }

  const fp = cad.footprint!;
  if (W.KiCadLibrary && W.KiCadLibrary.placeFootprint) { await W.KiCadLibrary.placeFootprint({ fpid: fp.fpid, footprint: fp.sexpr, fields: { Value: part.mpn || fp.name, ...fields } }); return true; }
  const pcb = W.CollabTools && W.CollabTools.pcb; const h = pcb && { ...((pcb as unknown as { _?: Record<string, (...a: unknown[]) => unknown> })._ || {}), ...(pcb as unknown as Record<string, (...a: unknown[]) => unknown>) };
  if (!h || !h.pasteChanges) { ctx.toast("Placing footprints is not available in this editor build.", 3500); return false; }
  const ref = nextRef(doc, cad.reference || "U");
  const node = boardFootprint(K, part, ref); if (!node) { ctx.toast("The part's footprint could not be read.", 3500); return false; }
  ctx.toast(`Click on the board to place ${ref} (${part.mpn || fp.name})  ·  Esc cancels`, 4000);
  const at = await clickOnBoard(ctx, footprintExtent(fp.sexpr), ref);
  if (!at) return false;
  const text = `(kicad_pcb (version 20241229) (generator "pcbnew") ${node})`;
  const r = h.pasteChanges(doc, text, at, { annotations: "keep" }) as { changes: KChange[]; ids: string[] };
  if (!r.changes.length) { ctx.toast("The footprint could not be added.", 3500); return false; }
  ctx.commit(r.changes, "place " + ref);
  const sel = (ctx as unknown as { setSelection?(ids: string[]): void }).setSelection; if (sel) sel.call(ctx, r.ids);
  ctx.requestRender(); ctx.toast(`Placed ${ref}`);
  return true;
}
