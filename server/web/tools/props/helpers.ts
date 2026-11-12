// props/helpers.ts — the node editors as one object (CollabTools.props.helpers): the Properties panel,
// the dialogs, the tool scripts and the chrome's property grid all edit nodes through it.
import { field, fieldList, isHidden, setField, setFieldHidden } from "./fields";
import { flipLayer, footprintAttrs, netNameOf, setFootprintAttrs, setFootprintPosition, setFootprintRotation, setFootprintSide } from "./footprint";
import { boardLayers, setDiameter, setLayer, setRotation, setShape, setStrokeWidth, setText, setTextSize, setViaDrill, setViaLayers, setViaSize, setWidth, setZoneName, setZonePriority, strokeWidth, textSize } from "./items";
import { evalExpr, formatLength } from "./numeric";
import { PAD_LAYER_PRESETS, PAD_SHAPES, PAD_TYPES, boardNetNames, netCodeOf, numberedNets, padInfo, padList, padNode, setPad } from "./pads";
import { deg360, delKid, kid, kids, normDeg, num, setKid, setYesNo, str, yes } from "./sexpr";
import { libUnitCount, mirrorOf, setSymbolFlag, setSymbolMirror, setSymbolPosition, setSymbolRotation, setSymbolTransform, setSymbolUnit, symbolT } from "./symbol";

export const helpers = { evalExpr, formatLength, kid, kids, num, str, setKid, delKid, yes, setYesNo, field, fieldList, setField, isHidden, setFieldHidden, symbolT, mirrorOf, setSymbolTransform, setSymbolRotation, setSymbolMirror, setSymbolPosition, setSymbolUnit, setSymbolFlag, libUnitCount, flipLayer, setFootprintPosition, setFootprintRotation, setFootprintSide, footprintAttrs, setFootprintAttrs, netNameOf, padList, padNode, padInfo, setPad, numberedNets, netCodeOf, boardNetNames, PAD_TYPES, PAD_SHAPES, PAD_LAYER_PRESETS, strokeWidth, setStrokeWidth, setWidth, setLayer, setText, textSize, setTextSize, setRotation, setShape, setDiameter, setViaSize, setViaDrill, setViaLayers, setZoneName, setZonePriority, boardLayers, normDeg, deg360 };
export type PropsHelpers = typeof helpers;
