// editor/subsheets.ts — the sub-sheet documents the open page's sheet symbols name, by Sheetfile (ctx.sheetDocs).  The
// dialogs fill it (dialogs/subsheets.ts reads a sub-sheet when a tool asks through ctx.loadSheetDoc).
export const subSheetDocs = new Map<string, KDoc>();
