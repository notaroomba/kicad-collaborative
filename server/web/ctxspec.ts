// ctxspec.ts — the context menus' share of KiCad's icons (server/web/generated/kicad-context-spec.json,
// produced by server/scripts/gen_kicad_context.py): the ones the toolbars do not already carry are
// added to the icon table KIcon draws from.
import { icons } from "./generated/kicad-context-spec.json";
import { SPEC, type IconSpec } from "./spec";

for (const [name, ic] of Object.entries(icons as unknown as Record<string, IconSpec>)) if (!SPEC.icons[name]) SPEC.icons[name] = ic;

export const hasIcon = (name: string | undefined): name is string => !!name && !!SPEC.icons[name];
