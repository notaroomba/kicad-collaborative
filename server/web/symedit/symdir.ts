// symedit/symdir.ts — a KiCad 10 directory symbol library (${KIPRJMOD}/X.kicad_symdir: one .kicad_sym file per
// symbol, SCH_IO_KICAD_SEXPR_LIB_CACHE with a directory path) as one live library buffer over its files' documents.
//
// Every file is its own shared document (symedit/libdoc.ts); this joins them into the one library the tree and the
// editor see.  An edit goes to the file the symbol came from (m_symbolSourceFiles); a new symbol (or a renamed one,
// which KiCad also writes to a fresh file) gets a new file named EscapeString( name, CTX_FILENAME ).kicad_sym.  Save
// writes every modified file.  The web cannot delete a project file, so a file whose last symbol was removed or
// renamed stays behind holding an empty library (KiCad deletes it on save).
import { LibDoc, libDocFor, type LibListener } from "./libdoc";
import { parseLibrary, serializeLibrary, text, node, NEW_LIBRARY_TEXT, type SymLib, type Node } from "./model";

/** EscapeString( aSource, CTX_FILENAME ): a symbol's file name in the directory. */
export function escapeFileName(name: string): string {
  const map: Record<string, string> = { "/": "{slash}", "\\": "{backslash}", "\"": "{dblquote}", "<": "{lt}", ">": "{gt}", "|": "{bar}", ":": "{colon}", "\t": "{tab}", "\n": "{return}", "\r": "{return}" };
  return name.replace(/[/\\"<>|:\t\n\r]/g, (c) => map[c]);
}
/** "X.kicad_symdir/R.kicad_sym" belongs to the directory library "X.kicad_symdir". */
export function symdirOf(path: string): string | null { const m = /^(.*\.kicad_symdir)\/[^/]+\.kicad_sym$/i.exec(path); return m ? m[1] : null; }

export interface DirFile { docId: string; path: string }
/** Makes the document for a new file of the directory and gives back its first content's document. */
/** What the editor holds as a project library's buffer. */
export type LibBuffer = LibDoc | SymDirDoc;
export type FileMaker = (path: string, firstText: string) => Promise<DirFile | null>;

export class SymDirDoc {
  readonly docId = ""; readonly path: string; nickname: string;
  private files: LibDoc[] = [];
  private listeners = new Set<LibListener>();
  private cache: { lib: SymLib; saved: SymLib } | null = null;
  /** new symbols whose file is being made: part of the buffer already */
  private staged = new Map<string, Node>();
  private makeFile: FileMaker;
  error: string | null = null;

  constructor(path: string, nickname: string, files: DirFile[], makeFile: FileMaker) {
    this.path = path; this.nickname = nickname; this.makeFile = makeFile;
    for (const f of files) this.adopt(f);
  }
  /** A file of the directory (one another user just made, too): its symbols join the library. */
  adopt(f: DirFile): LibDoc {
    const d = libDocFor(f.docId, f.path, this.nickname);
    if (!this.files.includes(d)) {
      this.files.push(d);
      d.on((why, names) => { this.cache = null; if (why === "error") this.error = d.error; for (const fn of Array.from(this.listeners)) { try { fn(why, names); } catch (e) { console.error(e); } } });
    }
    return d;
  }
  on(fn: LibListener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  connect(): void { for (const f of this.files) f.connect(); }
  whenLoaded(): Promise<void> { return Promise.all(this.files.map((f) => f.whenLoaded())).then(() => undefined); }
  get loaded(): boolean { return this.files.every((f) => f.loaded); }
  get canEdit(): boolean { return this.files.length ? this.files.every((f) => f.canEdit) : true; }
  get role(): string { return this.files.length ? this.files[0].role : "editor"; }

  private merged(): { lib: SymLib; saved: SymLib } {
    if (this.cache) return this.cache;
    const first = this.files.find((f) => f.loaded);
    const head = first ? first.lib.head : parseLibrary(NEW_LIBRARY_TEXT).head, version = first ? first.lib.version : parseLibrary(NEW_LIBRARY_TEXT).version;
    const lib: SymLib = { head, version, symbols: new Map() }, saved: SymLib = { head, version, symbols: new Map() };
    for (const f of this.files) { for (const [k, v] of f.lib.symbols) lib.symbols.set(k, v); for (const [k, v] of f.saved.symbols) saved.symbols.set(k, v); }
    for (const [k, v] of this.staged) if (!lib.symbols.has(k)) lib.symbols.set(k, v);
    return (this.cache = { lib, saved });
  }
  get lib(): SymLib { return this.merged().lib; }
  get saved(): SymLib { return this.merged().saved; }
  /** the file holding a symbol in the buffer (m_symbolSourceFiles) */
  private owner(name: string): LibDoc | null { for (const f of this.files) if (f.lib.symbols.has(name)) return f; return null; }

  symbolText(name: string, which: "lib" | "saved" = "lib"): string | null { const s = (which === "lib" ? this.lib : this.saved).symbols.get(name); return s ? text(s) : null; }
  isSymbolModified(name: string): boolean { return this.symbolText(name) !== this.symbolText(name, "saved"); }
  modifiedNames(): string[] { const out = new Set<string>(); for (const f of this.files) for (const n of f.modifiedNames()) out.add(n); for (const n of this.staged.keys()) out.add(n); return Array.from(out); }
  get isModified(): boolean { return this.modifiedNames().length > 0; }
  fileText(): string { return serializeLibrary(this.lib); }

  commit(symbols: ([string, string | null] | [string, string, string])[], extraRemoved: string[] = []): Promise<number> {
    const per = new Map<LibDoc, ([string, string | null] | [string, string, string])[]>();
    const fresh: [string, string][] = [];
    const push = (d: LibDoc, c: [string, string | null] | [string, string, string]) => { const l = per.get(d) || []; l.push(c); per.set(d, l); };
    for (const n of extraRemoved) { const d = this.owner(n); if (d) push(d, [n, null]); }
    for (const c of symbols) {
      const d = this.owner(c[0]);
      if (c[1] === null) { if (d) push(d, [c[0], null]); this.staged.delete(c[0]); }
      else if (d) push(d, c);
      else fresh.push([c[0], c[1]]);
    }
    const waits: Promise<number>[] = [];
    for (const [d, list] of per) waits.push(d.commit(list));
    for (const [n, t] of fresh) { this.staged.set(n, node(t)); waits.push(this.placeNew(n)); }
    this.cache = null;
    for (const fn of Array.from(this.listeners)) { try { fn("local", symbols.map((c) => c[0])); } catch (e) { console.error(e); } }
    return Promise.all(waits).then((s) => Math.max(0, ...s));
  }
  /** A symbol with no file yet: its own file, created empty (the directory's format version), then the symbol in it. */
  private async placeNew(name: string): Promise<number> {
    const ver = this.files.find((f) => f.loaded);
    const first = ver ? serializeLibrary({ head: ver.saved.head, version: ver.saved.version, symbols: new Map() }) : NEW_LIBRARY_TEXT;
    const f = await this.makeFile(`${this.path}/${escapeFileName(name)}.kicad_sym`, first);
    if (!f) { this.staged.delete(name); this.cache = null; throw new Error(`could not create the file for '${name}'`); }
    const d = this.adopt(f); d.connect(); await d.whenLoaded();
    const s = this.staged.get(name); if (!s) return 0;   // removed meanwhile
    const seq = d.commit([[name, text(s)]]);
    this.staged.delete(name); this.cache = null;
    return seq;
  }
  async save(): Promise<boolean> {
    let ok = true;
    for (const f of this.files) if (f.isModified && !(await f.save())) ok = false;
    return ok;
  }
  revert(names?: string[]): Promise<number> {
    const list = names || this.modifiedNames();
    for (const n of list) this.staged.delete(n);
    const per = new Map<LibDoc, string[]>();
    for (const f of this.files) { const mine = list.filter((n) => f.lib.symbols.has(n) || f.saved.symbols.has(n)); if (mine.length) per.set(f, mine); }
    this.cache = null;
    return Promise.all([...per].map(([f, ns]) => f.revert(ns))).then((s) => Math.max(0, ...s));
  }
}
