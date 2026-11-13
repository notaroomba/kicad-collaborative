// node server/static/tests/odb.test.js — the ODB++ writer (server/web/fab/odb.ts) on KiCad's demo boards.
// Every job is read back with a small ODB++ reader written here from the format's record layouts, and checked
// against the board model and against the Gerber and drill files the same bundle writes: record counts, symbol and
// attribute tables, the net / subnet / feature links of eda/data, components and their toeprints, surface winding.
// `npm run build` must have produced static/dist/fab.js and static/kicad-canvas.js first.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "dist", "fab.js"));
const K = globalThis.KiCadCanvas, F = globalThis.KiCadFab;

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok  ", name); } catch (e) { failed++; console.error("FAIL", name + ":", e.message); } }

const demos = path.join(__dirname, "..", "..", "..", "demos");
const BOARDS = [["pic_programmer", "pic_programmer.kicad_pcb"], ["ecc83", "ecc83-pp_v2.kicad_pcb"], ["kit-dev-coldfire-xilinx_5213", "kit-dev-coldfire-xilinx_5213.kicad_pcb"], ["royalblue54L_feather", "RoyalBlue54L-Feather.kicad_pcb"]];

/** A features file: symbols, attribute names and texts, and the records with their attributes. */
function readFeatures(text) {
  const out = { units: "", count: -1, syms: [], names: [], texts: [], recs: [] };
  const lines = text.split("\n"); let cur = null;
  for (const line of lines) {
    if (!line || line[0] === "#") continue;
    let m;
    if ((m = /^UNITS=(\w+)$/.exec(line))) out.units = m[1];
    else if ((m = /^F (\d+)$/.exec(line))) out.count = Number(m[1]);
    else if ((m = /^\$(\d+) (\S+)$/.exec(line))) { assert.strictEqual(Number(m[1]), out.syms.length, "symbol numbers run from 0"); out.syms.push(m[2]); }
    else if ((m = /^@(\d+) (\S+)$/.exec(line))) { assert.strictEqual(Number(m[1]), out.names.length); out.names.push(m[2]); }
    else if ((m = /^&(\d+) (.*)$/.exec(line))) { assert.strictEqual(Number(m[1]), out.texts.length); out.texts.push(m[2]); }
    else if (/^[LAPS] /.test(line)) {
      const semi = line.indexOf(";"); assert(semi > 0, "a record carries its attribute field: " + line);
      const f = line.slice(0, semi).trim().split(" "); const attrs = {};
      const tail = line.slice(semi + 1);
      if (tail !== ";") for (const a of tail.split(",")) { const [id, v] = a.split("="); assert(/^\d+$/.test(id), "attribute id in " + line); attrs[out.names[Number(id)]] = v === undefined ? true : v; assert(out.names[Number(id)], "attribute " + id + " is in the table"); }
      cur = { t: f[0], f, attrs, contours: [] }; out.recs.push(cur);
    } else if (/^OB /.test(line)) { const f = line.split(" "); cur.contours.push({ kind: f[3], begin: [Number(f[1]), Number(f[2])], pts: [], closed: false }); }
    else if (/^OS /.test(line)) { const f = line.split(" "); cur.contours[cur.contours.length - 1].pts.push([Number(f[1]), Number(f[2])]); }
    else if (line === "OE") cur.contours[cur.contours.length - 1].closed = true;
    else if (line === "SE") cur = null;
    else throw new Error("unknown line in a features file: " + line);
  }
  return out;
}
const shoelace = (pts) => { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]; return a / 2; };
/** matrix/matrix: its STEP and LAYER blocks. */
function readMatrix(text) {
  const blocks = []; let cur = null;
  for (const line of text.split("\n")) {
    let m;
    if ((m = /^(\w+) \{$/.exec(line))) { cur = { kind: m[1] }; blocks.push(cur); }
    else if (line === "}") cur = null;
    else if ((m = /^ {4}(\w+)=(.*)$/.exec(line))) cur[m[1]] = m[2];
    else assert.strictEqual(line, "", "matrix line: " + line);
  }
  return blocks;
}

for (const [dir, file] of BOARDS) {
  const full = path.join(demos, dir, file);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, "utf8"); const doc = K.parseDoc(text, "kicad_pcb");
  const ctx = { doc, setup: text, projectName: dir, date: new Date(2026, 0, 2, 3, 4, 5) };
  const job = F.odb(ctx, {}); const model = F.model(ctx);
  const files = new Map(job.files.map((f) => [f.path, f.text]));
  const matrix = readMatrix(files.get("matrix/matrix"));
  const layers = matrix.filter((b) => b.kind === "LAYER");
  const feats = new Map(layers.map((l) => [l.NAME, readFeatures(files.get(`steps/pcb/layers/${l.NAME}/features`))]));
  const pads = model.footprints.reduce((n, fp) => n + fp.pads.length, 0);

  test(`${dir}: the tree is an ODB++ job`, () => {
    for (const p of ["matrix/matrix", "matrix/stackup.xml", "misc/info", "misc/userattr", "misc/metadata.xml", "fonts/standard", "steps/pcb/stephdr", "steps/pcb/profile", "steps/pcb/attrlist", "steps/pcb/eda/data", "steps/pcb/netlists/cadnet/netlist"]) assert(files.has(p), p);
    assert(/^JOB_NAME=job\nUNITS=MM\nODB_VERSION_MAJOR=8\nODB_VERSION_MINOR=1\n/.test(files.get("misc/info")));
    assert(/CREATION_DATE=20260102\.030405\n/.test(files.get("misc/info")));
    assert(files.get("fonts/standard").startsWith("\nXSIZE  0.302000\nYSIZE  0.302000\nOFFSET 0.000000\nCHAR !\n"));
    assert.strictEqual((files.get("fonts/standard").match(/^CHAR /gm) || []).length, (files.get("fonts/standard").match(/^ECHAR$/gm) || []).length);
    for (const d of ["input", "symbols", "user", "wheels"]) assert(job.dirs.includes(d), d);
  });

  test(`${dir}: the matrix names every layer once, in rows from 1, with ids below MAX_UID`, () => {
    const step = matrix.filter((b) => b.kind === "STEP"); assert.strictEqual(step.length, 1); assert.strictEqual(step[0].NAME, "pcb");
    const maxUid = Number(/MAX_UID=(\d+)/.exec(files.get("misc/info"))[1]);
    const ids = new Set([step[0].ID]);
    layers.forEach((l, i) => {
      assert.strictEqual(Number(l.ROW), i + 1); assert(/^[a-z0-9_+.\-]{1,64}$/.test(l.NAME), l.NAME);
      assert(!ids.has(l.ID), "ids are unique"); ids.add(l.ID); assert(Number(l.ID) <= maxUid);
      assert(files.has(`steps/pcb/layers/${l.NAME}/attrlist`), l.NAME + " has an attrlist");
    });
    assert.strictEqual(new Set(layers.map((l) => l.NAME)).size, layers.length);
    const copper = layers.filter((l) => /^(SIGNAL|POWER_GROUND|MIXED)$/.test(l.TYPE));
    assert.strictEqual(copper.length, model.copper.length, "one row per copper layer");
    // copper and dielectric alternate between the outer layers
    const stack = layers.filter((l) => /^(SIGNAL|POWER_GROUND|MIXED|DIELECTRIC)$/.test(l.TYPE)).map((l) => (l.TYPE === "DIELECTRIC" ? "d" : "c")).join("");
    assert(/^c(d+c)+$/.test(stack), stack);
    // a drill or rout span names copper rows; a mask, paste or legend row refers to its side's copper
    const byName = new Map(layers.map((l) => [l.NAME, l])), byId = new Map(layers.map((l) => [l.ID, l]));
    for (const l of layers) {
      if (l.TYPE === "DRILL" || l.TYPE === "ROUT") { assert(copper.includes(byName.get(l.START_NAME)), l.NAME + " starts on copper"); assert(copper.includes(byName.get(l.END_NAME))); }
      if (l.REF) assert(copper.includes(byId.get(l.REF)));
      if (l.DIELECTRIC_TYPE === "CORE") { assert(copper.includes(byId.get(l.CU_TOP))); assert(copper.includes(byId.get(l.CU_BOTTOM))); }
    }
  });

  test(`${dir}: every features file counts its records and refers to its own tables`, () => {
    for (const [name, f] of feats) {
      assert.strictEqual(f.units, "MM"); assert.strictEqual(f.count, f.recs.length, name);
      for (const r of f.recs) {
        if (r.t === "L") { assert.strictEqual(r.f.length, 8, r.f.join(" ")); assert(Number(r.f[5]) < f.syms.length); assert(/^r\d/.test(f.syms[Number(r.f[5])])); assert(/^[PN]$/.test(r.f[6])); }
        if (r.t === "A") { assert.strictEqual(r.f.length, 11); assert(Number(r.f[7]) < f.syms.length); assert(/^[YN]$/.test(r.f[10]));
          const [xs, ys, xe, ye, xc, yc] = r.f.slice(1, 7).map(Number); assert(Math.abs(Math.hypot(xs - xc, ys - yc) - Math.hypot(xe - xc, ye - yc)) < 2e-3, "an arc's ends are as far from its centre"); }
        if (r.t === "P") { assert.strictEqual(r.f.length, 8); assert(Number(r.f[3]) < f.syms.length); assert.strictEqual(r.f[6], "8"); const a = Number(r.f[7]); assert(a >= 0 && a < 360); }
        if (r.t === "S") {
          assert(r.contours.length >= 1); assert.strictEqual(r.contours[0].kind, "I");
          for (const c of r.contours) {
            assert(c.closed && c.pts.length >= 3);
            assert.deepStrictEqual(c.pts[c.pts.length - 1], c.begin, "a contour ends where it begins");
            // Y points up in the job: an island runs clockwise (negative shoelace area), a hole the other way
            const a = shoelace(c.pts); assert(c.kind === "I" ? a < 0 : a > 0, `${name}: ${c.kind} contour winding`);
          }
        }
        for (const k of Object.keys(r.attrs)) if (k === ".string" || k === ".geometry") assert(Number(r.attrs[k]) < f.texts.length);
      }
      for (const s of f.syms) assert(/^(r|rect|oval)[0-9.x]+(xr[0-9.]+)?$/.test(s), "a standard symbol name: " + s);
    }
  });

  test(`${dir}: copper layers hold what the Gerbers hold`, () => {
    const g = F.plotGerbers(ctx, { layers: model.copper });
    const rows = layers.filter((l) => /^(SIGNAL|POWER_GROUND|MIXED)$/.test(l.TYPE));
    model.copper.forEach((layer, i) => {
      const prims = g.prims.get(layer), f = feats.get(rows[i].NAME);
      const n = (k) => prims.filter((p) => k.includes(p.k) && (p.w === undefined || p.w > 0 || p.k !== "seg")).length;
      assert.strictEqual(f.recs.filter((r) => r.t === "L").length, prims.filter((p) => p.k === "seg" && p.w > 0).length, layer + " lines");
      assert.strictEqual(f.recs.filter((r) => r.t === "A").length, prims.filter((p) => p.k === "arc" && p.w > 0).length, layer + " arcs");
      assert.strictEqual(f.recs.filter((r) => r.t === "P").length, n(["circle", "rect", "oval", "roundrect"]), layer + " flashes");
      assert.strictEqual(f.recs.filter((r) => r.t === "S").length, n(["region", "poly", "rpoly"]), layer + " surfaces");
      // a flash sits where the Gerber flashes it, Y turned up
      const flashes = prims.filter((p) => ["circle", "rect", "oval", "roundrect"].includes(p.k)), ps = f.recs.filter((r) => r.t === "P");
      flashes.forEach((p, k) => { assert(Math.abs(Number(ps[k].f[1]) - p.x) < 1e-6 && Math.abs(Number(ps[k].f[2]) + p.y) < 1e-6); });
    });
  });

  // eda/data
  const eda = files.get("steps/pcb/eda/data").split("\n");
  const lyr = eda.find((l) => l.startsWith("LYR")).split(" ").slice(1);
  const nets = []; const pkgs = [];
  for (const line of eda) {
    if (line.startsWith("NET ")) nets.push({ name: line.split(" ")[1], subnets: [] });
    else if (line.startsWith("SNT ")) nets[nets.length - 1].subnets.push({ head: line.slice(4), fids: [] });
    else if (line.startsWith("FID ")) { const s = nets[nets.length - 1].subnets; s[s.length - 1].fids.push(line.split(" ").slice(1)); }
    else if (line.startsWith("PKG ")) pkgs.push({ name: line.split(" ")[1], pins: [] });
    else if (line.startsWith("PIN ")) pkgs[pkgs.length - 1].pins.push(line.split(" ")[1]);
  }
  const subs = nets.flatMap((n) => n.subnets);

  test(`${dir}: eda/data links every pad, track, via and zone fill to features that exist`, () => {
    assert.strictEqual(nets[0].name, "$NONE$"); assert.strictEqual(new Set(nets.map((n) => n.name)).size, nets.length, "net names are unique");
    for (const n of nets) assert(/^[\x21-\x3a\x3c-\x7e]+$/.test(n.name), n.name);
    assert.strictEqual(subs.filter((s) => s.head.startsWith("TOP ")).length, pads, "one toeprint subnet per pad");
    assert.strictEqual(subs.filter((s) => s.head === "TRC").length, model.tracks.length);
    assert.strictEqual(subs.filter((s) => s.head === "VIA").length, model.vias.length);
    const typeOf = new Map(layers.map((l) => [l.NAME, l.TYPE])); const seen = new Set();
    for (const s of subs) for (const [kind, li, fi] of s.fids) {
      const name = lyr[Number(li)]; assert(name, "layer index " + li); const f = feats.get(name); assert(f, name);
      assert(Number(fi) < f.recs.length, `feature ${fi} of ${name}`);
      if (kind === "C") assert(/^(SIGNAL|POWER_GROUND|MIXED)$/.test(typeOf.get(name)), "a copper feature id is on a copper layer");
      else { assert.strictEqual(kind, "H"); assert(typeOf.get(name) === "DRILL" || typeOf.get(name) === "DOCUMENT"); }
      const key = name + ":" + fi; assert(!seen.has(key), "a feature belongs to one subnet"); seen.add(key);
      if (s.head === "TRC") assert(/^[LA]$/.test(f.recs[Number(fi)].t)); if (s.head === "VIA") assert.strictEqual(f.recs[Number(fi)].t, "P"); if (s.head.startsWith("PLN")) assert.strictEqual(f.recs[Number(fi)].t, "S");
    }
    // every track is on its copper layer once, every drilled via has one hole and a pad on each end layer it is flashed on
    for (const s of subs.filter((x) => x.head === "TRC")) assert.strictEqual(s.fids.length, 1);
    for (const s of subs.filter((x) => x.head === "VIA")) assert.strictEqual(s.fids.filter((x) => x[0] === "H" && typeOf.get(lyr[Number(x[1])]) === "DRILL").length, 1);
    // every feature of a copper layer that came from a pad, track, via or fill with a net is claimed
    const zoneFills = model.fills.filter((f) => /\.Cu$/.test(f.layer)).length;
    assert.strictEqual(subs.filter((s) => s.head.startsWith("PLN")).reduce((n, s) => n + s.fids.length, 0), zoneFills, "every zone fill outline is in a plane subnet");
  });

  test(`${dir}: components name their package, pins, nets and subnets`, () => {
    let comps = 0;
    for (const l of layers.filter((x) => x.TYPE === "COMPONENT")) {
      const lines = files.get(`steps/pcb/layers/${l.NAME}/components`).split("\n"); const side = l.NAME.endsWith("top") ? "T" : "B";
      let index = -1, pkg = null, toe = 0; const names = new Set();
      for (const line of lines) {
        const f = line.split(" ");
        if (f[0] === "CMP") {
          index++; toe = 0; comps++; pkg = pkgs[Number(f[1])]; assert(pkg, "package " + f[1]);
          assert.strictEqual(f[5], side === "T" ? "N" : "M"); assert(!names.has(f[6]), "designators are unique on a side"); names.add(f[6]);
          const a = Number(f[4]); assert(a >= 0 && a < 360);
        } else if (f[0] === "TOP") {
          assert.strictEqual(pkg.pins[Number(f[1])], f[8], "the toeprint is its package pin");
          const net = nets[Number(f[6])]; assert(net, "net " + f[6]); const s = net.subnets[Number(f[7])]; assert(s, "subnet " + f[7]);
          assert.strictEqual(s.head, `TOP ${side} ${index} ${toe}`, "the subnet points back at this toeprint"); toe++;
        }
      }
    }
    const withBody = model.footprints.filter((fp) => fp.pads.length || /\.CrtYd"/.test(JSON.stringify(fp.node)) || fp.node.some((g) => Array.isArray(g) && g[0] === "model")).length;
    assert.strictEqual(comps, withBody, "one CMP per footprint that is a part");
    for (const p of pkgs) assert(p.name && !/\s/.test(p.name));
  });

  test(`${dir}: drill layers hold the holes of the drill files, with a tool for each size`, () => {
    const drl = F.drillFiles(ctx, {}); const holes = (re) => drl.filter((d) => re.test(d.name)).reduce((n, d) => n + d.holes, 0);
    const count = (plated) => layers.filter((l) => l.TYPE === "DRILL" && l.NAME.startsWith(plated ? "drill_plated" : "drill_non-plated")).reduce((n, l) => n + feats.get(l.NAME).recs.length, 0);
    assert.strictEqual(count(true), holes(/-PTH\./), "plated holes"); assert.strictEqual(count(false), holes(/-NPTH\./), "unplated holes");
    for (const l of layers.filter((x) => x.TYPE === "DRILL")) {
      const tools = files.get(`steps/pcb/layers/${l.NAME}/tools`); const f = feats.get(l.NAME);
      const sizes = new Set((tools.match(/DRILL_SIZE=([0-9.]+)/g) || []).map((s) => s.slice(11)));
      for (const r of f.recs) { const s = f.syms[Number(r.t === "L" ? r.f[5] : r.f[3])]; assert(sizes.has(s.slice(1)), `${l.NAME}: a tool of ${s}`); assert(".drill" in r.attrs); }
      assert.strictEqual((tools.match(/^TOOLS \{$/gm) || []).length, sizes.size);
    }
  });

  test(`${dir}: the netlist names the nets of its points, and the profile is the board outline`, () => {
    const lines = files.get("steps/pcb/netlists/cadnet/netlist").split("\n"); const named = new Map();
    let points = 0;
    for (const line of lines) {
      let m2;
      if ((m2 = /^\$(\d+) (\S+)$/.exec(line))) named.set(m2[1], m2[2]);
      else if (/^\d+ /.test(line)) { const f = line.split(" "); assert(named.has(f[0]), "net " + f[0]); assert.strictEqual(named.get(f[0]), nets[Number(f[0])].name); assert(/^[TDB]$/.test(f[4])); points++; }
    }
    assert(points >= model.vias.filter((v) => v.type === "through").length);
    const prof = readFeatures(files.get("steps/pcb/profile").replace(/^F (\d+)\n/m, "F $1\n"));
    assert.strictEqual(prof.recs.length, 1); assert.strictEqual(prof.recs[0].t, "S");
    const box = prof.recs[0].contours[0].pts.reduce((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]);
    const edge = F.plotGerbers(ctx, { layers: ["Edge.Cuts"] }).prims.get("Edge.Cuts"); let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of edge) for (const poly of F.primPolys(Object.assign({}, p, { w: 1e-6 }))) for (const q of poly) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
    assert(Math.abs(box[0] - x0) < 0.02 && Math.abs(box[2] - x1) < 0.02 && Math.abs(box[1] + y1) < 0.02 && Math.abs(box[3] + y0) < 0.02, "the profile's box is the Edge.Cuts box");
    const rout = feats.get("rout"); assert(rout.recs.length >= 3); for (const r of rout.recs) assert(".rout_chain" in r.attrs);
  });
}

test("numbers are written as KiCad's FormatTrimmedDecimal writes them, and inches scale every length", () => {
  const full = path.join(demos, "pic_programmer", "pic_programmer.kicad_pcb"); if (!fs.existsSync(full)) return;
  const text = fs.readFileSync(full, "utf8"); const ctx = { doc: K.parseDoc(text, "kicad_pcb"), setup: text, date: new Date(2026, 0, 2) };
  const mm = new Map(F.odb(ctx, {}).files.map((f) => [f.path, f.text])), inch = new Map(F.odb(ctx, { inch: true }).files.map((f) => [f.path, f.text]));
  assert(/^UNITS=INCH$/m.test(inch.get("misc/info"))); assert(/^\.board_thickness=1600\.0$/m.test(mm.get("steps/pcb/attrlist")));
  assert(/^\.board_thickness=62\.992126$/m.test(inch.get("steps/pcb/attrlist")));   // mils
  const a = /^L (\S+) (\S+)/m.exec(mm.get("steps/pcb/layers/rout/features")), b = /^L (\S+) (\S+)/m.exec(inch.get("steps/pcb/layers/rout/features"));
  assert(Math.abs(Number(a[1]) / 25.4 - Number(b[1])) < 1e-6);
  for (const t of mm.values()) assert(!/\d\.\d*00( |\n|$)/.test(t.replace(/^(LINE|XSIZE|YSIZE|OFFSET|CREATION_DATE|SAVE_DATE).*$/gm, "")), "no number ends in two zeros");
  const low = F.odb(ctx, { precision: 1 }); assert(low.warnings.some((w) => /below the minimum of 3/.test(w)));
});

test("the origin choice moves every coordinate, and a product name is written to misc/info", () => {
  const [dir, file] = BOARDS[3]; const full = path.join(demos, dir, file); if (!fs.existsSync(full)) return;
  let text = fs.readFileSync(full, "utf8"); assert(/\(setup\b/.test(text));
  text = text.replace(/\(aux_axis_origin [^)]*\)\s*/, "").replace(/\(grid_origin [^)]*\)\s*/, "").replace(/\(setup\b/, "(setup (aux_axis_origin 100 80) (grid_origin 12.5 7.5)");
  const ctx = { doc: K.parseDoc(text, "kicad_pcb"), setup: text, date: new Date(2026, 0, 2) };
  const job = (o) => new Map(F.odb(ctx, o).files.map((f) => [f.path, f.text]));
  const abs = job({}), aux = job({ origin: "aux" }), grid = job({ origin: "grid", productName: "My board (rev 2)" });
  const firstPad = (m, p) => { const r = /^P (\S+) (\S+) /m.exec(m.get(p)); return [Number(r[1]), Number(r[2])]; };
  const layer = [...abs.keys()].find((k) => /layers\/[^/]+\/features$/.test(k) && /^P /m.test(abs.get(k)));
  const a = firstPad(abs, layer), b = firstPad(aux, layer), c = firstPad(grid, layer);
  assert(Math.abs(a[0] - b[0] - 100) < 1e-6 && Math.abs(a[1] - b[1] + 80) < 1e-6, `aux: ${a} ${b}`);
  assert(Math.abs(a[0] - c[0] - 12.5) < 1e-6 && Math.abs(a[1] - c[1] + 7.5) < 1e-6, `grid: ${a} ${c}`);
  const net = (m) => { const r = /^\d+ \S+ (\S+) (\S+) [TBD] /m.exec(m.get("steps/pcb/netlists/cadnet/netlist")); return [Number(r[1]), Number(r[2])]; };
  assert(Math.abs(net(abs)[0] - net(aux)[0] - 100) < 1e-6 && Math.abs(net(abs)[1] - net(aux)[1] + 80) < 1e-6, "netlist points move too");
  const cmp = (m) => { const k = [...m.keys()].find((x) => /comp_\+_top\/components$/.test(x)); const r = /^CMP \d+ (\S+) (\S+) /m.exec(m.get(k)); return [Number(r[1]), Number(r[2])]; };
  assert(Math.abs(cmp(abs)[0] - cmp(aux)[0] - 100) < 1e-6 && Math.abs(cmp(abs)[1] - cmp(aux)[1] + 80) < 1e-6, "components move too");
  assert(!/PRODUCT_MODEL_NAME/.test(abs.get("misc/info")));
  assert(/^PRODUCT_MODEL_NAME=\S+$/m.test(grid.get("misc/info")), grid.get("misc/info"));
});

// the TGZ choice of Export ODB++: the system's own tar must unpack exactly the job's files
(async () => {
  const name = "the tgz archive unpacks to the job's files with tar";
  try {
    const os = require("os"), cp = require("child_process");
    const [dir, file] = BOARDS[3]; const text = fs.readFileSync(path.join(demos, dir, file), "utf8"); const ctx = { doc: K.parseDoc(text, "kicad_pcb"), setup: text, date: new Date(2026, 0, 2) }; const job = F.odb(ctx, {});
    const enc = new TextEncoder();
    const long = { name: "steps/pcb/layers/" + "x".repeat(60) + "/" + "y".repeat(70) + "/features", data: enc.encode("long path\n") };
    const entries = job.dirs.map((d) => ({ name: d + "/", data: new Uint8Array(0) })).concat(job.files.map((f) => ({ name: f.path, data: enc.encode(f.text) })), [long]);
    const tgz = await F.gzip(F.tar(entries));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "odb-tgz-"));
    fs.writeFileSync(path.join(tmp, "job.tgz"), tgz); fs.mkdirSync(path.join(tmp, "out"));
    cp.execFileSync("tar", ["xzf", path.join(tmp, "job.tgz"), "-C", path.join(tmp, "out")]);
    for (const f of job.files) assert.strictEqual(fs.readFileSync(path.join(tmp, "out", f.path), "utf8"), f.text, f.path);
    for (const d of job.dirs) assert(fs.statSync(path.join(tmp, "out", d)).isDirectory(), d);
    assert.strictEqual(fs.readFileSync(path.join(tmp, "out", long.name), "utf8"), "long path\n");
    fs.rmSync(tmp, { recursive: true, force: true });
    passed++; console.log("  ok  ", name);
  } catch (e) { failed++; console.error("FAIL", name + ":", e.message); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
