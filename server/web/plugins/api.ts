// api.ts — what a plugin's requests do once host.ts has let them through.
//
// Reads are the assistant's read tools (web/ai/design.ts): the same facts, from the same code the
// editor draws with.  Writes build ordinary collaboration changes and hand them to the editor's
// own commit path, so a plugin's edit is applied locally, sent as an op, shown to every peer,
// recorded as one undo step and captured by checkpoints — exactly like a person's edit.  Nothing
// here touches the document any other way.

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as design from "../ai/design";
import { ED, K, ToolError } from "../ai/design";
import { added, buildProposal, modified, removed } from "../ai/proposals";
import { appState } from "../store";

export class ApiError extends Error { constructor(message: string, public code = "error") { super(message); } }

const PCB = (): any => (window as any).PcbTools || null;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const MAX_CHANGES = 2000;

const editor = () => { const ed = ED(); if (!ed || !ed.api) throw new ApiError("The editor is not ready.", "not_ready"); return ed; };
const liveDoc = () => { const ed = editor(); const open = design.openEntry(); if (!ed.kdoc || !open) throw new ApiError("No document is open in the editor.", "no_document"); return { ed, doc: ed.kdoc, open }; };

/** Run one of the assistant's read tools, turning its ToolError into the plugin's error. */
async function read<T>(fn: () => T | Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { if (e instanceof ToolError) throw new ApiError(e.message, "not_found"); throw e; }
}

// ---------------------------------------------------------------- the board file's header

/**
 * One header section of a board file ("setup", "general", …) as text, or "" when it has none.  The editor keeps a board's
 * items, not its header, so this reads the section out of the file as last saved; it stops at the first item, so a large
 * board costs no more than a small one.
 */
function headerSection(file: string, name: string): string {
  const HEAD = new Set(["version", "generator", "generator_version", "general", "paper", "page", "title_block", "layers", "setup", "net", "property", "host"]);
  let i = file.indexOf("(kicad_pcb"); if (i < 0) return ""; i += 10;
  for (;;) {
    while (i < file.length && file[i] !== "(" && file[i] !== ")") i++;
    if (i >= file.length || file[i] === ")") return "";
    const start = i; let j = i + 1; while (j < file.length && /[A-Za-z0-9_.]/.test(file[j])) j++;
    const head = file.slice(i + 1, j); if (!HEAD.has(head)) return "";
    let depth = 0, quoted = false;
    for (; i < file.length; i++) {
      const ch = file[i];
      if (quoted) { if (ch === "\\") i++; else if (ch === '"') quoted = false; }
      else if (ch === '"') quoted = true;
      else if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) { i++; break; }
    }
    if (head === name) return file.slice(start, i);
  }
}
/** The open board's file as the server last saved it ("" when it cannot be read). */
async function savedBoardFile(docId: string): Promise<string> {
  try { const r = await fetch(`/api/docs/${encodeURIComponent(docId)}/content`); return r.ok ? await r.text() : ""; } catch { return ""; }
}

// ---------------------------------------------------------------- reads

export const reads: Record<string, (a: any) => Promise<unknown>> = {
  overview: () => read(() => design.overview()),
  documents: async () => { const open = design.openEntry(); return design.projectDocs().map((d) => ({ path: d.path, type: d.docType === "kicad_pcb" ? "board" : "schematic", open: !!open && open.docId === d.docId })); },
  components: (a) => read(() => design.listComponents({ doc: a.doc, filter: a.filter, include_power: !!a.includePower })),
  component: (a) => read(() => design.getComponent({ ref: String(a.ref || ""), doc: a.doc })),
  nets: (a) => read(() => design.listNets({ doc: a.doc, filter: a.filter })),
  selection: () => read(() => design.getSelection()),
  runChecks: (a) => read(() => design.runChecks({ doc: a.doc })),
  boardInfo: () => read(() => design.boardInfo()),
  /**
   * The open board as one .kicad_pcb text, for a program that wants the file rather than a list (a KiCad Python plugin's
   * pcbnew.GetBoard()).  The editor keeps items, not the file, so the header is written out from what it knows: the layer
   * table, the thickness, the stackup, the origins, the title block and the net table.
   */
  board: () => read(async () => {
    const { ed, doc, open } = liveDoc(); const k = K();
    if (doc.type !== "pcb") throw new ApiError("The open document is a schematic; KiCad's Python plugins work on a board. Open the board first.", "not_board");
    const q = (v: unknown) => '"' + String(v == null ? "" : v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
    const out: string[] = [`(kicad_pcb (version ${doc.version || 20241229}) (generator "pcbnew") (generator_version "10.0")`, `(general (thickness ${r3(doc.thickness || 1.6)}))`, `(paper ${q(doc.paper || "A4")}${doc.portrait ? " portrait" : ""})`];
    const tb = doc.titleBlock || {}; const tbl: string[] = [];
    for (const f of ["title", "date", "rev", "company"]) if (tb[f]) tbl.push(`(${f} ${q(tb[f])})`);
    for (let i = 1; i <= 9; i++) if (tb["comment" + i]) tbl.push(`(comment ${i} ${q(tb["comment" + i])})`);
    if (tbl.length) out.push(`(title_block ${tbl.join(" ")})`);
    const layers: string[] = []; for (const [name, l] of doc.layers as Map<string, any>) layers.push(`(${l.id} ${q(name)} ${l.type || "user"}${l.userName ? " " + q(l.userName) : ""})`);
    if (layers.length) out.push(`(layers ${layers.join(" ")})`);
    // The setup section (mask and paste margins, plot settings, the stackup) is taken whole from the saved file; without one it is written from what the editor holds.
    const saved = headerSection(await savedBoardFile(open.docId), "setup");
    if (saved) out.push(saved);
    else {
      const setup: string[] = []; if (doc.stackup) setup.push(k.serialize(doc.stackup));
      if (doc.auxOrigin && (doc.auxOrigin[0] || doc.auxOrigin[1])) setup.push(`(aux_axis_origin ${r3(doc.auxOrigin[0])} ${r3(doc.auxOrigin[1])})`);
      if (doc.gridOrigin && (doc.gridOrigin[0] || doc.gridOrigin[1])) setup.push(`(grid_origin ${r3(doc.gridOrigin[0])} ${r3(doc.gridOrigin[1])})`);
      out.push(`(setup ${setup.join(" ")})`);
    }
    for (const [code, name] of doc.nets as Map<number, string>) out.push(`(net ${code} ${q(name)})`);
    for (const it of doc.items.values()) out.push(k.serialize(it.node));
    out.push(")");
    const ids: string[] = selectedIds();
    const st = ed.api.state || {};
    // The files a desktop plugin finds beside the board: the project file (net classes, design rules), the schematics and the project's other boards, as last saved.
    const files: { path: string; text: string }[] = []; let budget = 6 * 1024 * 1024;
    if (typeof ed.proSettings === "string" && ed.proSettings) files.push({ path: open.path.replace(/\.kicad_pcb$/, "") + ".kicad_pro", text: ed.proSettings });
    // … and the project's library tables with its own symbol libraries and footprints, for plugins that work on libraries.
    const beside = design.projectDocs().filter((d: any) => /^(kicad_(sch|pro|pcb)|lib_table|symbol_lib|footprint)$/.test(d.docType))
      .sort((x: any, y: any) => Number(/^kicad_/.test(y.docType) || y.docType === "lib_table") - Number(/^kicad_/.test(x.docType) || x.docType === "lib_table"));
    for (const d of beside.slice(0, 120)) {
      if (d.docId === open.docId || files.some((f) => f.path === d.path) || budget <= 0) continue;
      try { const r = await fetch(`/api/docs/${encodeURIComponent(d.docId)}/content`); if (!r.ok) continue; const text = await r.text(); if (text.length > budget) continue; budget -= text.length; files.push({ path: d.path, text }); } catch { /* the plugin runs without it */ }
    }
    let grid = 0; try { grid = Number(appState().viewport.gridPitch) || 0; } catch { /* the grid is a convenience for plugins that snap to it */ }
    return { path: open.path, project: st.project ? st.project.name : "", projectId: (() => { const pr = appState().project; return pr && pr.projectId ? String(pr.projectId) : ""; })(), text: out.join("\n"), selection: ids, version: "10.0.0", files, grid };
  }),
  /** Items in full: unlike the assistant's get_items nothing is clipped, because a program reads this, not a model. */
  items: (a) => read(async () => {
    const { doc, path } = await design.resolveDoc(a.doc); const k = K();
    const kinds = Array.isArray(a.kinds) ? new Set<string>(a.kinds) : null; const ids = Array.isArray(a.ids) ? new Set<string>(a.ids) : null;
    const near = a.near && typeof a.near === "object" ? a.near : null; const limit = Math.min(20000, Math.max(1, Number(a.limit) || 5000));
    const rows: any[] = []; let total = 0, budget = 8 * 1024 * 1024;
    for (const it of doc.items.values()) {
      if (kinds && !kinds.has(it.kind)) continue; if (ids && !ids.has(it.id)) continue;
      if (near) { const b = it.bbox; if (!b || b[2] < near.x - near.radius || b[0] > near.x + near.radius || b[3] < near.y - near.radius || b[1] > near.y + near.radius) continue; }
      total++; if (rows.length >= limit || budget <= 0) continue;
      const row: any = { id: it.id, kind: it.kind };
      if (it.ref) row.ref = it.ref; if (it.value) row.value = it.value; if (it.lib) row.lib = it.lib; if (it.layer) row.layer = it.layer;
      if (typeof it.x === "number") { row.x = r3(it.x); row.y = r3(it.y); } if (it.rot) row.rotation = it.rot;
      if (it.bbox) row.bbox = it.bbox.map(r3);
      if (it.kind === "symbol" || it.kind === "footprint") row.fields = design.fieldsOf(it.node);
      if (a.sexpr !== false) { row.sexpr = k.serialize(it.node); budget -= row.sexpr.length; }
      rows.push(row);
    }
    return { document: path, type: doc.type === "sch" ? "schematic" : "board", count: total, items: rows, truncated: total > rows.length };
  }),
};

// ---------------------------------------------------------------- writes

function mayWrite(): any {
  const { ed, doc, open } = liveDoc();
  if (ed.viewOnly) throw new ApiError("You have view-only access to this project, so plugins cannot change it.", "view_only");
  return { ed, doc, open };
}

function commit(ed: any, changes: any[], label: string): void {
  if (!changes.length) throw new ApiError("There is nothing to change.", "empty");
  if (changes.length > MAX_CHANGES) throw new ApiError(`That is ${changes.length} changes in one step; the limit is ${MAX_CHANGES}. Split it into steps.`, "too_large");
  ed.api.commitChanges(changes, label);
}

/** Whether every parenthesis outside a quoted string is closed, and none closes too early. */
function balanced(text: string): boolean {
  let depth = 0, quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === "\\") i++; else if (ch === '"') quoted = false; }
    else if (ch === '"') quoted = true;
    else if (ch === "(") depth++;
    else if (ch === ")") { if (--depth < 0) return false; }
  }
  return depth === 0 && !quoted;
}

/** One parsed item out of plugin-supplied s-expression text, or an error that says what is wrong with it. */
function parseItem(doc: any, text: unknown, where: string): any {
  const k = K();
  if (typeof text !== "string" || !text.trim()) throw new ApiError(`${where}: sexpr is required`, "invalid");
  if (text.length > 4 * 1024 * 1024) throw new ApiError(`${where}: the item is too large`, "invalid");
  if (!balanced(text)) throw new ApiError(`${where}: the s-expression's parentheses do not balance`, "invalid");   // the editor's parser is forgiving; a plugin's text is held to the grammar
  let trees: any[]; try { trees = k.parseAll(text); } catch { throw new ApiError(`${where}: the s-expression does not parse`, "invalid"); }
  if (trees.length !== 1 || !Array.isArray(trees[0]) || typeof trees[0][0] !== "string") throw new ApiError(`${where}: sexpr must be exactly one item`, "invalid");
  const node = trees[0];
  // The item has to be something this kind of document holds, and well-formed enough to draw:
  // adding a clone to an empty copy of the document is the editor's own test for both.
  const scratch = Object.assign({}, doc, { items: new Map() }); const probe = k.cloneNode(node);
  if (!k.uuidOf(probe)) probe.push(["uuid", k.newUuid()]);
  let ok: any = null; try { ok = k.addItem(scratch, probe); } catch { /* reported below */ }
  if (!ok) throw new ApiError(`${where}: "${node[0]}" is not an item a ${doc.type === "sch" ? "schematic sheet" : "board"} holds, or it is malformed`, "invalid");
  return node;
}

export const writes: Record<string, (a: any, label: string) => Promise<unknown>> = {
  /** Structured edits, the grammar the assistant's proposals use (set_field, move, remove, add_symbol, add_wire, add_track, …). */
  apply: async (a, label) => {
    const { ed } = mayWrite();
    let p; try { p = await buildProposal({ title: a.title, edits: a.edits }); } catch (e) { if (e instanceof ToolError) throw new ApiError(e.message.replace(/^No proposal was shown, because /, "Nothing was changed, because "), "invalid"); throw e; }
    commit(ed, p.changes, label);
    return { changes: p.lines.map((l) => ({ kind: l.kind, text: l.text, ids: l.ids })) };
  },
  /** Raw items: create from s-expressions, replace existing items by id, remove by id — one undo step. */
  commit: async (a, label) => {
    const { ed, doc } = mayWrite(); const k = K();
    const create = Array.isArray(a.create) ? a.create : [], update = Array.isArray(a.update) ? a.update : [], remove = Array.isArray(a.remove) ? a.remove : [], transform = Array.isArray(a.transform) ? a.transform : [];
    if (create.length + update.length + remove.length + transform.length > MAX_CHANGES) throw new ApiError(`The limit is ${MAX_CHANGES} changes in one step.`, "too_large");
    const changes: any[] = []; const touched = new Set<string>(); const created: string[] = [];
    const touch = (id: string, where: string) => { if (touched.has(id)) throw new ApiError(`${where}: item ${id} is changed twice in this commit`, "invalid"); touched.add(id); };
    // A footprint placed by position rather than by text ({id, x, y, rotation, side}): the editor's own move, turn and flip,
    // so pads, texts and graphics follow exactly as when a person does it.  It may come with an update of the same footprint.
    const place = new Map<string, any>();
    transform.forEach((t: any, i: number) => {
      const where = `transform[${i}]`; const it = t && typeof t.id === "string" ? doc.items.get(t.id) : null;
      if (!it) throw new ApiError(`${where}: there is no item with id ${t && t.id} on the open document`, "not_found");
      if (doc.type !== "pcb" || it.kind !== "footprint") throw new ApiError(`${where}: only a footprint is placed this way`, "invalid");
      for (const f of ["x", "y"]) if (typeof t[f] !== "number" || !isFinite(t[f]) || Math.abs(t[f]) > 1e5) throw new ApiError(`${where}: ${f} must be a number of millimetres`, "invalid");
      if (t.rotation !== undefined && (typeof t.rotation !== "number" || !isFinite(t.rotation))) throw new ApiError(`${where}: rotation must be a number of degrees`, "invalid");
      if (place.has(it.id)) throw new ApiError(`${where}: item ${it.id} is placed twice in this commit`, "invalid");
      place.set(it.id, t);
    });
    const placed = (node: any): any => {
      const t = place.get(k.uuidOf(node)); if (!t) return node; const P = PCB();
      if (!P) throw new ApiError("The board tools are not loaded.", "not_ready");
      const [ox, oy] = k.atOf(node);
      if ((t.side === "back" || t.side === "front") && (t.side === "back") !== (k.str((k.kid(node, "layer") || [])[1]) === "B.Cu")) P.flipNode(node, ox, doc);
      P.translateNode(node, t.x - ox, t.y - oy);
      const cur = k.atOf(node)[2] || 0;
      if (typeof t.rotation === "number" && t.rotation !== cur) P.rotateNode(node, t.x, t.y, t.rotation - cur);
      return node;
    };
    update.forEach((u: any, i: number) => {
      const where = `update[${i}]`; const it = u && typeof u.id === "string" ? doc.items.get(u.id) : null;
      if (!it) throw new ApiError(`${where}: there is no item with id ${u && u.id} on the open document`, "not_found");
      const node = parseItem(doc, u.sexpr, where);
      if (node[0] !== it.node[0]) throw new ApiError(`${where}: a ${it.node[0]} cannot become a ${node[0]}; remove it and create the new item`, "invalid");
      const uu = k.kid(node, "uuid"); if (uu) uu[1] = it.id; else node.push(["uuid", it.id]);   // an update keeps its identity whatever the text says
      touch(it.id, where); changes.push(modified(doc, it, placed(node)));
    });
    for (const id of place.keys()) if (!touched.has(id)) { const it = doc.items.get(id); touch(id, "transform"); changes.push(modified(doc, it, placed(k.cloneNode(it.node)))); }
    remove.forEach((id: any, i: number) => {
      const it = typeof id === "string" ? doc.items.get(id) : null;
      if (!it) throw new ApiError(`remove[${i}]: there is no item with id ${id} on the open document`, "not_found");
      touch(it.id, `remove[${i}]`); changes.push(removed(doc, it));
    });
    create.forEach((text: any, i: number) => {
      const where = `create[${i}]`; const node = parseItem(doc, text, where);
      if (!k.uuidOf(node)) node.push(["uuid", k.newUuid()]);
      const id = k.uuidOf(node);
      if (doc.items.has(id) || touched.has(id)) throw new ApiError(`${where}: that uuid is already in the document; leave the uuid out and one is assigned`, "invalid");
      touched.add(id); const c = added(doc, node); changes.push(c); created.push(c.id);
    });
    commit(ed, changes, label);
    return { created, updated: update.length, removed: remove.length, placed: place.size };
  },
};

// ---------------------------------------------------------------- fabrication outputs

let fabLoading: Promise<any> | null = null;
/** The editor's own Gerber, drill and placement writers (web/fab), fetched on first use. */
function loadFab(): Promise<any> {
  const W = window as any; if (W.KiCadFab && typeof W.KiCadFab.plotGerbers === "function") return Promise.resolve(W.KiCadFab);
  if (fabLoading) return fabLoading;
  fabLoading = new Promise<any>((ok, no) => {
    const own = document.querySelector<HTMLScriptElement>('script[src*="/static/dist/editor.js"]'); const query = own ? (own.getAttribute("src") || "").split("?")[1] : "";
    const el = document.createElement("script"); el.src = "/static/dist/fab.js" + (query ? "?" + query : "");
    el.onload = () => (W.KiCadFab && typeof W.KiCadFab.plotGerbers === "function" ? ok(W.KiCadFab) : no(new ApiError("The fabrication writers did not load.", "not_ready")));
    el.onerror = () => no(new ApiError("The fabrication writers could not be downloaded.", "not_ready"));
    document.head.appendChild(el);
  });
  fabLoading.catch(() => { fabLoading = null; });
  return fabLoading;
}
async function fabContext(): Promise<{ F: any; ctx: any }> {
  const { doc, open } = liveDoc();
  if (doc.type !== "pcb") throw new ApiError("Fabrication outputs are made from a board; the open document is a schematic.", "not_board");
  const [F, file] = await Promise.all([loadFab(), savedBoardFile(open.docId)]);
  return { F, ctx: { doc, setup: file || null, projectName: String(open.path).replace(/^.*\//, "").replace(/\.kicad_pcb$/, "") } };
}
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 80) : undefined);

/**
 * What KiCad's plot and drill classes write, from the editor's own writers and the board as it stands, so a plugin that
 * prepares a manufacturer's order gets the same files File → Fabrication Outputs makes.
 */
export const fab: Record<string, (a: any) => Promise<unknown>> = {
  layers: async () => { const { F, ctx } = await fabContext(); return { layers: F.plottableLayers(ctx.doc) }; },
  gerbers: async (a) => {
    const { F, ctx } = await fabContext(); const all: string[] = F.plottableLayers(ctx.doc); const want = strs(a.layers);
    const r = F.plotGerbers(ctx, { layers: want ? want.filter((l) => all.includes(l)) : undefined, useProtelExtensions: !!a.useProtelExtensions, useGerberX2: a.useGerberX2 !== false, useAuxOrigin: !!a.useAuxOrigin,
      precision: a.precision === 5 ? 5 : 6, plotReference: a.plotReference !== false, plotValue: a.plotValue !== false, subtractMaskFromSilk: !!a.subtractMaskFromSilk, commonLayers: strs(a.commonLayers),
      sketchDnpOnFab: a.sketchDnpOnFab, hideDnpOnFab: a.hideDnpOnFab, crossoutDnpOnFab: a.crossoutDnpOnFab });
    return { files: r.files.map((f: any) => ({ name: f.name, text: f.text, layer: f.layer })), warnings: r.warnings, missing: want ? want.filter((l) => !all.includes(l)) : [] };
  },
  drill: async (a) => {
    const { F, ctx } = await fabContext(); const zeros = ["decimal", "suppress_leading", "suppress_trailing", "keep"].includes(a.zeros) ? a.zeros : "decimal";
    const files = F.drillFiles(ctx, { metric: a.metric !== false, zeros, merge: !!a.merge, minimalHeader: !!a.minimalHeader, mirrorY: !!a.mirrorY, ovalMode: a.ovalMode === "g85" ? "g85" : "route", useAuxOrigin: !!a.useAuxOrigin,
      extension: typeof a.extension === "string" && /^[A-Za-z0-9]{1,8}$/.test(a.extension) ? a.extension : undefined });
    return { files: files.map((f: any) => ({ name: f.name, text: f.text, holes: f.holes, tools: f.tools })) };
  },
  positions: async (a) => {
    const { F, ctx } = await fabContext(); const side = a.side === "front" || a.side === "back" ? a.side : "both";
    const rows = F.positions(ctx, { side, smdOnly: !!a.smdOnly, excludeThroughHole: !!a.excludeThroughHole, excludeDnp: !!a.excludeDnp, useAuxOrigin: !!a.useAuxOrigin, negateBottomX: !!a.negateBottomX });
    return { rows: rows.map((r: any) => ({ ref: r.ref, value: r.value, package: r.pkg, x: r.x, y: r.y, rotation: r.rot, side: r.side })), csv: F.placementCsv(rows),
      ascii: F.placementAscii(rows, side, new Date().toISOString().slice(0, 19).replace("T", " "), "KiCad") };
  },
  bom: async (a) => { const { F, ctx } = await fabContext(); const lines = F.bom(ctx, { excludeDnp: !!a.excludeDnp }); return { csv: F.bomCsv(lines), lines: lines.length }; },
  /**
   * `kicad-cli pcb export svg`: the layers as the plot code reduces them (the same shapes the Gerbers hold), drawn in
   * KiCad's layer colours on the board's page or cropped to the board.  One file per layer, or all layers in one.
   */
  svg: async (a) => {
    const { F, ctx } = await fabContext(); const k = K(); const all: string[] = F.plottableLayers(ctx.doc);
    const pick = (v: unknown): string[] => (strs(v) || []).filter((l, i, arr) => all.includes(l) && arr.indexOf(l) === i);
    const want = pick(a.layers), common = pick(a.commonLayers).filter((l) => !want.includes(l));
    const r = F.plotGerbers(ctx, { layers: [...want, ...common], plotReference: a.plotReference !== false, plotValue: a.plotValue !== false });
    const f4 = (v: number): string => (Math.round(v * 10000) / 10000).toString();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; let masks = 0;
    const body = (layer: string): string => {
      const color = a.blackAndWhite ? "#000000" : String(k.pcbColor(layer)); let out = "", run: string[] = [];
      const flush = (): void => { if (run.length) { out += `<path d="${run.join(" ")}"/>\n`; run = []; } };
      for (const prim of r.prims.get(layer) || []) {
        const d: string[] = [];
        for (const poly of F.primPolys(prim) as [number, number][][]) {
          for (const q of poly) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }
          d.push("M" + poly.map((q) => f4(q[0]) + " " + f4(q[1])).join(" L") + " Z");
        }
        if (!d.length) continue;
        if (prim.clear) {      // what was plotted so far loses this shape: a mask over everything before it
          flush(); const id = "kc-clear-" + masks++;
          out = `<mask id="${id}" maskUnits="userSpaceOnUse" x="-1e5" y="-1e5" width="2e5" height="2e5"><rect x="-1e5" y="-1e5" width="2e5" height="2e5" fill="#fff"/><path d="${d.join(" ")}" fill="#000"/></mask>\n<g mask="url(#${id})">\n${out}</g>\n`;
        } else run.push(...d);
      }
      flush();
      return `<g id="${layer.replace(/[^A-Za-z0-9_.-]/g, "_")}" style="fill:${color}; fill-opacity:1; stroke:none; fill-rule:nonzero;">\n${out}</g>\n`;
    };
    const bodies = new Map<string, string>(); for (const l of [...want, ...common]) bodies.set(l, body(l));
    const page: [number, number] = Array.isArray(ctx.doc.page) && ctx.doc.page.length === 2 ? [ctx.doc.page[0], ctx.doc.page[1]] : [297, 210];
    const crop = a.area === "board" && isFinite(x0); const m = 0;
    const [vx, vy, vw, vh] = crop ? [x0 - m, y0 - m, x1 - x0 + 2 * m, y1 - y0 + 2 * m] : [0, 0, page[0], page[1]];
    const wrap = (name: string, inner: string): string => `<?xml version="1.0" standalone="no"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n`
      + `<svg xmlns:svg="http://www.w3.org/2000/svg" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="${f4(vw)}mm" height="${f4(vh)}mm" viewBox="${f4(vx)} ${f4(vy)} ${f4(vw)} ${f4(vh)}">\n`
      + `<title>SVG Image created as ${name.replace(/[<&>]/g, "_")}</title>\n<desc>Image generated by PCBNEW</desc>\n`
      + (a.mirror ? `<g transform="translate(${f4(2 * vx + vw)} 0) scale(-1 1)">\n${inner}</g>\n` : inner) + "</svg>\n";
    const name = F.projectNameOf ? F.projectNameOf(ctx) : ctx.projectName;
    const files: { name: string; text: string; layer?: string }[] = [];
    if (a.single) { const file = `${name}.svg`; files.push({ name: file, text: wrap(file, [...common, ...want].reverse().map((l) => bodies.get(l) || "").join("")) }); }
    else for (const l of want) { const file = `${name}-${String(F.layerDisplayName(ctx.doc, l)).replace(/\./g, "_")}.svg`; files.push({ name: file, layer: l, text: wrap(file, common.map((c) => bodies.get(c) || "").join("") + (bodies.get(l) || "")) }); }
    const req = [...(strs(a.layers) || []), ...(strs(a.commonLayers) || [])];
    return { files, warnings: r.warnings, missing: req.filter((l) => !all.includes(l)), box: isFinite(x0) ? [x0, y0, x1, y1] : null, page };
  },
  /** `kicad-cli pcb drc`: the Design Rules Checker's own run (Inspect → Design Rules Checker), as data. */
  drc: async (a) => {
    const { doc } = liveDoc(); if (doc.type !== "pcb") throw new ApiError("The design rule check runs on a board; the open document is a schematic.", "not_board");
    const tools = (window as any).CollabTools && (window as any).CollabTools.pcb;
    if (!tools || typeof tools.drcReport !== "function") throw new ApiError("The Design Rules Checker is not loaded.", "not_ready");
    const text = typeof a.text === "string" && a.text.length <= 64 * 1024 * 1024 ? a.text : undefined;
    const r = await tools.drcReport({ parity: a.parity !== false, text }); if (!r) throw new ApiError("The Design Rules Checker needs a board.", "not_board");
    return { parityError: r.parityError, markers: r.markers.map((m: any) => ({ code: m.code, severity: m.severity, text: m.text, x: r3(m.x), y: r3(m.y), group: m.group, items: m.items })),
      note: "The web editor checks clearance, edge clearance, unconnected items, shorts, dangling tracks, annular width, courtyards and schematic parity; KiCad's desktop DRC checks more rules." };
  },
  /** `kicad-cli sch export netlist` and `sch export bom`: the project's schematic as components and nets (what Update PCB from Schematic reads). */
  netlist: async () => {
    const tools = (window as any).CollabTools && (window as any).CollabTools.pcb;
    if (!tools || typeof tools.projectNetlist !== "function") throw new ApiError("The schematic tools are not loaded.", "not_ready");
    const res = await tools.projectNetlist(); if (!res || "error" in res) throw new ApiError((res && res.error) || "This project has no schematic.", "not_found");
    const n = res.netlist;
    return { root: res.root, warnings: n.warnings,
      components: n.components.map((c: any) => ({ ref: c.ref, value: c.value, footprint: c.footprint, libId: c.libId, paths: c.paths, fields: c.fields, sheetName: c.sheetName, sheetFile: c.sheetFile, dnp: !!c.dnp,
        excludeFromBom: !!c.excludeFromBom, excludeFromBoard: !!c.excludeFromBoard, pins: Array.from(c.pins as Map<string, any>).map(([num, pin]) => ({ num, net: pin.net, name: pin.name, type: pin.type })) })),
      nets: Array.from(n.nets as Map<string, any[]>).map(([name, nodes]) => ({ name, nodes: nodes.map((x) => ({ ref: x.ref, pin: x.pin })) })) };
  },
};

// ---------------------------------------------------------------- 3D pictures and models

let viewerLoading: Promise<any> | null = null;
/** The editor's 3D viewer (web/viewer3d), fetched on first use. */
function loadViewer3d(): Promise<any> {
  const W = window as any; if (W.KiCadViewer3D && typeof W.KiCadViewer3D.embed === "function") return Promise.resolve(W.KiCadViewer3D);
  if (viewerLoading) return viewerLoading;
  viewerLoading = new Promise<any>((ok, no) => {
    const own = document.querySelector<HTMLScriptElement>('script[src*="/static/dist/editor.js"]'); const query = own ? (own.getAttribute("src") || "").split("?")[1] : "";
    const el = document.createElement("script"); el.src = "/static/dist/viewer3d.js" + (query ? "?" + query : "");
    el.onload = () => (W.KiCadViewer3D && typeof W.KiCadViewer3D.embed === "function" ? ok(W.KiCadViewer3D) : no(new ApiError("The 3D viewer did not load.", "not_ready")));
    el.onerror = () => no(new ApiError("The 3D viewer could not be downloaded.", "not_ready"));
    document.head.appendChild(el);
  });
  viewerLoading.catch(() => { viewerLoading = null; });
  return viewerLoading;
}

/** The board a render is made of, set up once and kept while frames of the same board keep coming (an animation is hundreds of them). */
let stage: { key: string; viewer: any; host: HTMLElement; idle: number } | null = null;
function dropStage(): void { if (!stage) return; clearTimeout(stage.idle); try { stage.viewer.dispose(); } catch { /* the context is gone already */ } stage.host.remove(); stage = null; }
async function stageFor(a: any): Promise<{ viewer: any } | { needText: true }> {
  const key = typeof a.key === "string" && a.key.length <= 80 ? a.key : "";
  const text = typeof a.text === "string" && a.text.length <= 64 * 1024 * 1024 ? a.text : undefined;
  if (stage && key && stage.key === key) { clearTimeout(stage.idle); stage.idle = window.setTimeout(dropStage, 120000); return { viewer: stage.viewer }; }
  if (key && text === undefined) return { needText: true };
  const V = await loadViewer3d();
  let doc: any;
  if (text !== undefined) doc = (K().parseDoc as (t: string, k: string) => any)(text, "kicad_pcb");
  else { doc = liveDoc().doc; if (doc.type !== "pcb") throw new ApiError("A 3D picture is made of a board; the open document is a schematic.", "not_board"); }
  dropStage();
  const host = document.createElement("div"); host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:fixed;left:-20000px;top:0;width:640px;height:480px;pointer-events:none;opacity:0";
  document.body.appendChild(host);
  let viewer: any;
  try { viewer = V.embed(host, { wheel: false }); viewer.setDoc(doc, true); }
  catch (e) { host.remove(); throw new ApiError("This browser could not start WebGL for the 3D picture: " + String((e as Error).message || e), "not_ready"); }
  stage = { key: key || "live", viewer, host, idle: window.setTimeout(dropStage, key ? 120000 : 0) };
  return { viewer };
}
const SIDES: Record<string, [number, number, number]> = { top: [0, 0, 0], bottom: [0, 180, 0], front: [-90, 0, 0], back: [-90, 0, 180], left: [-90, 0, 90], right: [-90, 0, -90] };
const num3 = (v: unknown): [number, number, number] | null => (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && isFinite(x)) ? [v[0], v[1], v[2]] : null);
function bytesBase64(bytes: Uint8Array): string { let t = ""; for (let i = 0; i < bytes.length; i += 0x8000) t += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]); return btoa(t); }

/**
 * `kicad-cli pcb render` and `pcb export glb`: the board as the editor's 3D viewer shows it, at the pose, size and
 * lights asked for.  KiCad's command line ray-traces; this is the viewer's own drawing (the same one View > 3D Viewer
 * shows), so the picture is the web editor's, lit to match.
 */
Object.assign(fab, {
  render: async (a: any) => {
    const st = await stageFor(a); if ("needText" in st) return { needText: true };
    const v = st.viewer; const side = SIDES[String(a.side || "top")] || SIDES.top; const rot = num3(a.rotate) || [0, 0, 0];
    const width = Math.max(16, Math.min(8192, Math.round(Number(a.width) || 1600))), height = Math.max(16, Math.min(8192, Math.round(Number(a.height) || 900)));
    v.setOrtho(!a.perspective);
    const L = a.lights && typeof a.lights === "object" ? a.lights : null;
    v.setLights(L ? { top: num3(L.top) || undefined, bottom: num3(L.bottom) || undefined, side: num3(L.side) || undefined, camera: num3(L.camera) || undefined,
      sideElevation: typeof L.sideElevation === "number" ? L.sideElevation : undefined } : null);
    v.host.style.width = width + "px"; v.host.style.height = height + "px"; v.resize();
    v.pose(side[0] + rot[0], side[1] + rot[1], side[2] + rot[2], Math.max(0.05, Math.min(80, Number(a.zoom) || 1)));
    const pan = num3(a.pan); if (pan) v.pan(pan[0], pan[1], pan[2]);
    // the parts' real 3D models, as KiCad's render shows them; a model that takes too long keeps its stand-in
    if (typeof v.useModels === "function") { v.useModels(true); await Promise.race([v.modelsSettled(), new Promise((r) => setTimeout(r, 30000))]); }
    const jpeg = a.format === "jpeg";
    const blob: Blob = await v.renderImage({ width, height, transparent: !jpeg && a.background !== "opaque", type: jpeg ? "image/jpeg" : "image/png" });
    return { base64: bytesBase64(new Uint8Array(await blob.arrayBuffer())), width, height, renderer: "web" };
  },
  model: async (a: any) => {
    const st = await stageFor(a); if ("needText" in st) return { needText: true };
    const glb: ArrayBuffer = await st.viewer.exportGLB();
    return { base64: bytesBase64(new Uint8Array(glb)), bytes: glb.byteLength };
  },
});

// ---------------------------------------------------------------- the project's versions
//
// A plugin that keeps the design under version control on the desktop (git) keeps it in the project's version history
// here: a commit is a saved version, the commit window is the Save Version dialog, the log is the list of versions.

const projectId = (): string => { const pr = appState().project; if (!pr) throw new ApiError("No project is open.", "no_document"); return pr.projectId; };
export const project: Record<string, (a: any) => Promise<unknown>> = {
  versions: async () => {
    const r = await fetch(`/api/projects/${encodeURIComponent(projectId())}/timeline`); if (!r.ok) throw new ApiError(`The version history could not be read (the server answered ${r.status}).`, "not_found");
    const j = await r.json().catch(() => ({}));
    return { branch: j.branchName || null, versions: (Array.isArray(j.versions) ? j.versions : []).slice(0, 500).map((v: any) => ({ id: String(v.id || ""), name: String(v.name || ""), description: String(v.description || ""),
      kind: String(v.kind || "named"), author: v.author ? String(v.author.name || v.author.login || "") : "", createdAt: String(v.createdAt || "") })) };
  },
  saveVersion: async (a) => {
    projectId(); const app = (window as any).CollabApp; if (!app || typeof app.dispatch !== "function") throw new ApiError("The editor is not ready.", "not_ready");
    if ((appState() as any).role !== "editor") throw new ApiError("Saving a version needs edit access to this project.", "permission_denied");
    const name = typeof a.name === "string" ? a.name.trim().slice(0, 200) : "";
    if (name) app.dispatch({ type: "versions", cmd: "save", name, description: typeof a.description === "string" ? a.description.slice(0, 4000) : "" });
    else { app.dispatch({ type: "versions", cmd: "dialog", dialog: { kind: "save" } }); app.dispatch({ type: "showPane", pane: "history", show: true }); }
    return { saved: !!name, dialog: !name };
  },
};

// ---------------------------------------------------------------- KiCad's footprint libraries
//
// pcbnew.FootprintLoad, FootprintEnumerate and GetFootprintLibraries on the desktop read the installed libraries; here
// they are the libraries the editor's own footprint chooser reads (the server's /api/libs, KiCad's official ones).

const libName = (t: unknown): string => { const v = String(t ?? ""); if (!/^[A-Za-z0-9_.+\- ]{1,120}$/.test(v) || v.includes("..")) throw new ApiError("That is not a library or footprint name.", "bad_request"); return v; };
const libGet = async (path: string): Promise<any> => {
  const r = await fetch(path); if (r.status === 404) return null;
  if (!r.ok) throw new ApiError(`The footprint libraries could not be read (the server answered ${r.status}).`, "not_found");
  return r.json();
};
export const libs: Record<string, (a: any) => Promise<unknown>> = {
  libraries: async () => { const j = await libGet("/api/libs/footprints"); return { libraries: (j && Array.isArray(j.libraries) ? j.libraries : []).map((l: any) => String(l.name || "")).filter(Boolean) }; },
  footprints: async (a) => { const lib = libName(a.lib); const j = await libGet(`/api/libs/footprints/${encodeURIComponent(lib)}`); return { library: lib, footprints: (j && Array.isArray(j.footprints) ? j.footprints : []).map((f: any) => String(f.n || "")).filter(Boolean) }; },
  footprint: async (a) => { const lib = libName(a.lib), name = libName(a.name); const j = await libGet(`/api/libs/footprints/${encodeURIComponent(lib)}/${encodeURIComponent(name)}`); return j && typeof j.footprint === "string" ? { library: lib, name, fpid: `${lib}:${name}`, footprint: j.footprint } : {}; },
};

// ---------------------------------------------------------------- undo / redo

/** Edit → Undo and Redo of the open document, for a plugin that takes back its own failed edit as it would on the desktop. */
export const history: Record<string, () => Promise<unknown>> = {
  undo: async () => { const { ed } = mayWrite(); const depth = () => { try { return Number(appState().undo.undo) || 0; } catch { return -1; } }; const before = depth(); ed.api.undoLast(); return { done: depth() !== before }; },
  redo: async () => { const { ed } = mayWrite(); const depth = () => { try { return Number(appState().undo.redo) || 0; } catch { return -1; } }; const before = depth(); ed.api.redoLast(); return { done: depth() !== before }; },
};

// ---------------------------------------------------------------- the editors' copy buffer

/**
 * What Copy in this project's schematic or board editor took, and what its Paste will place: KiCad's clipboard text.
 * It is the editor's own buffer (shared between this browser's editor tabs), never the computer's clipboard, which a
 * plugin's frame is not allowed to read.  A plugin may put KiCad items there (text that starts with a bracket) for the
 * person to paste.
 */
export const copyBuffer: Record<string, (a: any) => Promise<unknown>> = {
  copied: async () => { const { ed } = liveDoc(); return { text: String(ed.api.toolCtx().clipboard.get() || "") }; },
  copy: async (a) => {
    const { ed } = mayWrite(); const text = String(a.text || "");
    if (!/^\s*\(/.test(text)) throw new ApiError("Only KiCad items can be put in the editor's copy buffer.", "invalid");
    if (text.length > 4_000_000) throw new ApiError("That is too much to copy at once.", "too_large");
    ed.api.toolCtx().clipboard.set(text); return { copied: text.length };
  },
};

// ---------------------------------------------------------------- view

const idsOf = (doc: any, a: any): string[] => {
  const out: string[] = [];
  for (const id of Array.isArray(a.ids) ? a.ids : []) if (typeof id === "string" && doc.items.has(id)) out.push(id);
  for (const r of Array.isArray(a.refs) ? a.refs : []) for (const it of design.findByRef(doc, String(r))) out.push(it.id);
  return out;
};

export const views: Record<string, (a: any) => Promise<unknown>> = {
  select: async (a) => { const { ed, doc } = liveDoc(); const ids = idsOf(doc, a); ed.api.toolCtx().setSelection(ids); return { selected: ids.length }; },
  highlight: async (a) => {
    const { ed, doc } = liveDoc(); const ids = idsOf(doc, a);
    // By net name: the board editor's own net highlight (Highlight Net), so the message panel and the router know it too.
    const names: string[] = (Array.isArray(a.nets) ? a.nets : []).filter((n: any) => typeof n === "string" && n).slice(0, 2000);
    const P = (window as any).CollabTools && (window as any).CollabTools.pcb;
    if (Array.isArray(a.nets) && doc.type === "pcb" && P && typeof P.netHighlightIds === "function") {
      for (const n of names) for (const id of P.netHighlightIds(doc, n)) ids.push(id);
      if (P.state) P.state.highlightNet = names.length ? names[0] : null;
    }
    ed.api.toolCtx().setHighlight(ids.length ? new Set(ids) : null); return { highlighted: ids.length };
  },
  focus: async (a) => {
    const { doc } = liveDoc(); const ids = idsOf(doc, a);
    if (ids.length) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const id of ids) { const it = doc.items.get(id); const b = it.bbox || [it.x, it.y, it.x, it.y]; if (!b || typeof b[0] !== "number") continue; x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); }
      if (isFinite(x0)) design.centreOn((x0 + x1) / 2, (y0 + y1) / 2);
    } else if (typeof a.x === "number" && typeof a.y === "number" && isFinite(a.x) && isFinite(a.y)) design.centreOn(a.x, a.y);
    else throw new ApiError("focus needs ids, refs, or x and y that are on the open document.", "invalid");
    return { shown: ids.length };
  },
  /** The Nets part of the Appearance panel: read it, or change net colours, which ratsnest lines show, and the two display modes. */
  appearance: async (a) => {
    liveDoc(); const P = (window as any).CollabPanels;
    if (!P || typeof P.dispatch !== "function") throw new ApiError("The Appearance panel is not available here.", "unavailable");
    const known = new Set<string>((P.getState().appearance.nets || []).map((n: any) => n.name));
    for (const act of Array.isArray(a.actions) ? a.actions.slice(0, 5000) : []) {
      if (!act || typeof act !== "object") continue;
      if (act.t === "netVisible" && known.has(act.name)) P.dispatch({ t: "netVisible", name: act.name, on: !!act.on });
      else if (act.t === "netColor" && known.has(act.name)) P.dispatch({ t: "netColor", name: act.name, color: typeof act.color === "string" && /^#[0-9a-fA-F]{6}$/.test(act.color) ? act.color : null });
      else if (act.t === "netColorMode" && ["all", "ratsnest", "off"].includes(act.mode)) P.dispatch({ t: "netColorMode", mode: act.mode });
      else if (act.t === "ratsnestMode" && ["all", "visible", "none"].includes(act.mode)) P.dispatch({ t: "ratsnestMode", mode: act.mode });
    }
    const ap = P.getState().appearance;
    return { nets: (ap.nets || []).map((n: any) => ({ name: n.name, color: n.color || null, visible: n.visible !== false })), netColorMode: ap.netColorMode, ratsnestMode: ap.ratsnestMode };
  },
  setMarkers: async (a) => {
    const { ed, doc } = liveDoc(); const list = Array.isArray(a.markers) ? a.markers.slice(0, 2000) : [];
    const markers = list.filter((m: any) => m && typeof m.x === "number" && typeof m.y === "number" && isFinite(m.x) && isFinite(m.y)).map((m: any) => ({
      code: String(m.code || "plugin").slice(0, 60), severity: m.severity === "error" ? "error" : "warning", x: m.x, y: m.y, text: String(m.text || "").slice(0, 400),
      ids: (Array.isArray(m.ids) ? m.ids : []).filter((id: any) => typeof id === "string" && doc.items.has(id)) }));
    ed.api.toolCtx().setMarkers(markers); return { markers: markers.length };
  },
  clearMarkers: async () => { const { ed } = liveDoc(); ed.api.toolCtx().setMarkers([]); return { markers: 0 }; },
  openDocument: (a) => read(() => design.openDocument({ doc: String(a.doc || "") })),
};

/** What is on screen, for the `editor`, `document` and `selection` events. */
export function editorState(withDesign: boolean): { scope: string | null; role: string | null; viewOnly: boolean; document: unknown } {
  const ed = ED(); const st = ed && ed.api ? ed.api.state : null; const open = design.openEntry(); const doc = ed ? ed.kdoc : null;
  return { scope: doc ? (doc.type === "sch" ? "schematic" : "pcb") : null, role: st ? st.role || null : null, viewOnly: !ed || !!ed.viewOnly,
    document: withDesign && open && doc ? { path: open.path, type: doc.type === "sch" ? "schematic" : "board", project: st && st.project ? st.project.name : "" } : null };
}

/** What is selected, as a plugin sees it: the app's selection, the board tools' own picks (tracks, vias, zones,
 *  graphics) and pads picked on their own, each pad by its own id as in KiCad's selection. */
export function selectedIds(): string[] {
  const ed = ED(); const doc = ed ? ed.kdoc : null; if (!doc) return [];
  const ids = new Set<string>(Array.from(ed.selection || []) as string[]); if (!ids.size && ed.selected) ids.add(ed.selected.id);
  const W = window as any; const pcb = W.CollabTools && W.CollabTools.pcb;
  let board = false; try { const open = design.openEntry(); board = !!open && /\.kicad_pcb$/.test(open.path); } catch { board = false; }
  if (pcb && board) {
    const st = pcb.state as { sel?: Set<string> } | undefined;
    if (st && st.sel) for (const id of st.sel) if (doc.items.has(id)) ids.add(id);
    const keys: string[] = pcb.selectedPadKeys ? pcb.selectedPadKeys() : [];
    const k = W.KiCadCanvas;
    for (const key of keys) {
      const i = key.lastIndexOf("#"); const fp = doc.items.get(key.slice(0, i)); if (!fp || !k || !k.kids) continue;
      const pad = k.kids(fp.node, "pad")[Number(key.slice(i + 1))]; if (!pad) continue;
      const u = k.kids(pad, "uuid")[0] || k.kids(pad, "tstamp")[0];
      if (u && typeof u[1] === "string") ids.add(u[1]);
    }
  }
  return Array.from(ids);
}

export function selectionSummary(): unknown {
  const ed = ED(); const doc = ed ? ed.kdoc : null; if (!doc) return { ids: [], items: [] };
  const ids: string[] = selectedIds();
  return { ids, items: ids.slice(0, 500).map((id) => { const it = doc.items.get(id); return it ? { id, kind: it.kind, ref: it.ref || undefined, value: it.value || undefined } : { id }; }) };
}
