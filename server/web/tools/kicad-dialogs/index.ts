// kicad-dialogs — KiCad's property dialogs for the web editor.  Double-click an item (or
// press E) for its properties dialog, double-click a symbol / footprint field for the
// "Edit Text and Field Properties" dialog.  Edits are staged on a cloned node and committed
// as one change on OK; Cancel discards them — the desktop dialog contract.  The item dialogs
// reuse props.js's per-kind rows (renderInto with a staging hook); the field dialog is its own
// form built from the (property …) node.  Registers window.KDialogs.
//
// Built by 'npm run build:kicad-dialogs' into static/kicad-dialogs.js, a classic script (IIFE).
"use strict";
import { type DialogCtx, type DialogItem, type ItemOpts, TITLES, openField, openItem, openNew } from "./items";
import { fieldAt, fieldEffects, fieldHidden, fieldLayer, fieldNode, fieldText, fieldUnlocked, setFieldAt, setFieldEffects, setFieldHidden, setFieldLayer, setFieldText, setFieldUnlocked } from "./fields";
import { exportToNode, root } from "../root";
import { close, isOpen, open } from "./shell";
import { ensureCss, grid, notebook, staticBox, treebook } from "./widgets";

const kdialogs = { open, close, openItem, openNew, openField, isOpen, TITLES, notebook, treebook, grid, staticBox, ensureCss,
  _: { fieldNode, fieldEffects, setFieldEffects, fieldAt, setFieldAt, fieldHidden, setFieldHidden, fieldUnlocked, setFieldUnlocked, fieldLayer, setFieldLayer, fieldText, setFieldText } };

/** window.KDialogs: this script's API plus the hooks other bundles hang on it (they are asked first). */
export type KDialogsModule = typeof kdialogs & {
  /** web/editor/pcbdialogs: a board item's own KiCad dialog; true when it took the item. */
  pcbItemDialog?(ctx: DialogCtx, item: DialogItem): boolean;
  /** web/editor/pcbdialogs: EDIT_TOOL::Properties over a selection of tracks and vias only (DIALOG_TRACK_VIA_PROPERTIES); true when it took them. */
  pcbSelectionDialog?(ctx: DialogCtx, items: DialogItem[]): boolean;
  /** web/dialogs/sch-items: eeschema's item dialogs; true when one took the item. */
  schItemDialog?(ctx: DialogCtx, item: DialogItem, opts: ItemOpts): boolean;
  /** web/editor/pcbdialogs: DIALOG_TEXT_PROPERTIES on a footprint field; true when it took the field. */
  pcbFieldDialog?(ctx: DialogCtx, item: DialogItem, name: string): boolean;
  /** web/dialogs/sch-items: DIALOG_FIELD_PROPERTIES; true when it took the field. */
  schFieldDialog?(ctx: DialogCtx, item: DialogItem, name: string): boolean;
  /** web/dialogs/sch-items: SCH_EDIT_TOOL::Properties for the current selection. */
  schProperties?(): boolean;
};

root.KDialogs = kdialogs;
exportToNode(root.KDialogs);
