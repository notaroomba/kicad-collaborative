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

export class ApiError extends Error { constructor(message: string, public code = "error") { super(message); } }

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const MAX_CHANGES = 2000;

const editor = () => { const ed = ED(); if (!ed || !ed.api) throw new ApiError("The editor is not ready.", "not_ready"); return ed; };
const liveDoc = () => { const ed = editor(); const open = design.openEntry(); if (!ed.kdoc || !open) throw new ApiError("No document is open in the editor.", "no_document"); return { ed, doc: ed.kdoc, open }; };

/** Run one of the assistant's read tools, turning its ToolError into the plugin's error. */
async function read<T>(fn: () => T | Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { if (e instanceof ToolError) throw new ApiError(e.message, "not_found"); throw e; }
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
    let p; try { p = buildProposal({ title: a.title, edits: a.edits }); } catch (e) { if (e instanceof ToolError) throw new ApiError(e.message.replace(/^No proposal was shown, because /, "Nothing was changed, because "), "invalid"); throw e; }
    commit(ed, p.changes, label);
    return { changes: p.lines.map((l) => ({ kind: l.kind, text: l.text, ids: l.ids })) };
  },
  /** Raw items: create from s-expressions, replace existing items by id, remove by id — one undo step. */
  commit: async (a, label) => {
    const { ed, doc } = mayWrite(); const k = K();
    const create = Array.isArray(a.create) ? a.create : [], update = Array.isArray(a.update) ? a.update : [], remove = Array.isArray(a.remove) ? a.remove : [];
    if (create.length + update.length + remove.length > MAX_CHANGES) throw new ApiError(`The limit is ${MAX_CHANGES} changes in one step.`, "too_large");
    const changes: any[] = []; const touched = new Set<string>(); const created: string[] = [];
    const touch = (id: string, where: string) => { if (touched.has(id)) throw new ApiError(`${where}: item ${id} is changed twice in this commit`, "invalid"); touched.add(id); };
    update.forEach((u: any, i: number) => {
      const where = `update[${i}]`; const it = u && typeof u.id === "string" ? doc.items.get(u.id) : null;
      if (!it) throw new ApiError(`${where}: there is no item with id ${u && u.id} on the open document`, "not_found");
      const node = parseItem(doc, u.sexpr, where);
      if (node[0] !== it.node[0]) throw new ApiError(`${where}: a ${it.node[0]} cannot become a ${node[0]}; remove it and create the new item`, "invalid");
      const uu = k.kid(node, "uuid"); if (uu) uu[1] = it.id; else node.push(["uuid", it.id]);   // an update keeps its identity whatever the text says
      touch(it.id, where); changes.push(modified(doc, it, node));
    });
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
    return { created, updated: update.length, removed: remove.length };
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
  highlight: async (a) => { const { ed, doc } = liveDoc(); const ids = idsOf(doc, a); ed.api.toolCtx().setHighlight(ids.length ? new Set(ids) : null); return { highlighted: ids.length }; },
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

export function selectionSummary(): unknown {
  const ed = ED(); const doc = ed ? ed.kdoc : null; if (!doc) return { ids: [], items: [] };
  const ids: string[] = Array.from(ed.selection || []); if (!ids.length && ed.selected) ids.push(ed.selected.id);
  return { ids, items: ids.slice(0, 500).map((id) => { const it = doc.items.get(id); return it ? { id, kind: it.kind, ref: it.ref || undefined, value: it.value || undefined } : { id }; }) };
}
