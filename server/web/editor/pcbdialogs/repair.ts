// pcbdialogs/repair — Tools > Repair Board (BOARD_EDITOR_CONTROL::RepairBoard): duplicate ids get new ones as one
// "Repair Board" step, then DisplayInfoMessage says what was found ("Information").
import { E } from "../state";
import { messageBox } from "./ui";

interface PcbToolsApi { repairBoard(doc: KDoc): { changes: KChange[]; duplicates: number; details: string[] } }
const PT = (): PcbToolsApi => (window as unknown as { PcbTools: PcbToolsApi }).PcbTools;

export function repairBoard(ctx: ToolCtx): void {
  const doc = E.kdoc as KDoc | null;
  if (!doc || doc.type !== "pcb") { ctx.toast("Repair Board needs a board"); return; }
  if (E.viewOnly) { ctx.toast("This board is read-only"); return; }
  const r = PT().repairBoard(doc);
  if (r.changes.length) { ctx.commit(r.changes, "Repair Board"); ctx.requestRender(); }
  if (r.duplicates) messageBox("Information", `${r.duplicates} potential problems repaired.\n\n${r.details.join("\n")}`);
  else messageBox("Information", "No board problems found.");
}
