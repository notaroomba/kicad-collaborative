// spec.ts — typed access to the generated KiCad UI spec (server/web/generated/kicad-ui-spec.json,
// produced by server/scripts/gen_kicad_ui.py from the C++ toolbar configs, TOOL_ACTIONs and icons).
import raw from "./generated/kicad-ui-spec.json";

/** TOOL_ACTION metadata: friendly name, tooltip, icon name and the default hotkey ("Ctrl+Shift+G"). */
export interface ActionMeta { id: string; label: string; tip: string | null; icon: string | null; key: string | null }

export interface ActionItem extends ActionMeta { act: string }
export interface GroupItem { group: string; items: ActionItem[] }
export interface SepItem { sep: true }
export interface ControlItem { control: string }
export type ToolbarItem = ActionItem | GroupItem | SepItem | ControlItem;

export type ToolbarLoc = "top" | "aux" | "left" | "right";
export type Toolbars = Partial<Record<ToolbarLoc, ToolbarItem[]>>;

export interface IconSpec { vb?: string; light?: string; dark?: string }

export interface KicadUiSpec {
  generated?: string;
  actions: Record<string, ActionMeta>;
  toolbars: Record<string, Toolbars>;
  icons: Record<string, IconSpec>;
}

export const SPEC: KicadUiSpec = raw as unknown as KicadUiSpec;

export const isGroup = (it: ToolbarItem): it is GroupItem => (it as GroupItem).group !== undefined;
export const isSep = (it: ToolbarItem): it is SepItem => (it as SepItem).sep === true;
export const isControl = (it: ToolbarItem): it is ControlItem => (it as ControlItem).control !== undefined;

// Actions are keyed by their C++ name ("ACTIONS::toggleGrid"); the chrome addresses them by the short id.
const BY_ID: Record<string, ActionMeta> = {};
for (const a of Object.values(SPEC.actions)) if (!BY_ID[a.id]) BY_ID[a.id] = a;

/** Metadata for a KiCad action by short id (null for our own entries such as "collabCopyLink"). */
export function actionMeta(id: string): ActionMeta | null { return BY_ID[id] || null; }
