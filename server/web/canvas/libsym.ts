// kicad-canvas — the Symbol Editor's render mode: one library symbol (a (symbol "Name" …) node of a
// .kicad_sym) as a document whose items are the symbol's own shapes, texts, pins and fields, drawn the way
// SCH_PAINTER draws them with m_IsSymbolEditor set (eeschema/sch_painter.cpp):
//   - only the shown unit plus the unit-0 items, the shown body style plus the body-style-0 items (m_ShowUnit /
//     m_ShowBodyStyle, sch_painter.cpp:272-281);
//   - every pin with its dangling target circle (isDangling forced, sch_painter.cpp:958) and, when
//     showElectricalTypes, its electrical type name in LAYER_PRIVATE_NOTES (PIN_LAYOUT_CACHE::GetPinElectricalTypeInfo);
//   - hidden pins and hidden fields in LAYER_HIDDEN when showHiddenPins / showHiddenFields (both default on,
//     symbol_editor_settings.cpp:84-88); private items drawn;
//   - a derived symbol's inherited graphics in the disabled colour (m_ShowGraphicsDisabled);
//   - no drawing sheet; the editor turns the grid axes on (symbol_edit_frame.cpp:341) at the anchor (0,0).
// Library coordinates are Y up; the document is Y down, so the transform is (x, y) -> (x, -y) (DefaultTransform).
//
// Item ids are stable for the life of the symbol's structure: "g:<sub-symbol name>:<child index>" for a shape /
// text of a sub-symbol, "p:<sub-symbol name>:<child index>" for a pin and "f:<field name>" for a field, so a
// selection survives a rebuild after a move.  item.libRef says where the node lives.
import { SCH, SCH_Z, dimColor } from "./colors";
import { G, boxUnion, textGeom, transformedText } from "./geom";
import { PIN_TEXT_OFFSET, TARGET_PIN_RADIUS, TILDE_LITERAL_VERSION, buildPinGeom, pinHidden, shapeGeom, type PinSym } from "./geom-sch";
import { atOf, effectsOf, faceOf, has, isList, kid, kids, num, str, strokeColorOf, widthOf } from "./sexpr";
import { SCH_PEN, textPen } from "./text";
import { newDoc } from "./doc";
import type { Doc, GeomSink, Item, Pt } from "./types";

export interface LibSymbolOpts {
  unit?: number; bodyStyle?: number;
  /** the library file's (version …): from 20250318 a pin named "~" is literally "~" */
  fileVersion?: number;
  showHiddenPins?: boolean; showHiddenFields?: boolean; showElectricalTypes?: boolean;
  /** View > Show Pin Alternate Icons (SYMBOL_EDITOR_SETTINGS m_ShowPinAltIcons, on by default) */
  showPinAltIcons?: boolean;
  /** the whole symbol greyed (a legacy library's: m_ShowDisabled) */
  disabled?: boolean;
  /** the parent this derived symbol extends (its drawing is shown disabled, m_ShowGraphicsDisabled) */
  parent?: SNode | null;
}

/** Where a library item lives: the sub-symbol (or "" for a field of the root) and the child index. */
export interface LibRef { kind: "graphic" | "pin" | "field"; sub: string; j: number; unit: number; body: number; inherited?: boolean; name?: string }

/** "Name_u_b" → [unit, body]; a name without the suffix is [0, 0]. */
export function subUnitBody(name: string): [number, number] {
  const m = /_(\d+)_(\d+)$/.exec(name); return m ? [+m[1], +m[2]] : [0, 0];
}

/** ElectricalPinTypeGetText: the names the Symbol Editor writes beside each pin. */
export const PIN_TYPE_NAMES: Record<string, string> = {
  input: "Input", output: "Output", bidirectional: "Bidirectional", tri_state: "Tri-state", passive: "Passive", free: "Free",
  unspecified: "Unspecified", power_in: "Power input", power_out: "Power output", open_collector: "Open collector",
  open_emitter: "Open emitter", no_connect: "Unconnected",
};

const yes = (n: SNode, key: string): boolean => { const k = kid(n, key); return k ? str(k[1]) !== "no" : has(n, key); };
const tf = (x: number, y: number): Pt => [x, -y];
const IDENT = [1, 0, 0, 1];

function pinSymOf(sym: SNode, col: (c: string) => string, fileVersion = 0): PinSym {
  const literalTilde = fileVersion >= TILDE_LITERAL_VERSION;
  const pn = kid(sym, "pin_names"); const nameOff = pn && kid(pn, "offset") ? num(kid(pn, "offset")![1]) : 0.508;
  const hideNames = !!(pn && (has(pn, "hide") || (kid(pn, "hide") && str(kid(pn, "hide")![1]) === "yes")));
  const pnu = kid(sym, "pin_numbers"); const hideNums = !!(pnu && (has(pnu, "hide") || (kid(pnu, "hide") && str(kid(pnu, "hide")![1]) === "yes")));
  let maxNameHalf = 0;
  for (const sub of kids(sym, "symbol")) for (const p of kids(sub, "pin")) { const nm = kid(p, "name"); if (nm && str(nm[1]) && (str(nm[1]) !== "~" || literalTilde)) maxNameHalf = Math.max(maxNameHalf, effectsOf(nm).size / 2); }
  return { nameOff, hideNames, hideNums, maxNameHalf, col, literalTilde };
}

/** One shape / text / text box of a sub-symbol into `item` (library coordinates, Y up). */
export function libGraphicGeom(item: GeomSink, g: SNode, col: (c: string) => string): void {
  const gk = String(g[0]);
  if (gk === "rectangle" || gk === "polyline" || gk === "bezier" || gk === "circle" || gk === "arc" || gk === "ellipse" || gk === "ellipse_arc") {
    shapeGeom(item, g, gk, tf, col(yes(g, "private") ? SCH.privateNotes : SCH.outline), "Symbols", SCH_Z.device, SCH_Z.deviceBg, widthOf(g, 0) || SCH_PEN, undefined, true);
    if (col !== ident) for (const x of item.geom) { if (x.color) x.color = col(x.color); if (x.fill) x.fill = col(x.fill); }
  } else if (gk === "text" || gk === "text_box") {
    const [x, y, r0] = atOf(g); const ef = effectsOf(g); const [px, py] = tf(x, y);
    const r = gk === "text" ? r0 / 10 : r0;   // saveText writes the angle in tenths of a degree, a text box in degrees
    const color = col(ef.hide ? SCH.hidden : yes(g, "private") ? SCH.privateNotes : (strokeColorOf(g) || SCH.outline));
    if (gk === "text_box") {
      const s = kid(g, "size"); const w = s ? num(s[1]) : 5, h = s ? Math.abs(num(s[2])) : 2.5;   // saveTextBox writes -height (library Y up)
      const bw = widthOf(g, 0); if (bw >= 0) G(item, { t: "poly", pts: [[px, py], [px + w, py], [px + w, py + h], [px, py + h]], close: true, w: bw || SCH_PEN, color: col(SCH.outline), layer: "Symbols", z: SCH_Z.device });
      transformedText(item, IDENT, px, py, str(g[1]), ef.size, color, r, ef.just, "Symbols", { z: SCH_Z.device, w: textPen(ef, ef.size), italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX, defH: "left", defV: "top" });
    } else transformedText(item, IDENT, px, py, str(g[1]), ef.size, color, r, ef.just, "Symbols", { z: SCH_Z.device, w: textPen(ef, ef.size), italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX });
  }
}
const ident = (c: string): string => c;

/** The pin's dangling target and electrical-type name, as the symbol editor always shows them. */
function pinExtras(item: GeomSink, p: SNode, color: string, showType: boolean): void {
  const [x, y, r] = atOf(p); const [px, py] = tf(x, y);
  G(item, { t: "circle", x: px, y: py, r: TARGET_PIN_RADIUS, w: SCH_PEN / 3, color, layer: "Pins", z: SCH_Z.pin });
  if (!showType) return;
  const label = PIN_TYPE_NAMES[str(p[1])] || "Unspecified";
  const nameN = kid(p, "name"); const nameSize = nameN ? effectsOf(nameN).size : 1.27;
  const size = Math.max(nameSize * 3 / 4, 0.7), thick = size / 8;
  // PIN_RIGHT local offset, then transformTextForPin: the text sits outside the pin's connection point
  const off = PIN_TEXT_OFFSET + thick / 2 + TARGET_PIN_RADIUS + TARGET_PIN_RADIUS / 2;   // outward from the connection point
  const dir = ((Math.round(r) % 360) + 360) % 360;   // the file angle points from the connection point into the body
  // transformTextForPin (pin_layout_cache.cpp:349): right-aligned horizontal text for PIN_RIGHT, mirrored for
  // PIN_LEFT; vertical text below the end of an upward pin and above the end of a downward one
  if (dir === 0) textGeom(item, px - off, py, label, size, SCH.privateNotes, 0, ["right", "middle"], "Pins", { z: SCH_Z.pin, w: thick });
  else if (dir === 180) textGeom(item, px + off, py, label, size, SCH.privateNotes, 0, ["left", "middle"], "Pins", { z: SCH_Z.pin, w: thick });
  else if (dir === 90) textGeom(item, px, py + off, label, size, SCH.privateNotes, 90, ["right", "middle"], "Pins", { z: SCH_Z.pin, w: thick });
  else textGeom(item, px, py - off, label, size, SCH.privateNotes, 90, ["left", "middle"], "Pins", { z: SCH_Z.pin, w: thick });
}

/**
 * The symbol as a document for the editor canvas (KiCadCanvas.parseLibSymbol).  `sym` is the root
 * (symbol "Name" …) node; a derived symbol passes its parent through opts.parent.
 */
export function parseLibSymbol(sym: SNode, opts?: LibSymbolOpts): Doc {
  opts = opts || {};
  const unit = opts.unit || 1, body = opts.bodyStyle || 1;
  const doc = newDoc("sch"); doc.page = [0, 0];
  const dim = (c: string) => dimColor(c, SCH.bg);
  const colAll = opts.disabled ? dim : ident;
  const showHiddenPins = opts.showHiddenPins !== false, showHiddenFields = opts.showHiddenFields !== false, showType = opts.showElectricalTypes !== false;
  const add = (id: string, ref: LibRef, sink: GeomSink, kind: string): void => {
    if (!sink.geom.length) return;
    const it = { id, kind, node: null as unknown as SNode, geom: sink.geom, bbox: sink.bbox, movable: !ref.inherited, libRef: ref } as unknown as Item;
    doc.items.set(id, it);
  };
  const shown = (u: number, b: number) => (u === 0 || u === unit) && (b === 0 || b === body);
  const drawFrom = (owner: SNode, inherited: boolean): void => {
    const col = inherited ? dim : colAll;
    const ps = pinSymOf(owner, col, opts!.fileVersion || 0); ps.altIcons = opts!.showPinAltIcons !== false;
    for (const sub of kids(owner, "symbol")) {
      const subName = str(sub[1]); const [u, b] = subUnitBody(subName); if (!shown(u, b)) continue;
      for (let j = 2; j < sub.length; j++) {
        const g = sub[j]; if (!isList(g)) continue;
        const gk = String(g[0]);
        if (gk === "pin") {
          const hidden = pinHidden(g);
          if (hidden && !showHiddenPins) continue;
          const sink: GeomSink = { geom: [], bbox: null };
          const pc = hidden ? () => col(SCH.hidden) : col;
          buildPinGeom(sink, g, tf, Object.assign({}, ps, { col: pc, showHidden: true }));
          pinExtras(sink, g, hidden ? col(SCH.hidden) : col(SCH.pin), showType);
          const numN = kid(g, "number");
          add("p:" + subName + ":" + j, { kind: "pin", sub: subName, j, unit: u, body: b, inherited, name: numN ? str(numN[1]) : "" }, sink, "lib_pin");
        } else if (gk === "rectangle" || gk === "polyline" || gk === "bezier" || gk === "circle" || gk === "arc" || gk === "ellipse" || gk === "ellipse_arc" || gk === "text" || gk === "text_box") {
          const sink: GeomSink = { geom: [], bbox: null };
          libGraphicGeom(sink, g, col);
          add("g:" + subName + ":" + j, { kind: "graphic", sub: subName, j, unit: u, body: b, inherited }, sink, "lib_" + gk);
        }
      }
    }
  };
  if (opts.parent) drawFrom(opts.parent, true);
  drawFrom(sym, false);
  // fields: the root's (property …) list, ki_* keywords excluded (they are not fields in a KiCad 10 LIB_SYMBOL)
  const props = kids(sym, "property");
  const fieldOwner = props.length || !opts.parent ? sym : opts.parent;
  for (let j = 1; j < fieldOwner.length; j++) {
    const p = fieldOwner[j]; if (!isList(p) || p[0] !== "property") continue;
    const name = str(p[1]), val = str(p[2]); if (name.startsWith("ki_")) continue;
    const ef = effectsOf(p); const hide = ef.hide || yes(p, "hide");
    if (hide && !showHiddenFields) continue;
    const showName = yes(p, "show_name");
    const shownText = (showName ? name + ": " : "") + val; if (!val) continue;
    const isRV = name === "Reference" || name === "Value";
    const color = colAll(hide ? SCH.hidden : yes(p, "private") ? SCH.privateNotes : isRV ? SCH.ref : SCH.field);
    const [x, y, r] = atOf(p);
    const sink: GeomSink = { geom: [], bbox: null };
    transformedText(sink, IDENT, x, -y, shownText, ef.size, color, r, ef.just, isRV ? "Reference & value" : "Fields", { z: name === "Reference" ? SCH_Z.ref : name === "Value" ? SCH_Z.value : SCH_Z.fields, w: textPen(ef, ef.size), italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX, field: name });
    add("f:" + name, { kind: "field", sub: "", j, unit: 0, body: 0, inherited: fieldOwner !== sym, name }, sink, "lib_field");
  }
  let bb = null as number[] | null;
  for (const it of doc.items.values()) if (it.bbox) bb = boxUnion(bb, it.bbox[0], it.bbox[1], it.bbox[2], it.bbox[3]);
  doc.bbox = bb;
  return doc;
}
