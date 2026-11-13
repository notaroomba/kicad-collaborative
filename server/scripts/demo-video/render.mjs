// Turns the footage in out/ into the demo video: builds the timeline (which take, which part of it,
// how fast, which caption), has compose.html draw every frame in a browser, and encodes with ffmpeg.
// Numbers in the captions are read from what the recorded runs returned (out/state.json), not typed in.
//
//   node render.mjs [--stills]          → out/junction-demo.mp4 and out/junction-demo-poster.jpg (--stills: two frames a scene)
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
    ? takes.map((t, i) => ({ x: 10 + i * 956, y: 110, w: 944, h: 800, dir: t.dir, frames: t.frames, label: split[i].label, chat: split[i].chat }))
    : [{ ...ONE, dir: takes[0].dir, frames: takes[0].frames }];
  const speed = (to - from) / show;
  // cutIn / cutOut: this stretch continues the one before / after it (same take, another speed), so no fade there
  return add({ kind: 'footage', name, from, speed: +speed.toFixed(3), length: show, windows, cutIn: !!cutIn, cutOut: !!cutOut,
    captions: captions.map((c, i) => ({ text: c, at: (show * i) / captions.length, until: (show * (i + 1)) / captions.length })) });
}

const sch = state.schematic, ai = state.ai, rt = state.route, fin = state.finish;
const [aiItems] = num(ai.output, /added (\d+) items/);
const split = (chat) => [{ dir: 'ada', label: 'Ada' }, { dir: 'ben', label: 'Ben', chat }];

add({ kind: 'title', length: 3.2, title: 'Junction', sub: 'Design hardware together, live.' });
// Ada and Ben draw the Pico schematic, each in their own browser
footage('schematic', { from: 0, to: sch.length, show: 20, split: split(), captions: [
  'Ada and Ben draw a Raspberry Pi Pico board in one schematic, each in their own browser',
  'Each sees the other\'s cursor, and every part and wire the moment it goes in',
  `${sch.ada + sch.ben} items between them, ${sch.ada} by Ada and ${sch.ben} by Ben` ] });
// stuck on the crystal: Ben asks an AI app connected to the project
const ask = ai.marks.ask, call = ai.marks.call, done = ai.marks.done;
footage('ai', { from: 0, to: call, show: call * 0.9, cutOut: true, split: split({ x: 30, y: 470, head: 'BEN\'S AI APP · CONNECTED TO JUNCTION', at: ask * 0.9 - 0.2, until: 99,
  lines: [{ who: 'Ben', text: 'We\'re stuck on the crystal. Can you add the 12 MHz circuit from the RP2040 design guide?', at: ask * 0.9, typing: 2.2 }] }), captions: [
  'They get stuck on the 12 MHz crystal and leave a gap', 'Ben asks the AI app he has connected to the project'] });
footage('ai', { from: call, to: done + 1.5, show: Math.min(12, (done + 1.5 - call)), cutIn: true, split: split({ x: 30, y: 470, head: 'BEN\'S AI APP · CONNECTED TO JUNCTION', at: -1, until: 99,
  lines: [{ who: 'Ben', text: 'We\'re stuck on the crystal. Can you add the 12 MHz circuit from the RP2040 design guide?', at: -1 },
          { who: 'Claude', ai: true, text: 'Adding it through Junction\'s run_python tool, one item at a time.', at: 0.2, typing: 1.2 }] }), captions: [
  'The AI works in the same file, with its own cursor: "Ben (Claude)"', `${aiItems} items added; both editors see each one land`] });
// routing, animated
footage('route', { from: 0, to: rt.length, show: Math.min(20, rt.length), split: split(), captions: [
  'Then they route the board together, track by track',
  `${rt.tracks} track segments and ${rt.vias} vias, each by the person whose half of the board it is in`] });
footage('finish', { from: fin.marks.fill - 0.3, to: fin.marks.open3d, show: 3.5, cutOut: true, captions: [fin.unconnected ? `Ground planes in and filled; ${fin.unconnected} connections left` : 'Ground planes in and filled: every connection made'] });
footage('finish', { from: fin.marks.loaded - 0.6, show: Math.min(7, fin.length - fin.marks.loaded + 0.6), cutIn: true, captions: ['The finished board in the 3D viewer'] });
add({ kind: 'title', length: 4, title: 'Junction', sub: 'Design hardware together, live.', code: 'github.com/notaroomba/junction' });
const timeline = { length: +at.toFixed(3), fps: FPS, icon: pathToFileURL(path.join(here, '..', '..', 'static', 'icon.svg')).href, scenes };
fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify({ ...timeline, scenes: scenes.map((s) => ({ ...s, windows: s.windows && s.windows.map((w) => ({ ...w, frames: w.frames.length })) })) }, null, 1));
console.log(`timeline ${timeline.length.toFixed(1)} s:`, scenes.map((s) => `${s.name || s.kind} ${s.length.toFixed(1)}s${s.speed ? ' ×' + s.speed.toFixed(1) : ''}`).join(', '));

const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, colorScheme: 'dark' })).newPage();
await page.goto(pathToFileURL(path.join(here, 'compose.html')).href);
await page.evaluate((t) => window.load(t), timeline);
const stills = process.argv.includes('--stills');
// the README's poster: a frame of the AI scene (both people and the AI's cursor), with a play button on it
const posterAt = scenes.filter((s) => s.name === 'ai')[1]; await page.evaluate((t) => window.seek(t), posterAt.start + posterAt.length * 0.55);
await page.evaluate(() => { const d = document.createElement('div'); d.id = 'play'; d.style.cssText = 'position:absolute;left:50%;top:50%;width:150px;height:150px;margin:-75px 0 0 -75px;border-radius:50%;background:rgba(10,10,12,.78);box-shadow:0 0 0 2px rgba(255,255,255,.85)';
  d.innerHTML = '<div style="position:absolute;left:60px;top:45px;border-left:46px solid #fff;border-top:30px solid transparent;border-bottom:30px solid transparent"></div>'; document.getElementById('stage').appendChild(d); });
await page.screenshot({ path: path.join(OUT, 'junction-demo-poster.jpg'), type: 'jpeg', quality: 86 });
await page.evaluate(() => document.getElementById('play').remove());
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
}
await browser.close();
