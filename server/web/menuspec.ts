// menuspec.ts — every KiCad TOOL_ACTION (server/web/generated/kicad-menu-spec.json, produced by
// server/scripts/gen_kicad_menus.py from common/tool/actions.cpp, eeschema/tools/sch_actions.cpp and
// pcbnew/tools/pcb_actions.cpp): friendly name, tooltip, icon and the default hotkey of this platform (KiCad's
// macOS defaults on a Mac, the Linux / Windows ones elsewhere).  The toolbar spec (spec.ts) only keeps the actions a toolbar shows; the menus, the key handling and
// Help > List Hotkeys need all of them, looked up per editor because eeschema and pcbnew reuse short ids
// ("properties", "mirrorH", "highlightNet", …) for different actions.
import bundled from "./generated/kicad-menu-spec.json";
import { IS_MAC } from "./keys";

// One copy of the table on the app page: editor.js (loaded first) carries it and publishes it; ui.js is built
// with MENU_SPEC_SHARED=true (package.json), which drops its own copy and reads the published one.
declare const MENU_SPEC_SHARED: boolean;
const G = globalThis as { KiCadMenuSpec?: unknown };
const raw = typeof MENU_SPEC_SHARED !== "undefined" && MENU_SPEC_SHARED ? G.KiCadMenuSpec || { actions: {} } : (G.KiCadMenuSpec = bundled);

export type EditorKind = "sch" | "pcb";
export interface MenuActionMeta { id: string; label: string; tip: string | null; icon: string | null; key: string | null; alt?: string; name?: string; defKey?: string | null; defAlt?: string }

/** KiCad gives a handful of actions another default on macOS (redo, the zoom keys, Add Filled Zone, Repeat Last Item). */
export { IS_MAC };
const ACTIONS = (raw as unknown as { actions: Record<string, MenuActionMeta & { mac?: string }> }).actions;
if (IS_MAC) for (const a of Object.values(ACTIONS)) if (a.mac !== undefined && a.defKey === undefined) a.key = a.mac || null;
const CLASS: Record<EditorKind, string> = { sch: "SCH_ACTIONS", pcb: "PCB_ACTIONS" };

// ---------------------------------------------------------------- the user's hotkeys (user.hotkeys)
// Preferences > Hotkeys edits each action's hotkey and alternate; KiCad writes them to user.hotkeys and every
// TOOL_ACTION reads them back (ReadHotKeyConfigIntoActions).  Here they are kept per viewer in browser storage,
// keyed by the action's table name ("SCH_ACTIONS::placeSymbol"), and laid over the defaults on load.
export type UserHotkeys = Record<string, [string, string]>;
const HOTKEYS_STORE = "kui.hotkeys";
for (const a of Object.values(ACTIONS)) if (a.defKey === undefined) { a.defKey = a.key; a.defAlt = a.alt || ""; }
/** The stored hotkeys ({} when none, or storage is unavailable). */
export function loadUserHotkeys(): UserHotkeys {
  try { const v = JSON.parse((typeof localStorage !== "undefined" && localStorage.getItem(HOTKEYS_STORE)) || "{}"); return v && typeof v === "object" ? v as UserHotkeys : {}; } catch (e) { return {}; }
}
/** Lay `user` over the defaults: an action not named keeps its default hotkey and alternate. */
export function applyUserHotkeys(user: UserHotkeys): void {
  for (const [name, a] of Object.entries(ACTIONS)) {
    const o = user[name];
    a.key = o ? o[0] || null : a.defKey ?? null;
    a.alt = o ? o[1] || "" : a.defAlt || "";
  }
  for (const k of Object.keys(OWNERS) as EditorKind[]) delete OWNERS[k];
  TOUCHED = null;
}
/** Save the hotkeys (only those that differ from the defaults are kept) and use them from now on. */
export function saveUserHotkeys(user: UserHotkeys): void {
  const out: UserHotkeys = {};
  for (const [name, v] of Object.entries(user)) { const a = ACTIONS[name]; if (!a) continue; if ((v[0] || "") !== (a.defKey || "") || (v[1] || "") !== (a.defAlt || "")) out[name] = [v[0] || "", v[1] || ""]; }
  try { if (typeof localStorage !== "undefined") { if (Object.keys(out).length) localStorage.setItem(HOTKEYS_STORE, JSON.stringify(out)); else localStorage.removeItem(HOTKEYS_STORE); } } catch (e) { /* no storage: the change lasts for this page */ }
  applyUserHotkeys(out);
}
/** Every action of the table with its current and default keys, by table name. */
export function allHotkeyActions(): [string, MenuActionMeta][] { return Object.entries(ACTIONS); }
let TOUCHED: Set<string> | null = null;
/** The keys the user's hotkeys move: assigned to an action that did not have them, or taken off one that did. */
export function userTouchedKey(key: string): boolean {
  if (!TOUCHED) {
    TOUCHED = new Set();
    for (const a of Object.values(ACTIONS)) {
      const now = [a.key || "", a.alt || ""].filter(Boolean).map(normKey), was = [a.defKey || "", a.defAlt || ""].filter(Boolean).map(normKey);
      for (const k of now) if (!was.includes(k)) TOUCHED.add(k);
      for (const k of was) if (!now.includes(k)) TOUCHED.add(k);
    }
  }
  return TOUCHED.has(normKey(key));
}

/** The action behind a short id in one editor: the editor's own table first, then the common one. */
export function menuMeta(editor: EditorKind | null, id: string): MenuActionMeta | null {
  if (editor) { const own = ACTIONS[`${CLASS[editor]}::${id}`]; if (own) return own; }
  return ACTIONS[`ACTIONS::${id}`] || (editor ? null : ACTIONS[`SCH_ACTIONS::${id}`] || ACTIONS[`PCB_ACTIONS::${id}`] || null);
}

export interface HotkeyRow { section: string; id: string; label: string; key: string; alt: string; tip: string; name?: string }
/** Every action of an editor's frame in KiCad's hotkey-list order: the common section, then the editor's own. */
export function hotkeyRows(editor: EditorKind): HotkeyRow[] {
  const out: HotkeyRow[] = [];
  for (const [section, cls] of [["Common", "ACTIONS"], [editor === "sch" ? "Schematic Editor" : "PCB Editor", CLASS[editor]]] as const) {
    for (const [name, a] of Object.entries(ACTIONS)) if (name.startsWith(cls + "::")) out.push({ section, id: a.id, label: a.label, key: a.key || "", alt: a.alt || "", tip: a.tip || "", name });
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
applyUserHotkeys(loadUserHotkeys());
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
