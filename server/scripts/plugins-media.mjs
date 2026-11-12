// plugins-media.mjs — checks the animation encoders plugins get in place of ffmpeg (web/plugins/media.ts) in a real
// browser: frames are drawn, encoded as a GIF, a palette and an MP4, and the results are decoded again by the
// browser's own decoders and compared with what went in.
//   node scripts/plugins-media.mjs            (after `npm run build`; OUT=<dir> keeps the files)
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const here = path.dirname(fileURLToPath(import.meta.url));
const shim = JSON.parse(fs.readFileSync(path.join(here, "..", "static", "dist", "pyodide", "kicad-python.json"), "utf8"));
const browser = await chromium.launch();
let failed = 0;
const check = (name, ok, detail) => { if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : " " + JSON.stringify(detail)}`); };
try {
  const page = await browser.newPage();
  await page.route("http://localhost/media", (r) => r.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }));
  await page.goto("http://localhost/media");
  await page.addScriptTag({ content: shim.files["kicad_media.js"] });
  const res = await page.evaluate(async () => {
    const W = 321, H = 240, N = 30, FPS = 30;
    // frames: a board-like green rectangle turning on a transparent ground, with a gradient that needs many colours
    const frames = [];
    for (let i = 0; i < N; i++) {
      const c = document.createElement("canvas"); c.width = W; c.height = H; const g = c.getContext("2d");
      g.translate(W / 2, H / 2); g.rotate((i / N) * Math.PI * 2);
      const grad = g.createLinearGradient(-80, 0, 80, 0); grad.addColorStop(0, "#0b5d1e"); grad.addColorStop(1, "#7fe08a");
      g.fillStyle = grad; g.fillRect(-80, -50, 160, 100); g.fillStyle = "#d4af37"; g.fillRect(-60, -30, 30, 12); g.fillStyle = "#ffffff"; g.fillRect(20, 10, 40, 6);
      const blob = await new Promise((ok) => c.toBlob(ok, "image/png")); frames.push(new Uint8Array(await blob.arrayBuffer()));
    }
    const run = async (opts, palette) => { const job = __kcMedia.open(Object.assign({ fps: FPS }, opts, palette ? { palette } : {})); for (const f of frames) job.add(f); return job.finish(); };
    const b64 = (u) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
    const out = {};
    // GIF on a background colour
    const gif = await run({ format: "gif", background: "#102030" });
    const dec = new ImageDecoder({ data: gif.bytes, type: "image/gif" }); await dec.tracks.ready; const track = dec.tracks.selectedTrack;
    await dec.completed;
    const first = await dec.decode({ frameIndex: 0 }); const last = await dec.decode({ frameIndex: track.frameCount - 1 });
    const px = async (vf, x, y) => { const c = new OffscreenCanvas(vf.displayWidth, vf.displayHeight); const g = c.getContext("2d"); g.drawImage(vf, 0, 0); return Array.from(g.getImageData(x, y, 1, 1).data); };
    let total = 0; for (let i = 0; i < track.frameCount; i++) { const f = await dec.decode({ frameIndex: i }); total += f.image.duration; f.image.close(); }
    out.gif = { bytes: gif.bytes.length, frames: track.frameCount, w: first.image.displayWidth, h: first.image.displayHeight, repetition: track.repetitionCount, seconds: total / 1e6,
      corner: await px(first.image, 2, 2), centre: await px(first.image, 160, 120), lastCentre: await px(last.image, 160, 120), head: String.fromCharCode(...gif.bytes.subarray(0, 6)) };
    out.gifB64 = b64(gif.bytes);
    // GIF that keeps transparency
    const tgif = await run({ format: "gif" });
    const tdec = new ImageDecoder({ data: tgif.bytes, type: "image/gif" }); await tdec.tracks.ready; const tf = await tdec.decode({ frameIndex: 3 });
    out.tgif = { corner: await px(tf.image, 2, 2), centre: await px(tf.image, 160, 120) };
    // palette picture, then a GIF made with it
    const pal = await run({ format: "palette", background: "#102030" });
    const bmp = await createImageBitmap(new Blob([pal.bytes], { type: "image/png" })); out.palette = { w: bmp.width, h: bmp.height };
    const pgif = await run({ format: "gif", background: "#102030" }, pal.bytes);
    const pdec = new ImageDecoder({ data: pgif.bytes, type: "image/gif" }); await pdec.tracks.ready; await pdec.completed; out.pgif = { frames: pdec.tracks.selectedTrack.frameCount };
    // MP4
    out.codec = await __kcMedia.video(W, H, FPS);
    const mp4 = await run({ format: "mp4", background: "#102030", even: true, crf: 18 });
    out.mp4B64 = b64(mp4.bytes);
    const v = document.createElement("video"); v.muted = true; v.src = URL.createObjectURL(new Blob([mp4.bytes], { type: "video/mp4" }));
    await new Promise((ok, no) => { v.onloadeddata = ok; v.onerror = () => no(new Error("the browser could not read the MP4: " + (v.error && v.error.message))); });
    const grab = async (t) => { v.currentTime = t; await new Promise((ok) => { v.onseeked = ok; }); const c = new OffscreenCanvas(v.videoWidth, v.videoHeight); const g = c.getContext("2d"); g.drawImage(v, 0, 0); return [Array.from(g.getImageData(2, 2, 1, 1).data), Array.from(g.getImageData(160, 120, 1, 1).data)]; };
    out.mp4 = { bytes: mp4.bytes.length, codec: mp4.codec, w: v.videoWidth, h: v.videoHeight, duration: v.duration, start: await grab(0.01), end: await grab(0.9) };
    return out;
  });
  const near = (a, b, tol) => a.length >= 3 && Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
  check("GIF: header and size", res.gif.head === "GIF89a" && res.gif.w === 321 && res.gif.h === 240, res.gif);
  check("GIF: every frame is there", res.gif.frames === 30);
  check("GIF: one second long at 30 fps", Math.abs(res.gif.seconds - 1) < 0.011, res.gif.seconds);
  check("GIF: loops forever", res.gif.repetition === Infinity, res.gif.repetition);
  check("GIF: background colour under the frames", near(res.gif.corner, [0x10, 0x20, 0x30], 6), res.gif.corner);
  check("GIF: the board's green in the middle", res.gif.centre[1] > res.gif.centre[0] + 40 && res.gif.centre[1] > res.gif.centre[2] + 40, res.gif.centre);
  check("GIF: transparency kept without a background", res.tgif.corner[3] === 0 && res.tgif.centre[3] === 255, res.tgif);
  check("palette: 16 x 16 picture", res.palette.w === 16 && res.palette.h === 16, res.palette);
  check("GIF from a given palette", res.pgif.frames === 30);
  check("MP4: the browser has an encoder", !!res.codec, res.codec);
  check("MP4: plays back, even size", res.mp4.w === 320 && res.mp4.h === 240, { w: res.mp4.w, h: res.mp4.h, codec: res.mp4.codec, bytes: res.mp4.bytes });
  check("MP4: one second long", Math.abs(res.mp4.duration - 1) < 0.05, res.mp4.duration);
  check("MP4: background colour and board colour", near(res.mp4.start[0], [0x10, 0x20, 0x30], 12) && res.mp4.start[1][1] > res.mp4.start[1][0] + 30, res.mp4.start);
  check("MP4: the last frames decode too", near(res.mp4.end[0], [0x10, 0x20, 0x30], 12), res.mp4.end);
  if (process.env.OUT) { fs.mkdirSync(process.env.OUT, { recursive: true }); fs.writeFileSync(path.join(process.env.OUT, "test.gif"), Buffer.from(res.gifB64, "base64")); fs.writeFileSync(path.join(process.env.OUT, "test.mp4"), Buffer.from(res.mp4B64, "base64")); }
} finally { await browser.close(); }
console.log(failed ? `${failed} check(s) failed` : "all media checks passed");
process.exit(failed ? 1 : 0);
