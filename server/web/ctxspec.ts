// ctxspec.ts — the context menus' share of KiCad's icons (server/web/generated/kicad-context-spec.json,
// produced by server/scripts/gen_kicad_context.py): the ones the toolbars do not already carry are served
// with the menu icon pack (scripts/gen-icon-pack.js → static/dist/kicad-icons.json, web/iconpack.ts).
import { SPEC } from "./spec";
import { loadIconPack, packIcon } from "./iconpack";

// the context menus' icons now arrive with the menu icon pack (static/dist/kicad-icons.json); start fetching it now
loadIconPack();

export const hasIcon = (name: string | undefined): name is string => !!name && !!(SPEC.icons[name] || packIcon(name));
