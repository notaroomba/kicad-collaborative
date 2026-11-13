// pyruntime.ts — runs one of KiCad's own Python plugins inside the plugin sandbox.
//
// KiCad's official plugins are Python programs written against the desktop application's
// `pcbnew` and `wx` modules.  Rather than translate them, the sandbox frame runs real CPython
// (Pyodide: the interpreter compiled to WebAssembly) and gives it those two modules, written
// over the collaborative board and over HTML (server/plugins/python).  This file is the piece
// in between: it is the "entry script" of every Python plugin, an ordinary sandboxed web
// plugin that happens to start an interpreter.  It has exactly the reach any web plugin has:
// the `kicad` API over the frame's one port, checked by host.ts against what the person granted.
//
// Python calls into the editor block (WebAssembly stack switching), so `dialog.ShowModal()`
// and `board.Add(...)` behave as the plugin's author wrote them for the desktop.

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Shipped as this function's own source text and run in the frame: it must be self-contained —
 * no imports, no references to anything outside its body.
 */
export function pythonRuntime(): void {
  const W: any = window; const kicad: any = W.kicad; const base: string = kicad.plugin.pyodide; W.__kcPyBase = base;
  let py: any = null;
  const say = (e: any) => (e && e.message ? String(e.message) : String(e));
  const lastLine = (e: any) => { const lines = say(e).trim().split("\n"); return lines[lines.length - 1].slice(0, 400); };

  // ---- wx: windows, modal waits, timers
  const modals = new Map<number, () => void>(); let shown = false; let presentSeq = 0;
  const promised = (fn: any, args: any[]) => {
    try { const r = fn.callPromising ? fn.callPromising(...args) : fn(...args); if (r && typeof r.catch === "function") r.catch((e: any) => console.error(say(e))); }
    catch (e) { console.error(say(e)); }
  };
  const frame = () => new Promise<void>((ok) => requestAnimationFrame(() => ok()));
  W.__kcWx = {
    /** A DOM listener that enters Python in a way that lets the handler block (open another dialog, wait for the editor). */
    promising: (fn: any) => (ev: any) => promised(fn, [ev]),
    /** Show a top-level wx window: the editor floats the frame as a dialog sized to the window's content. */
    async show(title: string, el: HTMLElement, wantW: number, wantH: number, modal: boolean) {
      const seq = ++presentSeq;
      if (!shown) { await kicad.ui.showWindow({ title, width: wantW || 460, height: wantH || 260, modal }); shown = true; await frame(); }
      if (seq !== presentSeq) return;
      const body = document.body; const pad = 2;
      el.style.width = "max-content"; const natural = Math.ceil(el.getBoundingClientRect().width) + pad; el.style.width = "";
      const width = Math.max(280, Math.min(1100, wantW > 0 ? Math.max(wantW, Math.min(natural, wantW + 240)) : natural));
      body.style.width = width + "px"; el.style.minHeight = "0";
      const height = Math.max(wantH > 0 ? Math.min(wantH, 760) : 0, Math.ceil(el.scrollHeight) + pad, 80);
      body.style.width = ""; el.style.minHeight = "";
      await kicad.ui.showWindow({ title, width, height, modal });
    },
    hide() { presentSeq++; shown = false; kicad.ui.hideWindow().catch(() => undefined); },
    modal: (id: number) => new Promise<void>((ok) => modals.set(id, ok)),
    endModal(id: number) { const ok = modals.get(id); if (ok) { modals.delete(id); ok(); } },
    tick: () => new Promise<void>((ok) => setTimeout(ok, 0)),
    sleep: (ms: number) => new Promise<void>((ok) => setTimeout(ok, Math.max(0, ms | 0))),
    later: (fn: any, ms: number) => setTimeout(() => promised(fn, []), Math.max(0, ms | 0)),
    copy: (_text: string) => undefined,
    /** Width and height of one line of text in a CSS font, for a plugin that lays out what it draws. */
    measure(text: string, font: string): [number, number] {
      measureCtx.font = font; const m = measureCtx.measureText(text);
      const h = (m.fontBoundingBoxAscent || 0) + (m.fontBoundingBoxDescent || 0) || parseFloat(font.replace(/^.*?([\d.]+)px.*$/, "$1")) * 1.25;
      return [m.width, h];
    },
    /** Play a window's drawing steps on its canvas (wx/_paint.py lists them).  The newest picture of a canvas wins. */
    paint(canvas: HTMLCanvasElement, json: string, w: number, h: number, clear: boolean) {
      const ops = JSON.parse(json) as any[]; const seq = (paintSeq.get(canvas) || 0) + 1; paintSeq.set(canvas, seq);
      const all = clear ? ops : (kept.get(canvas) || []).concat(ops); kept.set(canvas, all);
      loadImages(all).then(() => {
        if (paintSeq.get(canvas) !== seq) return;
        const dpr = window.devicePixelRatio || 1; const cw = Math.max(1, Math.round(w * dpr)), ch = Math.max(1, Math.round(h * dpr));
        if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
        const ctx = canvas.getContext("2d"); if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h); play(ctx, all, w, h);
      });
    },
    /** A bitmap a plugin drew on, as a PNG address. */
    async raster(w: number, h: number, json: string): Promise<string> {
      const ops = JSON.parse(json) as any[]; await loadImages(ops);
      const c = document.createElement("canvas"); c.width = Math.max(1, w); c.height = Math.max(1, h);
      const ctx = c.getContext("2d"); if (!ctx) return ""; play(ctx, ops, w, h); return c.toDataURL("image/png");
    },
    /** An SVG document drawn by the browser's own renderer at w x h, as a PNG address (what cairosvg.svg2png returns). */
    async svgPng(svg: string, w: number, h: number, background: string, negate: boolean): Promise<string> {
      const img = new Image();
      await new Promise<void>((ok, bad) => { img.onload = () => ok(); img.onerror = () => bad(new Error("The browser could not read this SVG")); img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg); });
      const c = document.createElement("canvas"); c.width = Math.max(1, w); c.height = Math.max(1, h);
      const ctx = c.getContext("2d"); if (!ctx) return "";
      if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, c.width, c.height); }
      ctx.drawImage(img, 0, 0, c.width, c.height);
      if (negate) { const d = ctx.getImageData(0, 0, c.width, c.height); const p = d.data; for (let i = 0; i < p.length; i += 4) { p[i] = 255 - p[i]; p[i + 1] = 255 - p[i + 1]; p[i + 2] = 255 - p[i + 2]; } ctx.putImageData(d, 0, 0); }
      return c.toDataURL("image/png");
    },
    /** Tell Python when an element's size changes (and once, when it is first laid out). */
    observe(el: HTMLElement, fn: (ev: any) => void) { new ResizeObserver(() => fn(null)).observe(el); },
  };
  // ---- drawing: the steps a wx device context recorded, on a canvas
  const measureCtx = document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;
  const paintSeq = new WeakMap<HTMLCanvasElement, number>(); const kept = new WeakMap<HTMLCanvasElement, any[]>();
  const images = new Map<string, HTMLImageElement | null>();
  const loadImages = (ops: any[]): Promise<void> => {
    const need: string[] = []; for (const o of ops) if (o[0] === "img" && !images.has(o[1]) && need.indexOf(o[1]) < 0) need.push(o[1]);
    if (!need.length) return Promise.resolve();
    if (images.size > 400) images.clear();
    return Promise.all(need.map((url) => new Promise<void>((ok) => { const im = new Image(); im.onload = () => { images.set(url, im); ok(); }; im.onerror = () => { images.set(url, null); ok(); }; im.src = url; }))).then(() => undefined);
  };
  const play = (ctx: CanvasRenderingContext2D, ops: any[], w: number, h: number) => {
    let stroke: string | null = "#000", fill: string | CanvasGradient | null = null, textColor = "#000", depth = 0;
    const stack: Array<[string | null, string | CanvasGradient | null, string]> = [];
    // A canvas can only drop a clip by going back to a saved state, so each clip saves one first.  `clips` counts
    // those per save level; dropping the clip goes back and puts the rest of the state (transform, font, pen) as it was.
    const clips: number[] = [0];
    const unclip = (keep: boolean) => {
      while (clips[clips.length - 1] > 0) {
        clips[clips.length - 1]--;
        if (!keep) { ctx.restore(); continue; }
        const t = ctx.getTransform(), font = ctx.font, alpha = ctx.globalAlpha, lw = ctx.lineWidth, dash = ctx.getLineDash();
        ctx.restore();
        ctx.setTransform(t); ctx.font = font; ctx.globalAlpha = alpha; ctx.lineWidth = lw; ctx.setLineDash(dash);
      }
    };
    ctx.save();
    ctx.lineWidth = 1; ctx.textBaseline = "top"; ctx.font = "400 13.33px system-ui, sans-serif"; ctx.lineJoin = "round"; ctx.lineCap = "butt";
    const paintPath = (mode: number) => { if (fill && mode !== 0) { ctx.fillStyle = fill; ctx.fill(); } if (stroke && mode !== 1) { ctx.strokeStyle = stroke; ctx.stroke(); } };
    // a one pixel line on whole coordinates lies between two pixel rows: it is moved half a pixel, as wx draws it
    const half = () => (ctx.lineWidth % 2 === 1 ? 0.5 : 0);
    const round = (x: number, y: number, rw: number, rh: number, r: number) => { const q = Math.max(0, Math.min(r, rw / 2, rh / 2)); ctx.moveTo(x + q, y); ctx.arcTo(x + rw, y, x + rw, y + rh, q); ctx.arcTo(x + rw, y + rh, x, y + rh, q); ctx.arcTo(x, y + rh, x, y, q); ctx.arcTo(x, y, x + rw, y, q); ctx.closePath(); };
    for (const o of ops) {
      switch (o[0]) {
        case "pen": stroke = o[1]; ctx.lineWidth = o[2] || 1; ctx.setLineDash(o[3] || []); break;
        case "brush": fill = o[1]; break;
        case "grad": { const c = o[2]; const g = o[1] === "linear" ? ctx.createLinearGradient(c[0], c[1], c[2], c[3]) : ctx.createRadialGradient(c[0], c[1], c[2], c[3], c[4], c[5]); for (const st of o[3]) g.addColorStop(Math.max(0, Math.min(1, st[0])), st[1]); fill = g; break; }
        case "font": ctx.font = o[1]; break;
        case "tfg": textColor = o[1]; break;
        case "clear": if (o[1]) { ctx.save(); ctx.setTransform(ctx.getTransform().a === 0 ? 1 : ctx.getTransform().a, 0, 0, ctx.getTransform().d === 0 ? 1 : ctx.getTransform().d, 0, 0); ctx.fillStyle = o[1]; ctx.fillRect(0, 0, w, h); ctx.restore(); } else ctx.clearRect(0, 0, w, h); break;
        case "line": if (stroke) { const k = half(); ctx.beginPath(); ctx.moveTo(o[1] + k, o[2] + k); ctx.lineTo(o[3] + k, o[4] + k); ctx.strokeStyle = stroke; ctx.stroke(); } break;
        case "lines": if (stroke && o[1].length >= 4) { const k = half(), p = o[1]; ctx.beginPath(); ctx.moveTo(p[0] + k, p[1] + k); for (let i = 2; i + 1 < p.length; i += 2) ctx.lineTo(p[i] + k, p[i + 1] + k); ctx.strokeStyle = stroke; ctx.stroke(); } break;
        case "poly": if (o[1].length >= 4) { const p = o[1]; ctx.beginPath(); ctx.moveTo(p[0], p[1]); for (let i = 2; i + 1 < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]); ctx.closePath(); paintPath(2); } break;
        case "point": if (stroke) { ctx.fillStyle = stroke; ctx.fillRect(o[1], o[2], 1, 1); } break;
        case "rect": if (fill) { ctx.fillStyle = fill; ctx.fillRect(o[1], o[2], o[3], o[4]); } if (stroke) { const k = half(); ctx.strokeStyle = stroke; ctx.strokeRect(o[1] + k, o[2] + k, Math.max(0, o[3] - 1), Math.max(0, o[4] - 1)); } break;
        case "rrect": ctx.beginPath(); round(o[1], o[2], o[3], o[4], o[5]); paintPath(2); break;
        case "ellipse": ctx.beginPath(); ctx.ellipse(o[1] + o[3] / 2, o[2] + o[4] / 2, Math.abs(o[3] / 2), Math.abs(o[4] / 2), 0, 0, Math.PI * 2); paintPath(2); break;
        case "arc": ctx.beginPath(); if (o[7] && fill) ctx.moveTo(o[1], o[2]); ctx.arc(o[1], o[2], o[3], o[4], o[5], !!o[6]); if (o[7] && fill) { ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); ctx.beginPath(); ctx.arc(o[1], o[2], o[3], o[4], o[5], !!o[6]); } if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); } break;
        case "earc": ctx.beginPath(); ctx.ellipse(o[1] + o[3] / 2, o[2] + o[4] / 2, Math.abs(o[3] / 2), Math.abs(o[4] / 2), 0, o[5], o[6], true); if (fill) { ctx.lineTo(o[1] + o[3] / 2, o[2] + o[4] / 2); ctx.fillStyle = fill; ctx.fill(); ctx.beginPath(); ctx.ellipse(o[1] + o[3] / 2, o[2] + o[4] / 2, Math.abs(o[3] / 2), Math.abs(o[4] / 2), 0, o[5], o[6], true); } if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); } break;
        case "text": { ctx.fillStyle = textColor; const lines = String(o[1]).split("\n"); const lh = parseFloat(ctx.font.replace(/^.*?([\d.]+)px.*$/, "$1")) * 1.25 || 16; for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], o[2], o[3] + i * lh); break; }
        case "rtext": ctx.save(); ctx.translate(o[2], o[3]); ctx.rotate(o[4]); ctx.fillStyle = textColor; ctx.fillText(String(o[1]), 0, 0); ctx.restore(); break;
        case "img": { const im = images.get(o[1]); if (im) { try { ctx.drawImage(im, o[2], o[3], o[4] || im.naturalWidth, o[5] || im.naturalHeight); } catch { /* a broken picture is left out */ } } break; }
        case "path": {
          const c = o[1]; ctx.beginPath();
          for (let i = 0; i < c.length;) {
            const k = c[i++];
            if (k === "M") { ctx.moveTo(c[i], c[i + 1]); i += 2; }
            else if (k === "L") { ctx.lineTo(c[i], c[i + 1]); i += 2; }
            else if (k === "C") { ctx.bezierCurveTo(c[i], c[i + 1], c[i + 2], c[i + 3], c[i + 4], c[i + 5]); i += 6; }
            else if (k === "Q") { ctx.quadraticCurveTo(c[i], c[i + 1], c[i + 2], c[i + 3]); i += 4; }
            else if (k === "A") { ctx.arc(c[i], c[i + 1], c[i + 2], c[i + 3], c[i + 4], !!c[i + 5]); i += 6; }
            else if (k === "T") { ctx.arcTo(c[i], c[i + 1], c[i + 2], c[i + 3], c[i + 4]); i += 5; }
            else if (k === "E") { ctx.ellipse(c[i] + c[i + 2] / 2, c[i + 1] + c[i + 3] / 2, Math.abs(c[i + 2] / 2), Math.abs(c[i + 3] / 2), 0, 0, Math.PI * 2); ctx.closePath(); i += 4; }
            else if (k === "R") { ctx.rect(c[i], c[i + 1], c[i + 2], c[i + 3]); i += 4; }
            else if (k === "O") { round(c[i], c[i + 1], c[i + 2], c[i + 3], c[i + 4]); i += 5; }
            else if (k === "Z") ctx.closePath();
            else break;
          }
          paintPath(o[2]); break;
        }
        case "save": ctx.save(); stack.push([stroke, fill, textColor]); depth++; clips.push(0); break;
        case "restore": if (depth > 0) { unclip(false); clips.pop(); ctx.restore(); const st = stack.pop(); if (st) { stroke = st[0]; fill = st[1]; textColor = st[2]; } depth--; } break;
        case "translate": ctx.translate(o[1], o[2]); break;
        case "scale": ctx.scale(o[1], o[2]); break;
        case "rotate": ctx.rotate(o[1]); break;
        case "clip": ctx.save(); clips[clips.length - 1]++; ctx.beginPath(); ctx.rect(o[1], o[2], o[3], o[4]); ctx.clip(); break;
        case "unclip": unclip(true); break;
        case "alpha": ctx.globalAlpha = o[1]; break;
        default: break;
      }
    }
    while (depth-- > 0) { unclip(false); clips.pop(); ctx.restore(); }
    unclip(false);
    ctx.restore();
  };
  // The person closed the floating dialog (its ×, or Escape): the topmost wx window gets its close event.
  // What happens in the editor while a plugin's window is open: the person's selection (plugins that ask to "pick an item
  // on the board" wait for it) and changes to the board (the plugin's copy is read again before its next handler runs).
  const tell = (name: string, data: any) => { if (py) py.runPythonAsync("import kicad_web\nkicad_web.editor_event(" + JSON.stringify(name) + ", " + JSON.stringify(JSON.stringify(data || {})) + ")").catch((e: any) => console.error(say(e))); };
  kicad.on("selection", (d: any) => tell("selection", { ids: d && Array.isArray(d.ids) ? d.ids : [] }));
  kicad.on("change", (d: any) => tell("change", d));
  kicad.on("window-closed", () => { if (py) py.runPythonAsync("import wx\nwx._user_closed()").catch((e: any) => console.error(say(e))); });

  // ---- the bridge Python blocks on
  const b64 = (bytes: Uint8Array) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as any); return btoa(s); };
  const unb64 = (text: string) => { const bin = atob(text); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
  W.__kcCall = async (method: string, json: string): Promise<string> => {
    const a = json ? JSON.parse(json) : {}; let out: any = null;
    switch (method) {
      case "design.board": out = await kicad.design.board(); break;
      case "design.commit": out = await kicad.design.commit(a); break;
      case "fab.layers": out = await kicad.fab.layers(); break;
      case "fab.gerbers": out = await kicad.fab.gerbers(a); break;
      case "fab.drill": out = await kicad.fab.drill(a); break;
      case "fab.positions": out = await kicad.fab.positions(a); break;
      case "fab.bom": out = await kicad.fab.bom(a); break;
      case "fab.svg": out = await kicad.fab.svg(a); break;
      case "fab.drc": out = await kicad.fab.drc(a); break;
      case "fab.netlist": out = await kicad.fab.netlist(); break;
      case "fab.render": out = await kicad.fab.render(a); break;
      case "fab.model": out = await kicad.fab.model(a); break;
      case "project.versions": out = await kicad.project.versions(); break;
      case "libs.libraries": out = await kicad.libs.libraries(); break;
      case "libs.footprints": out = await kicad.libs.footprints(a); break;
      case "libs.footprint": out = await kicad.libs.footprint(a); break;
      case "project.saveVersion": out = await kicad.project.saveVersion(a); break;
      case "project.addLibraryFiles": out = await kicad.project.addLibraryFiles(a); break;
      case "net.fetch": out = await kicad.net.fetch(a); break;
      case "view.select": out = await kicad.view.select(a); break;
      case "view.move": out = await kicad.view.move(a); break;
      case "view.highlight": out = await kicad.view.highlight(a); break;
      case "view.appearance": out = await kicad.view.appearance(a); break;
      case "design.undo": out = await kicad.design.undo(); break;
      case "design.copied": out = await kicad.design.copied(); break;
      case "design.copy": out = await kicad.design.copy(a); break;
      case "design.redo": out = await kicad.design.redo(); break;
      case "view.focus": out = await kicad.view.focus(a); break;
      case "ui.confirm": out = await kicad.ui.confirm(a); break;
      case "ui.openLink": out = await kicad.ui.openLink(a); break;
      case "ui.prompt": out = await kicad.ui.prompt(a); break;
      case "ui.status": kicad.ui.status(a.text || "").catch(() => undefined); break;
      case "files.save": out = await kicad.files.save({ filename: a.filename, bytes: unb64(a.base64 || ""), mime: a.mime }); break;
      case "files.pick": { const f = await kicad.files.pick({ title: a.title, accept: a.accept, as: "bytes" }); out = f ? { name: f.name, base64: b64(new Uint8Array(f.bytes)) } : null; break; }
      // the plugin's own settings files, kept between runs (kicad_web._save_state)
      case "storage.get": out = await kicad.storage.get(String(a.key || "")); break;
      case "storage.set": out = await kicad.storage.set(String(a.key || ""), a.value); break;
      case "storage.remove": out = await kicad.storage.remove(String(a.key || "")); break;
      default: throw new Error("the Python runtime has no call named " + method);
    }
    return JSON.stringify(out === undefined ? null : out);
  };

  // ---- actions
  let chain: Promise<unknown> = Promise.resolve();
  const runAction = (index: number) => {
    const next = chain.then(async () => {
      const out = JSON.parse(await py.runPythonAsync("kicad_web.run_action(" + index + ")"));
      if (out.note) kicad.ui.toast(out.note).catch(() => undefined);
      if (!out.ok) throw new Error(out.error || "the plugin failed; its log has the details");
    });
    chain = next.catch(() => undefined);       // one action at a time; a failure does not block the next
    return next;
  };

  // ---- footprint wizards (kicad_wizard.web_op), queued with the actions: the wizard object is shared
  const wizardOp = (index: number, req: any) => {
    const next = chain.then(async () => {
      py.globals.set("_kc_wiz", JSON.stringify(req && typeof req === "object" ? req : {}));
      const out = JSON.parse(await py.runPythonAsync("kicad_web.wizard_op(" + index + ", _kc_wiz)"));
      py.globals.delete("_kc_wiz");
      if (out.error) throw new Error(out.error);
      return out;
    });
    chain = next.catch(() => undefined);
    return next;
  };

  const loadScript = (src: string) => new Promise<void>((ok, no) => { const s = document.createElement("script"); s.src = src; s.onload = () => ok(); s.onerror = () => no(new Error("the Python runtime could not be downloaded")); document.head.appendChild(s); });
  (async () => {
    kicad.ui.status("Starting Python…").catch(() => undefined);
    await loadScript(base + "pyodide.js");
    py = await W.loadPyodide({ indexURL: base, stdout: (t: string) => console.log(t), stderr: (t: string) => console.warn(t) });
    const shim = await (await fetch(base + "kicad-python.json")).json();
    for (const name of Object.keys(shim.files)) { const dst = "/kicad/lib/" + name; py.FS.mkdirTree(dst.slice(0, dst.lastIndexOf("/"))); py.FS.writeFile(dst, shim.files[name]); }
    const files: Record<string, string> = {}; for (const name of kicad.resources.list()) files[name] = await kicad.resources.text(name);
    py.globals.set("_kc_files", py.toPy(files));
    // Packages the plugin imports that the runtime carries (numpy, requests, KiCad's kipy, …) are fetched now, once.
    try {
      const lock = await (await fetch(base + "pyodide-lock.json")).text();
      py.globals.set("_kc_lock", lock);
      const need: string[] = JSON.parse(await py.runPythonAsync("import sys\nsys.path.insert(0, '/kicad/lib')\nimport kicad_web\nkicad_web.needed_packages(_kc_files, _kc_lock)"));
      py.globals.delete("_kc_lock");
      for (const name of need) {
        kicad.ui.status("Loading " + name + "…").catch(() => undefined);
        try { await py.loadPackage(name, { messageCallback: () => undefined, errorCallback: (t: string) => console.warn(t) }); }
        catch (e) { console.warn("The Python package " + name + " could not be loaded: " + lastLine(e)); }
      }
    } catch (e) { console.warn("The plugin's Python packages could not be checked: " + lastLine(e)); }
    const info = JSON.parse(await py.runPythonAsync([
      "import sys",
      "sys.path.insert(0, '/kicad/lib') if '/kicad/lib' not in sys.path else None",
      "import js, kicad_web",
      "from pyodide.ffi import run_sync",
      "def _kc_bridge(method, args):",
      "    return run_sync(js.__kcCall(method, args))",
      // the web addresses this plugin was granted: a connection to this computer itself is carried only when one of them names it
      "import kicad_net",
      "kicad_net.granted = set(" + JSON.stringify((Array.isArray(kicad.plugin.hosts) ? kicad.plugin.hosts : []).filter((h: any) => typeof h === "string")) + ")",
      "kicad_web.boot(" + JSON.stringify(kicad.plugin.identifier) + ", _kc_files, _kc_bridge, " + JSON.stringify(kicad.plugin.name) + ")",
    ].join("\n")));
    py.globals.delete("_kc_files");
    for (const a of info.actions) kicad.actions.register("py" + a.index, () => runAction(a.index), { name: a.name, description: a.description, icon: a.icon, button: !!a.button, wizard: !!a.wizard });
    // a footprint wizard is also offered to the footprint editor's wizard dialog, which talks to it directly
    for (const a of info.actions) if (a.wizard) kicad.wizards.register("py" + a.index, (req: any) => wizardOp(a.index, req), { name: String(a.name).replace(/^Footprint Wizard: /, ""), description: a.description });
    kicad.ui.status("").catch(() => undefined);
    if (info.error) console.error("This plugin could not be loaded: " + info.error);
    else if (!info.actions.length) console.warn("This plugin loaded but added no board editor actions.");
    kicad.plugin.loaded({ failed: !!info.error && !info.actions.length, error: info.error || null, actions: info.actions.length });
  })().catch((e) => { console.error("The Python runtime did not start: " + lastLine(e)); kicad.ui.status("").catch(() => undefined); kicad.plugin.loaded({ failed: true, error: lastLine(e), actions: 0 }); });
}
