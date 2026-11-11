// menuspec.ts — every KiCad TOOL_ACTION (server/web/generated/kicad-menu-spec.json, produced by
// server/scripts/gen_kicad_menus.py from common/tool/actions.cpp, eeschema/tools/sch_actions.cpp and
// pcbnew/tools/pcb_actions.cpp): friendly name, tooltip, icon and the default hotkey of this platform (KiCad's
// macOS defaults on a Mac, the Linux / Windows ones elsewhere).  The toolbar spec (spec.ts) only keeps the actions a toolbar shows; the menus, the key handling and
// Help > List Hotkeys need all of them, looked up per editor because eeschema and pcbnew reuse short ids
// ("properties", "mirrorH", "highlightNet", …) for different actions.
import raw from "./generated/kicad-menu-spec.json";

export type EditorKind = "sch" | "pcb";
export interface MenuActionMeta { id: string; label: string; tip: string | null; icon: string | null; key: string | null; alt?: string }

/** KiCad gives a handful of actions another default on macOS (redo, the zoom keys, Add Filled Zone, Repeat Last Item). */
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");
const ACTIONS = (raw as unknown as { actions: Record<string, MenuActionMeta & { mac?: string }> }).actions;
if (IS_MAC) for (const a of Object.values(ACTIONS)) if (a.mac !== undefined) a.key = a.mac || null;
const CLASS: Record<EditorKind, string> = { sch: "SCH_ACTIONS", pcb: "PCB_ACTIONS" };

/** The action behind a short id in one editor: the editor's own table first, then the common one. */
export function menuMeta(editor: EditorKind | null, id: string): MenuActionMeta | null {
  if (editor) { const own = ACTIONS[`${CLASS[editor]}::${id}`]; if (own) return own; }
  return ACTIONS[`ACTIONS::${id}`] || (editor ? null : ACTIONS[`SCH_ACTIONS::${id}`] || ACTIONS[`PCB_ACTIONS::${id}`] || null);
}

export interface HotkeyRow { section: string; id: string; label: string; key: string; alt: string; tip: string }
/** Every action of an editor's frame in KiCad's hotkey-list order: the common section, then the editor's own. */
export function hotkeyRows(editor: EditorKind): HotkeyRow[] {
  const out: HotkeyRow[] = [];
  for (const [section, cls] of [["Common", "ACTIONS"], [editor === "sch" ? "Schematic Editor" : "PCB Editor", CLASS[editor]]] as const) {
    for (const [name, a] of Object.entries(ACTIONS)) if (name.startsWith(cls + "::")) out.push({ section, id: a.id, label: a.label, key: a.key || "", alt: a.alt || "", tip: a.tip || "" });
  }
  return out;
}

/** Normalise a hotkey in the spec's notation so two spellings compare equal ("Ctrl+Shift+Z"). */
export function normKey(key: string): string {
  const parts = key.split("+"); let k = parts.pop() || "";
  if (k === "" && key.endsWith("+")) { k = "+"; parts.pop(); }
  const mods = ["Ctrl", "Shift", "Alt"].filter((m) => parts.includes(m));
  return [...mods, k.length === 1 ? k.toUpperCase() : k].join("+");
}

const OWNERS: Partial<Record<EditorKind, Map<string, string[]>>> = {};
/** The ids of the actions whose default hotkey is `key` in an editor, the editor's own actions first. */
export function hotkeyOwners(editor: EditorKind, key: string): string[] {
  let m = OWNERS[editor];
  if (!m) {
    m = new Map();
    for (const cls of [CLASS[editor], "ACTIONS"]) for (const [name, a] of Object.entries(ACTIONS)) {
      if (!name.startsWith(cls + "::")) continue;
      for (const k of [a.key, a.alt]) { if (!k) continue; const nk = normKey(k); const l = m.get(nk); if (l) { if (!l.includes(a.id)) l.push(a.id); } else m.set(nk, [a.id]); }
    }
    OWNERS[editor] = m;
  }
  return m.get(normKey(key)) || [];
}
