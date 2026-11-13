// pcbtools-loader.ts — the board tools arrive when a board does.
//
// static/pcb-tools.js (the board editor's tools, DRC and router) and static/dist/autoroute.js are a third of what
// the page used to download and run before anything could be shown, and a schematic needs none of it.  They are
// fetched and run here instead: before the first board or footprint is drawn (doc.ts openDoc; boot.ts has started
// the download by then when the page opens on a board), or once a schematic is on screen and the browser is idle,
// so that going over to the board afterwards waits for nothing.
import type { Boot } from "./boot";
import { BOARD_HINT } from "./bootpick";
import { E } from "./state";

let wired: Promise<void> | null = null;

/** The page's one loader of the two scripts (boot.ts), which may have started them already. */
function load(): Promise<void> {
  const boot = (window as unknown as { __kcBoot?: Boot }).__kcBoot;
  return boot && boot.pcbTools ? boot.pcbTools() : Promise.reject(new Error("the page has no loader for the board tools"));
}

/** Load the board tools (once) and wire them into the editor the way the page's own start-up used to. */
export function ensurePcbTools(): Promise<void> {
  if (!wired) {
    wired = load().then(() => {
      // the project file may have arrived first: the rules it carries are the board tools' to keep (doc.ts rootSchematic)
      const pcb = CollabTools.pcb as (PcbToolModule & { setDesignSettings?(src: unknown): void }) | undefined;
      if (E.proSettings && pcb && pcb.setDesignSettings) { try { pcb.setDesignSettings(E.proSettings); } catch (e) { /* module without rules */ } }
      // whoever adds to the board tools does it now: the editor's dialogs (pcbdialogs/index.ts), the vendor parts menu (web/parts).
      // An event, not an import: this module is imported by doc.ts and must not pull the dialogs in ahead of their own imports.
      window.dispatchEvent(new CustomEvent("kc-pcb-tools"));
    }).catch((e) => { wired = null; throw e; });   // a failed download is tried again by the next board
  }
  return wired;
}

/** With a schematic on screen: bring the board tools in when the browser has nothing better to do. */
export function preloadPcbToolsWhenIdle(): void {
  if (wired) return;
  const go = () => { ensurePcbTools().catch(() => { /* the next board asks again */ }); };
  const ric = (window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  if (ric) ric(go, { timeout: 3000 }); else setTimeout(go, 800);
}

/**
 * Remember that this document is a board (and, when it is what its project opens on, the project): the page's
 * loader then starts the board tools the moment such a page arrives, before the server has said what it opens on.
 */
export function noteBoardOpened(docId: string, projectId: string | null): void {
  try {
    const ids = (localStorage.getItem(BOARD_HINT) || "").split(" ").filter(Boolean);
    for (const id of [docId, projectId]) { if (!id) continue; const at = ids.indexOf(id); if (at >= 0) ids.splice(at, 1); ids.push(id); }
    localStorage.setItem(BOARD_HINT, ids.slice(-60).join(" "));
  } catch (e) { /* storage unavailable: the server's answer still starts the download */ }
}
