// tools/globals.d.ts — the global object as the classic tool scripts built from web/tools/<name>/ see it
// (static/kicad-dialogs.js, props.js, ...): window in the browser, globalThis under node.  The scripts
// talk to each other and to the chrome only through these globals; web/globals.d.ts holds the chrome's
// (consumer-side) view of the same objects.

/** kicad-canvas.js as the tool scripts use it: the chrome's contract plus the helpers it does not name. */
interface ToolsCanvasApi extends KiCadCanvasApi {
  /** Deep copy of a node that keeps the reader's record of which atoms were quoted (JSON would drop it). */
  cloneNode<T>(node: T): T;
}

/** window.CollabTools as the tool scripts fill it: one entry per script. */
interface ToolsCollab {
  props?: import("./props/index").PropsApi;
  sch?: SchToolModule;
  pcb?: PcbToolModule;
}

interface ToolsRoot {
  KiCadCanvas: ToolsCanvasApi;
  CollabTools: ToolsCollab;
  KDialogs: import("./kicad-dialogs/index").KDialogsModule;
}
