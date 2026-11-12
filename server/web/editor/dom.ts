// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
// KiCad Collaborative web app: home (recent / explore / open link) + online
// board editor.  Talks to the same REST + WebSocket API the desktop uses.
//
// This file is the editor core: the document (kicad-canvas.js), the websocket
// snapshot/op protocol, presence, selection, drags through the tool engines,
// undo/redo, comments, follow mode and pointer handling on #stage.  The chrome
// around the stage (menus, toolbars, docked panels, status bar, overlays) is
// React (server/web → /static/dist/ui.js) and renders from the observable store
// published on window.CollabApp below; it sends intents back via dispatch().

/** The element for a selector (`T` names its type where it is not an HTML element).  The editor asks only for the
 *  fixed elements of static/app.html, so the answer is taken to be there. */
export const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document): T => r.querySelector(s) as T;

export const $$ = (s: string, r: ParentNode = document): HTMLElement[] => Array.from(r.querySelectorAll<HTMLElement>(s));

export const NS = "http://www.w3.org/2000/svg";
