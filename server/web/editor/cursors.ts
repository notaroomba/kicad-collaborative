// cursors.ts — the canvas cursor, KiCad's KICURSOR (common/gal/cursors.cpp), set the way the tools set it.
//
// Each tool declares its KICURSOR (LINE_WIRE for Draw Wires, LABEL_NET for Add Label, COMPONENT for Add Symbol …,
// tools/*-tools TOOLS); a tool may switch it while it runs through its module's cursorNow() (COMPONENT becomes
// MOVING once a symbol rides on the cursor).  The selection tool follows SCH_SELECTION_TOOL / PCB_SELECTION_TOOL::
// OnIdle: Shift shows ADD, Ctrl+Shift SUBTRACT, Ctrl XOR, otherwise m_nonModifiedCursor — LINE_WIRE / LINE_BUS /
// LINE_GRAPHIC over an autostart point, HAND over hypertext, MOVING over the selection, SELECT_LASSO in lasso mode,
// ARROW otherwise; a box drag shows SELECT_WINDOW left to right and SELECT_LASSO right to left (greedy).  Panning
// never changes the cursor.  The bitmaps are KiCad's own (kicursors.generated.ts); ARROW, HAND and BULLSEYE are
// the stock cursors (GetStockCursor).
import { KICURSOR_IMAGES } from "./kicursors.generated";
import { E } from "./state";
import { stage } from "./view";
import { activeModule, moduleTool, toolCtx } from "./tools";

// wxCURSOR_BULLSEYE (a stock cursor the browser does not have): a target with its hotspot in the middle
const BULLSEYE = 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="#fff" stroke-width="3"/><circle cx="12" cy="12" r="9" fill="none" stroke="#000" stroke-width="1.2"/><circle cx="12" cy="12" r="5" fill="none" stroke="#fff" stroke-width="3"/><circle cx="12" cy="12" r="5" fill="none" stroke="#000" stroke-width="1.2"/><circle cx="12" cy="12" r="1.6" fill="#000"/></svg>') + '") 12 12, crosshair';

/** The CSS cursor for a KICURSOR name ("LINE_WIRE"), or "" when it is not one. */
export function kicursorCss(name: string): string {
  if (name === "ARROW" || name === "DEFAULT") return "default";
  if (name === "HAND") return "pointer";
  if (name === "BULLSEYE") return BULLSEYE;
  const img = KICURSOR_IMAGES[name];
  return img ? `url("${img[0]}") ${img[1]} ${img[2]}, default` : "";
}

/** A tool's declared cursor as CSS: a KICURSOR name, the older "crosshair" (PENCIL), "move" (MOVING), "text" (TEXT), or CSS. */
export function toolCursor(declared: string): string {
  if (!declared) return "";
  const alias = declared === "crosshair" ? "PENCIL" : declared === "move" ? "MOVING" : declared === "text" ? "TEXT" : declared;
  return kicursorCss(alias) || declared;
}

/** The modifier keys as the last key or pointer event left them (wxGetMouseState in OnIdle). */
const mods = { shift: false, ctrl: false, alt: false };
export function noteModifiers(ev: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): void {
  const c = ev.ctrlKey || ev.metaKey;
  if (mods.shift === ev.shiftKey && mods.ctrl === c && mods.alt === ev.altKey) return;
  mods.shift = ev.shiftKey; mods.ctrl = c; mods.alt = ev.altKey;
  refreshCursor();
}

/** SELECTION_TOOL::setModifiersState → ADD / SUBTRACT / XOR (null without a modifier). */
/** The modifier state as the cursor logic last saw it. */
export function heldModifiers(): { shift: boolean; ctrl: boolean; alt: boolean } { return { shift: mods.shift, ctrl: mods.ctrl, alt: mods.alt }; }

export function modifierCursor(shift: boolean, ctrl: boolean): string | null {
  return ctrl && shift ? "SUBTRACT" : shift ? "ADD" : ctrl ? "XOR" : null;
}

type CursorModule = { cursorNow?: (ctx: unknown) => string | null; state?: { autoCursor?: string | null; hyperHover?: unknown } };

/** A cursor an app-level interaction holds while it runs (a library footprint riding the cursor: MOVING). */
let override: string | null = null;
export function setCursorOverride(name: string | null): void { override = name; refreshCursor(); }

/** The KICURSOR (or CSS) the canvas should show now. */
export function currentCursor(): string {
  if (override) return override;
  const t = E.tool as string;
  // a module may hold a cursor of its own while an operation runs (state.kicursor, e.g. WARNING over a collision)
  { const m0 = activeModule() as { state?: { kicursor?: string | null } } | null; const k = m0 && m0.state && m0.state.kicursor; if (k) return k; }
  if (t === "select") {
    const bs = E.boxSel as { start: number[]; cur: number[]; lasso: boolean } | null;
    if (bs) return bs.lasso || bs.cur[0] < bs.start[0] ? "SELECT_LASSO" : "SELECT_WINDOW";
    const m = activeModule() as CursorModule | null;
    if ((E.drag && E.drag.moved) || (E.fdrag && E.fdrag.moved)) return "MOVING";
    if (m && m.cursorNow) { try { const c = m.cursorNow(toolCtx()); if (c) return c; } catch (e) { console.warn(e); } }
    const mc = modifierCursor(mods.shift, mods.ctrl); if (mc) return mc;
    const st = m && m.state;
    if (st && st.autoCursor) return st.autoCursor;
    if ((st && st.hyperHover) || E.hyperHover) return "HAND";   // SCH_ITEM::HasHoveredHypertext (editor/hypertext.ts)
    if (stage.classList.contains("over-sel")) return "MOVING";
    if (E.selMode === "lasso") return "SELECT_LASSO";
    return "ARROW";
  }
  if (t === "zoomtool") return "ZOOM_IN";
  if (t === "measure") return "MEASURE";
  if (t === "pan") return "grab";
  if (t === "comment") return "cell";
  const m = activeModule() as (CursorModule & { tools?: { id: string; cursor?: string }[] }) | null;
  if (m && moduleTool(t)) {
    if (m.cursorNow) { try { const c = m.cursorNow(toolCtx()); if (c) return c; } catch (e) { console.warn(e); } }
    const def = m.tools && m.tools.find((x) => x.id === t);
    return def && def.cursor ? def.cursor : "PENCIL";
  }
  return "ARROW";
}

/** Put the current cursor on the canvas (cheap: called on every move, key and tool change). */
export function refreshCursor(): void {
  if (!stage) return;
  const css = toolCursor(currentCursor());
  if (stage.style.cursor !== css) stage.style.cursor = css;
}

if (typeof window !== "undefined") {
  const onKey = (ev: KeyboardEvent): void => { if (ev.key === "Shift" || ev.key === "Control" || ev.key === "Meta" || ev.key === "Alt") noteModifiers(ev); };
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);
  window.addEventListener("blur", () => { mods.shift = mods.ctrl = mods.alt = false; refreshCursor(); });
}
