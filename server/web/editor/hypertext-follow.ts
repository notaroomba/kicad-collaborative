// hypertext-follow.ts — SCH_NAVIGATE_TOOL::HypertextCommand: what a click on a schematic hyperlink does (hypertext.ts).
import { openPopupMenu } from "./contextmenu";
import { navigateDocs, openDoc, rootSchematic, sheetPages } from "./doc";
import { state } from "./appstore";
import { gotoPageOf } from "./hypertext";
import { E } from "./state";
import { toast } from "./util";

/** SCH_NAVIGATE_TOOL::HypertextCommand. */
export function followHypertext(href: string, at: { clientX: number; clientY: number }): void {
  if (href === "HYPERTEXT_BACK") { navigateDocs(-1); return; }
  const dest = gotoPageOf(href);
  if (dest !== null) {
    if (!dest) return;
    const root = rootSchematic();
    const rootPage = root && state.doc === root && E.kdoc && E.kdoc.pageNumber ? String(E.kdoc.pageNumber) : "1";
    if (root && dest === rootPage) { if (state.doc !== root) openDoc(root); return; }
    for (const [path, page] of sheetPages) {
      if (page !== dest) continue;
      const d = state.docs && state.docs.find((x) => x.docType === "kicad_sch" && x.path === path);
      if (d) { if (state.doc !== d) openDoc(d); return; }
    }
    toast(`Page '${dest}' not found.`);
    return;
  }
  // GetAssociatedDocument opens web and mail links; a link of any other scheme (javascript:, data: …) is not followed
  const web = /^(https?|ftp|mailto):/i.test(href);
  openPopupMenu(at.clientX, at.clientY, [{ label: `Open ${href}`, disabled: !web, tip: "Only web and mail links open in the browser",
    run: () => { window.open(href, "_blank", "noopener,noreferrer"); } }]);
}
