// actions.ts — what a toolbar button or menu entry does here.  An action id is either a KiCad
// TOOL_ACTION (short id from the spec), one of our own entries (collabCopyLink, home, …), or a
// module action ("module:<id>" from CollabTools.<sch|pcb>.actions).  app.js publishes the ids
// it handles; a draw action maps to a web tool id (TOOL_MAP) that is available when app.js or
// the active module registers it.  Anything else keeps its place, dimmed, and explains that it
// runs in the desktop app.
import { useMemo } from "react";
import { actionMeta } from "./spec";
import { LINKS, LOCAL_KEYS, LOCAL_LABELS, PANE_ACTION, toolFor } from "./tables";
import { anchorOf, dispatch, useApp, type Editor, type ModuleAction, type ModuleTool } from "./store";

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

/** The module action behind an id: "module:<id>" explicitly, or a KiCad entry the active module backs (same id). */
export function moduleActionFor(a: Avail, id: string): ModuleAction | undefined {
  if (isModuleAction(id)) return a.moduleActions.get(id.slice(7));
  return a.handled.has(id) ? undefined : a.moduleActions.get(id);
}

/** Why an action is dimmed; null when it works here. */
export function unavailable(a: Avail, id: string): string | null {
  if (a.handled.has(id) || LINKS[id]) return null;
  if (moduleActionFor(a, id)) return null;
  if (isModuleAction(id)) return "not available in the web editor yet";
  const tid = toolFor(a.editor, id);
  if (tid) return a.appTools.has(tid) || a.moduleTools.has(tid) ? null : "not available in the web editor yet";
  return "runs in the desktop app";
}

export function keyFor(a: Avail, id: string): string {
  const ma = moduleActionFor(a, id);
  if (ma) return ma.key || (isModuleAction(id) ? "" : actionMeta(id)?.key || "");
  const tid = toolFor(a.editor, id);
  const mt = tid ? a.moduleTools.get(tid) : undefined;
  return (mt && mt.key) || actionMeta(id)?.key || LOCAL_KEYS[id] || "";
}

export function labelFor(a: Avail, id: string): string {
  if (isModuleAction(id)) return a.moduleActions.get(id.slice(7))?.label || id.slice(7);
  if (LOCAL_LABELS[id]) return LOCAL_LABELS[id];
  const m = actionMeta(id);
  return m ? m.label.replace(/\.\.\.$/, "…") : id;
}

export function titleFor(a: Avail, id: string): string {
  const m = actionMeta(id); const k = keyFor(a, id);
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
  const anchor = anchorOf(el);
  if (a.handled.has(id) || isModuleAction(id)) { dispatch({ type: "action", id, anchor }); return; }
  if (moduleActionFor(a, id)) { dispatch({ type: "action", id: "module:" + id, anchor }); return; }
  const tid = toolFor(a.editor, id);
  if (tid && (a.appTools.has(tid) || a.moduleTools.has(tid))) { dispatch({ type: "setTool", tool: tid }); return; }
  if (LINKS[id]) { window.open(LINKS[id], "_blank"); return; }
  dispatch({ type: "popover", popover: { kind: "desktop", title: labelFor(a, id), why: tid ? "This tool isn't in the web editor yet." : "This runs in the desktop app.", anchor } });
}
