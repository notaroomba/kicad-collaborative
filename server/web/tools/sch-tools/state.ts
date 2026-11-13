import type { SchState } from "./types";
import { root } from "../root";

export const K = root.KiCadCanvas;
if (!K) throw new Error("sch-tools.js needs kicad-canvas.js loaded first");
export const { kid, kids, num, str, atOf, ptsOf, setPts, setAt, uuidOf } = K;

export const CLR = { wire: "#009600", bus: "#0000C2", sel: "#FFB43A", hover: "#4D7FC4" };
export const LINE_KINDS = new Set(["wire", "bus", "polyline"]);
export const TEXT_KINDS = new Set(["label", "global_label", "hierarchical_label", "text"]);
export const POINT_KINDS = new Set(["junction", "no_connect", "bus_entry"]);
export const SHAPE_KINDS = new Set(["rectangle", "circle", "arc", "ellipse", "ellipse_arc"]);          // sheet-level SCH_SHAPEs (polyline is a LINE_KIND)
export const DRAW_TOOLS = new Set(["rect", "circle", "ellipse", "ellipse_arc", "arc", "textbox", "sheet", "table", "bezier", "polygon", "rulearea"]);
// Kinds the canvas has no SCH_TYPE_NAMES entry for: the desktop's GetClass() names.
export const TYPE_NAMES: Record<string, string> = { bezier: "SCH_SHAPE", image: "SCH_BITMAP", table: "SCH_TABLE", rule_area: "SCH_RULE_AREA" };
// KiCad's delete cursor: a small bin with a crosshair hotspot
export const DELETE_CURSOR = 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M2 8h12M8 2v12M4 8h8M8 4v8" stroke="#fff" stroke-width="3"/><path d="M2 8h12M8 2v12" stroke="#000" stroke-width="1.2"/><path d="M14 10h8l-1 12h-6zM13 8h10M17 6h2v2h-2z" fill="#fff" stroke="#c00" stroke-width="1.2"/></svg>') + '") 8 8, crosshair';
// KICURSOR::BULLSEYE (the highlight-net tool)
export const BULLSEYE_CURSOR = 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="#fff" stroke-width="3"/><circle cx="12" cy="12" r="9" fill="none" stroke="#000" stroke-width="1.2"/><circle cx="12" cy="12" r="5" fill="none" stroke="#fff" stroke-width="3"/><circle cx="12" cy="12" r="5" fill="none" stroke="#000" stroke-width="1.2"/><circle cx="12" cy="12" r="1.6" fill="#000"/></svg>') + '") 12 12, crosshair';
export const TOOLS = [
  { id: "wire", label: "Wire", key: "W", kind: "wire", cursor: "LINE_WIRE", icon: '<path d="M3 18h8v-9h10"/>' },
  { id: "bus", label: "Bus", key: "B", kind: "bus", cursor: "LINE_BUS", icon: '<path d="M3 18h8v-9h10" stroke-width="3.2"/>' },
  { id: "busentry", label: "Bus entry", key: "Z", cursor: "PLACE", icon: '<path d="M4 20h7l9-9"/><path d="M4 4v16" stroke-width="3.2"/>' },
  { id: "junction", label: "Junction", key: "J", cursor: "PLACE", icon: '<path d="M12 3v18M3 12h18"/><circle cx="12" cy="12" r="3" fill="currentColor"/>' },
  { id: "noconnect", label: "No connect", key: "Q", cursor: "PLACE", icon: '<path d="M12 3v9M7 7l10 10M17 7L7 17"/>' },
  { id: "label", label: "Net label", key: "L", kind: "label", cursor: "LABEL_NET", icon: '<path d="M6 17l5-11 5 11M8.5 13h5M4 21h16"/>' },
  { id: "glabel", label: "Global label", key: "Ctrl+L", kind: "global_label", cursor: "LABEL_GLOBAL", icon: '<path d="M3 8h13l4 4-4 4H3z"/>' },
  { id: "hlabel", label: "Hierarchical label", key: "H", kind: "hierarchical_label", cursor: "LABEL_HIER", icon: '<path d="M3 8h13l4 4-4 4H3zM7 12h6"/>' },
  { id: "text", label: "Text", key: "T", kind: "text", cursor: "TEXT", icon: '<path d="M5 6h14M12 6v13M9 19h6"/>' },
  { id: "place", label: "Place symbol", key: "A", cursor: "COMPONENT", icon: '<rect x="7" y="5" width="10" height="14"/><path d="M3 9h4M3 15h4M17 9h4M17 15h4"/>' },
  { id: "power", label: "Power symbol", key: "P", cursor: "COMPONENT", icon: '<path d="M12 21v-9M6 12h12M12 12l-5-7M12 12l5-7"/>' },
  { id: "classlabel", label: "Directive label", key: "", cursor: "LABEL_NET", icon: '<path d="M4 20l8-8"/><circle cx="14" cy="10" r="2.5"/><path d="M15 4h6v3h-6z"/>' },
  { id: "lines", label: "Lines", key: "I", kind: "polyline", cursor: "LINE_GRAPHIC", icon: '<path d="M3 20l6-10 5 6 7-12"/>' },
  { id: "rect", label: "Rectangle", key: "", cursor: "PENCIL", icon: '<rect x="4" y="6" width="16" height="12"/>' },
  { id: "circle", label: "Circle", key: "", cursor: "PENCIL", icon: '<circle cx="12" cy="12" r="8"/>' },
  { id: "ellipse", label: "Ellipse", key: "", cursor: "PENCIL", icon: '<ellipse cx="12" cy="12" rx="9" ry="5"/>' },
  { id: "ellipse_arc", label: "Elliptical arc", key: "", cursor: "PENCIL", icon: '<path d="M3 12a9 5 0 0 1 18 0"/>' },
  { id: "arc", label: "Arc", key: "", cursor: "PENCIL", icon: '<path d="M4 18a8 8 0 0 1 16 0"/>' },
  { id: "textbox", label: "Text box", key: "", cursor: "PENCIL", icon: '<rect x="3" y="5" width="18" height="14"/><path d="M8 9h8M12 9v7"/>' },
  { id: "delete", label: "Delete", key: "", cursor: "REMOVE", icon: '<path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 11v6M14 11v6"/>' },
  // KiCad's drawSheet hotkey (S) is app.js's select key, so the sheet tool has none here
  { id: "sheet", label: "Hierarchical sheet", key: "", cursor: "PENCIL", icon: '<rect x="4" y="6" width="16" height="13"/><path d="M4 6V3h6M4 9h3M17 15h3"/>' },
  { id: "sheetpin", label: "Sheet pin", key: "", cursor: "PENCIL", icon: '<rect x="8" y="4" width="12" height="16"/><path d="M2 12h6M6 10l2 2-2 2"/>' },
  { id: "table", label: "Table", key: "", cursor: "PENCIL", icon: '<rect x="3" y="5" width="18" height="14"/><path d="M3 10h18M3 14h18M9 5v14M15 5v14"/>' },
  { id: "bezier", label: "Bezier curve", key: "", cursor: "PENCIL", icon: '<path d="M3 19C3 8 21 16 21 5"/><path d="M3 19l4-8M21 5l-4 8" stroke-dasharray="1.5 1.5"/>' },
  { id: "polygon", label: "Polygon", key: "", cursor: "PENCIL", icon: '<path d="M4 9l8-5 8 5-3 10H7z"/>' },
  { id: "rulearea", label: "Rule area", key: "", cursor: "PENCIL", icon: '<path d="M4 5h16v14H4z" stroke-dasharray="2 2"/><path d="M8 9l8 6M16 9l-8 6"/>' },
  { id: "image", label: "Image", key: "", cursor: "PENCIL", icon: '<rect x="3" y="5" width="18" height="14"/><path d="M3 16l5-5 4 4 3-3 6 5"/><circle cx="16" cy="9" r="1.5"/>' },
  // ` is KiCad's net-highlight hotkey (highlightNetTool itself has no default)
  { id: "highlight", label: "Highlight net", key: "", cursor: "BULLSEYE", icon: '<path d="M3 12h6l3-6 3 12 3-6h3"/><circle cx="12" cy="12" r="9" stroke-dasharray="2 2"/>' },
];
export const toolOf = (id: string) => TOOLS.find((t) => t.id === id) || null;

// Module state: one in-progress operation at a time, plus a selection of our own
// for the items app.js's select tool ignores (everything but symbols).
// The fields the later sections own (dragMode, lineMode, markers, ...) are set by their own top-level
// statements when the script loads, hence the assertion.
export const S = { ctx: null, tool: "select", wire: null, carry: null, drag: null, pending: null, sel: null, hover: null,
  cursor: null, cursorClient: null, prompt: null, picker: null, dom: false, draw: null, highlight: null, sheetJob: null, imageWait: false } as SchState;
