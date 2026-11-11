// mcp/host — the headless editor behind the MCP endpoint (src/mcp.rs).
//
// The design assistant's tools (web/ai) read and change a design through the editor that has it
// open: the parsed document, the schematic and board tool modules, the autorouter, and the commit
// path that turns a change into an op.  None of that exists on the server, which never parses a
// KiCad file.  So the server starts this program (Node, one per person who is using the endpoint)
// and hands it each tool call.  It opens the document the call names exactly as a browser tab
// would, over the collaboration socket, and stands in for the editor: the same modules run against
// the same live document, and an edit leaves as the same op, so it shows up at once for everyone
// in the document.
//
// Wire format, one JSON object per line.  In: { id, base, token, agent, canWrite, user, tool,
// project, args }.  Out: { id, ok: true, result, record?, svg? } or { id, ok: false, error }.
// Calls are run one at a time: the modules keep the open editor in a global.

/* eslint-disable @typescript-eslint/no-explicit-any */
import "./env";
import "../canvas/index";
import "../../static/sch-tools.js";
import "../../static/pcb-tools.js";
import "../router/index";
import * as design from "../ai/design";
import { ToolError } from "../ai/design";
import * as library from "../ai/library";
import { buildProposal, staleReason, writeRules } from "../ai/proposals";
import { renderPicture } from "./picture";
import { DocSession, editProjectFile, readTextDocument, type Conn, type DocEntry, type UndoRecord } from "./session";

declare const process: any;
declare function require(name: string): any;

const W = globalThis as any;
const K = (): any => W.KiCadCanvas;

interface Project { projectId: string; name: string; role: string; docs: DocEntry[] }
interface Request { id: number; base: string; token: string; agent: string; canWrite: boolean; user: { id: number; login: string; name: string }; tool: string; project: Project | null; args: any }
interface Reply { result: unknown; record?: unknown; swap?: unknown; svg?: string }

const SESSION_IDLE_MS = 5 * 60 * 1000, PROCESS_IDLE_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------- the server, as the person

let conn: Conn = { base: "", token: "", agent: "" };
const realFetch = W.fetch.bind(W);
/** The shared modules fetch site-relative URLs with the browser's cookie; here they go to the server with the person's token. */
W.fetch = (input: any, init?: any) => {
  if (typeof input === "string" && input.startsWith("/")) {
    const headers = new W.Headers((init && init.headers) || {}); headers.set("authorization", `Bearer ${conn.token}`);
    return realFetch(conn.base + input, Object.assign({}, init, { headers, credentials: undefined }));
  }
  return realFetch(input, init);
};

async function api(path: string, init?: any): Promise<any> {
  let r: any;
  try { r = await W.fetch(path, init); } catch { throw new ToolError("The server could not be reached."); }
  const text = await r.text(); let body: any = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) throw new ToolError((body && body.message) || `The server refused the request (${r.status}).`);
  return body;
}
const post = (path: string, body: unknown, method = "POST") => api(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// ---------------------------------------------------------------- documents

const sessions = new Map<string, DocSession>();
function session(entry: DocEntry): DocSession {
  let s = sessions.get(entry.docId);
  if (!s) { s = new DocSession(entry, conn); sessions.set(entry.docId, s); }
  s.touch(conn); return s;
}

const baseName = (p: string) => p.split("/").pop() || p;
const drawable = (d: DocEntry) => d.docType === "kicad_sch" || d.docType === "kicad_pcb";
const depth = (p: string) => p.split("/").length;

/** The sheet KiCad opens first: the one named after the project file, else the shallowest. */
function rootSchematic(p: Project): DocEntry | null {
  const sch = p.docs.filter((d) => d.docType === "kicad_sch"); if (!sch.length) return null;
  const pro = p.docs.find((d) => d.docType === "kicad_pro");
  const want = pro ? pro.path.replace(/\.kicad_pro$/, ".kicad_sch") : "";
  return sch.find((d) => d.path === want) || sch.slice().sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path))[0];
}

function findDocument(p: Project, name: unknown): DocEntry {
  const docs = p.docs.filter(drawable);
  const listed = () => docs.map((d) => d.path).join(", ") || "(none)";
  if (typeof name !== "string" || !name.trim()) throw new ToolError(`Say which document: ${listed()}.`);
  const q = name.trim().toLowerCase(); const stem = (s: string) => s.replace(/\.kicad_(sch|pcb)$/, "");
  const hit = docs.find((d) => d.path.toLowerCase() === q) || docs.find((d) => d.docId === q)
    || docs.find((d) => baseName(d.path).toLowerCase() === q)
    || (/^(board|pcb|the board)$/.test(q) ? docs.find((d) => d.docType === "kicad_pcb") : undefined)
    || (/^(schematic|sch|root|the schematic)$/.test(q) ? rootSchematic(p) || undefined : undefined)
    || (() => { const m = docs.filter((d) => stem(baseName(d.path).toLowerCase()) === stem(q)); return m.length === 1 ? m[0] : undefined; })();
  if (!hit) throw new ToolError(`There is no document "${name}" in ${p.name}. The documents are: ${listed()}.`);
  return hit;
}

const proCache = new Map<string, { at: number; text: string }>();
/** The project file as it stands (design rules, net classes, text variables); null when the project has none. */
async function projectFile(p: Project, fresh = false): Promise<string | null> {
  const pro = p.docs.find((d) => d.docType === "kicad_pro"); if (!pro) return null;
  const hit = proCache.get(pro.docId); if (hit && !fresh && Date.now() - hit.at < 4000) return hit.text;
  try { const text = await readTextDocument(conn, pro.docId); proCache.set(pro.docId, { at: Date.now(), text }); return text; }
  catch (e) { console.warn("mcp host: project file not read", e); return hit ? hit.text : null; }
}

/** What the drawing sheet and the text variables need to know about where a document sits in its project. */
function sheetContext(doc: any, entry: DocEntry, p: Project, pro: string | null): void {
  doc.fileName = baseName(entry.path); doc.filePath = entry.path; doc.projectName = p.name;
  try { const v = pro ? JSON.parse(pro).text_variables : null; doc.projectVars = v && typeof v === "object" && Object.keys(v).length ? v : null; } catch { doc.projectVars = null; }
  if (doc.type !== "sch") { doc.sheetName = ""; doc.sheetPath = ""; doc.sheetCount = 1; return; }
  doc.sheetCount = p.docs.filter((d) => d.docType === "kicad_sch").length || 1;
  const root = rootSchematic(p);
  if (root && root.docId === entry.docId) { doc.sheetName = "Root"; doc.sheetPath = "/"; }
  else { doc.sheetName = baseName(entry.path).replace(/\.kicad_sch$/, ""); doc.sheetPath = "/" + doc.sheetName + "/"; }
}

/** The object the shared modules know as the editor (window.CollabEditor), for one document of one project. */
function editorFor(req: Request, p: Project, sess: DocSession | null, pro: string | null): any {
  const tabs = p.docs.filter(drawable);
  const viewOnly = !req.canWrite || p.role !== "editor" || (!!sess && sess.role !== "editor");
  const state = { project: { projectId: p.projectId, name: p.name, docs: p.docs }, docs: tabs, doc: sess ? sess.entry : null, docId: sess ? sess.entry.docId : null, role: p.role, me: req.user };
  const nothing = () => undefined;
  return { kdoc: sess ? sess.kdoc : null, IU: sess ? sess.IU : 1e6, proSettings: pro, viewOnly, selection: new Set<string>(), selected: null, zoom: 1,
    api: { state, toolCtx: () => ({ setHighlight: nothing, setSelection: nothing }), applyView: nothing, requestRender: nothing } };
}

/** Run `fn` with a document open as the editor's, the way the assistant's tools expect to find it. */
async function withDocument<T>(req: Request, name: unknown, fn: (sess: DocSession, doc: any, ed: any) => T | Promise<T>): Promise<T> {
  const p = needProject(req); const entry = findDocument(p, name); const sess = session(entry);
  const pro = await projectFile(p); const doc = await sess.current();
  sheetContext(doc, entry, p, pro);
  const ed = editorFor(req, p, sess, pro); W.CollabEditor = ed;
  try { return await fn(sess, doc, ed); } finally { W.CollabEditor = null; }
}

/** The shared modules word their errors for the in-app assistant (a proposal card, "the open document"); here there is neither. */
function plain(message: string): string {
  return message.replace(/^No proposal was shown, because/, "Nothing was applied, because").replace(/\bfor one proposal; split it into steps a person can review/, "for one call; split it into several")
    .replace(/\bsplit the proposal\b/g, "split the call").replace(/\bon the open document\b/g, "in this document").replace(/\bthe proposal\b/g, "the change").replace(/\bproposal\b/g, "change");
}
function needProject(req: Request): Project { if (!req.project) throw new ToolError("This tool needs a project."); return req.project; }
const without = (args: any, ...keys: string[]) => { const o = Object.assign({}, args); for (const k of ["project", "document", ...keys]) delete o[k]; return o; };
const r3 = (v: number) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------- changes

function needWrite(req: Request, p: Project): void {
  if (!req.canWrite) throw new ToolError("This connection was allowed to read only. Reconnect it and tick \"Let it make changes\" to edit.");
  if (p.role !== "editor") throw new ToolError(`You have view-only access to ${p.name}.`);
}

const RULE_PATHS = ["min_track_width", "min_clearance", "min_copper_edge_clearance"];
/** The parts of the project file a set_rules edit writes, as they were, so the edit can be taken back. */
function rulesBefore(text: string): { classes: unknown; rules: Record<string, unknown> } {
  const pro = JSON.parse(text); const rules: Record<string, unknown> = {};
  const now = (((pro.board || {}).design_settings || {}).rules || {}) as Record<string, unknown>;
  const defaults = (K().projectFile && K().projectFile.RULE_DEFAULTS) || {};
  for (const k of RULE_PATHS) rules[k] = now[k] !== undefined ? now[k] : defaults[k];
  return { classes: JSON.parse(JSON.stringify(((pro.net_settings || {}).classes) || [])), rules };
}
function restoreRules(pro: any, was: { classes: unknown; rules: Record<string, unknown> }): void {
  const ns = pro.net_settings = pro.net_settings || { classes: [], meta: { version: 0 } }; ns.classes = was.classes;
  const board = pro.board = pro.board || {}; const ds = board.design_settings = board.design_settings || {}; const rules = ds.rules = ds.rules || {};
  for (const [k, v] of Object.entries(was.rules)) if (v !== undefined) rules[k] = v;
}

async function applyChanges(req: Request): Promise<Reply> {
  const p = needProject(req); const args = req.args || {};
  return withDocument(req, args.document, async (sess, _doc, ed) => {
    const prop = await buildProposal({ title: args.title, rationale: args.rationale, edits: args.edits });
    const summary: any = { document: prop.docPath, edits: prop.lines.map((l) => l.text), details: prop.details,
      connectivity: !prop.connectivity ? undefined : prop.connectivity.length
        ? { changed: prop.connectivity, note: "These pins are connected differently by the change. If that is not what it is for (a tidy-up must not change connections), undo it and apply a corrected version." }
        : prop.lines.some((l) => /^Add /.test(l.text)) ? "the pins that were there before are on the same nets as before; list_nets shows how the new parts are connected"
        : "unchanged: every pin is on the same net as before" };
    if (args.dry_run) return { result: Object.assign({ applied: false, note: "Dry run: nothing was changed. Call again without dry_run to apply." }, summary) };
    needWrite(req, p);
    if (ed.viewOnly) throw new ToolError(`You have view-only access to ${p.name}.`);
    const stale = staleReason(prop); if (stale) throw new ToolError(stale);

    let rules: unknown; const pro = p.docs.find((d) => d.docType === "kicad_pro");
    if (prop.rules) {
      if (!pro) throw new ToolError("This project has no .kicad_pro file, so its board rules cannot be changed.");
      const text = await projectFile(p, true); if (!text) throw new ToolError("The project file could not be read.");
      rules = rulesBefore(text); const r = prop.rules;
      const saved = await editProjectFile(conn, pro.docId, (j) => writeRules(j, r), "board rules");
      proCache.set(pro.docId, { at: Date.now(), text: saved.text });
    }
    let undo: UndoRecord = { inverse: [], after: {} };
    if (prop.changes.length) {
      try { undo = await sess.commit(prop.changes); }
      catch (e) { if (rules) throw new ToolError(`${e instanceof Error ? e.message : String(e)} The board rules of this change were saved; the other edits were not applied.`); throw e; }
    }
    return { result: Object.assign({ applied: true, changes: prop.changes.length, board_rules: rules ? "written to the project file" : undefined }, summary),
      record: { docId: sess.entry.docId, title: prop.title, edits: summary.edits, undo: Object.assign({}, undo, rules ? { rules } : {}) } };
  });
}

async function undoChanges(req: Request): Promise<Reply> {
  const p = needProject(req); needWrite(req, p);
  const rec = req.args.__record as { docId: string; title: string; undo: UndoRecord & { rules?: any } };
  const entry = p.docs.find((d) => d.docId === rec.docId); if (!entry) throw new ToolError("The document of that change is no longer in the project.");
  return withDocument(req, entry.path, async (sess, doc) => {
    const k = K(); const blocked: string[] = [];
    for (const [id, was] of Object.entries(rec.undo.after || {})) {
      const it = doc.items.get(id);
      if (was === null) { if (it) blocked.push(`${it.ref || it.kind} was put back by someone since`); }
      else if (!it) blocked.push(`an item the change touched (${id.slice(0, 8)}) has been deleted since`);
      else if (k.serialize(it.node) !== was) blocked.push(`${it.ref || it.kind + " " + id.slice(0, 8)} has been edited since`);
      if (blocked.length >= 8) break;
    }
    const redo = req.tool === "redo_changes", word = redo ? "redone" : "undone";
    if (blocked.length) throw new ToolError(`"${rec.title}" cannot be ${word} as a whole, because the design has moved on: ${blocked.join("; ")}. Nothing was changed. Make the correction as a new change instead.`);
    // what this call takes away is kept, so that the opposite tool can put it back
    let rulesNow: unknown;
    if (rec.undo.rules) {
      const pro = p.docs.find((d) => d.docType === "kicad_pro");
      if (pro) {
        const text = await projectFile(p, true); if (text) rulesNow = rulesBefore(text);
        const saved = await editProjectFile(conn, pro.docId, (j) => restoreRules(j, rec.undo.rules), "board rules"); proCache.set(pro.docId, { at: Date.now(), text: saved.text });
      }
    }
    let back: UndoRecord = { inverse: [], after: {} };
    if (rec.undo.inverse && rec.undo.inverse.length) back = await sess.commit(rec.undo.inverse);
    return { result: { [word]: rec.title, document: entry.path, changes: (rec.undo.inverse || []).length, [redo ? "board_rules_set_again" : "board_rules_restored"]: rec.undo.rules ? true : undefined,
        note: redo ? "undo_changes takes it back again." : "redo_changes puts it back." },
      swap: Object.assign({}, back, rulesNow ? { rules: rulesNow } : {}) };
  });
}

// ---------------------------------------------------------------- reading as text and as a picture

const HEADER = ["version", "generator", "generator_version", "general", "paper", "layers", "setup", "uuid", "title_block"];
/** The document in KiCad's own format, as it stands now: the stored file's header with the live items. */
function sourceText(sess: DocSession, doc: any): string {
  const k = K(); const base = k.parse(sess.file); const out: any[] = [base[0]];
  for (const n of base.slice(1)) if (Array.isArray(n) && HEADER.includes(n[0])) out.push(n);
  if (doc.type === "sch") out.push(["lib_symbols", ...doc.lib.values()]);
  for (const it of doc.items.values()) out.push(it.node);
  if (doc.type === "sch") { const si = base.find((n: any) => Array.isArray(n) && n[0] === "sheet_instances"); if (si) out.push(si); }
  return k.serialize(out) + "\n";
}

async function readDocument(req: Request): Promise<Reply> {
  const a = req.args || {};
  return withDocument(req, a.document, (sess, doc) => {
    const text = sourceText(sess, doc); const offset = Math.max(0, Math.floor(Number(a.offset) || 0)); const max = Math.min(100000, Math.max(1000, Math.floor(Number(a.max_chars) || 40000)));
    const part = text.slice(offset, offset + max); const next = offset + part.length;
    return { result: { document: sess.entry.path, format: doc.type === "sch" ? "kicad_sch" : "kicad_pcb", total_chars: text.length, offset, text: part,
      next_offset: next < text.length ? next : undefined,
      note: next < text.length ? `Cut at ${max} characters; call again with offset ${next} for more. get_items with a filter is usually the better way to read part of a design.` : undefined } };
  });
}

async function renderView(req: Request): Promise<Reply> {
  const a = req.args || {};
  return withDocument(req, a.document, (sess, doc) => {
    const k = K(); const opts: any = {}; let box: number[] | null = null;
    if (Array.isArray(a.area) && a.area.length === 4 && a.area.every((v: unknown) => typeof v === "number" && isFinite(v as number))) box = [Math.min(a.area[0], a.area[2]), Math.min(a.area[1], a.area[3]), Math.max(a.area[0], a.area[2]), Math.max(a.area[1], a.area[3])];
    const missing: string[] = [];
    if (!box && Array.isArray(a.refs) && a.refs.length) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const r of a.refs) { const hits = design.findByRef(doc, String(r)); if (!hits.length) missing.push(String(r)); for (const it of hits) { const b = it.bbox || [it.x, it.y, it.x, it.y]; x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); } }
      if (!isFinite(x0)) throw new ToolError(`Not on ${sess.entry.path}: ${missing.join(", ")}.`);
      const m = Math.max(doc.type === "sch" ? 12 : 4, 0.25 * Math.max(x1 - x0, y1 - y0)); box = [x0 - m, y0 - m, x1 + m, y1 + m];
    }
    if (box) { if (box[2] - box[0] < 0.5 || box[3] - box[1] < 0.5) throw new ToolError("The area is too small to draw; give at least half a millimetre each way."); opts.bbox = box; opts.margin = 0; }
    if (doc.type === "pcb" && Array.isArray(a.layers) && a.layers.length) {
      const all: any[] = k.layerList(doc); const want = new Set(a.layers.map((l: unknown) => String(l).toLowerCase()));
      const unknown = Array.from(want).filter((w) => !all.some((l) => String(l.name).toLowerCase() === w));
      if (unknown.length) throw new ToolError(`Not layers of this board: ${unknown.join(", ")}. It has: ${all.map((l) => l.name).join(", ")}.`);
      opts.hidden = new Set(all.filter((l) => !want.has(String(l.name).toLowerCase())).map((l) => l.key));
    } else if (doc.type === "pcb") opts.hidden = new Set(Array.from(k.PCB_HIDDEN_DEFAULT || []));
    const svg: string = renderPicture(doc, opts);
    const vb = /viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/.exec(svg);
    const shown = vb ? [Number(vb[1]), Number(vb[2]), Number(vb[1]) + Number(vb[3]), Number(vb[2]) + Number(vb[4])].map(r3) : box;
    return { svg, result: { document: sess.entry.path, shown_mm: shown, not_on_this_document: missing.length ? missing : undefined,
      note: "Coordinates in the image run from the top left of shown_mm, x to the right and y down, in millimetres." } };
  });
}

// ---------------------------------------------------------------- comments, checkpoints, projects

async function listComments(req: Request): Promise<Reply> {
  const p = needProject(req); const entry = findDocument(p, req.args.document); const IU = entry.docType === "kicad_sch" ? 1e4 : 1e6;
  const all: any[] = (await api(`/api/docs/${entry.docId}/comments`)).comments || [];
  const row = (c: any) => ({ id: c.id, author: c.authorLogin, text: c.body, at: c.createdAt });
  // what the thread is pinned to: a component (or other item) or a net; absent for a thread pinned to a place
  const pinned = (c: any) => (c.anchor ? (c.anchor.kind === "net" ? { net: c.anchor.label || c.anchor.id } : { on: c.anchor.label || "item" }) : {});
  const threads = all.filter((c) => !c.parentId).filter((c) => req.args.include_resolved || !c.resolved)
    .map((c) => Object.assign(row(c), pinned(c), { x: r3(c.x / IU), y: r3(c.y / IU), resolved: !!c.resolved, replies: all.filter((r) => r.parentId === c.id).map(row) }));
  return { result: { document: entry.path, count: threads.length, comments: threads } };
}

async function addComment(req: Request): Promise<Reply> {
  const p = needProject(req); const a = req.args || {};
  if (!req.canWrite) throw new ToolError("This connection was allowed to read only.");
  if (typeof a.text !== "string" || !a.text.trim()) throw new ToolError("text is required.");
  if (a.reply_to !== undefined) {
    const c = await post(`/api/docs/${findDocument(p, a.document).docId}/comments`, { body: a.text, parentId: Number(a.reply_to) });
    return { result: { id: c.id, reply_to: c.parentId, document: findDocument(p, a.document).path } };
  }
  return withDocument(req, a.document, async (sess, doc) => {
    let x = a.x, y = a.y; let anchor: { kind: "item" | "net"; id: string; label: string; item?: string } | undefined;
    const mid = (it: any) => { const b = it.bbox; return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [it.x || 0, it.y || 0]; };
    if (typeof a.ref === "string" && a.ref) {
      const hit = design.findByRef(doc, a.ref)[0]; if (!hit) throw new ToolError(`There is no ${a.ref} on ${sess.entry.path}.`);
      [x, y] = mid(hit); anchor = { kind: "item", id: hit.id, label: hit.ref || a.ref };
    } else if (typeof a.net === "string" && a.net) {
      const on = netAnchorItem(doc, a.net); if (!on) throw new ToolError(`There is no net ${a.net} on ${sess.entry.path}. list_nets gives the names.`);
      if (typeof x !== "number" || typeof y !== "number") [x, y] = mid(on.item);
      anchor = { kind: "net", id: on.name, label: on.name, item: on.item.kind === "footprint" || on.item.kind === "symbol" ? undefined : on.item.id };
    }
    if (typeof x !== "number" || typeof y !== "number" || !isFinite(x) || !isFinite(y)) throw new ToolError("Say what the comment is about: ref, net, or x and y in millimetres.");
    const c = await post(`/api/docs/${sess.entry.docId}/comments`, { body: a.text, x: Math.round(x * sess.IU), y: Math.round(y * sess.IU), anchor });
    return { result: { id: c.id, document: sess.entry.path, x: r3(x), y: r3(y), on: anchor && anchor.kind === "item" ? anchor.label : undefined, net: anchor && anchor.kind === "net" ? anchor.label : undefined } };
  });
}

/** An item of the document that is on the named net, with the net's name as the document spells it. */
function netAnchorItem(doc: any, name: string): { name: string; item: any } | null {
  const q = name.trim().toLowerCase().replace(/^\//, ""); const same = (n: string) => n.toLowerCase().replace(/^\//, "") === q;
  if (doc.type === "sch") {
    const net = design.schNets(doc).find((n) => same(n.name) || same(n.board) || n.labels.some(same)); if (!net) return null;
    const items = net.ids.map((id: string) => doc.items.get(id)).filter(Boolean);
    const item = items.find((it: any) => /label$/.test(it.kind)) || items.find((it: any) => it.kind === "wire") || items[0];
    return item ? { name: net.name, item } : null;
  }
  const k = design.K();
  for (const it of doc.items.values()) if ((it.kind === "segment" || it.kind === "arc" || it.kind === "via" || it.kind === "zone") && same(k.netNameOf(doc, it.node) || "")) return { name: k.netNameOf(doc, it.node), item: it };
  for (const it of doc.items.values()) if (it.kind === "footprint") for (const p of k.kids(it.node, "pad")) { const n = k.netNameOf(doc, p) || ""; if (n && same(n)) return { name: n, item: it }; }
  return null;
}

async function resolveComment(req: Request): Promise<Reply> {
  if (!req.canWrite) throw new ToolError("This connection was allowed to read only.");
  const c = await post(`/api/comments/${Number(req.args.comment_id)}`, { resolved: req.args.resolved !== false }, "PATCH");
  return { result: { id: c.id, resolved: c.resolved } };
}

async function listCheckpoints(req: Request): Promise<Reply> {
  const p = needProject(req); const rows: any[] = (await api(`/api/projects/${p.projectId}/checkpoints`)).checkpoints || [];
  const by = new Map<string, { name: string; created: string; documents: string[] }>();
  for (const r of rows) { const g = by.get(r.name) || { name: r.name, created: r.createdAt, documents: [] as string[] }; g.documents.push(r.path); if (r.createdAt > g.created) g.created = r.createdAt; by.set(r.name, g); }
  return { result: { project: p.name, checkpoints: Array.from(by.values()).sort((a, b) => b.created.localeCompare(a.created)) } };
}

async function createCheckpoint(req: Request): Promise<Reply> {
  const p = needProject(req); needWrite(req, p);
  if (typeof req.args.name !== "string" || !req.args.name.trim()) throw new ToolError("name is required.");
  const r = await post(`/api/projects/${p.projectId}/checkpoints`, { name: req.args.name.trim() });
  return { result: { checkpoint: r.name, documents: (r.docs || []).map((d: any) => d.path),
    note: "As in the web editor, a checkpoint marks each document's most recent saved file; edits made since that save (by anyone, through any client) come after it in the history." } };
}

async function createProject(req: Request): Promise<Reply> {
  if (!req.canWrite) throw new ToolError("This connection was allowed to read only.");
  if (typeof req.args.name !== "string" || !req.args.name.trim()) throw new ToolError("name is required.");
  const r = await post("/api/projects/blank", { name: req.args.name.trim() });
  return { result: { project_id: r.projectId, name: r.name || req.args.name.trim(), documents: (r.docs || []).map((d: any) => d.path), url: `${req.args.__site || conn.base}/p/${r.projectId}/edit`,
    note: "An empty project: one schematic sheet and one board. Draw the schematic with apply_changes, then update_from_schematic on the board." } };
}

// ---------------------------------------------------------------- dispatch

const TOOLS: Record<string, (req: Request) => Promise<Reply>> = {
  get_design_overview: async (req) => {
    const p = needProject(req); const name = req.args.document || (rootSchematic(p) || p.docs.find((d) => d.docType === "kicad_pcb") || { path: "" }).path;
    if (!name) { W.CollabEditor = editorFor(req, p, null, null); try { return { result: design.overview() }; } finally { W.CollabEditor = null; } }
    return withDocument(req, name, () => { const o: any = design.overview(); delete o.selection; for (const d of o.documents || []) { d.described_below = d.open || undefined; delete d.open; } o.document = o.open_document; delete o.open_document; return { result: o }; });
  },
  list_components: (req) => withDocument(req, req.args.document, async () => ({ result: await design.listComponents(without(req.args)) })),
  get_component: (req) => withDocument(req, req.args.document, async () => ({ result: await design.getComponent(without(req.args) as any) })),
  list_nets: (req) => withDocument(req, req.args.document, async () => ({ result: await design.listNets(without(req.args)) })),
  run_checks: (req) => withDocument(req, req.args.document, async () => ({ result: await design.runChecks({}) })),
  get_items: (req) => withDocument(req, req.args.document, async () => ({ result: await design.getItems(without(req.args)) })),
  find_datasheets: (req) => withDocument(req, req.args.document, async () => ({ result: await design.findDatasheets(without(req.args)) })),
  get_board_info: (req) => withDocument(req, "board", async () => ({ result: await design.boardInfo() })),
  find_parts: async (req) => ({ result: await library.findParts(req.args || {}) }),
  get_library_part: async (req) => ({ result: await library.getLibraryPart(req.args || {}) }),
  apply_changes: applyChanges,
  undo_changes: undoChanges,
  redo_changes: undoChanges,
  read_document: readDocument,
  render_view: renderView,
  list_comments: listComments,
  add_comment: addComment,
  resolve_comment: resolveComment,
  list_checkpoints: listCheckpoints,
  create_checkpoint: createCheckpoint,
  create_project: createProject,
};

async function handle(req: Request): Promise<any> {
  conn = { base: req.base, token: req.token, agent: req.agent || "" };
  const tool = TOOLS[req.tool];
  if (!tool) return { id: req.id, ok: false, error: `Unknown tool ${req.tool}.` };
  try { const r = await tool(req); return Object.assign({ id: req.id, ok: true }, r); }
  catch (e) {
    if (!(e instanceof ToolError)) console.error("mcp host: tool failed", req.tool, e);
    return { id: req.id, ok: false, error: e instanceof ToolError ? plain(e.message) : `The tool failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

let queue: Promise<void> = Promise.resolve(); let lastCall = Date.now(); let busy = 0;
const rl = require("node:readline").createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line: string) => {
  if (!line.trim()) return;
  let req: Request; try { req = JSON.parse(line); } catch { return; }
  busy++;
  queue = queue.then(() => handle(req)).then((out) => { process.stdout.write(JSON.stringify(out) + "\n"); }, (e) => { process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: String(e) }) + "\n"); })
    .then(() => { busy--; lastCall = Date.now(); });
});
rl.on("close", () => process.exit(0));

// Documents nobody asked about for a while are let go (the peer leaves the document), and so is the process.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.lastUsed > SESSION_IDLE_MS) { s.close(); sessions.delete(id); }
  if (!busy && now - lastCall > PROCESS_IDLE_MS) process.exit(0);
}, 30000);
if (typeof (sweep as any).unref === "function") (sweep as any).unref();
process.stdout.write(JSON.stringify({ ready: true }) + "\n");
