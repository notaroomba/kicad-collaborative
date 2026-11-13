// symedit/fpfilters.ts — PANEL_FOOTPRINT_FILTERS (eeschema/dialogs/panel_footprint_filters.cpp), the Library Symbol
// Properties "Footprint Filters" page: the filter list (Add / Edit / Delete, a double-click edits the row under it or
// adds one), and "Matching footprints (n):" — the footprints any selected filter (every filter when none is selected)
// matches, as pcbnew's QueryMatchingFootprints answers it: EDA_PATTERN_MATCH_WILDCARD_ANCHORED over the lower-cased
// footprint name, with "lib:" in front when the pattern holds a ':', at most 500 per pattern ("(n+)" when cut), the
// union sorted (StrNumCmp, ignoring case) without duplicates.  The pure part is DOM-free for the node tests.

/** SanitizeFpFilter: filters are saved space-separated, so a space inside one becomes '_'. */
export function sanitizeFpFilter(f: string): string { return f.replace(/ /g, "_"); }

/** EDA_PATTERN_MATCH_WILDCARD_ANCHORED: '*' any run, '?' one character, the whole candidate must match. */
export function wildcardAnchored(pattern: string): RegExp {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp("^" + body + "$");
}

export interface FpIndexLib { name: string; footprints: string[] }
export interface MatchResult { names: string[]; limited: boolean }
export const MAX_MATCH_RESULTS = 500;

/** One pattern's matches (FOOTPRINT_MATCH_QUERY with m_MaxResults = 500), as "lib:name". */
export function matchPattern(pattern: string, libs: FpIndexLib[], max = MAX_MATCH_RESULTS): MatchResult {
  const pat = pattern.toLowerCase(); const re = wildcardAnchored(pat); const withLib = pat.includes(":");
  const names: string[] = []; let limited = false;
  outer: for (const l of libs) for (const f of l.footprints) {
    const cand = (withLib ? l.name.toLowerCase() + ":" : "") + f.toLowerCase();
    if (!re.test(cand)) continue;
    if (max > 0 && names.length >= max) { limited = true; break outer; }
    names.push(l.name + ":" + f);
  }
  return { names, limited };
}

/** FP_FILTER_MATCHER::GetMatches: the union of every pattern's matches. */
export function matchFootprints(patterns: string[], libs: FpIndexLib[]): MatchResult {
  const all: string[] = []; let limited = false;
  for (const p of patterns) { const r = matchPattern(p, libs); all.push(...r.names); limited = limited || r.limited; }
  all.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  const out: string[] = [];
  for (const n of all) if (!out.length || out[out.length - 1].toLowerCase() !== n.toLowerCase()) out.push(n);
  return { names: out, limited };
}

// ---------------------------------------------------------------- the footprint index (GET /api/libs/footprints)
let index: FpIndexLib[] | null = null; let loading: Promise<FpIndexLib[]> | null = null; let progress = 0;
/** GetFootprintLibrariesLoadProgress: 0..1 while the library indexes load. */
export function footprintIndexProgress(): number { return index ? 1 : progress; }
export function footprintIndex(): FpIndexLib[] | null { return index; }
/** StartFootprintLibrariesLoad: every global library's footprint names, eight requests at a time. */
export function loadFootprintIndex(): Promise<FpIndexLib[]> {
  if (index) return Promise.resolve(index);
  if (loading) return loading;
  loading = (async () => {
    let names: string[] = [];
    try {
      const r = await fetch("/api/libs/footprints", { credentials: "same-origin", headers: { accept: "application/json" } });
      const j = r.ok && /json/.test(r.headers.get("content-type") || "") ? await r.json() as { libraries?: { name: string }[] } : null;
      names = j && Array.isArray(j.libraries) ? j.libraries.map((l) => l && l.name).filter((n): n is string => typeof n === "string") : [];
    } catch { names = []; }
    const out: FpIndexLib[] = new Array(names.length); let done = 0, next = 0;
    const worker = async (): Promise<void> => {
      while (next < names.length) {
        const i = next++; const lib = names[i];
        try {
          const r = await fetch(`/api/libs/footprints/${encodeURIComponent(lib)}`, { credentials: "same-origin", headers: { accept: "application/json" } });
          const j = r.ok ? await r.json() as { footprints?: { n: string }[] } : null;
          out[i] = { name: lib, footprints: j && Array.isArray(j.footprints) ? j.footprints.map((f) => f && f.n).filter((n): n is string => !!n) : [] };
        } catch { out[i] = { name: lib, footprints: [] }; }
        done++; progress = names.length ? done / names.length * 0.999 : 0.999;
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, names.length) }, worker));
    index = out.filter(Boolean); loading = null; return index;
  })();
  return loading;
}
