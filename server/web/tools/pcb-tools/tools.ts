// pcb-tools/tools.ts — the tool list the module registers, its hints, and the segments a drag in progress travels.
import type { Pt, TrackLine } from "./types";
import { elemsPts } from "./posture";
import { connLines } from "./select-move";
import { DELETE_CURSOR, S } from "./state";
import { pt, widthOf } from "./util";

// ---------------------------------------------------------------- module
export const TOOLS = [
  { id: "route", label: "Route track", key: "X", cursor: "crosshair", icon: '<path d="M4 18h6l4-4h6"/><circle cx="4" cy="18" r="1.5"/><circle cx="20" cy="14" r="1.5"/>' },
  { id: "routediff", label: "Route differential pair", key: "6", cursor: "crosshair", icon: '<path d="M3 9h7l3-3h8M3 15h7l3 3h8"/>' },
  { id: "tunesingle", label: "Tune length of a single track", key: "7", cursor: "crosshair", icon: '<path d="M3 16h4v-6h3v6h3v-6h3v6h5"/>' },
  { id: "tuneskew", label: "Tune skew of a differential pair", key: "9", cursor: "crosshair", icon: '<path d="M3 9h4v-4h3v4h11M3 15h18"/>' },
  { id: "via", label: "Add via", key: "V", cursor: "crosshair", icon: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/>' },
  { id: "drag", label: "Drag track segment", key: "D", cursor: "move", icon: '<path d="M5 7h14"/><path d="M5 17h14" stroke-dasharray="2 2"/><path d="M12 9v5M9 12l3 3 3-3"/>' },
  { id: "gline", label: "Draw line", key: "Shift+L", cursor: "crosshair", icon: '<path d="M5 19L19 5"/>' },
  { id: "grect", label: "Draw rectangle", key: "Shift+R", cursor: "crosshair", icon: '<rect x="4" y="6" width="16" height="12" rx="1"/>' },
  { id: "gcircle", label: "Draw circle", key: "Shift+C", cursor: "crosshair", icon: '<circle cx="12" cy="12" r="8"/>' },
  { id: "gtext", label: "Add text", key: "T", cursor: "text", icon: '<path d="M6 6h12M12 6v13M9 19h6"/>' },
  { id: "garc", label: "Draw arc", key: "Ctrl+Shift+A", cursor: "crosshair", icon: '<path d="M4 18a8 8 0 0 1 16 0"/>' },
  { id: "gpoly", label: "Draw polygon", key: "Ctrl+Shift+P", cursor: "crosshair", icon: '<path d="M12 3l9 7-4 11H7L3 10z"/>' },
  // KiCad's hotkeys where they do not collide with the web's (Ctrl+Shift+Z is redo, so the zone takes the macOS Alt+Z)
  { id: "gcurve", label: "Draw Bezier curve", key: "Ctrl+Shift+B", cursor: "crosshair", icon: '<path d="M4 18C8 4 16 20 20 6"/><path d="M4 18l4-6M20 6l-4 8" stroke-dasharray="1.5 1.5"/>' },
  { id: "gtextbox", label: "Draw text box", key: "", cursor: "crosshair", icon: '<rect x="3" y="5" width="18" height="14" rx="1"/><path d="M7 9h10M7 12h7M7 15h5"/>' },
  { id: "table", label: "Draw table", key: "", cursor: "crosshair", icon: '<rect x="3" y="5" width="18" height="14"/><path d="M3 10h18M3 14.5h18M9 5v14M15 5v14"/>' },
  { id: "image", label: "Place reference image", key: "", cursor: "crosshair", icon: '<rect x="3" y="5" width="18" height="14" rx="1"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-7 7"/>' },
  { id: "zone", label: "Draw filled zone", key: "Alt+Z", cursor: "crosshair", icon: '<path d="M4 5h16v14H4z"/><path d="M4 12l7-7M4 19l14-14M11 19l9-9M18 19l2-2"/>' },
  { id: "rulearea", label: "Draw rule area", key: "Ctrl+Shift+K", cursor: "crosshair", icon: '<path d="M4 5h16v14H4z" stroke-dasharray="3 2"/><path d="M8 8l8 8M16 8l-8 8"/>' },
  { id: "dimaligned", label: "Draw aligned dimension", key: "", cursor: "crosshair", icon: '<path d="M4 20L20 4"/><path d="M4 20l6-1-5-5zM20 4l-6 1 5 5z"/>' },
  { id: "dimortho", label: "Draw orthogonal dimension", key: "Ctrl+Shift+H", cursor: "crosshair", icon: '<path d="M4 18h16M4 13v8M20 13v8"/><path d="M4 18l4-2v4zM20 18l-4-2v4z"/>' },
  { id: "dimcenter", label: "Draw center dimension", key: "", cursor: "crosshair", icon: '<circle cx="12" cy="12" r="7" stroke-dasharray="2 2"/><path d="M12 3v18M3 12h18"/>' },
  { id: "dimradial", label: "Draw radial dimension", key: "", cursor: "crosshair", icon: '<circle cx="9" cy="15" r="6"/><path d="M9 15l10-10h2"/><path d="M15 9l-1 3 3-1z"/>' },
  { id: "leader", label: "Draw leader", key: "", cursor: "crosshair", icon: '<path d="M4 18l8-8h8"/><path d="M4 18l4-1-3-3z"/>' },
  { id: "delete", label: "Delete", key: "", cursor: DELETE_CURSOR, icon: '<path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 11v6M14 11v6"/>' },
  // KiCad's one-shot pickers (ACTIONS::gridSetOrigin, PCB_ACTIONS::drillOrigin)
  { id: "gridorigin", label: "Grid Origin", key: "", cursor: "crosshair", icon: '<circle cx="12" cy="12" r="7"/><path d="M7 7l10 10M17 7L7 17"/>' },
  { id: "drillorigin", label: "Drill/Place File Origin", key: "", cursor: "crosshair", icon: '<circle cx="12" cy="12" r="7"/><path d="M12 3v18M3 12h18"/>' },
  // PCB_PICKER_TOOL (selectPointInteractively / selectItemInteractively) for a dialog that asks for a point or an item
  { id: "pickpoint", label: "Select Point", key: "", cursor: "crosshair", hidden: true, icon: '<circle cx="12" cy="12" r="3"/><path d="M12 3v5M12 16v5M3 12h5M16 12h5"/>' },
  { id: "pickitem", label: "Select Item", key: "", cursor: "default", hidden: true, icon: '<path d="M5 3l14 9-6 1.5L10 20z"/>' },
];
export const TOOL_HINT = { route: "Route — click to start and to fix, / posture, V via, Ctrl+/ corner mode, Backspace undo segment, End or double-click to finish, Esc to discard",
  routediff: "Route differential pair — click a pad, via or track end of a pair's net to start, click to fix, / posture, V via pair, Backspace undo segment, End or double-click to finish, Esc to discard",
  tunesingle: "Tune length — click a track to start, move along it and click to finish; 1/2 spacing, 3/4 amplitude, Ctrl+L settings, Esc to cancel",
  tuneskew: "Tune skew — click a track of a differential pair, move along it and click to finish; 1/2 spacing, 3/4 amplitude, Ctrl+L settings, Esc to cancel",
  via: "Via — click to place", drag: "Drag — move the mouse, click to fix", gline: "Line — click start and end; click the start point or press Enter to stop",
  grect: "Rectangle — click two corners", gcircle: "Circle — click the centre, then the radius", gtext: "Text — click where it goes",
  garc: "Arc — click the points the drawing mode asks for; / switches the posture, Alt+/ the mode, Backspace takes back a point", gpoly: "Polygon — click the corners; click the first corner or press Enter to close",
  gcurve: "Bezier — click the start, the first control point, the second control point, then the end",
  gtextbox: "Text box — click two corners", table: "Table — click the top-left corner, then the size",
  image: "Image — choose a file, then click where its centre goes",
  zone: "Zone — click the corners; click the first corner or press Enter to close, then pick the net",
  rulearea: "Rule area — click the corners on F.Cu and B.Cu; click the first corner or press Enter to close",
  dimaligned: "Aligned dimension — click the two points, then how far out the crossbar goes",
  dimortho: "Orthogonal dimension — click the two points, then where the crossbar goes (beside the points measures Y, above or below them X)",
  dimcenter: "Center dimension — click the centre, then the size of the cross",
  dimradial: "Radial dimension — click the centre, then a point on the circle",
  leader: "Leader — click the arrow point and the elbow; Dimension Properties then takes the text",
  delete: "Delete — click an item to remove it; Esc to leave the tool",
  pickpoint: "Select center point...", pickitem: "Select center item...",
  gridorigin: "Grid origin — click where the grid starts", drillorigin: "Drill/place file origin — click the origin point for drill and placement files" };

/**
 * The in-flight route leg, in mm, as [x1, y1, x2, y2, widthMm] segments — what a peer should see
 * while a track is being drawn.  Committed legs are already real items and travel as ops.
 */
export function ghostSegs() {
  const rt = S.route;
  // a drag in progress (the router's dragger, or a footprint's attached lines) travels the same way
  const lineSegs = (lines: { l: TrackLine; pts: Pt[] }[]) => { const out: number[][] = []; for (const { l, pts } of lines) for (let i = 0; i + 1 < pts.length; i++) out.push([pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], l.width]); return out; };
  if (!rt && S.drag && S.drag.moved) { const out = []; for (const d of S.drag.subs) if (d.sol) out.push(...lineSegs(d.sol.lines)); return out; }
  if (!rt && S.move && S.move.conns && S.move.conns.length && S.move.moved) return lineSegs(connLines(S.move, S.move.last[0], S.move.last[1]));

  if (!rt)
    return [];

  // the route's fixed stages are not on the board until the route ends: they travel as ghosts too, with the head
  const out = [];
  for (const st of rt.stages) for (const op of st.ops) { const n = op.add || (op.set && op.node); if (!n || (n[0] !== "segment" && n[0] !== "arc")) continue; const a = pt(n, "start"), b = pt(n, "end"); out.push([a![0], a![1], b![0], b![1], widthOf(n, 0.25)]); }
  const heads = rt.dp ? (rt.dpLines ? [rt.dpLines.P, rt.dpLines.N] : []) : [rt.els && rt.els.length ? elemsPts(rt.els) : (rt.head || [rt.last])];
  for (const pts of heads) for (let i = 0; i + 1 < pts.length; i++) out.push([pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], rt.width]);
  return out;
}
