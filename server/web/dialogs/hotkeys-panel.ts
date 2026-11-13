// dialogs/hotkeys-panel.ts — Preferences > Common > Hotkeys: PANEL_HOTKEYS_EDITOR over WIDGET_HOTKEY_LIST.
// A "Type filter text" box, then a tree of sections (HOTKEY_STORE: one per application prefix of the action's name —
// Common, Schematic Editor, PCB Editor — and Gestures) with the Command / Hotkey / Alternate / Description columns.
// A double-click edits the hotkey (HK_PROMPT_DIALOG "Set Hotkey"); the right-click menu has Edit..., Edit
// Alternate..., Undo Changes, Clear Assigned Hotkey, Clear Assigned Alternate and Restore Defaults; a changed row
// shows " *" after its command.  Under the list: Undo All Changes and Import Hotkeys....  OK saves (menuspec.ts
// saveUserHotkeys); the paged dialog's Reset to Defaults puts every hotkey back to its default.
import { trapTab } from "../tools/kicad-dialogs/shell";
import { keyName } from "../keys";
import { allHotkeyActions, normKey, saveUserHotkeys, type UserHotkeys } from "../menuspec";
import { h, popupMenu } from "./dom";
import { messageBox } from "../editor/pcbdialogs/ui";

export interface HotkeyEntry {
  /** the table name ("SCH_ACTIONS::placeSymbol"); "" for the read-only commands and gestures */
  name: string; section: string; label: string; tip: string;
  key: string; alt: string;
  /** the hotkeys in use when the dialog opened (Undo Changes) and KiCad's defaults (Restore Defaults) */
  origKey: string; origAlt: string; defKey: string; defAlt: string;
  /** the action's TOOL_ACTION name ("eeschema.InteractiveDrawing.placeSymbol"), as a user.hotkeys file names it */
  toolName: string;
}
export interface HotkeySection { name: string; rows: HotkeyEntry[] }

const APP_SECTIONS: Record<string, string> = { common: "Common", kicad: "Project Manager", eeschema: "Schematic Editor", pcbnew: "PCB Editor", plEditor: "Drawing Sheet Editor", "3DViewer": "3D Viewer", gerbview: "Gerber Viewer" };
const APP_OF_CLASS: Record<string, string> = { ACTIONS: "common", SCH_ACTIONS: "eeschema", PCB_ACTIONS: "pcbnew" };
/** HOTKEY_STORE::GetSectionName. */
export function sectionName(toolName: string): string { const app = toolName.split(".")[0]; return APP_SECTIONS[app] || app; }

const pseudo = (label: string, key: string, alt = ""): HotkeyEntry => ({ name: "", section: "", label, tip: "", key, alt, origKey: key, origAlt: alt, defKey: key, defAlt: alt, toolName: "" });
/** g_standardPlatformCommands (Close is not one on Windows) and g_gesturePseudoActions. */
const isWindows = (): boolean => typeof navigator !== "undefined" && /Win/i.test(navigator.platform || navigator.userAgent || "");
export const PLATFORM_COMMANDS = (): HotkeyEntry[] => [...(isWindows() ? [] : [pseudo("Close", "Ctrl+W")]), pseudo("Quit", "Ctrl+Q")];
export const GESTURES = (): HotkeyEntry[] => [pseudo("Accept Autocomplete", "Return", "Num Pad Enter"), pseudo("Cancel Autocomplete", "Esc"), pseudo("Toggle Checkbox", "Space"),
  pseudo("Pan Left/Right", "Ctrl+Wheel"), pseudo("Pan Up/Down", "Shift+Wheel"), pseudo("Finish Drawing", "DblClick"), pseudo("Add to Selection", "Shift+Click"),
  pseudo("Highlight Net", "Ctrl+Click"), pseudo("Remove from Selection", "Ctrl+Shift+Click"), pseudo("Ignore Grid Snaps", "Ctrl+"), pseudo("Ignore Other Snaps", "Shift+")];

/**
 * HOTKEY_STORE::Init( actions, true ): the actions sorted by their TOOL_ACTION name, a section per application
 * prefix (the platform commands open Common), then Gestures.
 */
export function hotkeySections(): HotkeySection[] {
  const entries: HotkeyEntry[] = [];
  for (const [name, a] of allHotkeyActions()) {
    if (!a.label) continue;
    const cls = name.split("::")[0], toolName = a.name || `${APP_OF_CLASS[cls] || "common"}.${a.id}`;
    entries.push({ name, section: sectionName(toolName), label: a.label, tip: a.tip || "", key: a.key || "", alt: a.alt || "", origKey: a.key || "", origAlt: a.alt || "", defKey: a.defKey || "", defAlt: a.defAlt || "", toolName });
  }
  entries.sort((x, y) => (x.toolName < y.toolName ? -1 : x.toolName > y.toolName ? 1 : 0));
  const out: HotkeySection[] = [];
  let cur: HotkeySection | null = null, app = "";
  for (const e of entries) {
    const a = e.toolName.split(".")[0];
    if (!cur || a !== app) { app = a; cur = { name: e.section, rows: a === "common" ? PLATFORM_COMMANDS() : [] }; out.push(cur); }
    cur.rows.push(e);
  }
  out.push({ name: "Gestures", rows: GESTURES() });
  return out;
}

/** The command column: the label without its ellipsis, " *" while the hotkey differs from the one in use (updateFromClientData). */
export function commandText(e: HotkeyEntry): string { return e.label.replace(/\.\.\.|…/g, "") + (e.key !== e.origKey ? " *" : ""); }
/** HOTKEY_FILTER::FilterMatches: the command's name or the hotkey's name contains the filter (any case). */
export function filterMatches(e: HotkeyEntry, filter: string): boolean {
  const f = filter.trim().toUpperCase(); if (!f) return true;
  return e.label.toUpperCase().includes(f) || hotkeyText(e.key).toUpperCase().includes(f);
}
/** KeyNameFromKeyCode in this platform's names ("Ctrl+" is a modifier on its own). */
export function hotkeyText(key: string): string { if (!key) return ""; return key.endsWith("+") && key.length > 1 && !key.endsWith("++") ? keyName(key.slice(0, -1)) + "+" : keyName(key); }
/** WIDGET_HOTKEY_LIST's reserved keys. */
export const RESERVED = ["Ctrl+Tab", "Ctrl+Shift+Tab"];
/** HOTKEY_STORE::CheckKeyConflicts: another action of the same section, or of Common (Common against every section). */
export function keyConflict(sections: HotkeySection[], entry: HotkeyEntry, key: string): HotkeyEntry | null {
  const k = normKey(key);
  for (const s of sections) {
    if (!(s.name === entry.section || s.name === "Common")) continue;
    for (const e of s.rows) { if (e === entry || !e.name) continue; if ((e.key && normKey(e.key) === k) || (e.alt && normKey(e.alt) === k)) return e; }
  }
  return null;
}
/** ReadHotKeyConfig: "action.name<TAB>primary<TAB>secondary" lines. */
export function parseHotkeyFile(text: string): Map<string, [string, string]> {
  const out = new Map<string, [string, string]>();
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) { const t = line.split("\t"); if (t[0]) out.set(t[0], [t[1] || "", t[2] || ""]); }
  return out;
}
/** The user's hotkeys the panel stands for, by table name. */
export function userHotkeysOf(sections: HotkeySection[]): UserHotkeys {
  const out: UserHotkeys = {};
  for (const s of sections) for (const e of s.rows) if (e.name) out[e.name] = [e.key, e.alt];
  return out;
}

/** The event as a hotkey ("Ctrl+Shift+Z", "Del", "F5"), or null for a modifier on its own (MapKeypressToKeycode). */
export function keyOfEvent(ev: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): string | null {
  const NAMED: Record<string, string> = { Delete: "Del", Escape: "Esc", " ": "Space", Insert: "Ins", PageUp: "PgUp", PageDown: "PgDn", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Enter: "Return", Backspace: "Back" };
  let k = ev.key;
  if (!k || k === "Control" || k === "Shift" || k === "Alt" || k === "Meta" || k === "Dead" || k === "Unidentified") return null;
  if (ev.altKey && ev.code && /^Key[A-Z]$/.test(ev.code)) k = ev.code.slice(3);   // Option composes another character on a Mac
  else if (ev.altKey && ev.code && /^Digit\d$/.test(ev.code)) k = ev.code.slice(5);
  k = NAMED[k] || k;
  const letter = k.length === 1 && /[a-z]/i.test(k); if (letter) k = k.toUpperCase();
  const printable = k.length === 1 && !letter && !/[0-9]/.test(k);
  const mods: string[] = [];
  if (ev.ctrlKey || ev.metaKey) mods.push("Ctrl");
  if (ev.shiftKey && !printable) mods.push("Shift");
  if (ev.altKey) mods.push("Alt");
  return [...mods, k].join("+");
}

/** HK_PROMPT_DIALOG ("Set Hotkey"): resolves the key pressed, "" for Clear assigned hotkey, null for Esc. */
export function promptForKey(command: string, current: string): Promise<string | null> {
  return new Promise((resolve) => {
    const cur = h("b", { "data-k": "hk-current" }, hotkeyText(current));
    const panel = h("div", { tabindex: 0, "data-k": "hk-capture", style: "outline:none;padding:5px" },
      h("div", { style: "display:grid;grid-template-columns:max-content auto;gap:10px 10px;align-items:center" }, h("span", null, "Command:"), h("b", null, command), h("span", null, "Current key:"), cur));
    const clear = h("button", { class: "btn", type: "button", "data-k": "hk-clear" }, "Clear assigned hotkey");
    const body = h("div", { class: "kd-body", style: "text-align:center" }, h("p", { style: "margin:10px" }, "Press a new hotkey, or press Esc to cancel..."), h("hr", { style: "border:none;border-top:1px solid var(--line);margin:2px" }), panel, h("div", { style: "margin:5px" }, clear));
    const dlg = h("div", { class: "kd-dialog", role: "dialog", "aria-label": "Set Hotkey", style: "width:auto;min-width:320px" }, h("div", { class: "kd-title" }, h("span", null, "Set Hotkey")), body);
    const ov = h("div", { class: "kd-overlay kd-prompt", style: "z-index:10040", "data-k": "hk-prompt" }, dlg);
    const done = (v: string | null): void => { ov.remove(); resolve(v); };
    clear.addEventListener("click", () => done(""));
    ov.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.target === clear && (ev.key === "Enter" || ev.key === " ")) return;
      if (ev.key === "Tab" && ev.target === clear) { trapTab(ev, dlg); return; }
      ev.preventDefault();
      if (ev.key === "Escape" && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && !ev.altKey) { done(null); return; }
      const k = keyOfEvent(ev); if (k) done(k);
    });
    document.body.append(ov); panel.focus();
  });
}

const COLS = ["Command (double-click to edit)", "Hotkey", "Alternate", "Description"];
/** The panel inside a Preferences page; apply() on OK. */
export function hotkeysPanel(pg: HTMLElement, staged?: UserHotkeys): { apply(): void; resetToDefaults(): void; staged(): UserHotkeys } {
  const sections = hotkeySections();
  if (staged) for (const s of sections) for (const e of s.rows) { const v = e.name ? staged[e.name] : undefined; if (v) { e.key = v[0]; e.alt = v[1]; } }
  const filter = h("input", { type: "search", id: "kd-pref-hotkey-filter", placeholder: "Type filter text", style: "width:100%;margin:5px 5px 0 0" }) as HTMLInputElement;
  const tb = h("tbody", { id: "kd-pref-hotkeys" });
  const collapsed = new Set<string>();
  let selected: HotkeyEntry | null = null;
  const th = (t: string, w?: number): HTMLElement => h("th", { style: (w ? `width:${w}px;` : "") + "white-space:nowrap" }, t);
  const table = h("table", { class: "kd-grid kd-hotkeys", style: "width:100%" }, h("thead", null, h("tr", null, th(COLS[0]), th(COLS[1], 120), th(COLS[2], 120), th(COLS[3]))), tb);
  const draw = (): void => {
    const rows: HTMLElement[] = [];
    for (const s of sections) {
      const shown = s.rows.filter((e) => filterMatches(e, filter.value));
      const open = !collapsed.has(s.name);
      const tw = h("span", { style: "display:inline-block;width:14px;cursor:pointer" }, open ? "▾" : "▸");
      const head = h("tr", { class: "hk-sec", "data-section": s.name }, h("td", { colspan: 4, style: "font-weight:600;background:var(--panel-2);cursor:default" }, tw, s.name));
      head.addEventListener("click", () => { if (open) collapsed.add(s.name); else collapsed.delete(s.name); draw(); });
      rows.push(head);
      if (!open) continue;
      for (const e of shown) {
        const tr = h("tr", { "data-hk": e.name || e.label, class: e === selected ? "sel" : "" },
          h("td", { class: "ro", style: "padding-left:22px;white-space:nowrap" }, commandText(e)), h("td", { class: "ro", style: "white-space:nowrap" }, hotkeyText(e.key)),
          h("td", { class: "ro", style: "white-space:nowrap" }, hotkeyText(e.alt)), h("td", { class: "ro", style: "color:var(--ink-2);white-space:nowrap" }, e.tip.replace(/[\r\n]/g, " ")));
        tr.addEventListener("click", () => { selected = e; for (const r of Array.from(tb.querySelectorAll("tr.sel"))) r.classList.remove("sel"); tr.classList.add("sel"); });
        tr.addEventListener("dblclick", () => { void edit(e, false); });
        tr.addEventListener("contextmenu", (ev) => {
          ev.preventDefault(); selected = e; tr.classList.add("sel");
          if (!e.name) return;   // a gesture: no hotkey data behind it
          popupMenu(ev.clientX, ev.clientY, [
            { label: "Edit...", run: () => void edit(e, false) }, { label: "Edit Alternate...", run: () => void edit(e, true) },
            { label: "Undo Changes", run: () => { e.key = e.origKey; e.alt = e.origAlt; draw(); } },
            { label: "Clear Assigned Hotkey", run: () => { e.key = ""; draw(); } }, { label: "Clear Assigned Alternate", run: () => { e.alt = ""; draw(); } },
            { label: "Restore Defaults", run: () => { e.key = e.defKey; e.alt = e.defAlt; draw(); } }]);
        });
        rows.push(tr);
      }
    }
    tb.replaceChildren(...rows);
  };
  /** WIDGET_HOTKEY_LIST::editItem + changeHotkey + resolveKeyConflicts. */
  const edit = async (e: HotkeyEntry, alternate: boolean): Promise<void> => {
    if (!e.name) return;
    const key = await promptForKey(commandText(e).replace(/ \*$/, ""), alternate ? e.alt : e.key);
    if (key === null) return;
    if (RESERVED.some((r) => normKey(r) === normKey(key))) { messageBox("Error", `'${hotkeyText(key)}' is a reserved hotkey in KiCad and cannot be assigned.`); return; }
    const set = (): void => { if (alternate) e.alt = key; else e.key = key; draw(); };
    if (!key || (alternate ? e.alt : e.key) === key) { set(); return; }
    const other = keyConflict(sections, e, key);
    if (!other) { set(); return; }
    messageBox("Hotkey conflict", `'${hotkeyText(key)}' is already assigned to '${other.label}' in section '${other.section}'.  Both bindings will be kept, but only one will run per key press.  Continue?`,
      [{ label: "Yes", fn: set }, { label: "No" }], 1);
  };
  const fileInput = h("input", { type: "file", accept: ".hotkeys", style: "display:none" }) as HTMLInputElement;
  fileInput.addEventListener("change", () => {
    const f = fileInput.files && fileInput.files[0]; fileInput.value = ""; if (!f) return;
    void f.text().then((text) => {
      const got = parseHotkeyFile(text), ignored = new Set<string>();
      const take = (k: string): string | null => { if (RESERVED.some((r) => normKey(r) === normKey(k))) { ignored.add(k); return null; } return k; };
      for (const s of sections) for (const e of s.rows) {
        const v = e.toolName ? got.get(e.toolName) : undefined; if (!v) continue;
        const k = take(v[0]), a = take(v[1]);
        if (k !== null) e.key = k; if (a !== null) e.alt = a;
      }
      draw();
      if (ignored.size) messageBox("Warning", `The following hotkeys are reserved and were not imported: ${Array.from(ignored).map(hotkeyText).join(", ")}`);
    });
  });
  filter.addEventListener("input", draw);
  const undoAll = h("button", { class: "btn", type: "button", id: "kd-pref-hk-undo", title: "Undo all changes made so far in this dialog" }, "Undo All Changes");
  const imp = h("button", { class: "btn", type: "button", id: "kd-pref-hk-import", title: "Import hotkey definitions from an external file, replacing the current values" }, "Import Hotkeys...");
  undoAll.addEventListener("click", () => { for (const s of sections) for (const e of s.rows) { e.key = e.origKey; e.alt = e.origAlt; } draw(); });
  imp.addEventListener("click", () => fileInput.click());
  pg.style.display = "flex"; pg.style.flexDirection = "column";
  pg.append(filter, h("div", { class: "kd-grid-wrap", style: "flex:1;min-height:300px;height:380px;margin-top:5px;overflow:auto" }, table),
    h("div", { style: "display:flex;gap:6px;margin-top:8px" }, undoAll, imp), fileInput);
  draw();
  return {
    apply(): void { saveUserHotkeys(userHotkeysOf(sections)); },
    resetToDefaults(): void { for (const s of sections) for (const e of s.rows) { e.key = e.defKey; e.alt = e.defAlt; } draw(); },
    staged: () => userHotkeysOf(sections),
  };
}
