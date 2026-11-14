// dialogs/browse-cells.ts — the browse buttons of KiCad's text cell editors (common/widgets/grid_text_button_helpers.cpp
// and common/properties/pg_editors.cpp), for the fields grids and the Properties panel:
//
//   GRID_CELL_FPID_EDITOR / PG_FPID_EDITOR   BITMAPS::small_library; opens FOOTPRINT_CHOOSER_FRAME with the symbol's
//                                            pin count and footprint filters (SelectFootprintFromChooser) on the cell's
//                                            footprint, and an accepted choice ("Lib:Name") is the cell's new value,
//                                            committed at once (WX_GRID::CommitPendingChanges)
//   GRID_CELL_URL_EDITOR / PG_URL_EDITOR     BITMAPS::small_folder while the cell is empty, BITMAPS::www once it holds
//                                            something; with a value, GetAssociatedDocument opens it (a web or mail link
//                                            in a new tab), and with none KiCad's file dialog would pick a local file,
//                                            which a web page cannot browse to
import type { GridCellButton } from "./dom";
import type { FpChooserFilters } from "../library/fpchoice";
import { datasheetLink } from "../library/fpchoice";
import { messageBox } from "./sch-items";

interface LibApi { openChooser(kind: "footprint", opts?: { title?: string; preselect?: string; fpFilters?: FpChooserFilters | null; noSources?: boolean; history?: boolean }): Promise<{ fpid?: string; item?: { id: string } } | null> }
const libApi = (): LibApi | null => (window as unknown as { KiCadLibrary?: LibApi }).KiCadLibrary || null;

let busy = false;   // m_buttonFpChooserLock: a second click while the chooser is loading does nothing
/** SelectFootprintFromChooser: the chooser on `current`, filtered by the symbol's netlist; the chosen "Lib:Name" or null. */
export async function chooseFootprint(current: string, filters: FpChooserFilters | null): Promise<string | null> {
  const L = libApi(); if (!L || busy) return null;
  busy = true;
  try {
    const got = await L.openChooser("footprint", { title: "Footprint Chooser", preselect: current.trim(), fpFilters: filters, noSources: true, history: true });
    return got ? got.fpid || (got.item && got.item.id) || null : null;
  } finally { busy = false; }
}

/** GetAssociatedDocument for a Datasheet value: a link opens in a new tab; anything else is reported. */
export function openDatasheet(value: string): void {
  const d = datasheetLink(value);
  if (d.kind === "url") { window.open(d.url, "_blank", "noopener,noreferrer"); return; }
  if (d.kind === "other") void messageBox(`Documentation file '${d.url}' not found.`);
}

/** In place of KiCad's "Open file" dialog for an empty Datasheet: a web page cannot browse the computer's files, so the
 *  value is a typed link. */
export function noFileBrowsing(where: "cell" | "property"): Promise<void> {
  return messageBox(`Local files cannot be browsed from the web editor.\nType the datasheet's web address (https://…) into the ${where}.`, "Open file");
}

/** The URL editor's bitmap (UpdateButtonBitmaps / PG_URL_EDITOR::CreateControls). */
export const urlIcon = (value: string): string => (datasheetLink(value).kind === "none" ? "small_folder" : "www");
/** The button's tooltip: FIELDS_GRID_TRICKS' "Select Footprint..." / "Show Datasheet" help strings. */
export const FP_BROWSE_TIP = "Browse for footprint";
export const urlTip = (value: string): string => (datasheetLink(value).kind === "none" ? "Open file" : "Show datasheet in browser");

/** A fields grid cell's footprint browse button. */
export function footprintButton(filters: () => FpChooserFilters | null): GridCellButton {
  return {
    icon: () => "small_library", title: () => FP_BROWSE_TIP,
    run(value, set) { void chooseFootprint(value, filters()).then((fp) => { if (fp) set(fp); }); },
  };
}
/** A fields grid cell's datasheet button. */
export function datasheetButton(): GridCellButton {
  return {
    icon: urlIcon, title: urlTip,
    run(value, _set, input) {
      if (datasheetLink(value).kind !== "none") { openDatasheet(value); return; }
      void noFileBrowsing("cell").then(() => { if (input) input.focus(); });
    },
  };
}
