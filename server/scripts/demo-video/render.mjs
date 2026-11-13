// Turns the footage in out/ into the demo video: builds the timeline (which take, which part of it,
// how fast, which caption), has compose.html draw every frame in a browser, and encodes with ffmpeg.
// Numbers in the captions are read from what the recorded runs returned (out/state.json), not typed in.
//
//   node render.mjs [--preview]         → out/junction-demo.mp4 (and out/junction-demo-preview.gif)
//
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT || path.join(here, 'out');
const FPS = 30;
const state = JSON.parse(fs.readFileSync(path.join(OUT, 'state.json'), 'utf8'));
const take = (name) => { const dir = path.join(OUT, name); const m = JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8')); return { dir: pathToFileURL(dir).href, ...m }; };
// when the drawing first changes in a take: the first photograph whose JPEG is noticeably larger than the opening one
const firstChange = (name, after) => { const dir = path.join(OUT, name); const m = JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8')); const size = (f) => fs.statSync(path.join(dir, f.file)).size; const base = size(m.frames[0]);
  const hit = m.frames.find((f) => f.t >= after && size(f) > base * 1.03); return hit ? hit.t : after; };
const num = (text, re) => { const m = re.exec(text || ''); if (!m) throw new Error(`a caption number is missing: ${re}`); return m.slice(1); };

const ONE = { x: 160, y: 50, w: 1600, h: 900 };
const scenes = []; let at = 0;
const add = (s) => { s.start = +at.toFixed(3); at += s.length; scenes.push(s); return s; };
// a stretch [from, to] of a take, shown for `show` seconds (so its speed is what it has to be)
function footage(name, { from, to, show, captions, split, cutIn, cutOut }) {
  const takes = split ? split.map((s) => take(`${name}/${s.dir}`)) : [take(name)];
  from = from ?? 0; to = to ?? takes[0].length;
  const windows = split
    ? takes.map((t, i) => ({ x: 10 + i * 956, y: 110, w: 944, h: 800, dir: t.dir, frames: t.frames, label: split[i].label }))
    : [{ ...ONE, dir: takes[0].dir, frames: takes[0].frames }];
  const speed = (to - from) / show;
  // cutIn / cutOut: this stretch continues the one before / after it (same take, another speed), so no fade there
  return add({ kind: 'footage', name, from, speed: +speed.toFixed(3), length: show, windows, cutIn: !!cutIn, cutOut: !!cutOut,
    captions: captions.map((c, i) => ({ text: c, at: (show * i) / captions.length, until: (show * (i + 1)) / captions.length })) });
}

const sch = state['ai-schematic'], brd = state['ai-board'], ar = state['autoroute'], v3 = state['viewer3d'], fab = state['fab'];
const [parts, nets] = num(sch.result.output, /'placed': (\d+), 'nets': (\d+)/);
const [ercErrors] = num(sch.result.output, /erc \{'check': 'ERC', 'errors': (\d+)/);
const [routed, connections, vias] = num(brd.result.notes.join('\n'), /routed (\d+) of (\d+) connections, (\d+) vias/);
const [bw, bh] = num(brd.result.output, /'width': ([\d.]+), 'height': ([\d.]+)/);
const [layers] = [(/'copper_layers': \[([^\]]*)\]/.exec(brd.result.output)[1].split(',').length)];
const [models, modelParts] = num(brd.result.output, /'parts': (\d+), 'from_kicad_library': (\d+)/).reverse();

add({ kind: 'title', length: 3.2, title: 'Junction', sub: 'KiCad, with everyone in the same file.' });
add({ kind: 'prompt', length: 6.2, typing: 4.2, label: 'Asked of an AI app connected to Junction over MCP',
  text: 'Design an ESP32 devboard: bare chip, USB-C, Bluetooth, battery management with a JST battery connector, an IMU and a barometer. Raspberry Pi Pico size, 4 layers.' });
const schDone = `${parts} parts and ${nets} nets drawn in the shared schematic, ERC ${ercErrors} errors`;
footage('ai-schematic', { from: sch.marks.call - 0.5, to: sch.marks.fit - 0.3, show: 6, cutOut: true, captions: [
  'The AI sends one Python script through the run_python tool'] });
footage('ai-schematic', { from: sch.marks.fit - 0.3, show: 3, cutIn: true, captions: [schDone] });
const brdDone = `${routed} of ${connections} connections routed, ${vias} vias`;
footage('ai-board', { from: Math.max(brd.marks.call - 0.5, firstChange('ai-board', brd.marks.call) - 8), to: brd.marks.done, show: 11, cutOut: true, captions: [
  `A second call lays out the board: ${bw} × ${bh} mm, ${layers} copper layers`,
  `${parts} footprints placed, then routed net by net`] });
footage('ai-board', { from: brd.marks.done, show: 2.4, cutIn: true, captions: [brdDone] });
footage('viewer3d', { from: v3.marks.loaded - 1.2, show: v3.length - v3.marks.loaded + 1.2, captions: [`The same board in the 3D viewer: ${models} of ${modelParts} parts with their real 3D model`] });
footage('together', { show: state.together.length, split: [{ dir: 'ada', label: 'Ada' }, { dir: 'ben', label: 'Ben' }], captions: [
  'Two people in one schematic, each with their own view',
  'Cursors, selections and edits arrive as they happen' ] });
footage('autoroute', { show: 10, captions: [
  `Autorouter: a board with its ${ar.before.removed} tracks and vias taken off, ${ar.before.connections} connections to make`,
  `${ar.before.connections - ar.after.left} of ${ar.before.connections} routed: ${ar.after.tracks} track segments, ${ar.after.vias} vias` ] });
footage('fab', { show: Math.min(fab.length, 8), captions: ['Gerbers, drill, BOM and placement files for the fab, from the browser'] });
add({ kind: 'title', length: 4, title: 'Junction', sub: 'KiCad desktop and the browser, live.', code: 'github.com/notaroomba/junction' });
const timeline = { length: +at.toFixed(3), fps: FPS, icon: pathToFileURL(path.join(here, '..', '..', 'static', 'icon.svg')).href, scenes };
fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify({ ...timeline, scenes: scenes.map((s) => ({ ...s, windows: s.windows && s.windows.map((w) => ({ ...w, frames: w.frames.length })) })) }, null, 1));
console.log(`timeline ${timeline.length.toFixed(1)} s:`, scenes.map((s) => `${s.name || s.kind} ${s.length.toFixed(1)}s${s.speed ? ' ×' + s.speed.toFixed(1) : ''}`).join(', '));

const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, colorScheme: 'dark' })).newPage();
await page.goto(pathToFileURL(path.join(here, 'compose.html')).href);
await page.evaluate((t) => window.load(t), timeline);
const stills = process.argv.includes('--stills');
const mp4 = path.join(OUT, 'junction-demo.mp4');
if (stills) {
  for (const s of scenes) for (const k of [0.3, 0.75]) { await page.evaluate((t) => window.seek(t), s.start + s.length * k); await page.screenshot({ path: path.join(OUT, `still-${String(scenes.indexOf(s)).padStart(2, '0')}-${k}.jpg`), type: 'jpeg', quality: 80 }); }
} else {
  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { stdio: ['pipe', 'inherit', 'inherit'] });
  const total = Math.round(timeline.length * FPS);
  for (let i = 0; i < total; i++) {
    await page.evaluate((t) => window.seek(t), i / FPS);
    const buf = await page.screenshot({ type: 'jpeg', quality: 95 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 300 === 0) console.log(`  frame ${i} of ${total}`);
  }
  ff.stdin.end(); await new Promise((r) => ff.on('close', r));
  console.log(mp4, (fs.statSync(mp4).size / 1e6).toFixed(1), 'MB');
  if (process.argv.includes('--preview')) {
    const gif = path.join(OUT, 'junction-demo-preview.gif');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', mp4, '-vf', 'fps=6,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', gif]);
    console.log(gif, (fs.statSync(gif).size / 1e6).toFixed(1), 'MB');
  }
}
await browser.close();
