// Holds the web editor's fabrication outputs (server/web/fab) against KiCad's own for the same board:
// every plottable layer is written by both, drawn by gerbv on the same window and compared pixel by pixel;
// the Excellon drill files and the placement file are compared as text.
//
//   KICAD_CLI=/path/to/kicad-cli [DPI=600] [KEEP=/some/dir] [TOLERANCE=0.02] node fab-verify.mjs board.kicad_pcb [more boards…]
//
// Needs kicad-cli (this tree's, from its build directory, reads the current file format) and gerbv.
// "solid" differences are those that survive a 3 × 3 erosion: a one-pixel fringe along an edge is how two
// writers round the same shape, a solid patch is a shape one of them does not have.  A layer fails when its
// solid difference is more than TOLERANCE percent of the reference's ink.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
require(path.join(here, '..', 'static', 'kicad-canvas.js'));
require(path.join(here, '..', 'static', 'dist', 'fab.js'));
const K = globalThis.KiCadCanvas, F = globalThis.KiCadFab;

const CLI = process.env.KICAD_CLI || 'kicad-cli';
const DPI = +(process.env.DPI || 600), TOLERANCE = +(process.env.TOLERANCE || 0.02);
const boards = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const AUX = process.argv.includes('--aux'), SUBTRACT = process.argv.includes('--subtract');
if (!boards.length) { console.error('usage: KICAD_CLI=… node fab-verify.mjs board.kicad_pcb […] [--aux] [--subtract]'); process.exit(2); }
// a kicad-cli in its build tree finds its libraries only when told it runs from there
const inBuildTree = path.isAbsolute(CLI) && fs.existsSync(path.join(path.dirname(CLI), '..', 'pcbnew', '_pcbnew.kiface'));
const env = Object.assign({}, process.env, inBuildTree ? { KICAD_RUN_FROM_BUILD_DIR: '1' } : {});
const cli = (args) => spawnSync(CLI, args, { env, encoding: 'utf8' });

// older command lines have no switches for Do-not-populate parts on the Fab layers (and plot them plainly)
const help = cli(['pcb', 'export', 'gerbers', '--help']); const DNP_FLAGS = /crossout-dnp/.test((help.stdout || '') + (help.stderr || ''));
let failed = 0;
for (const board of boards) {
  const name = path.basename(board).replace(/\.kicad_pcb$/, '');
  const work = process.env.KEEP ? path.join(process.env.KEEP, name) : fs.mkdtempSync(path.join(os.tmpdir(), 'fab-verify-'));
  const mine = path.join(work, 'mine'), ref = path.join(work, 'ref'), tmp = path.join(work, 'tmp');
  for (const d of [mine, ref, tmp]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
  console.log(`\n== ${name}`);
  const text = fs.readFileSync(board, 'utf8');
  const t0 = Date.now();
  const doc = K.parseDoc(text, 'kicad_pcb');
  const ctx = { doc, setup: text, projectName: name };
  const layers = F.plottableLayers(doc);
  const g = F.plotGerbers(ctx, { layers, useGerberX2: true, useAuxOrigin: AUX, subtractMaskFromSilk: SUBTRACT, sketchDnpOnFab: DNP_FLAGS, crossoutDnpOnFab: DNP_FLAGS });
  for (const f of g.files) fs.writeFileSync(path.join(mine, f.layer.replace(/\./g, '_') + '.gbr'), f.text);
  const drills = F.drillFiles(ctx, { useAuxOrigin: AUX });
  for (const d of drills) fs.writeFileSync(path.join(mine, d.name), d.text);
  fs.writeFileSync(path.join(mine, 'pos.csv'), F.placementCsv(F.positions(ctx, { useAuxOrigin: AUX })));
  console.log(`   web: ${g.files.length} layers, ${drills.length} drill files in ${Date.now() - t0} ms${g.warnings.length ? `; ${g.warnings.length} warning(s)` : ''}`);
  for (const w of g.warnings) console.log(`   warning: ${w}`);

  // the reference
  const common = ['--no-protel-ext'].concat(DNP_FLAGS ? ['--sketch-dnp-fps-on-fab-layers', '--crossout-dnp-fps-on-fab-layers'] : []).concat(AUX ? ['--use-drill-file-origin'] : [], SUBTRACT ? ['--subtract-soldermask'] : []);
  for (const layer of layers) {
    for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f));
    cli(['pcb', 'export', 'gerbers', ...common, '-l', layer, '-o', tmp + '/', board]);
    const out = fs.readdirSync(tmp).find((f) => /\.gbr$/.test(f));
    if (out) fs.renameSync(path.join(tmp, out), path.join(ref, layer.replace(/\./g, '_') + '.gbr'));
  }
  cli(['pcb', 'export', 'drill', '--excellon-separate-th', '--excellon-units', 'mm', '--excellon-oval-format', 'route', ...(AUX ? ['--drill-origin', 'plot'] : []), '-o', ref + '/', board]);
  cli(['pcb', 'export', 'pos', '--format', 'csv', '--units', 'mm', ...(AUX ? ['--use-drill-file-origin'] : []), '-o', path.join(ref, 'pos.csv'), board]);

  // the same window for both: the board's box and a margin, in gerbv's inches (Y up)
  const [x0, y0, x1, y1] = doc.bbox, m = 8, o = AUX ? F.model(ctx).settings.auxOrigin : [0, 0];
  const ox = (x0 - m - o[0]) / 25.4, oy = (-(y1 + m) + o[1]) / 25.4, w = (x1 - x0 + 2 * m) / 25.4, h = (y1 - y0 + 2 * m) / 25.4;
  const render = (src, dst) => {
    spawnSync('gerbv', ['-x', 'png', '-D', String(DPI), `--origin=${ox.toFixed(5)};${oy.toFixed(5)}`, `--window_inch=${w.toFixed(5)}x${h.toFixed(5)}`, '-b', '#000000', '-f', '#FFFFFF', '-B', '0', '-o', dst, src], { encoding: 'utf8' });
    if (!fs.existsSync(dst)) return null;
    const img = readPng(fs.readFileSync(dst)); fs.rmSync(dst); return img;
  };
  let worst = 0;
  for (const layer of layers) {
    const key = layer.replace(/\./g, '_'), a = path.join(mine, key + '.gbr'), b = path.join(ref, key + '.gbr');
    if (!fs.existsSync(b)) { console.log(`   ${layer.padEnd(12)} no reference from kicad-cli`); failed++; continue; }
    const A = render(a, path.join(tmp, 'a.png')), B = render(b, path.join(tmp, 'b.png'));
    if (!A || !B || A.w !== B.w || A.h !== B.h) { console.log(`   ${layer.padEnd(12)} could not be drawn`); failed++; continue; }
    const n = A.w * A.h; let inkRef = 0, diff = 0; const x = new Uint8Array(n);
    for (let i = 0; i < n; i++) { if (B.on[i]) inkRef++; if (A.on[i] !== B.on[i]) { x[i] = 1; diff++; } }
    let solid = 0;
    for (let yy = 1; yy < A.h - 1; yy++) for (let xx = 1, i = yy * A.w + 1; xx < A.w - 1; xx++, i++) {
      if (x[i] && x[i - 1] && x[i + 1] && x[i - A.w] && x[i + A.w] && x[i - A.w - 1] && x[i - A.w + 1] && x[i + A.w - 1] && x[i + A.w + 1]) solid++;
    }
    const pct = 100 * solid / Math.max(inkRef, 1); if (inkRef || solid) worst = Math.max(worst, pct);
    const bad = pct > TOLERANCE || (!inkRef && solid > 0); if (bad) failed++;
    console.log(`   ${layer.padEnd(12)} ${bad ? 'DIFFERS' : 'same   '}  ink ${String(inkRef).padStart(9)} px  edge fringe ${String(diff).padStart(7)}  solid ${String(solid).padStart(6)} (${pct.toFixed(4)}%)`);
  }
  // drill and placement: the text, without the comment lines that carry the date and the program's name
  const body = (t) => t.split(/\r?\n/).filter((l) => !/^\s*[;#]/.test(l)).join('\n').trim();
  for (const d of drills) {
    const r = path.join(ref, d.name);
    const same = fs.existsSync(r) && body(fs.readFileSync(r, 'utf8')) === body(d.text);
    if (!same && !(d.holes === 0 && !fs.existsSync(r))) failed++;
    console.log(`   ${d.name.padEnd(28)} ${same ? 'identical' : d.holes === 0 && !fs.existsSync(r) ? 'empty (kicad-cli writes none)' : 'DIFFERS'}  ${d.holes} holes`);
  }
  const pa = body(fs.readFileSync(path.join(mine, 'pos.csv'), 'utf8')), pb = fs.existsSync(path.join(ref, 'pos.csv')) ? body(fs.readFileSync(path.join(ref, 'pos.csv'), 'utf8')) : null;
  if (pa !== pb) failed++;
  console.log(`   ${'pos.csv'.padEnd(28)} ${pa === pb ? 'identical' : 'DIFFERS'}  ${pa.split('\n').length - 1} parts`);
  console.log(`   worst layer: ${worst.toFixed(4)}% solid difference`);
  if (!process.env.KEEP) fs.rmSync(work, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} difference(s)` : '\nall outputs match');
process.exit(failed ? 1 : 0);

/** An 8-bit PNG (grey, RGB or RGBA, not interlaced) as a bitmap of lit pixels. */
function readPng(buf) {
  let p = 8, w = 0, h = 0, type = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), kind = buf.toString('latin1', p + 4, p + 8);
    if (kind === 'IHDR') { w = buf.readUInt32BE(p + 8); h = buf.readUInt32BE(p + 12); type = buf[p + 17]; }
    else if (kind === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const bpp = type === 6 ? 4 : type === 2 ? 3 : type === 4 ? 2 : 1, stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat)); const on = new Uint8Array(w * h);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) if (cur[x * bpp] > 127) on[y * w + x] = 1;
    const t = prev; prev = cur; cur = t;
  }
  return { w, h, on };
}
