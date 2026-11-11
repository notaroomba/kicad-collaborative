#!/usr/bin/env node
// Writes static/dist/kicad-icons.json — the KiCad icons the menus and context menus draw that the toolbars do not
// (web/generated/kicad-menu-icons.json + the icons of web/generated/kicad-context-spec.json, minus the toolbar
// icons web/generated/kicad-ui-spec.json already carries).  They used to be inlined in ui.js (~750 KB); ui.js now
// fetches this file once at start-up (web/iconpack.ts), long before a menu can open.
const fs = require("fs"), path = require("path");
const gen = path.resolve(__dirname, "..", "web", "generated");
const read = (f) => JSON.parse(fs.readFileSync(path.join(gen, f), "utf8"));
const toolbar = read("kicad-ui-spec.json").icons || {};
const icons = {};
for (const src of [read("kicad-menu-icons.json").icons || {}, read("kicad-context-spec.json").icons || {}])
  for (const [name, ic] of Object.entries(src)) if (!toolbar[name] && !icons[name]) icons[name] = ic;
const out = path.resolve(__dirname, "..", "static", "dist", "kicad-icons.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ icons }));
console.log(`kicad-icons.json: ${Object.keys(icons).length} icons, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
