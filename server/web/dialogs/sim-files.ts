// dialogs/sim-files.ts — the files the Simulation Model dialog can read a SPICE library from: the project's
// spice_model documents (fetched through /api/docs/{id}/content) and the embedded files of the symbol and of the
// schematic (kicad-embed://<name>; their data is base64 of a zstd frame, decoded by zstd.ts).
import type { SimFile } from "./sim-model";
import { zstdDecompress } from "./zstd";

interface DocEntry { docId: string; path: string; docType: string }
type Node = unknown;
const isList = (n: Node): n is Node[] => Array.isArray(n);
const str = (n: Node): string => (typeof n === "string" ? n : n == null ? "" : String(n));
const kid = (n: Node, k: string): Node[] | null => { if (!isList(n)) return null; for (let i = 1; i < n.length; i++) { const c = n[i]; if (isList(c) && c[0] === k) return c; } return null; };
const kids = (n: Node, k: string): Node[][] => (isList(n) ? n.slice(1).filter((c): c is Node[] => isList(c) && c[0] === k) : []);

export const SPICE_EXT = /\.(lib|sub|cir|mod|spice|ibs)$/i;

/** The project's SPICE model documents, relative to the project directory.  `docs` is the whole /info list
 *  (appState.project.docs: appState.docs keeps only the schematics and boards). */
export function projectModelFiles(docs: DocEntry[]): SimFile[] {
  return docs.filter((d) => d.docType === "spice_model" || SPICE_EXT.test(d.path)).map((d) => ({
    path: d.path, label: d.path,
    load: async () => { try { const r = await fetch(`/api/docs/${d.docId}/content?v=${Date.now()}`); return r.ok ? await r.text() : null; } catch (e) { return null; } },
  }));
}

/** The text of an embedded file's zstd frame: decoded here (zstd.ts), the browser's DecompressionStream('zstd')
 *  only as a fallback for a frame the decoder refuses (a dictionary). */
export async function unzstd(bytes: Uint8Array): Promise<string | null> {
  try { return new TextDecoder().decode(zstdDecompress(bytes)); } catch (e) { /* try the browser's decoder */ }
  const DS = (globalThis as unknown as { DecompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream;
  if (!DS) return null;
  try { const s = new Blob([bytes.buffer as ArrayBuffer]).stream().pipeThrough(new DS("zstd")); return await new Response(s).text(); } catch (e) { return null; }
}

/** The (embedded_files (file (name ..) (data ..))) entries of the given nodes, as kicad-embed:// files. */
export function embeddedModelFiles(owners: (Node | null)[]): SimFile[] {
  const out: SimFile[] = []; const seen = new Set<string>();
  for (const o of owners) {
    const ef = o ? kid(o, "embedded_files") : null; if (!ef) continue;
    for (const f of kids(ef, "file")) {
      const name = str((kid(f, "name") || [])[1]); if (!name || seen.has(name)) continue; seen.add(name);
      const data = kid(f, "data"); const b64 = data ? data.slice(1).map(str).join("").replace(/[|\s]/g, "") : "";
      out.push({ path: "kicad-embed://" + name, label: name + " (embedded)", load: async () => {
        if (!b64) return null;
        let bytes: Uint8Array; try { const bin = atob(b64); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); } catch (e) { return null; }
        return unzstd(bytes);
      } });
    }
  }
  return out;
}

/** GetGraphicalPins( ALL_UNITS, ALL_BODY_STYLES ) of a library symbol (lib_symbols entry or symbol-editor node),
 *  dropping body style 2+ on a multi-body-style symbol (De Morgan variants are equivalences). */
export function simPinsOfLib(lib: Node | null): { number: string; name: string }[] {
  const out: { number: string; name: string }[] = []; if (!lib) return out;
  const subs = kids(lib, "symbol"); const bodyOf = (s: Node[]) => { const m = /_(\d+)_(\d+)$/.exec(str(s[1])); return m ? +m[2] : 1; };
  const multiBody = subs.some((s) => bodyOf(s) >= 2);
  const take = (s: Node[]) => { for (const p of kids(s, "pin")) out.push({ number: str((kid(p, "number") || [])[1]), name: str((kid(p, "name") || [])[1]) }); };
  take(lib as Node[]);
  for (const s of subs) if (!multiBody || bodyOf(s) < 2) take(s);
  return out;
}
/** LIB_SYMBOL::GetPrefix / SCH_SYMBOL::UpdatePrefix: the Reference text ('~' read as a space) without its trailing
 *  digits, '?' and '*', trimmed. */
export function refPrefix(ref: string): string { let p = ref.replace(/~/g, " "); while (p.length && /[0-9?*]$/.test(p)) p = p.slice(0, -1); return p.trim(); }
