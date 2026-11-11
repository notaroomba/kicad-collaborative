// index.ts — vendor parts in the web editor (bundled to static/dist/parts.js).
//
// Loaded after the tool modules and before the editor, it
//   * publishes window.KiCadParts (open the dialog, place a part by reference),
//   * adds "Add Part from Vendor…" and "Part Libraries…" to the schematic and board Tools
//     menus, through the modules' own action tables so the menus need no change,
//   * and offers the vendors as a source to the editor's symbol and footprint choosers
//     (window.KiCadLibrary) when that module is present.
import { api, type Part } from "./api";
import { placePart } from "./place";
import { closeParts, isOpen, openParts, setCtxSource } from "./ui";

interface LibrarySource {
  id: string; label: string; kinds: ("symbol" | "footprint")[];
  search(query: string, kind: "symbol" | "footprint"): Promise<{ id: string; name: string; description?: string; keywords?: string; library?: string }[]>;
  fetch(item: { id: string }, kind: "symbol" | "footprint"): Promise<Record<string, unknown>>;
}
const W = window as unknown as {
  CollabTools?: CollabToolsApi; KiCadLibrary?: { registerSource?(s: LibrarySource): void };
  KiCadParts?: unknown;
};

let lastCtx: ToolCtx | null = null;
setCtxSource(() => lastCtx);

function installActions(): void {
  const tools = W.CollabTools; if (!tools) return;
  for (const m of [tools.sch, tools.pcb] as (ToolModule | undefined)[]) {
    if (!m) continue;
    if (m.actions && m.actions.vendorParts) continue;
    // a module may publish a frozen table: extend a copy rather than the table itself
    try {
      m.actions = {
        ...(m.actions || {}),
        vendorParts: { label: "Add Part from Vendor…", key: null, menu: "Tools", run(ctx: ToolCtx) { lastCtx = ctx; openParts({ ctx }); } },
        vendorBom: { label: "Bill of Materials with Vendor Prices…", key: null, menu: "Tools", run(ctx: ToolCtx) { lastCtx = ctx; openParts({ ctx, tab: "bom" }); } },
        vendorLibraries: { label: "Part Libraries…", key: null, menu: "Tools", run(ctx: ToolCtx) { lastCtx = ctx; openParts({ ctx, tab: "libraries" }); } },
      };
    } catch (e) { console.warn("vendor parts: could not add the menu entries", e); }
  }
}

/** Vendor search inside the editor's own Choose Symbol / Choose Footprint dialogs. */
function registerSource(): boolean {
  const lib = W.KiCadLibrary; if (!lib || !lib.registerSource) return false;
  const split = (id: string): [string, string] => { const i = id.indexOf(":"); return [id.slice(0, i), id.slice(i + 1)]; };
  lib.registerSource({
    id: "vendors", label: "Vendors (LCSC, Mouser, DigiKey)", kinds: ["symbol", "footprint"],
    async search(query) {
      if (query.trim().length < 2) return [];
      const r = await api.search(query.trim(), "all");
      return r.results.map((p) => ({ id: `${p.vendor}:${p.vendor_id}`, name: p.mpn || p.vendor_id, description: [p.manufacturer, p.description].filter(Boolean).join(" — "), keywords: `${p.vendor_id} ${p.package}`, library: p.vendor_name }));
    },
    async fetch(item, kind) {
      const [vendor, id] = split(item.id); const p = await api.part(vendor, id);
      const fields = { ...p.fields, ...(p.datasheet ? { Datasheet: p.datasheet } : {}) };
      if (!p.cad || (kind === "symbol" ? !p.cad.symbol : !p.cad.footprint)) throw new Error(`No ${kind} is available for ${p.mpn || id}.`);
      return kind === "symbol"
        ? { libId: p.cad.symbol!.lib_id, symbol: p.cad.symbol!.sexpr, fields: { Value: p.mpn || p.cad.symbol!.name, Footprint: p.cad.footprint ? p.cad.footprint.fpid : "", ...fields } }
        : { fpid: p.cad.footprint!.fpid, footprint: p.cad.footprint!.sexpr, fields: { Value: p.mpn || p.cad.footprint!.name, ...fields } };
    },
  });
  return true;
}

W.KiCadParts = {
  /** Open the dialog.  `ctx` is the editor's tool context; without one the dialog browses and manages libraries only. */
  open(opts?: { ctx?: ToolCtx; tab?: "search" | "libraries" | "keys" | "bom"; query?: string }) { if (opts && opts.ctx) lastCtx = opts.ctx; openParts(opts || {}); },
  close: closeParts,
  isOpen,
  /** Fetch a part by reference and put it on the cursor: the same thing the dialog's Place button does. */
  async place(ctx: ToolCtx, vendor: string, id: string, lib?: string): Promise<boolean> { const p: Part = await api.part(vendor, id, { lib }); return placePart(ctx, p); },
  api,
};

installActions();
if (!registerSource()) {
  // the library module may load after this script
  let tries = 0; const t = setInterval(() => { if (registerSource() || ++tries > 40) clearInterval(t); }, 250);
}
document.addEventListener("DOMContentLoaded", installActions);
