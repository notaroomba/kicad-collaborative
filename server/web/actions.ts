// actions.ts — what a toolbar button or menu entry does here.  An action id is either a KiCad
// TOOL_ACTION (short id from the spec), one of our own entries (collabCopyLink, home, …), or a
// module action ("module:<id>" from CollabTools.<sch|pcb>.actions).  app.js publishes the ids
// it handles; a draw action maps to a web tool id (TOOL_MAP) that is available when app.js or
// the active module registers it.  Anything else keeps its place, dimmed, and explains that it
// runs in the desktop app.
import { useMemo } from "react";
import { actionMeta } from "./spec";
import { hotkeyOwners, menuMeta, normKey } from "./menuspec";
import { EDITOR_ONLY, EXTRA_TOOLS, LINKS, LOCAL_KEYS, LOCAL_LABELS, MODULE_ALIAS, PANE_ACTION, toolFor } from "./tables";
import { anchorOf, dispatch, useApp, type Editor, type ModuleAction, type ModuleTool } from "./store";
import { isPluginUiId, pluginUiKey, pluginUiLabel, runPluginUi } from "./plugins/host";

export interface Avail {
  editor: Editor | null;
  handled: Set<string>;
  appTools: Set<string>;
  moduleTools: Map<string, ModuleTool>;
  moduleActions: Map<string, ModuleAction>;
}

/** The availability tables, memoised on the store slices they derive from. */
export function useAvail(): Avail {
  const editor = useApp((s) => s.document.editor);
  const handled = useApp((s) => s.tool.handled);
  const appTools = useApp((s) => s.tool.appTools);
  const moduleTools = useApp((s) => s.tool.moduleTools);
  const moduleActions = useApp((s) => s.tool.moduleActions);
  return useMemo(() => ({
    editor, handled: new Set(handled), appTools: new Set(appTools),
    moduleTools: new Map(moduleTools.map((t) => [t.id, t])),
    moduleActions: new Map(moduleActions.map((a) => [a.id, a])),
  }), [editor, handled, appTools, moduleTools, moduleActions]);
}

export const isModuleAction = (id: string) => id.startsWith("module:");

/** Handled by the editor core in this editor (an id only one editor implements does not count in the other). */
function handledHere(a: Avail, id: string): boolean { return a.handled.has(id) && (!EDITOR_ONLY[id] || EDITOR_ONLY[id] === a.editor); }

/**
 * The module action behind an id: "module:<id>" explicitly, the module's own name for a KiCad action
 * (MODULE_ALIAS — it does more than the core's handler: tracks, groups, the module's own selection), or a KiCad
 * entry the active module backs under the same id.
 */
export function moduleActionFor(a: Avail, id: string): ModuleAction | undefined {
  if (isModuleAction(id)) return a.moduleActions.get(id.slice(7));
  const alias = a.editor ? MODULE_ALIAS[a.editor][id] : undefined;
  if (alias && a.moduleActions.has(alias)) return a.moduleActions.get(alias);
  return handledHere(a, id) ? undefined : a.moduleActions.get(id);
}

/** Why an action is dimmed; null when it works here. */
export function unavailable(a: Avail, id: string): string | null {
  if (handledHere(a, id) || LINKS[id] || isPluginUiId(id)) return null;   // a plugin entry is listed only while its plugin is enabled
  if (moduleActionFor(a, id)) return null;
  if (isModuleAction(id)) return "not available in the web editor yet";
  const tid = toolFor(a.editor, id);
  if (tid) return a.appTools.has(tid) || a.moduleTools.has(tid) ? null : "not available in the web editor yet";
  return "runs in the desktop app";
}

/** A key a module chose that KiCad binds to a different action in this editor is not that module entry's hotkey here. */
function ownKey(a: Avail, id: string, key: string | null | undefined): string {
  if (!key) return "";
  if (!a.editor) return key;
  const owners = hotkeyOwners(a.editor, normKey(key.replace(/^Delete$/, "Del").replace(/^Insert$/, "Ins")));
  return owners.length && !owners.includes(id) ? "" : key;
}

/** The hotkey shown beside an action: KiCad's default (what editor/hotkeys.ts binds), else the module's own key. */
export function keyFor(a: Avail, id: string): string {
  if (isPluginUiId(id)) return pluginUiKey(id);
  if (isModuleAction(id)) { const m = a.moduleActions.get(id.slice(7)); return m ? ownKey(a, id.slice(7), m.key) : ""; }
  const extra = EXTRA_TOOLS.find((e) => e.id === id); if (extra) return extra.key;
  const meta = menuMeta(a.editor, id);
  if (meta && meta.key) return meta.key;
  const ma = moduleActionFor(a, id);
  if (ma && ma.key) return ownKey(a, id, ma.key);
  const tid = toolFor(a.editor, id);
  const mt = tid ? a.moduleTools.get(tid) : undefined;
  return (mt && ownKey(a, id, mt.key)) || LOCAL_KEYS[id] || "";
}

export function labelFor(a: Avail, id: string): string {
  if (isPluginUiId(id)) return pluginUiLabel(id) || id;
  if (isModuleAction(id)) return (a.moduleActions.get(id.slice(7))?.label || LOCAL_LABELS[id.slice(7)] || id.slice(7)).replace(/…/g, "...");
  if (LOCAL_LABELS[id]) return LOCAL_LABELS[id];
  const m = menuMeta(a.editor, id) || actionMeta(id);
  if (m) return m.label;
  return (moduleActionFor(a, id)?.label || id).replace(/…/g, "...");
}

/** KiCad's icon for an action (null for our own entries and module-only commands). */
export function iconFor(a: Avail, id: string): string | null {
  if (isModuleAction(id)) return null;
  const m = menuMeta(a.editor, id) || actionMeta(id);
  return m && m.icon && m.icon !== "INVALID_BITMAP" ? m.icon : null;
}

export function titleFor(a: Avail, id: string): string {
  const m = menuMeta(a.editor, id) || actionMeta(id); const k = keyFor(a, id);
  let t = (m ? m.label : labelFor(a, id)) + (k ? `  (${k})` : "");
  if (m && m.tip && m.tip !== m.label) t += "\n" + m.tip;
  const why = unavailable(a, id);
  if (why) t += "\n— " + why;
  return t;
}

/** Whether a checkable action is "on": pane toggles read the pane state, everything else app.js's toggles. */
export function isOn(id: string, toggles: Record<string, boolean>, panes: Record<string, boolean>): boolean {
  for (const [pane, act] of Object.entries(PANE_ACTION)) if (act === id) return !!panes[pane];
  if (id === "showAppearance") return !!panes.appearance;
  return !!toggles[id];
}

/** Run an action from a click: handled → app.js; a tool → activate it; otherwise explain the desktop. */
export function runUiAction(a: Avail, id: string, el?: Element | null): void {
  if (isPluginUiId(id)) { runPluginUi(id); return; }
  const anchor = anchorOf(el);
  if (isModuleAction(id)) { dispatch({ type: "action", id, anchor }); return; }
  const ma = moduleActionFor(a, id);
  if (ma) { dispatch({ type: "action", id: "module:" + ma.id, anchor }); return; }
  if (handledHere(a, id)) { dispatch({ type: "action", id, anchor }); return; }
  const tid = toolFor(a.editor, id);
  if (tid && (a.appTools.has(tid) || a.moduleTools.has(tid))) { dispatch({ type: "setTool", tool: tid }); return; }
  if (LINKS[id]) { window.open(LINKS[id], "_blank"); return; }
  dispatch({ type: "popover", popover: { kind: "desktop", title: labelFor(a, id).replace(/\.\.\.$/, ""), why: tid ? "This tool isn't in the web editor yet." : "This runs in the desktop app.", anchor } });
}
