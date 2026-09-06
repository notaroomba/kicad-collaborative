// smoke-editor.js — load the editor bundle under node with a permissive DOM stub to catch module
// evaluation-order errors (TDZ, missing imports); DOM-shaped failures are expected and reported as such.
"use strict";
const path = require("path");
const mk = () => new Proxy(function () {}, { get(t, k) { if (k === Symbol.iterator) return function* () {}; if (k === "length") return 0; if (k === Symbol.toPrimitive) return () => 0; if (k === "then") return undefined; return mk(); }, apply() { return mk(); }, construct() { return mk(); }, set() { return true; } });
const def = (k, v) => Object.defineProperty(global, k, { value: v, writable: true, configurable: true });
const store = {};
def("window", global); def("document", mk());
def("location", { pathname: "/", search: "", hash: "", href: "http://x/", origin: "http://x" }); def("history", { pushState() {}, replaceState() {} });
def("localStorage", { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } });
def("navigator", { clipboard: null, userAgent: "node" }); def("requestAnimationFrame", (f) => setTimeout(f, 0)); def("cancelAnimationFrame", clearTimeout);
def("matchMedia", () => ({ matches: false, addEventListener() {}, addListener() {} })); def("fetch", () => Promise.reject(new Error("offline"))); def("WebSocket", function () {});
def("ResizeObserver", function () { return { observe() {}, disconnect() {} }; }); def("addEventListener", () => {}); def("removeEventListener", () => {}); def("getComputedStyle", () => mk());
def("devicePixelRatio", 1); def("innerWidth", 1440); def("innerHeight", 900); def("PointerEvent", function () {}); def("KeyboardEvent", function () {}); def("MouseEvent", function () {});
def("HTMLElement", function () {}); def("Image", function () {}); def("URL", { createObjectURL() { return ""; }, revokeObjectURL() {} });
require(path.join(__dirname, "..", "static", "kicad-canvas.js"));
for (const m of ["kicad-dialogs", "sch-tools", "pcb-tools", "props"]) { try { require(path.join(__dirname, "..", "static", m + ".js")); } catch (e) { console.log("tool module", m, "failed under the stub:", (e.message || e).split("\n")[0]); } }
try { require(process.argv[2] || path.join(__dirname, "..", "static", "dist", "editor.js")); console.log("editor bundle evaluated; CollabApp:", typeof global.CollabApp, "CollabEditor keys:", global.CollabEditor ? Object.keys(global.CollabEditor).length : 0); }
catch (e) { const m = String((e && e.stack) || e).split("\n").slice(0, 3).join(" | "); console.log(/before initialization|is not defined|is not a function|Cannot access|Cannot read/.test(m) ? "EVAL ERROR: " + m : "dom-shaped failure (expected under the stub): " + m); }
