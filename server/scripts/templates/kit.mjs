// kit.mjs: what gen.mjs builds a starter template with.  A template is described as a schematic
// (symbols from KiCad's own libraries, wires, power symbols, labels) and a placement for the board;
// everything else comes from KiCad itself: the netlist, the zone fill and the saved files.
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
import { createRequire } from "node:module"; import { fileURLToPath } from "node:url"; import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
export const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.join(HERE, "..", "..", "static");
require(path.join(STATIC, "kicad-canvas.js")); require(path.join(STATIC, "pcb-tools.js")); require(path.join(STATIC, "dist", "autoroute.js"));
export const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, R = globalThis.PcbAutoRouter;

/** KiCad's own libraries, copied out of the kicad/kicad:10.0 image (see README.md); lib/ keeps the few files in use. */
const SHARE = process.env.KICAD_SHARE || "";
const LIB = path.join(HERE, "lib");
export const IMAGE = process.env.KICAD_IMAGE || "kicad/kicad:10.0";

export const r3 = (v) => Math.round(v * 1000) / 1000;
export const q = (s) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
const kid = K.kid, kids = K.kids;

/** KiCad's file layout: one token per line, tab indented, short lists inline. */
export function pretty(node, depth = 0) {
  const ind = "\t".repeat(depth);
  const inline = new Set(["xy", "at", "size", "start", "end", "mid", "center", "offset", "drill", "layers", "color", "font", "justify", "stroke", "width", "type", "net", "pts", "uuid", "layer", "thickness", "hide", "fill", "effects", "radius", "rect_delta", "page", "reference", "unit", "path"]);
  if (node.every((c) => !Array.isArray(c)) || (inline.has(node[0]) && JSON.stringify(node).length < 110)) return ind + K.serialize(node);
  const head = []; let j = 0;
  for (; j < node.length && !Array.isArray(node[j]); j++) head.push(node[j]);
  let out = ind + headText(node, j);
  out += "\n";
  for (; j < node.length; j++) out += (Array.isArray(node[j]) ? pretty(node[j], depth + 1) : "\t".repeat(depth + 1) + atomText(node, j)) + "\n";
  return out + ind + ")";
}
function atomText(node, j) { const c = node[j], mask = K.quotedMask(node); return typeof c === "number" ? String(r3(c)) : (j < 30 && (mask >> j) & 1) ? q(c) : String(c); }
function headText(node, n) { let out = "("; for (let j = 0; j < n; j++) out += (j ? " " : "") + atomText(node, j); return out; }

// ------------------------------------------------------------------ libraries

/** The text of one top-level symbol of a library file. */
function sliceSymbol(text, name) {
  const start = text.indexOf(`\n\t(symbol ${q(name)}\n`);
  if (start < 0) return null;
  const end = text.indexOf("\n\t)\n", start);
  return text.slice(start + 1, end + 3);
}
/** A library symbol as a schematic keeps it: a derived symbol is stored flattened, with its parent's body. */
export function libSymbol(id) {
  const file = path.join(LIB, "sym", id.replace(":", "__") + ".kicad_sym");
  if (!fs.existsSync(file)) {
    if (!SHARE) throw new Error(`lib/sym has no ${id}; set KICAD_SHARE to a copy of KiCad's share folder to fetch it`);
    const [lib, name] = id.split(":");
    const text = fs.readFileSync(path.join(SHARE, "symbols", lib + ".kicad_sym"), "utf8");
    const own = sliceSymbol(text, name); if (!own) throw new Error("no symbol " + id);
    let node = K.parse(own);
    const ext = kid(node, "extends");
    if (ext) {
      const parentName = K.str(ext[1]), parent = K.parse(sliceSymbol(text, parentName));
      const head = parent.slice(2).filter((c) => Array.isArray(c) && c[0] !== "property" && c[0] !== "symbol" && c[0] !== "embedded_fonts");
      const props = node.slice(2).filter((c) => Array.isArray(c) && c[0] === "property");
      const units = kids(parent, "symbol").map((u) => { u[1] = name + K.str(u[1]).slice(parentName.length); return u; });
      const tail = parent.slice(2).filter((c) => Array.isArray(c) && c[0] === "embedded_fonts");
      const flat = K.parse(`(symbol ${q(name)})`);
      node = [...flat, ...head, ...props, ...units, ...tail];
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, K.serialize(node).replace(/^\(symbol [^ )]+/, `(symbol ${q(name)}`) + "\n");
    } else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, own.replace(/^\t/gm, "") + "\n"); }
  }
  const node = K.parse(fs.readFileSync(file, "utf8"));
  return node;
}
export function libFootprint(id) {
  const file = path.join(LIB, "fp", id.replace(":", "__") + ".kicad_mod");
  if (!fs.existsSync(file)) {
    if (!SHARE) throw new Error(`lib/fp has no ${id}; set KICAD_SHARE to a copy of KiCad's share folder to fetch it`);
    const [lib, name] = id.split(":");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(SHARE, "footprints", lib + ".pretty", name + ".kicad_mod"), file);
  }
  return K.parse(fs.readFileSync(file, "utf8"));
}

// ------------------------------------------------------------------ KiCad itself

/** Run kicad-cli in the official image on a folder; returns what it printed. */
export function kicad(dir, args) {
  fs.chmodSync(dir, 0o777);
  for (const f of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, f), 0o666);
  try { return execFileSync("docker", ["run", "--rm", "-v", `${dir}:/w`, "-w", "/w", IMAGE, "kicad-cli", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { return String(e.stdout || "") + String(e.stderr || ""); }
}

// ------------------------------------------------------------------ schematic

export class Schematic {
  constructor(stem, title, paper) {
    this.stem = stem; this.title = title; this.paper = paper || '"A4"';
    this.uuid = (name) => { const h = crypto.createHash("sha1").update(stem + "/" + name).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
    this.root = this.uuid("sheet");
    this.libs = new Map(); this.syms = []; this.items = []; this.segs = []; this.pins = {}; this.nPwr = 0; this.nFlg = 0; this.n = 0;
  }
  lib(id) { if (!this.libs.has(id)) { const s = libSymbol(id); s[1] = id; this.libs.set(id, s); } return this.libs.get(id); }
  field(name, value, x, y, angle, justify, hide) {
    return `(property ${q(name)} ${q(value)} (at ${r3(x)} ${r3(y)} ${angle || 0}) (effects (font (size 1.27 1.27))${justify ? ` (justify ${justify})` : ""}${hide ? " (hide yes)" : ""}))`;
  }
  /** Place a symbol.  `rf` / `vf`: where the reference and value go, [dx, dy, justify, angle]. */
  sym(ref, id, value, fp, x, y, rot = 0, rf = [2.54, -1.27, "left"], vf = [2.54, 1.27, "left"], opts = {}) {
    const lib = this.lib(id), key = opts.key || ref;
    const prop = (n) => { const p = kids(lib, "property").find((c) => K.str(c[1]) === n); return p ? K.str(p[2]) : ""; };
    const pins = []; for (const sub of kids(lib, "symbol")) for (const p of kids(sub, "pin")) pins.push(K.str(kid(p, "number")[1]));
    const hideRef = ref.startsWith("#");
    const text = `(symbol (lib_id ${q(id)}) (at ${r3(x)} ${r3(y)} ${rot}) (unit 1) (exclude_from_sim no) (in_bom ${opts.power ? "no" : "yes"}) (on_board yes) (dnp no) (fields_autoplaced yes) (uuid ${q(this.uuid("sym/" + key))})
      ${this.field("Reference", ref, x + rf[0], y + rf[1], rf[3], rf[2], hideRef)} ${this.field("Value", value, x + vf[0], y + vf[1], vf[3], vf[2], opts.hideValue)}
      ${this.field("Footprint", fp || "", x, y, 0, "", true)} ${this.field("Datasheet", prop("Datasheet"), x, y, 0, "", true)} ${this.field("Description", prop("Description"), x, y, 0, "", true)}
      ${[...new Set(pins)].map((n) => `(pin ${q(n)} (uuid ${q(this.uuid(`pin/${key}/${n}`))}))`).join(" ")}
      (instances (project ${q(this.stem)} (path ${q("/" + this.root)} (reference ${q(ref)}) (unit 1)))))`;
    const node = K.parse(text);
    this.syms.push({ key, ref, id, node, x, y, description: prop("Description"), datasheet: prop("Datasheet") });
    // Pin positions come from the renderer's own symbol maths, so a wire end is exactly on its pin.
    const probe = K.parseDoc(`(kicad_sch (version 20250114) (generator "eeschema") (lib_symbols ${K.serialize(lib)}) ${K.serialize(node)})`);
    for (const p of K.pinPoints(probe, probe.items.get(this.uuid("sym/" + key)))) {
      const at = [r3(p.x), r3(p.y)];
      this.pins[`${key}.${p.number}`] = at; if (!(`${key}.${p.name}` in this.pins)) this.pins[`${key}.${p.name}`] = at;
    }
    return key;
  }
  pin(name) { if (!this.pins[name]) throw new Error("no pin " + name + " (have " + Object.keys(this.pins).filter((k) => k.startsWith(name.split(".")[0] + ".")).join(" ") + ")"); return this.pins[name]; }
  at(p) { return typeof p === "string" ? this.pin(p) : p; }
  /** A power symbol with its pin at (x, y).  Rotation 0 points up for a rail and down for ground, as the library draws them. */
  power(id, x, y, rot = 0) {
    const name = id.split(":")[1], key = "P" + (++this.n), ground = /GND/.test(name);
    const dy = ground ? 6.35 : -6.35, vy = ground ? 3.81 : -3.556;
    const turn = (dx, d) => rot === 180 ? [-dx, -d] : rot === 90 ? [d, -dx] : rot === 270 ? [-d, dx] : [dx, d];
    const [rx, ry] = turn(0, dy), [vx, vv] = turn(0, vy);
    const just = rot === 90 ? (ground ? "left" : "right") : rot === 270 ? (ground ? "right" : "left") : "";
    return this.sym("#PWR" + String(++this.nPwr).padStart(2, "0"), id, name, "", x, y, rot, [rx, ry, ""], [vx, vv, just], { key, power: true });
  }
  /** KiCad's PWR_FLAG on a wire: tells ERC the net is driven from outside the sheet. */
  flag(x, y, rot = 0) {
    const key = "F" + (++this.n);
    const off = rot === 180 ? 1 : -1;
    return this.sym("#FLG" + String(++this.nFlg).padStart(2, "0"), "power:PWR_FLAG", "PWR_FLAG", "", x, y, rot, [0, off * 1.905, ""], [0, off * 4.445, ""], { key, power: true });
  }
  /** Ground straight below a pin (or `len` further down a wire). */
  gnd(p, len = 0, id = "power:GND") { const [x, y] = this.at(p); if (len) this.wire([x, y], [x, y + len]); return this.power(id, x, y + len); }
  /** A rail straight above a pin. */
  rail(id, p, len = 0) { const [x, y] = this.at(p); if (len) this.wire([x, y], [x, y - len]); return this.power(id, x, y - len); }
  /** Wire through the given points.  Two points that do not line up get a corner: across first, or down first after "|". */
  wire(...pts) {
    let prev = null, vfirst = false;
    for (const raw of pts) {
      if (raw === "|") { vfirst = true; continue; }
      const p = this.at(raw);
      if (prev) {
        const legs = prev[0] === p[0] || prev[1] === p[1] ? [prev, p] : vfirst ? [prev, [prev[0], p[1]], p] : [prev, [p[0], prev[1]], p];
        for (let i = 1; i < legs.length; i++) {
          const a = legs[i - 1], b = legs[i]; if (a[0] === b[0] && a[1] === b[1]) continue;
          this.segs.push([a, b]);
        }
      }
      prev = p; vfirst = false;
    }
  }
  label(name, p, rot = 0, justify = "left bottom") {
    const [x, y] = this.at(p);
    this.items.push(`(label ${q(name)} (at ${x} ${y} ${rot}) (effects (font (size 1.27 1.27)) (justify ${justify})) (uuid ${q(this.uuid("label/" + (++this.n)))}))`);
    this.ends = this.ends || []; this.ends.push([x, y]);
  }
  /** A titled section: a dashed frame with its name in bold at the top left.  Parts inside are wired; only labels and power symbols leave it. */
  frame(title, x0, y0, x1, y1) {
    this.items.push(`(rectangle (start ${x0} ${y0}) (end ${x1} ${y1}) (stroke (width 0) (type dash)) (fill (type none)) (uuid ${q(this.uuid("frame/" + title))}))`);
    this.items.push(`(text ${q(title)} (exclude_from_sim no) (at ${x0 + 2.54} ${y0 + 6.35} 0) (effects (font (size 2.54 2.54) (thickness 0.508) (bold yes)) (justify left bottom)) (uuid ${q(this.uuid("title/" + title))}))`);
  }
  /** A resistor lying in line with a pin, `gap` to its right (or left when negative).  Returns the far end. */
  inline(ref, value, fp, from, gap = 5.08) {
    const [x, y] = this.at(from), dir = gap < 0 ? -1 : 1, cx = x + gap + dir * 3.81;
    this.sym(ref, "Device:R", value, fp, cx, y, 90, [-dir * 5.08, -1.016, "", 90], [dir * 5.588, -1.016, "", 90]);
    const a = this.pin(ref + ".1"), b = this.pin(ref + ".2"), near = Math.abs(a[0] - x) < Math.abs(b[0] - x) ? a : b;
    this.wire([x, y], near);
    return near === a ? b : a;
  }
  nc(p) { const [x, y] = this.at(p); this.items.push(`(no_connect (at ${x} ${y}) (uuid ${q(this.uuid("nc/" + (++this.n)))}))`); }
  text(s, x, y, size = 1.27) { this.items.push(`(text ${q(s)} (exclude_from_sim no) (at ${x} ${y} 0) (effects (font (size ${size} ${size})) (justify left bottom)) (uuid ${q(this.uuid("text/" + (++this.n)))}))`); }
  /** KiCad only joins things at wire ends, so a wire is cut wherever a pin, a label or another wire's end lands on it. */
  split() {
    const pts = [...Object.values(this.pins), ...(this.ends || []), ...this.segs.flat()];
    const out = [];
    for (const [a, b] of this.segs) {
      const on = pts.filter((p) => (a[0] === b[0] && p[0] === a[0] && p[1] > Math.min(a[1], b[1]) && p[1] < Math.max(a[1], b[1])) || (a[1] === b[1] && p[1] === a[1] && p[0] > Math.min(a[0], b[0]) && p[0] < Math.max(a[0], b[0])));
      const d = (p) => Math.abs(p[0] - a[0]) + Math.abs(p[1] - a[1]);
      const chain = [a, ...on.sort((p, o) => d(p) - d(o)).filter((p, i, l) => !i || d(p) !== d(l[i - 1])), b];
      for (let i = 1; i < chain.length; i++) out.push([chain[i - 1], chain[i]]);
    }
    this.segs = out;
  }
  /** A dot wherever three or more wire ends and pins meet. */
  junctions() {
    const ends = new Map(), bump = (p) => ends.set(p[0] + "," + p[1], (ends.get(p[0] + "," + p[1]) || 0) + 1);
    for (const [a, b] of this.segs) { bump(a); bump(b); }
    const pinAt = new Set(Object.values(this.pins).map((p) => p[0] + "," + p[1]));
    const out = [];
    for (const [k, n] of ends) {
      const [x, y] = k.split(",").map(Number);
      const mid = this.segs.some(([a, b]) => (a[0] === b[0] && a[0] === x && y > Math.min(a[1], b[1]) && y < Math.max(a[1], b[1])) || (a[1] === b[1] && a[1] === y && x > Math.min(a[0], b[0]) && x < Math.max(a[0], b[0])));
      if (n + (pinAt.has(k) ? 1 : 0) + (mid ? 2 : 0) >= 3) out.push([x, y]);
    }
    return out;
  }
  render(meta) {
    this.split();
    const wires = this.segs.map(([a, b], i) => `(wire (pts (xy ${a[0]} ${a[1]}) (xy ${b[0]} ${b[1]})) (stroke (width 0) (type default)) (uuid ${q(this.uuid("wire/" + i))}))`);
    for (const [a, b] of this.segs) for (const p of [a, b]) for (const v of p) if (Math.abs(v / 1.27 - Math.round(v / 1.27)) > 1e-6) throw new Error(`wire point ${p} is off the 1.27 mm grid`);
    const j = this.junctions().map(([x, y], i) => `(junction (at ${x} ${y}) (diameter 0) (color 0 0 0 0) (uuid ${q(this.uuid("junction/" + i))}))`);
    return `(kicad_sch (version 20250114) (generator "eeschema") (generator_version "9.0") (uuid ${q(this.root)}) (paper ${this.paper})
  (title_block (title ${q(this.title)}) (date ${q(meta.date)}) (rev ${q(meta.rev)}) (company "Junction") (comment 1 ${q(meta.comment)}))
  (lib_symbols ${[...this.libs.values()].map((s) => K.serialize(s)).join(" ")})
  ${j.join("\n")}
  ${wires.join("\n")}
  ${this.items.join("\n")}
  ${this.syms.map((s) => K.serialize(s.node)).join("\n")}
  (sheet_instances (path "/" (page "1"))) (embedded_fonts no))\n`;
  }
}

// ------------------------------------------------------------------ board

const LAYERS = `(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (9 "F.Adhes" user "F.Adhesive") (11 "B.Adhes" user "B.Adhesive") (13 "F.Paste" user) (15 "B.Paste" user)
  (5 "F.SilkS" user "F.Silkscreen") (7 "B.SilkS" user "B.Silkscreen") (1 "F.Mask" user) (3 "B.Mask" user) (17 "Dwgs.User" user "User.Drawings") (19 "Cmts.User" user "User.Comments")
  (21 "Eco1.User" user "User.Eco1") (23 "Eco2.User" user "User.Eco2") (25 "Edge.Cuts" user) (27 "Margin" user) (31 "F.CrtYd" user "F.Courtyard") (29 "B.CrtYd" user "B.Courtyard") (35 "F.Fab" user) (33 "B.Fab" user))`;

/** KiCad's netlist of the schematic: { nets: [name], pad: { "R1.2": netIndex }, parts: [{ ref, value, footprint, uuid }] }. */
export function netlist(dir, stem) {
  const out = kicad(dir, ["sch", "export", "netlist", "--format", "kicadsexpr", "-o", "netlist.net", stem + ".kicad_sch"]);
  const file = path.join(dir, "netlist.net");
  if (!fs.existsSync(file)) throw new Error("kicad-cli wrote no netlist: " + out);
  const root = K.parse(fs.readFileSync(file, "utf8")); fs.unlinkSync(file);
  const parts = kids(kid(root, "components"), "comp").map((c) => {
    const get = (k) => { const n = kid(c, k); return n ? K.str(n[1]) : ""; };
    const fields = {}; const fl = kid(c, "fields"); if (fl) for (const f of kids(fl, "field")) fields[K.str(kid(f, "name")[1])] = f.length > 2 ? K.str(f[2]) : "";
    return { ref: get("ref"), value: get("value"), footprint: get("footprint"), datasheet: get("datasheet"), description: get("description") || fields.Description || "", uuid: K.str(kid(c, "tstamps")[1]) };
  });
  const nets = [""], pad = {};
  for (const n of kids(kid(root, "nets"), "net")) {
    const name = K.str(kid(n, "name")[1]); if (/^unconnected-/.test(name)) { /* a pin with a no-connect mark keeps its own net, as pcbnew does */ }
    nets.push(name);
    for (const node of kids(n, "node")) pad[`${K.str(kid(node, "ref")[1])}.${K.str(kid(node, "pin")[1])}`] = nets.length - 1;
  }
  return { nets, pad, parts };
}

export class Board {
  /** `origin`: where the board's corner sits on the page; `size`: [w, h, corner radius]. */
  constructor(sch, nl, origin, size) {
    this.sch = sch; this.nl = nl; this.ox = origin[0]; this.oy = origin[1]; this.w = size[0]; this.h = size[1]; this.r = size[2] || 0;
    this.fps = []; this.items = []; this.n = 0; this.uuid = sch.uuid;
  }
  footprint(ref, libId, value, x, y, rot, opts = {}) {
    const src = libFootprint(libId), part = this.nl.parts.find((p) => p.ref === ref), uuid = this.uuid, sym = this.sch.syms.find((p) => p.ref === ref);
    const id = uuid("fp/" + ref);
    const out = [K.parse(`(layer "F.Cu")`), K.parse(`(uuid ${q(id)})`), ["at", r3(this.ox + x), r3(this.oy + y), ...(rot ? [rot] : [])]];
    const turn = (at) => { if (!at) return; const a = ((at[3] || 0) + rot) % 360; if (a) at[3] = a; else at.length = 3; };
    let padNo = 0, shape = 0; const body = [];
    for (const c of src.slice(2)) {
      if (!Array.isArray(c)) continue;
      const k = c[0];
      if (k === "version" || k === "generator" || k === "generator_version" || k === "layer" || k === "embedded_fonts") continue;
      if (k === "attr" && opts.boardOnly) { for (const flag of ["board_only", "exclude_from_pos_files", "exclude_from_bom"]) if (!c.includes(flag)) c.push(flag); }
      if (k === "property") {
        const name = K.str(c[1]);
        if (name === "Reference") { c[2] = ref; if (opts.refAt) { const at = kid(c, "at"); at[1] = opts.refAt[0]; at[2] = opts.refAt[1]; } }
        if (name === "Value") c[2] = value;
        if (name === "Datasheet" && sym) c[2] = sym.datasheet;
        if (name === "Description" && sym) c[2] = sym.description;
        // Footprint text stays readable: it turns with the footprint only as far as it stays upright.
        const at = kid(c, "at"); if (at) { const a = name === "Reference" ? (opts.refAngle || 0) : (((at[3] || 0) + rot) % 180 + 180) % 180; if (a) at[3] = a; else at.length = 3; }
        const u = kid(c, "uuid"); if (u) u[1] = uuid(`fp/${ref}/prop/${name}`);
        if (opts.hideRef && name === "Reference" && !kid(c, "hide")) c.splice(c.indexOf(kid(c, "effects")), 0, K.parse("(hide yes)"));
      } else if (k === "pad") {
        const num = K.str(c[1]); turn(kid(c, "at"));
        const net = this.nl.pad[`${ref}.${num}`];
        const u = kid(c, "uuid"), pid = uuid(`fp/${ref}/pad/${num}/${padNo++}`); if (u) u[1] = pid; else c.push(K.parse(`(uuid ${q(pid)})`));
        if (net) c.splice(c.length - 1, 0, K.parse(`(net ${net} ${q(this.nl.nets[net])})`));
      } else if (k === "fp_text") { turn(kid(c, "at")); const u = kid(c, "uuid"); if (u) u[1] = uuid(`fp/${ref}/text/${shape++}`); }
      else { const u = kid(c, "uuid"); if (u) u[1] = uuid(`fp/${ref}/shape/${shape++}`); }
      body.push(c);
    }
    // pcbnew gives a footprint the symbol's datasheet and description; the library file may not carry the fields at all
    for (const name of ["Datasheet", "Description"]) {
      if (!sym || body.some((c) => c[0] === "property" && K.str(c[1]) === name)) continue;
      body.push(K.parse(`(property ${q(name)} ${q(sym[name.toLowerCase()])} (at 0 0 ${rot % 180 ? 90 : 0}) (unlocked yes) (layer "F.Fab") (hide yes) (uuid ${q(uuid(`fp/${ref}/prop/${name}`))}) (effects (font (size 1.27 1.27) (thickness 0.15))))`));
    }
    if (opts.boardOnly && !body.some((c) => c[0] === "attr")) body.push(K.parse("(attr board_only exclude_from_pos_files exclude_from_bom)"));
    const head = body.filter((c) => c[0] === "descr" || c[0] === "tags"), rest = body.filter((c) => c[0] !== "descr" && c[0] !== "tags");
    const props = rest.filter((c) => c[0] === "property"), other = rest.filter((c) => c[0] !== "property");
    const link = part ? [K.parse(`(path ${q("/" + part.uuid)})`), K.parse('(sheetname "/")'), K.parse(`(sheetfile ${q(this.sch.stem + ".kicad_sch")})`)] : [];
    const text = `(footprint ${q(libId)} ` + [...out, ...head, ...props, ...link, ...other].map((c) => K.serialize(c)).join(" ") + ")";
    this.fps.push({ ref, id, text, x: this.ox + x, y: this.oy + y });
  }
  /** Place every part of the netlist: `where[ref] = [x, y, rot, { refAt }]`. */
  place(where) {
    for (const p of this.nl.parts) {
      const at = where[p.ref]; if (!at) throw new Error("no place for " + p.ref);
      if (!p.footprint) throw new Error(p.ref + " has no footprint");
      this.footprint(p.ref, p.footprint, p.value, at[0], at[1], at[2] || 0, at[3] || {});
    }
  }
  hole(n, x, y, libId = "MountingHole:MountingHole_2.2mm_M2", value = "M2") { this.footprint("H" + n, libId, value, x, y, 0, { boardOnly: true, hideRef: true }); }
  edge() {
    const X0 = this.ox, Y0 = this.oy, X1 = X0 + this.w, Y1 = Y0 + this.h, BR = this.r, k = BR * (1 - Math.SQRT1_2);
    const E = (kind, body) => this.items.push(`(${kind} ${body} (stroke (width 0.1) (type default)) (layer "Edge.Cuts") (uuid ${q(this.uuid("edge/" + (++this.n)))}))`);
    E("gr_line", `(start ${X0 + BR} ${Y0}) (end ${X1 - BR} ${Y0})`); E("gr_line", `(start ${X1} ${Y0 + BR}) (end ${X1} ${Y1 - BR})`);
    E("gr_line", `(start ${X1 - BR} ${Y1}) (end ${X0 + BR} ${Y1})`); E("gr_line", `(start ${X0} ${Y1 - BR}) (end ${X0} ${Y0 + BR})`);
    if (BR) {
      E("gr_arc", `(start ${X1 - BR} ${Y0}) (mid ${r3(X1 - k)} ${r3(Y0 + k)}) (end ${X1} ${Y0 + BR})`); E("gr_arc", `(start ${X1} ${Y1 - BR}) (mid ${r3(X1 - k)} ${r3(Y1 - k)}) (end ${X1 - BR} ${Y1})`);
      E("gr_arc", `(start ${X0 + BR} ${Y1}) (mid ${r3(X0 + k)} ${r3(Y1 - k)}) (end ${X0} ${Y1 - BR})`); E("gr_arc", `(start ${X0} ${Y0 + BR}) (mid ${r3(X0 + k)} ${r3(Y0 + k)}) (end ${X0 + BR} ${Y0})`);
    }
  }
  silk(s, x, y, size = 1, thickness = 0.15, angle = 0) {
    this.items.push(`(gr_text ${q(s)} (at ${r3(this.ox + x)} ${r3(this.oy + y)}${angle ? " " + angle : ""}) (layer "F.SilkS") (uuid ${q(this.uuid("silk/" + (++this.n)))}) (effects (font (size ${size} ${size}) (thickness ${thickness}))))`);
  }
  net(name) { const i = this.nl.nets.indexOf(name); if (i < 0) throw new Error("no net " + name + " (have " + this.nl.nets.join(", ") + ")"); return i; }
  /** A ground pour over the whole board on the given layers. */
  pour(netName, layers, inset = 0.5) {
    const n = this.net(netName), X0 = this.ox + inset, Y0 = this.oy + inset, X1 = this.ox + this.w - inset, Y1 = this.oy + this.h - inset;
    for (const layer of layers) this.items.push(`(zone (net ${n}) (net_name ${q(netName)}) (layer ${q(layer)}) (uuid ${q(this.uuid("zone/" + layer))}) (hatch edge 0.5) (connect_pads yes (clearance 0.3)) (min_thickness 0.25) (filled_areas_thickness no)
      (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts (xy ${X0} ${Y0}) (xy ${X1} ${Y0}) (xy ${X1} ${Y1}) (xy ${X0} ${Y1}))))`);
  }
  /** A hand-drawn track through board-local points; `via` drops one at the end. */
  track(netName, layer, width, pts, via) {
    const n = this.net(netName);
    for (let i = 1; i < pts.length; i++) this.items.push(`(segment (start ${r3(this.ox + pts[i - 1][0])} ${r3(this.oy + pts[i - 1][1])}) (end ${r3(this.ox + pts[i][0])} ${r3(this.oy + pts[i][1])}) (width ${width}) (layer ${q(layer)}) (net ${n}) (uuid ${q(this.uuid("track/" + (++this.n)))}))`);
    if (via) this.via(netName, pts[pts.length - 1][0], pts[pts.length - 1][1]);
  }
  via(netName, x, y, size = 0.6, drill = 0.3) {
    this.items.push(`(via (at ${r3(this.ox + x)} ${r3(this.oy + y)}) (size ${size}) (drill ${drill}) (layers "F.Cu" "B.Cu") (net ${this.net(netName)}) (uuid ${q(this.uuid("via/" + (++this.n)))}))`);
  }
  render(meta, extra = "") {
    return `(kicad_pcb (version 20241229) (generator "pcbnew") (generator_version "9.0") (general (thickness 1.6) (legacy_teardrops no)) (paper "A4")
  (title_block (title ${q(this.sch.title)}) (date ${q(meta.date)}) (rev ${q(meta.rev)}) (company "Junction") (comment 1 ${q(meta.comment)}))
  ${LAYERS}
  (setup (pad_to_mask_clearance 0) (allow_soldermask_bridges_in_footprints no) (tenting front back) (grid_origin ${this.ox} ${this.oy}))
  ${this.nl.nets.map((n, i) => `(net ${i} ${q(n)})`).join(" ")}
  ${this.fps.map((f) => f.text).join("\n")}
  ${this.items.join("\n")}
  ${extra}
  (embedded_fonts no))\n`;
  }
  /** Route what the hand-drawn tracks left open with the editor's own autorouter; returns the new items as text. */
  autoroute(text, settings, opts = {}) {
    const doc = K.parseDoc(text, "kicad_pcb"), s = P.designSettings(settings);
    const res = R.route(K, P, doc, s, { passes: 3, ...opts });
    return { res, text: res.items.map((it) => K.serialize(it.node)).join("\n") };
  }
}
