// harness/workspace — a project held as text, with the design assistant's tools running on it.
//
// The Python harness (server/harness/kicad_harness) drives a design through a handful of coarse
// calls: read the components, apply a batch of edits, place, route, check.  Those calls are the
// assistant's own tool modules (web/ai), which expect an editor with a document open.  A
// Workspace stands in for that editor without a server or a canvas: documents come in as KiCad
// file text, every edit is applied to an in-memory copy, and at the end the workspace hands back
// either the new file text (local files) or the changes as ordinary collaboration change records
// (what a caller with a live document would commit).
//
// One instance serves one script run.  It is used by the command-line engine (cli.ts); the
// MCP endpoint's run_python reaches the same tool modules through its live sessions instead.

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as design from "../ai/design";
import { ToolError } from "../ai/design";
import { checkLayout } from "../ai/layout";
import { reviewDesign } from "../ai/review";
import { renderPicture } from "../mcp/picture";
import * as library from "../ai/library";
import { buildProposal, writeRules, type EditLine } from "../ai/proposals";

const W = globalThis as any;
const K = (): any => W.KiCadCanvas;

export interface DocInput { path: string; text: string; docId?: string }
export interface DocResult { path: string; docId: string; changes: any[]; basis: Record<string, string>; lines: EditLine[] }
export interface Fetched { ok: boolean; status: number; body: string }
/** Where site-relative requests of the tool modules go (KiCad's libraries, vendor parts, the datasheet reader). */
export type Backend = (url: string, init?: { method?: string; body?: string }) => Promise<Fetched>;

interface Held { docId: string; path: string; docType: string; text: string; kdoc: any; changes: Map<string, any>; basis: Record<string, string>; lines: EditLine[]; dirty: boolean; paper?: string; titleBlock?: string; layers?: string; setup?: string; general?: string }

const HEADER = ["version", "generator", "generator_version", "general", "paper", "layers", "setup", "uuid", "title_block", "embedded_fonts"];
const typeOf = (path: string) => (/\.kicad_pcb$/i.test(path) ? "kicad_pcb" : /\.kicad_sch$/i.test(path) ? "kicad_sch" : /\.kicad_pro$/i.test(path) ? "kicad_pro" : "");
const baseName = (p: string) => p.split("/").pop() || p;

function response(f: Fetched): any {
  return { ok: f.ok, status: f.status, headers: { get: () => null }, text: async () => f.body, json: async () => JSON.parse(f.body) };
}

export class Workspace {
  private docs: Held[] = [];
  private pro: string | null = null;
  private proPath = "";
  private proDirty = false;
  private rules: Record<string, number | string> | undefined;
  private current: Held | null = null;

  constructor(readonly name: string, inputs: DocInput[], private backend: Backend, private role = "editor") {
    let n = 0;
    for (const d of inputs) {
      const docType = typeOf(d.path);
      if (docType === "kicad_pro") { this.pro = d.text; this.proPath = d.path; continue; }
      if (!docType) continue;
      this.docs.push({ docId: d.docId || `local-${++n}`, path: d.path, docType, text: d.text, kdoc: null, changes: new Map(), basis: {}, lines: [], dirty: false });
    }
    // the tool modules fetch site-relative addresses: the project's own documents are answered from here
    W.fetch = async (input: any, init?: any) => {
      const url = String(input);
      const m = /^\/api\/docs\/([^/]+)\/(content|ops)/.exec(url);
      if (m) {
        const h = this.docs.find((d) => d.docId === m[1]);
        if (!h) return response({ ok: false, status: 404, body: "{}" });
        return response({ ok: true, status: 200, body: m[2] === "ops" ? '{"ops":[]}' : this.textOf(h) });
      }
      return response(await this.backend(url, init ? { method: init.method, body: typeof init.body === "string" ? init.body : undefined } : undefined));
    };
  }

  private parsed(h: Held): any {
    if (!h.kdoc) {
      try { h.kdoc = K().parseDoc(h.text, h.docType); } catch (e) { throw new ToolError(`${h.path} could not be parsed.`); }
      h.kdoc.fileName = baseName(h.path); h.kdoc.filePath = h.path; h.kdoc.projectName = this.name;
    }
    return h.kdoc;
  }

  private find(name: unknown): Held {
    if (!this.docs.length) throw new ToolError("This project has no schematic or board.");
    if (name === undefined || name === null || name === "") {
      if (this.current) return this.current;
      return this.docs.find((d) => d.docType === "kicad_sch") || this.docs[0];
    }
    const q = String(name).trim().toLowerCase(); const strip = (s: string) => s.replace(/\.kicad_(sch|pcb)$/, "");
    const hit = this.docs.find((d) => d.path.toLowerCase() === q) || this.docs.find((d) => baseName(d.path).toLowerCase() === q)
      || this.docs.find((d) => strip(baseName(d.path).toLowerCase()) === strip(q))
      || (/^(board|pcb)$/.test(q) ? this.docs.find((d) => d.docType === "kicad_pcb") : undefined)
      || (/^(schematic|sch|sheet)$/.test(q) ? this.docs.find((d) => d.docType === "kicad_sch") : undefined);
    if (!hit) throw new ToolError(`There is no document "${name}" in this project. The documents are: ${this.docs.map((d) => d.path).join(", ")}.`);
    return hit;
  }

  /** Make `h` the open document of a stand-in editor, the way the tool modules expect to find one. */
  private open(h: Held): any {
    const doc = this.parsed(h); this.current = h;
    const entries = this.docs.map((d) => ({ docId: d.docId, path: d.path, docType: d.docType }));
    const all = this.proPath ? entries.concat([{ docId: "pro", path: this.proPath, docType: "kicad_pro" }]) : entries;
    const nothing = () => undefined;
    const state = { project: { projectId: "harness", name: this.name, docs: all }, docs: entries, doc: entries.find((e) => e.docId === h.docId), docId: h.docId, role: this.role, me: { id: 0, login: "harness", name: "Harness" } };
    const ed = { kdoc: doc, IU: h.docType === "kicad_sch" ? 1e4 : 1e6, proSettings: this.pro, viewOnly: false, selection: new Set<string>(), selected: null, zoom: 1,
      api: { state, toolCtx: () => ({ setHighlight: nothing, setSelection: nothing }), applyView: nothing, requestRender: nothing } };
    W.CollabEditor = ed; design.forgetDocs();
    return ed;
  }

  /** The document in KiCad's own format as it stands now: the file's header with the current items. */
  private textOf(h: Held): string {
    if (!h.kdoc || !h.dirty) return h.text;
    const k = K(); const doc = h.kdoc; const base = k.parse(h.text); const out: any[] = [base[0]];
    for (const n of base.slice(1)) {
      if (!Array.isArray(n) || !HEADER.includes(n[0])) continue;
      if (n[0] === "title_block" && h.titleBlock !== undefined) continue;      // replaced below, right after the paper as KiCad writes it
      if (n[0] === "layers" && h.general && !base.some((q: any) => Array.isArray(q) && q[0] === "general")) out.push(k.parse(h.general));   // a file with no (general …) gets one where KiCad writes it
      out.push(n[0] === "paper" && h.paper ? k.parse(h.paper) : n[0] === "layers" && h.layers ? k.parse(h.layers) : n[0] === "setup" && h.setup ? k.parse(h.setup) : n[0] === "general" && h.general ? k.parse(h.general) : n);
      if (n[0] === "layers" && h.setup && !base.some((q: any) => Array.isArray(q) && q[0] === "setup")) out.push(k.parse(h.setup));
      if (n[0] === "paper" && h.titleBlock) out.push(k.parse(h.titleBlock));
    }
    if (doc.type === "sch") out.push(["lib_symbols", ...doc.lib.values()]);
    else for (const n of base.slice(1)) if (Array.isArray(n) && n[0] === "net") out.push(n);
    for (const it of doc.items.values()) out.push(it.node);
    if (doc.type === "sch") for (const n of base.slice(1)) if (Array.isArray(n) && (n[0] === "sheet_instances" || n[0] === "embedded_fonts") && !HEADER.includes(n[0])) out.push(n);
    return k.serialize(out) + "\n";
  }

  private async apply(args: any): Promise<unknown> {
    const h = this.find(args.document); const ed = this.open(h); const k = K(); const doc = ed.kdoc;
    const prop = await buildProposal({ title: args.title, rationale: args.rationale, edits: args.edits });
    for (const [id, was] of Object.entries(prop.basis)) if (!(id in h.basis) && !(h.changes.get(id)?.kind === "ADDED")) h.basis[id] = was;
    for (const c of prop.changes) {
      if (c.typeName === "BOARD_SETUP") { k.boardSetup.applyBoardSetup(doc, c); for (const q of c.properties || []) if (q.after && typeof q.after.v === "string" && (q.name === "layers" || q.name === "setup" || q.name === "general")) (h as any)[q.name] = q.after.v; h.dirty = true; continue; }   // layer stack: kept for the file's header
      if (c.docProps) { k.applyDocProps(doc, c.docProps); h.paper = c.docProps.paper; if (typeof c.docProps.titleBlock === "string") h.titleBlock = c.docProps.titleBlock; h.dirty = true; continue; }   // page size: kept for the file's header
      let ok = false; try { ok = k.applyChange(doc, c, ed.IU); } catch (e) { console.warn("harness: change not applied", e); }
      if (!ok && c.kind !== "REMOVED") throw new ToolError(`An edit could not be applied to ${h.path}; nothing after it was applied.`);
      const prev = h.changes.get(c.id);
      if (!prev) h.changes.set(c.id, c);
      else if (prev.kind === "ADDED") { if (c.kind === "REMOVED") h.changes.delete(c.id); else h.changes.set(c.id, Object.assign({}, c, { kind: "ADDED" })); }
      else if (prev.kind === "REMOVED") h.changes.set(c.id, Object.assign({}, c, { kind: c.kind === "ADDED" ? "MODIFIED" : c.kind }));
      else h.changes.set(c.id, c);
    }
    if (prop.changes.length) { h.dirty = true; if (doc.type !== "sch") k.computeBBox(doc); }
    h.lines.push(...prop.lines);
    if (prop.rules) {
      let pro: any = {}; try { pro = this.pro ? JSON.parse(this.pro) : {}; } catch { pro = {}; }
      writeRules(pro, prop.rules); this.pro = JSON.stringify(pro, null, 2) + "\n"; this.proDirty = true;
      this.rules = Object.assign(this.rules || {}, prop.rules);
      if (!this.proPath) this.proPath = this.name + ".kicad_pro";
    }
    return { document: h.path, edits: prop.lines.map((l) => l.text), details: prop.details,
      added: prop.changes.filter((c) => c.kind === "ADDED").map((c) => c.id),
      connectivity: prop.connectivity && prop.connectivity.length ? prop.connectivity : undefined };
  }

  /** Run one tool.  `document` in the arguments names the sheet or the board it is about. */
  async call(tool: string, args: any): Promise<unknown> {
    args = args || {};
    const on = <T>(fn: () => T): T => { this.open(this.find(args.document)); return fn(); };
    const rest = () => { const o = Object.assign({}, args); delete o.document; return o; };
    switch (tool) {
      case "documents": return { project: this.name, documents: this.docs.map((d) => ({ path: d.path, type: d.docType === "kicad_pcb" ? "board" : "schematic" })) };
      case "overview": return on(() => design.overview());
      case "list_components": return on(() => design.listComponents(rest()));
      case "get_component": return on(() => design.getComponent(rest()));
      case "list_nets": return on(() => design.listNets(rest()));
      case "get_geometry": return on(() => design.geometry(rest()));
      case "check_layout": return on(() => checkLayout(rest()));
      case "review_design": return on(() => reviewDesign(rest()));
      case "render": { const h = this.find(args.document); const ed = this.open(h); return { document: h.path, svg: renderPicture(ed.kdoc, args.box ? { bbox: args.box, frame: false } : {}) }; }
      case "run_checks": return on(() => design.runChecks(rest()));
      case "get_board_info": { const b = this.docs.find((d) => d.docType === "kicad_pcb"); if (!b) throw new ToolError("This project has no board."); this.open(b); return design.boardInfo(); }
      case "get_items": return on(() => design.getItems(rest()));
      case "find_datasheets": return on(() => design.findDatasheets(rest()));
      case "find_parts": return library.findParts(rest());
      case "get_library_part": return library.getLibraryPart(rest());
      case "read_datasheet": return library.readDatasheet(rest());
      case "apply": return this.apply(args);
      case "text": { const h = this.find(args.document); return { document: h.path, text: this.textOf(h) }; }
      default: throw new ToolError(`Unknown harness call ${tool}.`);
    }
  }

  /** What the run changed, per document, as change records (squashed: one per item). */
  result(): { docs: DocResult[]; rules?: Record<string, number | string> } {
    return { docs: this.docs.filter((d) => d.changes.size).map((d) => ({ path: d.path, docId: d.docId, changes: Array.from(d.changes.values()), basis: d.basis, lines: d.lines })), rules: this.rules };
  }

  /** The files as they stand now, for the ones that changed (local projects are written back from this). */
  files(): { path: string; text: string }[] {
    const out = this.docs.filter((d) => d.dirty).map((d) => ({ path: d.path, text: this.textOf(d) }));
    if (this.proDirty && this.pro) out.push({ path: this.proPath, text: this.pro });
    return out;
  }
}

export { ToolError };
