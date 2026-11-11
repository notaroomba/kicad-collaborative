// node server/scripts/landing-demo/fill.cjs
//
// Has KiCad itself fill the demo board's ground pour, then checks both demo files with KiCad's
// own ERC and DRC.  Needs docker (image kicad/kicad:10.0).  The fill is kept in
// lib/zone-fill.json and gen.cjs puts it into blinker.kicad_pcb; run this again whenever gen.cjs
// changes the board.  Exits non-zero if KiCad reports anything at all.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto"), { execFileSync } = require("child_process");
require(path.join(__dirname, "..", "..", "static", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas;
const IMAGE = "kicad/kicad:10.0", OUT = path.join(__dirname, "..", "..", "web", "landing", "demo");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blinker-")); fs.chmodSync(dir, 0o777);
const gen = (env) => execFileSync("node", [path.join(__dirname, "gen.cjs")], { env: Object.assign({}, process.env, env), stdio: "inherit" });
const kicad = (...args) => {
  try { execFileSync("docker", ["run", "--rm", "-v", dir + ":/w", "-w", "/w", IMAGE, "kicad-cli", ...args], { stdio: "pipe" }); return 0; }
  catch (e) { if (e.status == null) throw e; return e.status; }
};
const put = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); fs.chmodSync(f, 0o666); return f; };
const flat = (n) => {
  const mask = K.quotedMask(n);
  return "(" + n.map((c, j) => Array.isArray(c) ? flat(c) : typeof c === "number" ? String(c) : (j < 30 && (mask >> j) & 1) ? JSON.stringify(c) : String(c)).join(" ") + ")";
};

// 1. The board as generated, unfilled; KiCad fills it and saves it.
const bareFile = path.join(dir, "bare.kicad_pcb");
gen({ BLINKER_UNFILLED: bareFile });
const bare = fs.readFileSync(bareFile, "utf8");
put("fill.kicad_pcb", bare);
kicad("pcb", "drc", "--refill-zones", "--save-board", "-o", "fill.rpt", "fill.kicad_pcb");
const filled = K.parse(fs.readFileSync(path.join(dir, "fill.kicad_pcb"), "utf8"));
const polygons = K.kids(K.kids(filled, "zone")[0], "filled_polygon").map(flat);
if (!polygons.length) throw new Error("KiCad wrote no fill for the ground pour");
fs.writeFileSync(path.join(__dirname, "lib", "zone-fill.json"), JSON.stringify({ hash: crypto.createHash("sha1").update(bare).digest("hex"), by: IMAGE, polygons }) + "\n");

// 2. The files the site ships, checked as they are (no refill).
gen({});
put("blinker.kicad_sch", fs.readFileSync(path.join(OUT, "blinker.kicad_sch"), "utf8"));
put("blinker.kicad_pcb", fs.readFileSync(path.join(OUT, "blinker.kicad_pcb"), "utf8"));
const erc = kicad("sch", "erc", "--severity-all", "--exit-code-violations", "-o", "erc.rpt", "blinker.kicad_sch");
const drc = kicad("pcb", "drc", "--severity-all", "--schematic-parity", "--exit-code-violations", "-o", "drc.rpt", "blinker.kicad_pcb");
const show = (f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter((l) => l.trim() && !/^\s*(\*\* Ignored|- )/.test(l)).join("\n");
console.log(`${polygons.length} filled polygon(s) from ${IMAGE}`);
console.log(erc ? show("erc.rpt") : "ERC: clean");
console.log(drc ? show("drc.rpt") : "DRC (with schematic parity): clean");
process.exit(erc || drc ? 1 : 0);
