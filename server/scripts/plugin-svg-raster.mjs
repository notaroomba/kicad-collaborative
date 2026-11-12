// plugin-svg-raster.mjs — draws one SVG with a real browser (Chromium through Playwright) and prints the PNG
// as a data: address.  plugins-python.mjs runs it for cairosvg.svg2png, which in the web editor is drawn by the
// browser the plugin runs in; here there is no browser, so one is started for the picture.
//   stdin: {"svg": "...", "w": 800, "h": 600, "background": "", "negate": false}
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const a = JSON.parse(fs.readFileSync(0, "utf8"));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const url = await page.evaluate(async ({ svg, w, h, background, negate }) => {
    const img = new Image();
    await new Promise((ok, bad) => { img.onload = () => ok(); img.onerror = () => bad(new Error("The browser could not read this SVG")); img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg); });
    const c = document.createElement("canvas"); c.width = Math.max(1, w); c.height = Math.max(1, h);
    const ctx = c.getContext("2d");
    if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, c.width, c.height); }
    ctx.drawImage(img, 0, 0, c.width, c.height);
    if (negate) { const d = ctx.getImageData(0, 0, c.width, c.height); const p = d.data; for (let i = 0; i < p.length; i += 4) { p[i] = 255 - p[i]; p[i + 1] = 255 - p[i + 1]; p[i + 2] = 255 - p[i + 2]; } ctx.putImageData(d, 0, 0); }
    return c.toDataURL("image/png");
  }, a);
  process.stdout.write(url);
} finally { await browser.close(); }
