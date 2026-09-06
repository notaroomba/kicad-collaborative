// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
// KiCad Collaborative web app: home (recent / explore / open link) + online
// board editor.  Talks to the same REST + WebSocket API the desktop uses.
//
// This file is the editor core: the document (kicad-canvas.js), the websocket
// snapshot/op protocol, presence, selection, drags through the tool engines,
// undo/redo, comments, follow mode and pointer handling on #stage.  The chrome
// around the stage (menus, toolbars, docked panels, status bar, overlays) is
// React (server/web → /static/dist/ui.js) and renders from the observable store
// published on window.CollabApp below; it sends intents back via dispatch().

export const $ = (s, r = document) => r.querySelector(s);

export const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

export const NS = "http://www.w3.org/2000/svg";
