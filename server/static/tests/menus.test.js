// menus.test.js — the menu tables (server/web/tables.ts) against KiCad's action table and the tool modules:
// every entry names a real KiCad action (or one of ours), every module command has its place in a menu, and no
// module hotkey shadows a different KiCad default without KiCad's meaning being given precedence.  Run:
//   node server/static/tests/menus.test.js
"use strict";
const fs = require("fs"), path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const WEB = path.join(__dirname, "..", "..", "web");
const SPEC = JSON.parse(fs.readFileSync(path.join(WEB, "generated", "kicad-menu-spec.json"), "utf8")).actions;
const CLASS = { sch: "SCH_ACTIONS", pcb: "PCB_ACTIONS" };

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e && e.message).split("\n").join("\n       ")); } }

const meta = (ed, id) => SPEC[`${CLASS[ed]}::${id}`] || SPEC[`ACTIONS::${id}`] || null;
const normKey = (key) => { const parts = key.split("+"); let k = parts.pop() || ""; if (k === "" && key.endsWith("+")) { k = "+"; parts.pop(); } return [...["Ctrl", "Shift", "Alt"].filter((m) => parts.includes(m)), k.length === 1 ? k.toUpperCase() : k].join("+"); };
const moduleKey = (k) => normKey(String(k).replace(/^Delete$/, "Del").replace(/^Insert$/, "Ins").replace(/\+Delete$/, "+Del"));
function owners(ed) {
  const m = new Map();
  for (const cls of [CLASS[ed], "ACTIONS"]) for (const [name, a] of Object.entries(SPEC)) {
    if (!name.startsWith(cls + "::")) continue;
    for (const k of [a.key, a.alt]) { if (!k) continue; const nk = normKey(k); if (!m.has(nk)) m.set(nk, []); m.get(nk).push(a.id); }
  }
  return m;
}
/** Every entry of a menu tree: [{ id, label, trail }] (separators dropped). */
function flatten(entries, trail, out) {
  for (const e of entries) {
    if (e === "-") continue;
    if (Array.isArray(e)) { flatten(e[1], trail.concat(e[0].replace("&", "")), out); continue; }
    const bar = e.indexOf("|"); out.push({ id: bar < 0 ? e : e.slice(0, bar), label: bar < 0 ? null : e.slice(bar + 1), trail });
  }
  return out;
}

(async () => {
  // node ≥ 22.18 loads the TypeScript table directly (it only imports a type)
  const T = await import(path.join(WEB, "tables.ts"));
  console.log("menus under node");

  test("the menu bars carry KiCad's titles, in KiCad's order, with their mnemonics", () => {
    assert.deepStrictEqual(T.MENUS.sch.map((m) => m[0]), ["&File", "&Edit", "&View", "&Place", "&Inspect", "&Tools", "P&references", "&Help"]);
    assert.deepStrictEqual(T.MENUS.pcb.map((m) => m[0]), ["&File", "&Edit", "&View", "&Place", "Ro&ute", "&Inspect", "&Tools", "P&references", "&Help"]);
    for (const ed of ["sch", "pcb"]) { const letters = T.MENUS[ed].map((m) => m[0].charAt(m[0].indexOf("&") + 1).toLowerCase()); assert.strictEqual(new Set(letters).size, letters.length, ed + ": mnemonics are unique"); }
  });

  test("the Footprint Editor's menu bar is menubar_footprint_editor.cpp: KiCad's titles and every entry a KiCad action", () => {
    assert.deepStrictEqual(T.FPEDIT_MENUS.map((m) => m[0]), ["&File", "&Edit", "&View", "&Place", "&Inspect", "&Tools", "P&references", "&Help"]);
    const ids = [];
    for (const [title, entries] of T.FPEDIT_MENUS) for (const e of flatten(entries, [title.replace("&", "")], [])) {
      ids.push(e.id);
      assert.ok(meta("pcb", e.id) || T.LOCAL_LABELS[e.id] || T.LINKS[e.id] || e.label, `fpedit ${e.trail.join(" > ")}: unknown entry "${e.id}"`);
    }
    const place = T.FPEDIT_MENUS.find((m) => m[0] === "&Place")[1].filter((e) => e !== "-");
    assert.deepStrictEqual(place.slice(0, 2), ["placePad", "drawRuleArea"]);
    assert.ok(place.includes("setAnchor") && ids.includes("saveFpToBoard") && ids.includes("loadFpFromBoard") && ids.includes("enumeratePads"));
    // the pad tools and the anchor are tools of the board module, kept out of the board editor
    for (const id of ["placePad", "placeThtPad", "placeSmdPad", "placeNpthPad", "placePasteAperturePad", "setAnchor"]) { assert.ok(T.TOOL_MAP.pcb[id], id); assert.ok(T.FPEDIT_ONLY.has(id), id); }
    for (const [, entries] of T.MENUS.pcb) for (const e of flatten(entries, [], [])) assert.ok(!T.FPEDIT_ONLY.has(e.id), `board menu has footprint-editor-only ${e.id}`);
  });

  test("every entry is a KiCad action of that editor, one of our own entries or a module command", () => {
    for (const ed of ["sch", "pcb"]) {
      const mod = globalThis.CollabTools[ed];
      for (const [title, entries] of T.MENUS[ed]) for (const e of flatten(entries, [title.replace("&", "")], [])) {
        if (e.id.startsWith("module:")) { assert.ok(mod.actions[e.id.slice(7)], `${ed} ${e.trail.join(" > ")}: no module action ${e.id}`); continue; }
        assert.ok(meta(ed, e.id) || T.LOCAL_LABELS[e.id] || T.LINKS[e.id] || mod.actions[e.id], `${ed} ${e.trail.join(" > ")}: unknown entry "${e.id}"`);
      }
    }
  });

  test("no entry is listed twice in one menu panel, no menu starts or ends with a separator", () => {
    const walk = (ed, entries, trail) => {
      const ids = entries.filter((e) => typeof e === "string" && e !== "-").map((e) => e.split("|")[0]);
      assert.strictEqual(new Set(ids).size, ids.length, `${ed} ${trail}: duplicate entry ${ids.filter((x, i) => ids.indexOf(x) !== i)}`);
      assert.ok(entries[0] !== "-" && entries[entries.length - 1] !== "-", `${ed} ${trail}: stray separator`);
      entries.forEach((e, i) => { if (e === "-") assert.notStrictEqual(entries[i - 1], "-", `${ed} ${trail}: doubled separator`); if (Array.isArray(e)) walk(ed, e[1], trail + " > " + e[0]); });
    };
    for (const ed of ["sch", "pcb"]) for (const [title, entries] of T.MENUS[ed]) walk(ed, entries, title);
  });

  test("KiCad's own structure: File > Import / Export, Edit > Select, View > Panels, the board's Drawing Mode, Contrast Mode, Draw Dimensions, Fabrication Outputs", () => {
    const sub = (ed, menu, title) => { const m = T.MENUS[ed].find((x) => x[0].replace("&", "") === menu); const s = m && m[1].find((e) => Array.isArray(e) && e[0].replace("&", "") === title); assert.ok(s, `${ed}: ${menu} > ${title}`); return s[1].filter((e) => e !== "-").map((e) => (Array.isArray(e) ? e[0] : e)); };
    assert.deepStrictEqual(sub("sch", "File", "Import"), ["importNonKicadSchematic|Non-KiCad Schematic...", "importFPAssignments|Footprint Assignments...", "importGraphics|Graphics..."]);
    assert.deepStrictEqual(sub("sch", "File", "Export"), ["drawSheetOnClipboard|Drawing to Clipboard", "exportNetlist|Netlist...", "exportSymbolsToLibrary|Symbols..."]);
    assert.deepStrictEqual(sub("pcb", "File", "Fabrication Outputs"), ["generateGerbers", "generateDrillFiles", "generateIPC2581File", "generateODBPPFile", "generatePosFile", "generateReportFile", "generateD356File", "generateBOM", "generateBOMLegacy", "fabPackage"]);
    assert.deepStrictEqual(sub("pcb", "View", "Drawing Mode"), ["zoneDisplayFilled", "zoneDisplayOutline", "padDisplayMode", "viaDisplayMode", "trackDisplayMode", "graphicsOutlines", "textOutlines"]);
    assert.deepStrictEqual(sub("pcb", "View", "Contrast Mode"), ["highContrastMode", "layerAlphaDec", "layerAlphaInc"]);
    assert.deepStrictEqual(sub("pcb", "Place", "Draw Dimensions"), ["drawOrthogonalDimension", "drawAlignedDimension", "drawCenterDimension", "drawRadialDimension", "drawLeader"]);
    assert.deepStrictEqual(sub("pcb", "Edit", "Select").slice(0, 2), ["selectAll", "unselectAll"]);
    assert.deepStrictEqual(sub("sch", "View", "Panels").slice(0, 3), ["showProperties", "showSearch", "showHierarchy"]);
    assert.deepStrictEqual(sub("pcb", "View", "Panels").slice(0, 5), ["showProperties", "showSearch", "showLayersManager", "showNetInspector", "showConstraintsPanel"]);
  });

  test("every module command has its place in a menu (nothing falls into Other Commands)", () => {
    for (const ed of ["sch", "pcb"]) {
      const placed = new Set(); for (const [title, entries] of T.MENUS[ed]) for (const e of flatten(entries, [title], [])) placed.add(e.id);
      const covered = new Set(T.MODULE_DUPLICATES[ed]);
      for (const id of placed) covered.add(id.startsWith("module:") ? id.slice(7) : id);
      for (const [kicad, own] of Object.entries(T.MODULE_ALIAS[ed])) { assert.ok(placed.has(kicad) || T.MODULE_DUPLICATES[ed].includes(own), `${ed}: alias ${kicad} is not in a menu`); covered.add(own); }
      const seen = new Set(), loose = [];
      for (const a of Object.values(globalThis.CollabTools[ed].actions)) {
        if (covered.has(a.id)) continue;
        const sig = a.label + "\u0000" + (a.key || ""); if (seen.has(sig)) continue; seen.add(sig); loose.push(a.id);
      }
      // a command that repeats a placed one under a second name is fine as long as its twin (same label) is placed
      const placedLabels = new Set(Object.values(globalThis.CollabTools[ed].actions).filter((a) => covered.has(a.id)).map((a) => a.label));
      assert.deepStrictEqual(loose.filter((id) => !placedLabels.has(globalThis.CollabTools[ed].actions[id].label)), [], `${ed}: module commands without a menu entry`);
    }
  });

  test("aliases and editor-only ids point at real things", () => {
    for (const ed of ["sch", "pcb"]) for (const [kicad, own] of Object.entries(T.MODULE_ALIAS[ed])) {
      assert.ok(meta(ed, kicad), `${ed}: ${kicad} is not a KiCad action`); assert.ok(globalThis.CollabTools[ed].actions[own], `${ed}: the module has no ${own}`);
    }
    for (const [id, ed] of Object.entries(T.EDITOR_ONLY)) assert.ok(meta(ed, id), `${id} is not an action of the ${ed} editor`);
    for (const ed of ["sch", "pcb"]) for (const [act, tid] of Object.entries(T.TOOL_MAP[ed])) assert.ok(meta(ed, act), `${ed}: TOOL_MAP ${act} -> ${tid} is not a KiCad action`);
  });

  test("hotkeys: a module key KiCad binds to something else is pre-empted in KiCad's favour", () => {
    for (const ed of ["sch", "pcb"]) {
      const own = owners(ed), mod = globalThis.CollabTools[ed], wins = T.KICAD_KEY_WINS[ed];
      const aliasOf = Object.fromEntries(Object.entries(T.MODULE_ALIAS[ed]).map(([k, v]) => [v, k]));
      const toolActs = {}; for (const [act, tid] of Object.entries(T.TOOL_MAP[ed])) (toolActs[tid] = toolActs[tid] || []).push(act);
      // the module keeps these on purpose: V places a via (KiCad's router does the same; as a tool it is Ctrl+Shift+X),
      // D drags a track segment (KiCad's Drag 45 Degree Mode), ` is Highlight Net under either name
      const same = { pcb: { via: "V", drag: "D", highlightNetSelection: "`", pack: "P" }, sch: { highlight: "`" } }[ed];
      const clash = [];
      for (const a of Object.values(mod.actions)) { if (!a.key) continue; const k = moduleKey(a.key), o = own.get(k) || []; if (o.length && !o.includes(a.id) && !o.includes(aliasOf[a.id]) && same[a.id] !== k && !wins[k]) clash.push(`${a.id} on ${k} (KiCad: ${o})`); }
      for (const t of mod.tools) { if (!t.key) continue; const k = moduleKey(t.key), o = own.get(k) || []; if (o.length && !(toolActs[t.id] || []).some((x) => o.includes(x)) && same[t.id] !== k && !wins[k]) clash.push(`tool ${t.id} on ${k} (KiCad: ${o})`); }
      assert.deepStrictEqual(clash, [], ed + ": module keys that shadow a KiCad default");
    }
  });

  test("hotkeys: KiCad's defaults named in the hotkey list resolve to the expected action", () => {
    const has = (ed, key, id) => (owners(ed).get(normKey(key)) || []).includes(id);
    const sch = { W: "drawWire", B: "drawBus", L: "placeLabel", "Ctrl+L": "placeGlobalLabel", H: "placeHierLabel", J: "placeJunction", Q: "placeNoConnect", A: "placeSymbol", P: "placePower", R: "rotateCCW", X: "mirrorH", Y: "mirrorV",
      M: "move", G: "drag", E: "properties", V: "editValue", U: "editReference", F: "editFootprint", C: "unfoldBus", Del: "doDelete", Ins: "repeatDrawItem", "Ctrl+F": "find", F1: "zoomIn", F2: "zoomOut", F5: "zoomRedraw", F4: "zoomCenter",
      Home: "zoomFitScreen", Space: "resetLocalCoords", S: "drawSheet", T: "placeSchematicText", Z: "placeBusWireEntry", I: "drawLines", O: "autoplaceFields", "Shift+Space": "lineModeNext", "Ctrl+Y": "redo", "Ctrl+D": "duplicate" };
    const pcb = { X: "routeSingleTrack", M: "move", D: "drag45Degree", E: "properties", F: "flip", R: "rotateCcw", "Shift+R": "rotateCw", PgUp: "layerTop", PgDn: "layerBottom", W: "trackWidthInc", "Shift+W": "trackWidthDec", B: "zoneFillAll",
      "Ctrl+B": "zoneUnfillAll", "`": "highlightNet", N: "gridNext", "Shift+N": "gridPrev", "+": "layerNext", "-": "layerPrev", "'": "viaSizeInc", "\\": "viaSizeDec", "Ctrl+Shift+Z": "drawZone", "Ctrl+Shift+X": "drawVia",
      "Ctrl+Shift+L": "drawLine", "Ctrl+Shift+T": "placeText", L: "toggleLock", U: "selectConnection", "Shift+M": "moveExact", "Ctrl+U": "toggleUnits", "Ctrl+F1": "listHotKeys", H: "highContrastModeCycle" };
    for (const [k, id] of Object.entries(sch)) assert.ok(has("sch", k, id), `schematic ${k} should be ${id}, is ${owners("sch").get(normKey(k))}`);
    for (const [k, id] of Object.entries(pcb)) assert.ok(has("pcb", k, id), `board ${k} should be ${id}, is ${owners("pcb").get(normKey(k))}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
