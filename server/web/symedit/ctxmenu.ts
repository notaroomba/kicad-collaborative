// symedit/ctxmenu.ts — the Symbol Editor canvas context menus as KiCad's CONDITIONAL_MENUs build them: an entry
// whose condition is false is left out (not greyed), entries sort by their order number, and separators collapse.
//   - selection tool: SCH_SELECTION_TOOL::Init (symbolProperties / pinTable at 400, AddStandardSubMenus at 1000)
//     plus what SYMBOL_EDITOR_MOVE_TOOL (move, alignToGrid at 150), SYMBOL_EDITOR_EDIT_TOOL (200 / 250 / 300 / 400)
//     and SYMBOL_EDITOR_PIN_TOOL (push pin properties at 250) add to it;
//   - drawing tools: SCH_TOOL_BASE::Init (cancelInteractive at 1, zoom / grid), finishInteractive while an item is
//     new (SYMBOL_EDITOR_DRAWING_TOOLS::Init), and the edit tool's drawMenu rows at 200;
//   - zoom tool: ZOOM_TOOL::Init (cancelInteractive, zoom / grid).
// DOM-free: the node tests run it.

export interface SymMenuCtx {
  tool: "select" | "draw" | "zoom";
  /** an item is being drawn or placed (IsNew) */
  drawing: boolean;
  /** kinds of the selected items, in selection order ("pin", "property", "text", "rectangle", …) */
  kinds: string[];
  haveSymbol: boolean;
  /** IsSymbolEditable (not a read-only library / view-only) */
  editable: boolean;
  /** IsSymbolAlias: a derived symbol, whose only editable items are its fields */
  alias: boolean;
  canConvertStacked: boolean;
  canExplodeStacked: boolean;
}
export type SymMenuRow = string;   // an action id, "-" for a separator, "zoomMenu" / "gridMenu" for the submenus

const SWAPPABLE = new Set(["pin", "rectangle", "circle", "arc", "polyline", "bezier", "ellipse", "ellipse_arc", "text", "text_box", "property"]);
const COPY_TEXT = new Set(["text", "text_box", "property", "pin"]);

/** Collapse leading, trailing and repeated separators (CONDITIONAL_MENU::Evaluate). */
export function tidy(rows: SymMenuRow[]): SymMenuRow[] {
  const out: SymMenuRow[] = [];
  for (const r of rows) { if (r === "-" && (!out.length || out[out.length - 1] === "-")) continue; out.push(r); }
  while (out.length && out[out.length - 1] === "-") out.pop();
  return out;
}

export function symCanvasMenu(c: SymMenuCtx): SymMenuRow[] {
  const n = c.kinds.length, notEmpty = n > 0, idle = !c.drawing;
  const canEdit = c.editable && (!c.alias || c.kinds.every((k) => k === "property"));
  const rows: [number, SymMenuRow, boolean][] = [];
  const add = (order: number, id: SymMenuRow, cond = true) => rows.push([order, id, cond]);
  if (c.tool === "zoom" || c.tool === "draw") {
    add(1, "cancelInteractive"); add(1, "-");
    if (c.tool === "draw") {
      add(2, "finishInteractive", c.drawing);
      add(200, "-");
      for (const id of ["rotateCCW", "rotateCW", "mirrorV", "mirrorH"]) add(200, id, canEdit && notEmpty && idle);
      add(200, "properties", canEdit && n === 1);
    }
  } else {
    const canMove = c.editable && (!c.alias || c.kinds.every((k) => k === "property"));
    add(150, "move", canMove && notEmpty && idle); add(150, "alignToGrid", canMove && notEmpty && idle);
    add(200, "-");
    for (const id of ["rotateCCW", "rotateCW", "mirrorV", "mirrorH"]) add(200, id, canEdit && notEmpty);
    add(200, "swap", canEdit && n > 1 && c.kinds.every((k) => SWAPPABLE.has(k)));
    add(200, "properties", canEdit && n === 1);
    add(250, "-"); add(250, "convertStackedPins", canEdit && c.canConvertStacked); add(250, "explodeStackedPin", canEdit && c.canExplodeStacked);
    const onePin = n === 1 && c.kinds[0] === "pin" && c.editable && !c.alias;
    add(250, "-"); for (const id of ["pushPinLength", "pushPinNameSize", "pushPinNumSize"]) add(250, id, onePin);
    add(300, "-");
    add(300, "cut", notEmpty && idle); add(300, "copy", notEmpty && idle);
    add(300, "copyAsText", notEmpty && idle && c.kinds.every((k) => COPY_TEXT.has(k)));
    add(300, "paste", canEdit && idle); add(300, "duplicate", canEdit && notEmpty); add(300, "doDelete", canEdit && notEmpty);
    add(400, "-"); add(400, "symbolProperties", c.haveSymbol && !notEmpty); add(400, "pinTable", c.haveSymbol && !notEmpty);
    add(400, "-"); add(400, "selectAll", c.haveSymbol); add(400, "unselectAll", c.haveSymbol);
  }
  add(1000, "-"); add(1000, "zoomMenu"); add(1000, "gridMenu");
  return tidy(rows.map((r, i) => [r, i] as const).sort((a, b) => a[0][0] - b[0][0] || a[1] - b[1]).filter(([r]) => r[2]).map(([r]) => r[1]));
}
