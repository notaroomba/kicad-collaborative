// hotkeys.ts — KiCad's default hotkeys for the web editor.
//
// The key handling used to be a list of fixed keys in index.ts (F fit, S select, H pan, C comment, G grid,
// N snap, +/- zoom) in front of whatever the tool modules bound themselves, which shadowed KiCad's own
// meanings (F = Edit Footprint / Flip, H = hierarchical label, C = unfold bus, G = drag, N = next grid,
// S = add sheet, +/- = next / previous layer on a board).  Here the table is KiCad's: every TOOL_ACTION's
// default hotkey (web/menuspec.ts, generated from the action tables) resolves to whatever implements that
// action in the web — a chrome handler (editor/actions.ts HANDLERS), a tool-module action
// (CollabTools.<sch|pcb>.actions, by KiCad's id or its alias in tables.ts) or a tool (TOOL_MAP).
//
// Two entry points:
//   preemptKey(ev)     window capture phase, before the modules' own capture handlers: only the combinations
//                      where a module binds a key KiCad uses for something else (tables.ts KICAD_KEY_WINS);
//   runSpecHotkey(ev)  from index.ts's keydown handler after the module had its turn: the generic table.
// Nothing fires while the user types in a field, a dialog or an open menu (typingTarget).
import { hotkeyOwners, type EditorKind } from "../menuspec";
import { EDITOR_ONLY, FPEDIT_BLOCKED, FPEDIT_ONLY, KICAD_KEY_WINS, MODULE_ALIAS, toolFor } from "../tables";
import { HANDLERS } from "./actions";
import { state, store } from "./appstore";
import { E } from "./state";
import { activeModule, moduleTool, runModuleAction, setTool, toolCtx } from "./tools";
import { isSch } from "./view";

type Handler = import("./types").ActionHandler;
interface ToolModule { actions?: Record<string, unknown>; onKey?: (key: string, ev: unknown, ctx: unknown) => unknown }

const NAMED: Record<string, string> = { Delete: "Del", Escape: "Esc", " ": "Space", Insert: "Ins", PageUp: "PgUp", PageDown: "PgDn", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };

/** The event as a hotkey in the spec's notation: "Ctrl+Shift+Z", "F1", "Shift+Space", "'" (Cmd counts as Ctrl). */
export function comboOf(ev: KeyboardEvent): string {
  let k = ev.key;
  if (!k || k === "Control" || k === "Shift" || k === "Alt" || k === "Meta" || k === "Dead" || k === "Unidentified") return "";
  // Alt composes other characters on some layouts (Alt+3 → "#" / "£"): take the physical key for digits and letters
  if (ev.altKey && ev.code) { const m = /^(?:Key|Digit)(.)$/.exec(ev.code); if (m) k = m[1]; }
  k = NAMED[k] || k;
  const letter = k.length === 1 && /[a-z]/i.test(k);
  if (letter) k = k.toUpperCase();
  const printable = k.length === 1 && !letter && !/[0-9]/.test(k);   // "+", "~", "{": Shift is part of typing the character
  const mods: string[] = [];
  if (ev.ctrlKey || ev.metaKey) mods.push("Ctrl");
  if (ev.shiftKey && !printable) mods.push("Shift");
  if (ev.altKey) mods.push("Alt");
  return [...mods, k].join("+");
}

const NON_TEXT_INPUT = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color"]);

/** True while keys belong to something else: a text field, a KiCad dialog, an open menu or a modal. */
export function typingTarget(ev: KeyboardEvent): boolean {
  if (typeof document !== "undefined" && document.documentElement.dataset.symedit === "open") return true;   // the Symbol Editor frame owns the keyboard
  const t = ev.target as HTMLElement | null;
  if (t && t.tagName) {
    // a ticked checkbox / radio / button (Selection Filter, panel toggles) keeps only Space and Enter for itself
    if (t.tagName === "INPUT" && NON_TEXT_INPUT.has((t as HTMLInputElement).type)) { if (ev.key === " " || ev.key === "Enter") return true; }
    else if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable) return true;
    if (typeof t.closest === "function" && t.closest(".kd-overlay, [role='dialog'], [role='menu'], #popover")) return true;
  }
  const w = window as unknown as { KDialogs?: { isOpen?: () => boolean } };
  if (w.KDialogs && w.KDialogs.isOpen && w.KDialogs.isOpen()) return true;
  return document.body.dataset.menuOpen === "1";
}

const editorKind = (): EditorKind => (isSch() ? "sch" : "pcb");
/** The Footprint Editor runs on the board editor's tables: its own actions only there, the board's routing and zones never. */
const fpEditAllows = (id: string): boolean => (E.DOC_TYPE === "footprint" ? !FPEDIT_BLOCKED.has(id) : !FPEDIT_ONLY.has(id));

/** Run the web's implementation of one KiCad action; false when there is none (or the module declined it). */
export function runKicadAction(id: string): boolean {
  if (!fpEditAllows(id)) return false;
  const ed = editorKind(); const mod = activeModule() as ToolModule | null;
  const alias = MODULE_ALIAS[ed][id];
  if (alias && mod && mod.actions && mod.actions[alias]) return runModuleAction(alias) !== false;
  const h = (HANDLERS as Record<string, Handler>)[id];
  if (h && (!EDITOR_ONLY[id] || EDITOR_ONLY[id] === ed)) { h(null); return true; }
  if (mod && mod.actions && mod.actions[id]) return runModuleAction(id) !== false;
  const tid = toolFor(ed, id);
  if (tid && ((store.get().tool.appTools as string[]).includes(tid) || moduleTool(tid))) {
    if (E.viewOnly && moduleTool(tid) && tid !== "highlight") return false;
    setTool(tid); return true;
  }
  return false;
}

/** Whether a KiCad action has an implementation here (the hotkey list marks the rest as desktop-only). */
export function kicadActionAvailable(id: string): boolean {
  if (!fpEditAllows(id)) return false;
  const ed = editorKind(); const mod = activeModule() as ToolModule | null;
  const alias = MODULE_ALIAS[ed][id];
  if ((HANDLERS as Record<string, Handler>)[id] && (!EDITOR_ONLY[id] || EDITOR_ONLY[id] === ed)) return true;
  if (mod && mod.actions && (mod.actions[id] || (alias && mod.actions[alias]))) return true;
  const tid = toolFor(ed, id);
  return !!tid && ((store.get().tool.appTools as string[]).includes(tid) || !!moduleTool(tid));
}

/** The generic table: the first action KiCad binds to this key that the web implements. */
export function runSpecHotkey(ev: KeyboardEvent): boolean {
  if (!E.kdoc) return false;
  const combo = comboOf(ev); if (!combo) return false;
  for (const id of hotkeyOwners(editorKind(), combo)) if (runKicadAction(id)) return true;
  return false;
}

/** Capture-phase hook: KiCad's meaning for the keys the modules would otherwise take (tables.ts KICAD_KEY_WINS). */
export function preemptKey(ev: KeyboardEvent): void {
  if ((state as { view?: string }).view !== "editor" || !E.kdoc || typingTarget(ev)) return;
  const combo = comboOf(ev); if (!combo) return;
  if (E.tool === "measure" && combo === "Ctrl+C") return;   // the measure tool takes ACTIONS::copy itself (index.ts)
  const what = KICAD_KEY_WINS[editorKind()][combo]; if (!what) return;
  if (what === "spec") runSpecHotkey(ev);
  else if (what.startsWith("key:")) {
    const mod = activeModule() as ToolModule | null; const k = what.slice(4), shift = k.startsWith("Shift+");
    if (mod && mod.onKey) { try { mod.onKey(shift ? k.slice(6) : k, { shiftKey: shift, preventDefault() {} }, toolCtx(undefined)); } catch (e) { console.warn(e); } }
  }
  ev.preventDefault(); ev.stopImmediatePropagation();
}

if (typeof window !== "undefined") window.addEventListener("keydown", preemptKey, true);
