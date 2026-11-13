// Compare.tsx — the Compare window: two versions of a schematic sheet or a board, and what changed.
//
// It follows KiCad's own diff dialog (common/dialogs/dialog_kicad_diff.cpp, File ▸ Compare … with
// History): "Reference" and "Comparison" on top with a revision chooser and Older / Newer, the tree of
// changes grouped Added / Removed / Modified with a filter box and a check box per category, the canvas
// with the changes outlined in the diff colours, and the Property / Before / After list of the picked
// change.  The versions on offer are the document as it is now, the project's checkpoints (and the
// version history once the server has one), the commits of the linked GitHub repository, and a file.
import { Select } from "../components/Select";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as RPointerEvent, type ReactNode, type RefObject } from "react";
import { dispatch, useApp } from "../store";
import { ago, cx } from "../util";
import { countsText, diffDocs, type Category, type Change, type DocDiff } from "./diff";
import { changeAt, extent, fitBox, paint, type DiffView, type Mode, type PaintInput } from "./paint";
import { SourceError, listVersions, loadVersion, refLabel, sameRef, type Choice, type DocEntry, type Listing, type Loaded, type VersionRef } from "./sources";
import { closeCompare, openCompare, reviewStore, takeLinkRequest, type CompareRequest } from "./store";

const CATS: Category[] = ["added", "removed", "modified"];
const CAT_NAME: Record<Category, string> = { added: "Added", removed: "Removed", modified: "Modified" };
const isDesign = (d: DocEntry): boolean => d.docType === "kicad_sch" || d.docType === "kicad_pcb";
const baseName = (p: string): string => p.split("/").pop() || p;

interface EditorGlobals { hiddenLayers?: Set<string>; kdoc?: KDoc | null }
const editor = (): EditorGlobals => ((window as unknown as { CollabEditor?: EditorGlobals }).CollabEditor || {});

export function CompareWindow() {
  const st = useSyncExternalStore(reviewStore.subscribe, reviewStore.get, reviewStore.get);
  const hasDoc = useApp((s) => s.view === "editor" && s.document.hasDoc);
  // a link that asks for the window (?compare=1, as the desktop's File ▸ Compare with Checkpoint… opens)
  const linked = useRef(false);
  useEffect(() => {
    if (!hasDoc || linked.current) return;
    linked.current = true;
    if (takeLinkRequest()) openCompare();
  }, [hasDoc]);
  if (!st.open || !hasDoc) return null;
  return <CompareDialog key={st.n} request={st.request} />;
}

function useSize(): [RefObject<HTMLDivElement>, { w: number; h: number }] {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

function CompareDialog({ request }: { request: CompareRequest }) {
  const project = useApp((s) => s.project);
  const openDoc = useApp((s) => s.document.doc);
  const liveVersion = useApp((s) => s.document.version);
  const canComment = useApp((s) => !!s.canComment);
  const docs = useMemo(() => (project ? project.docs.filter(isDesign) : []), [project]);
  const [entryId, setEntryId] = useState<string>(request.docId || (openDoc && isDesign(openDoc) ? openDoc.docId : docs[0] ? docs[0].docId : ""));
  const entry = docs.find((d) => d.docId === entryId) || null;
  const isOpen = !!entry && !!openDoc && entry.docId === openDoc.docId;
  const projectId = project ? project.projectId : "";

  const [listing, setListing] = useState<Listing | null>(null);
  const [extra, setExtra] = useState<Choice[]>([]);
  const [refA, setRefA] = useState<VersionRef | null>(null);
  const [refB, setRefB] = useState<VersionRef | null>(null);
  const [sides, setSides] = useState<{ a: Loaded; b: Loaded } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [mode, setMode] = useState<Mode>("overlay");
  const [show, setShow] = useState<Record<Category, boolean>>({ added: true, removed: true, modified: true });
  const [filter, setFilter] = useState("");
  const [hiddenRows, setHiddenRows] = useState<Set<string>>(new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showProps, setShowProps] = useState(true);
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(new Set());
  const [layersOpen, setLayersOpen] = useState(false);
  const [split, setSplit] = useState(0.5);
  const [notice, setNotice] = useState<string | null>(null);

  // ---- the versions on offer for the chosen document
  const fileInput = useRef<HTMLInputElement>(null), fileFor = useRef<"a" | "b">("a");
  const firstRequest = useRef(true);
  useEffect(() => {
    if (!entry || !projectId) { setLoading(false); return; }
    let gone = false;
    setListing(null); setSides(null); setError(null); setLoading(true); setSelectedKey(null); setHiddenRows(new Set());
    const K = window.KiCadCanvas;
    setHiddenLayers(entry.docType === "kicad_pcb" ? new Set(isOpen && editor().hiddenLayers ? editor().hiddenLayers : K.PCB_HIDDEN_DEFAULT) : new Set());
    listVersions(projectId, entry, isOpen).then((l) => {
      if (gone) return;
      const asked = firstRequest.current ? request : {}; firstRequest.current = false;
      const now = l.choices[0].ref;
      const saved = l.choices.filter((c) => c.group !== "Now").sort((x, y) => (y.when || "").localeCompare(x.when || ""));
      const custom: Choice[] = [];
      for (const r of [asked.a, asked.b]) if (r && !l.choices.some((c) => sameRef(c.ref, r))) custom.push({ ref: r, label: refLabel(r), group: "Versions" });
      setExtra(custom); setListing(l);
      setRefA(asked.a || (saved[0] ? saved[0].ref : now));
      setRefB(asked.b || now);
      if (asked.pickFile) { fileFor.current = "a"; setTimeout(() => fileInput.current?.click(), 0); }
    }).catch((e) => { if (!gone) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } });
    return () => { gone = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryId, projectId]);

  const choices = useMemo(() => (listing ? [...listing.choices, ...extra] : []), [listing, extra]);

  // ---- read both sides
  useEffect(() => {
    if (!entry || !refA || !refB) return;
    let gone = false;
    setLoading(true); setError(null);
    Promise.all([loadVersion(refA, projectId, entry, isOpen ? entry : null), loadVersion(refB, projectId, entry, isOpen ? entry : null)])
      .then(([a, b]) => { if (!gone) { setSides({ a, b }); setLoading(false); } })
      .catch((e) => { if (!gone) { setSides(null); setLoading(false); setError(e instanceof SourceError ? e.message : "That version could not be read."); } });
    return () => { gone = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refA, refB, entryId, projectId]);

  // the editor replaces its document object when it loads again (a reconnect, a restored version): a
  // live side follows it to the new one
  useEffect(() => {
    if (!sides) return;
    const k = (editor() as { kdoc?: KDoc | null }).kdoc; if (!k) return;
    const a = sides.a.live && sides.a.doc !== k, b = sides.b.live && sides.b.doc !== k;
    if (a || b) setSides({ a: a ? { ...sides.a, doc: k } : sides.a, b: b ? { ...sides.b, doc: k } : sides.b });
  }, [liveVersion, sides]);

  // ---- the difference (a live side follows the editor: other people keep editing while this is open)
  const liveTick = sides && (sides.a.live || sides.b.live) ? liveVersion : 0;
  const diff: DocDiff | null = useMemo(() => {
    if (!sides) return null;
    try { return diffDocs(window.KiCadCanvas, sides.a.doc, sides.b.doc); } catch (e) { console.warn("compare failed", e); return null; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sides, liveTick]);

  const rows = useMemo(() => {
    if (!diff) return [];
    const q = filter.trim().toLowerCase();
    return q ? diff.changes.filter((c) => (c.label + " " + c.detail).toLowerCase().includes(q)) : diff.changes;
  }, [diff, filter]);
  const selected = useMemo(() => (selectedKey ? rows.find((c) => c.key === selectedKey) || null : null), [rows, selectedKey]);
  const shown = useMemo(() => rows.filter((c) => show[c.category]), [rows, show]);

  // ---- the view
  const [stageRef, size] = useSize();
  const view = useRef<DiffView | null>(null);
  const [frame, setFrame] = useState(0);
  const redraw = useCallback(() => setFrame((n) => n + 1), []);
  const paneW = mode === "side" ? Math.max(1, Math.floor((size.w - 1) / 2)) : size.w;
  const fit = useCallback(() => {
    if (!sides || !paneW || !size.h) return;
    view.current = fitBox(extent(sides.a.doc, sides.b.doc), paneW, size.h, sides.b.doc.type === "sch" ? 0.97 : 0.88);
    redraw();
  }, [sides, paneW, size.h, redraw]);
  // fit when a pair of versions arrives, and when the canvas first gets a size
  const fitted = useRef<unknown>(null);
  useEffect(() => { if (sides && paneW && size.h && fitted.current !== sides) { fitted.current = sides; fit(); } }, [sides, paneW, size.h, fit]);

  const input: PaintInput | null = useMemo(() => (sides && diff ? { a: sides.a.doc, b: sides.b.doc, diff, show, hiddenRows, rows, selected, hiddenLayers, dpr: window.devicePixelRatio || 1 } : null),
    [sides, diff, show, hiddenRows, rows, selected, hiddenLayers]);

  const cvA = useRef<HTMLCanvasElement>(null), cvB = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!input || !view.current || !paneW || !size.h) return;
    const raf = requestAnimationFrame(() => {
      const dpr = input.dpr;
      const draw = (cv: HTMLCanvasElement | null, side: "both" | "before" | "after" | "swipe") => {
        if (!cv || !view.current) return;
        const w = Math.round(paneW * dpr), h = Math.round(size.h * dpr);
        if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
        const ctx = cv.getContext("2d"); if (!ctx) return;
        try { paint(ctx, paneW, size.h, view.current, input, side, split); } catch (e) { console.warn("compare: paint failed", e); }
      };
      if (mode === "side") { draw(cvA.current, "before"); draw(cvB.current, "after"); }
      else draw(cvA.current, mode === "swipe" ? "swipe" : "both");
    });
    return () => cancelAnimationFrame(raf);
  }, [input, mode, paneW, size.h, frame, split]);

  const zoomTo = useCallback((c: Change) => {
    if (!c.bbox || !paneW || !size.h) return;
    const b = c.bbox, grow = Math.max(b[2] - b[0], b[3] - b[1], sides && sides.b.doc.type === "sch" ? 12 : 4) * 1.4;
    const cxm = (b[0] + b[2]) / 2, cym = (b[1] + b[3]) / 2;
    view.current = fitBox([cxm - grow, cym - grow, cxm + grow, cym + grow], paneW, size.h, 1);
    redraw();
  }, [paneW, size.h, sides, redraw]);

  const pick = useCallback((c: Change | null, zoom: boolean) => {
    setSelectedKey(c ? c.key : null);
    if (c && zoom) zoomTo(c);
    if (c) requestAnimationFrame(() => { const el = document.querySelector(`.rv-row[data-key="${CSS.escape(c.key)}"]`); if (el) el.scrollIntoView({ block: "nearest" }); });
  }, [zoomTo]);

  // ---- pointer: drag pans, the wheel zooms about the cursor, a click picks the change under it
  const drag = useRef<{ x: number; y: number; moved: boolean; id: number } | null>(null);
  const toDoc = (ev: { clientX: number; clientY: number; currentTarget: Element }): [number, number] | null => {
    const v = view.current; if (!v) return null;
    const r = ev.currentTarget.getBoundingClientRect();
    return [v.cx + (ev.clientX - r.left - r.width / 2) / v.scale, v.cy + (ev.clientY - r.top - r.height / 2) / v.scale];
  };
  const onDown = (ev: RPointerEvent<HTMLCanvasElement>) => {
    if (ev.button > 1) return;
    drag.current = { x: ev.clientX, y: ev.clientY, moved: false, id: ev.pointerId };
    try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch { /* not capturable */ }
  };
  const onMove = (ev: RPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current, v = view.current; if (!d || !v || d.id !== ev.pointerId) return;
    const dx = ev.clientX - d.x, dy = ev.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true; d.x = ev.clientX; d.y = ev.clientY;
    v.cx -= dx / v.scale; v.cy -= dy / v.scale; redraw();
  };
  const onUp = (ev: RPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current; drag.current = null;
    if (!d || d.moved || !input || !view.current) return;
    const p = toDoc(ev); if (!p) return;
    pick(changeAt(input, p[0], p[1], 6 / view.current.scale), false);
  };
  useEffect(() => {
    const el = stageRef.current; if (!el) return;
    const wheel = (ev: WheelEvent) => {
      const v = view.current, cv = (ev.target as Element).closest("canvas"); if (!v || !cv) return;
      ev.preventDefault();
      const r = cv.getBoundingClientRect(), px = ev.clientX - r.left - r.width / 2, py = ev.clientY - r.top - r.height / 2;
      const k = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0018)), next = Math.min(4000, Math.max(0.05, v.scale * k));
      v.cx += px / v.scale - px / next; v.cy += py / v.scale - py / next; v.scale = next; redraw();
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [stageRef, redraw]);
  const zoomBy = (k: number) => { const v = view.current; if (v) { v.scale = Math.min(4000, Math.max(0.05, v.scale * k)); redraw(); } };

  // ---- keys: Escape closes, the arrows walk the changes
  useEffect(() => {
    const key = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement | null)?.tagName || "";
      // a drop-down's open list takes its own Escape and arrows (the k-select is the event target: its list is in its shadow root)
      if (tag === "K-SELECT" && (ev.target as HTMLElement).hasAttribute("data-popup-open")) return;
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); if (layersOpen) setLayersOpen(false); else closeCompare(); return; }
      if (/^(INPUT|SELECT|K-SELECT|TEXTAREA)$/.test(tag)) return;
      if ((ev.key === "ArrowDown" || ev.key === "ArrowUp") && shown.length) {
        ev.preventDefault(); ev.stopPropagation();
        const i = selected ? shown.indexOf(selected) : -1, n = shown.length;
        pick(shown[ev.key === "ArrowDown" ? (i + 1) % n : (i - 1 + n) % n] || null, true);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [shown, selected, pick, layersOpen]);

  // ---- pickers
  const setRef = (side: "a" | "b", value: string) => {
    if (value === "file") { fileFor.current = side; fileInput.current?.click(); return; }
    const c = choices[Number(value)]; if (!c) return;
    if (side === "a") setRefA(c.ref); else setRefB(c.ref);
  };
  const onFile = async (files: FileList | null) => {
    const f = files && files[0]; if (!f || !entry) return;
    const text = await f.text();
    const want = entry.docType === "kicad_sch" ? "(kicad_sch" : "(kicad_pcb";
    if (!text.trimStart().startsWith(want)) { setNotice(`${f.name} is not a KiCad ${entry.docType === "kicad_sch" ? "schematic" : "board"} file.`); return; }
    const ref: VersionRef = { kind: "file", name: f.name, text };
    setExtra((x) => [...x.filter((c) => !sameRef(c.ref, ref)), { ref, label: f.name, group: "File" }]);
    if (fileFor.current === "a") setRefA(ref); else setRefB(ref);
  };
  const history = useMemo(() => choices.filter((c) => c.group !== "Now" && c.group !== "File").sort((x, y) => (y.when || "").localeCompare(x.when || "")), [choices]);
  const histIndex = refA ? history.findIndex((c) => sameRef(c.ref, refA)) : -1;
  const step = (by: number) => { const c = history[histIndex + by]; if (c) setRefA(c.ref); };

  const picker = (side: "a" | "b", ref: VersionRef | null): ReactNode => {
    const groups: Choice["group"][] = ["Now", "Checkpoints", "Versions", "GitHub commits", "File"];
    const value = ref ? choices.findIndex((c) => sameRef(c.ref, ref)) : -1;
    return (
      <Select className="input rv-pick" data={{ side }} value={value < 0 ? "" : String(value)} disabled={!listing} onChange={(v) => setRef(side, v)} label={side === "a" ? "Reference version" : "Comparison version"}
        options={[...(value < 0 ? [{ value: "", label: "…" }] : []),
          ...groups.flatMap((g) => choices.map((c, i) => [c, i] as const).filter(([c]) => c.group === g)
            .map(([c, i]) => (g === "Now" ? { value: String(i), label: c.label } : { value: String(i), label: c.label + (c.when ? ` · ${ago(c.when)}` : ""), group: g }))),
          { value: "file", label: "Choose a file…" }]} />
    );
  };

  // ---- actions
  const summaryText = (): string => {
    if (!diff || !sides || !entry) return "";
    const lines = [`${entry.path}: ${sides.a.label} → ${sides.b.label}`, countsText(diff), ""];
    for (const cat of CATS) { const l = diff.changes.filter((c) => c.category === cat); if (!l.length) continue; lines.push(`${CAT_NAME[cat]} (${l.length})`); for (const c of l) lines.push(`  ${c.label}${c.detail ? ` — ${c.detail}` : ""}`); }
    return lines.join("\n");
  };
  const copySummary = async () => { try { await navigator.clipboard.writeText(summaryText()); setNotice("Summary copied."); } catch { setNotice("The browser did not allow copying."); } };
  const saveImage = () => {
    const cv = cvA.current; if (!cv || !entry) return;
    let out: HTMLCanvasElement = cv;
    if (mode === "side" && cvB.current) {   // both halves in one picture
      out = document.createElement("canvas"); out.width = cv.width + cvB.current.width; out.height = cv.height;
      const c = out.getContext("2d"); if (c) { c.drawImage(cv, 0, 0); c.drawImage(cvB.current, cv.width, 0); }
    }
    out.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${baseName(entry.path).replace(/\.kicad_(sch|pcb)$/, "")}-compare.png`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, "image/png");
  };
  const liveItem = (c: Change): string | null => { const d = editor().kdoc; return d ? c.ids.find((id) => d.items.has(id)) || c.oldIds.find((id) => d.items.has(id)) || null : null; };
  const commentWhy = !selected ? "Pick a change first" : !isOpen ? "Open this document in the editor to comment on it" : !canComment ? "You can view this project but not comment on it" : null;
  const comment = () => {
    if (!selected || commentWhy) return;
    const item = liveItem(selected), b = selected.bbox;
    const body = `${CAT_NAME[selected.category]}: ${selected.label}${selected.detail ? ` (${selected.detail})` : ""}\n`;
    closeCompare();
    dispatch({ type: "commentOn", itemId: item || undefined, at: b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : undefined, body });
  };
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(null), 2600); return () => clearTimeout(t); }, [notice]);

  // ---- layers of a board
  const layerRows = useMemo(() => {
    if (!sides || sides.b.doc.type !== "pcb") return [];
    const K = window.KiCadCanvas, seen = new Map<string, { key: string; name: string; color: string }>();
    for (const d of [sides.b.doc, sides.a.doc]) for (const l of K.layerList(d)) if (!seen.has(l.key)) seen.set(l.key, l);
    return Array.from(seen.values());
  }, [sides]);
  const toggleLayer = (key: string) => setHiddenLayers((h) => { const n = new Set(h); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  const kind = entry ? (entry.docType === "kicad_sch" ? "Schematic" : "Board") : "Document";
  const sameSides = !!refA && !!refB && sameRef(refA, refB);
  const noHistory = !!listing && history.length === 0 && !extra.length;
  const cursor = "grab";

  return (
    <div className="kd-overlay rv-overlay" data-compare onMouseDown={(ev) => { if (ev.target === ev.currentTarget) closeCompare(); }}>
      <div className="kd-dialog rv-dialog" role="dialog" aria-label={`Compare ${kind} Versions`}>
        <div className="kd-title"><span>Compare {kind} Versions</span><span className="kd-x" role="button" aria-label="Close" onClick={() => closeCompare()}>×</span></div>

        <div className="rv-head">
          {docs.length > 1 ? (
            <label className="rv-field"><span>Document:</span>
              <Select className="input" id="rvDoc" value={entryId} onChange={(v) => setEntryId(v)} options={docs.map((d) => ({ value: d.docId, label: d.path }))} />
            </label>
          ) : null}
          <label className="rv-field grow"><span>Reference:</span>{picker("a", refA)}
            <button type="button" className="btn sm" id="rvOlder" disabled={histIndex < 0 || histIndex >= history.length - 1} title="The version before this one" onClick={() => step(1)}>Older</button>
            <button type="button" className="btn sm" id="rvNewer" disabled={histIndex <= 0} title="The version after this one" onClick={() => step(-1)}>Newer</button>
          </label>
          <button type="button" className="btn sm ghost rv-swap" id="rvSwap" title="Swap the two sides" disabled={!refA || !refB} onClick={() => { const a = refA; setRefA(refB); setRefB(a); }}>⇄</button>
          <label className="rv-field grow"><span>Comparison:</span>{picker("b", refB)}</label>
          <input ref={fileInput} type="file" hidden accept=".kicad_sch,.kicad_pcb" onChange={(ev) => { void onFile(ev.target.files); ev.target.value = ""; }} />
        </div>
        {listing && listing.github !== "ok" && listing.github !== "unlinked" && listing.githubNote ? <div className="rv-note">{listing.githubNote} <a href={`/p/${projectId}/github`}>GitHub Sync</a></div> : null}

        <div className="rv-main">
          <aside className="rv-side">
            <input className="input rv-filter" type="search" placeholder="Filter changes…" value={filter} onChange={(ev) => setFilter(ev.target.value)} aria-label="Filter changes" />
            <div className="rv-cats">
              {CATS.map((c) => (
                <label key={c} className={cx("rv-cat", c)}><input type="checkbox" checked={show[c]} onChange={(ev) => setShow((s) => Object.assign({}, s, { [c]: ev.target.checked }))} />
                  <i />{CAT_NAME[c]}<b>{diff ? diff.counts[c] : 0}</b></label>
              ))}
            </div>
            <div className="rv-tree" id="rvTree" role="tree">
              {CATS.map((cat) => {
                const list = rows.filter((c) => c.category === cat);
                if (!list.length || !show[cat]) return null;
                return (
                  <div key={cat} className="rv-group">
                    <div className={cx("rv-group-title", cat)}><i />{CAT_NAME[cat]} <span>{list.length}</span></div>
                    {list.map((c) => {
                      const hidden = hiddenRows.has(c.key);
                      return (
                        <div key={c.key} role="treeitem" aria-selected={selected === c} className={cx("rv-row", cat, selected === c && "sel", hidden && "off")} data-key={c.key} onClick={() => pick(c, true)}>
                          <div className="rv-row-text"><span className="rv-label" title={c.label}>{c.label}</span>{c.detail ? <span className="rv-detail" title={c.detail}>{c.detail}</span> : null}</div>
                          <button type="button" className="rv-eye" title={hidden ? "Show Change" : "Hide Change"} aria-pressed={hidden}
                            onClick={(ev) => { ev.stopPropagation(); setHiddenRows((h) => { const n = new Set(h); if (n.has(c.key)) n.delete(c.key); else n.add(c.key); return n; }); }}>{hidden ? "show" : "hide"}</button>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              {diff && !rows.length ? <p className="note rv-empty">{diff.changes.length ? "No change matches the filter." : "No differences detected."}</p> : null}
              {hiddenRows.size ? <button type="button" className="btn sm ghost rv-showall" onClick={() => setHiddenRows(new Set())}>Show All Hidden</button> : null}
            </div>
          </aside>

          <section className="rv-view">
            <div className="rv-bar">
              <div className="seg" role="group" aria-label="View">
                <button type="button" className={cx(mode === "overlay" && "on")} data-mode="overlay" onClick={() => setMode("overlay")}>Overlay</button>
                <button type="button" className={cx(mode === "side" && "on")} data-mode="side" onClick={() => setMode("side")}>Side by side</button>
                <button type="button" className={cx(mode === "swipe" && "on")} data-mode="swipe" onClick={() => setMode("swipe")}>Swipe</button>
              </div>
              {layerRows.length ? (
                <div className="rv-layers">
                  <button type="button" className={cx("btn sm", layersOpen && "on")} id="rvLayers" aria-expanded={layersOpen} onClick={() => setLayersOpen((o) => !o)}>Layers</button>
                  {layersOpen ? (
                    <div className="rv-layer-menu" role="menu">
                      <div className="rv-layer-quick">
                        <button type="button" className="btn sm" onClick={() => setHiddenLayers(new Set())}>All</button>
                        <button type="button" className="btn sm" onClick={() => setHiddenLayers(new Set(layerRows.filter((l) => !/\.Cu$/.test(l.key) && l.key !== "Edge.Cuts").map((l) => l.key)))}>Copper</button>
                      </div>
                      {layerRows.map((l) => (
                        <label key={l.key}><input type="checkbox" checked={!hiddenLayers.has(l.key)} onChange={() => toggleLayer(l.key)} /><i style={{ background: l.color }} />{l.name}</label>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <label className="rv-check"><input type="checkbox" checked={showProps} onChange={(ev) => setShowProps(ev.target.checked)} />Properties</label>
              <span className="rv-spacer" />
              <button type="button" className="btn sm" title="Zoom out" onClick={() => zoomBy(0.8)}>−</button>
              <button type="button" className="btn sm" title="Zoom in" onClick={() => zoomBy(1.25)}>+</button>
              <button type="button" className="btn sm" id="rvFit" title="Zoom to fit" onClick={fit}>Fit</button>
            </div>

            <div className={cx("rv-stage", mode)} ref={stageRef} data-mode={mode}>
              {sides && diff ? (
                <>
                  <canvas ref={cvA} className="rv-canvas" data-canvas={mode === "side" ? "before" : "main"} style={{ width: paneW, height: size.h, cursor }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => { drag.current = null; }} />
                  {mode === "side" ? <canvas ref={cvB} className="rv-canvas second" data-canvas="after" style={{ width: paneW, height: size.h, cursor }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => { drag.current = null; }} /> : null}
                  {mode === "side" ? <><span className="rv-tag left">{sides.a.label}</span><span className="rv-tag right">{sides.b.label}</span></> : null}
                  {mode === "swipe" ? <Divider split={split} onSplit={setSplit} left={sides.a.label} right={sides.b.label} /> : null}
                </>
              ) : null}
              {loading ? <div className="rv-cover"><span className="spinner" /> Reading the versions…</div> : null}
              {!loading && error ? <div className="rv-cover"><div className="callout err">{error}</div></div> : null}
              {!loading && !error && !entry ? <div className="rv-cover"><div className="callout">This project has no schematic or board to compare.</div></div> : null}
              {!loading && !error && sides && sameSides ? (
                <div className="rv-hint">{noHistory
                  ? "Nothing to compare with yet. Save a checkpoint (File ▸ Save), link a GitHub repository, or choose a file as the reference."
                  : "Both sides are the same version. Pick another one as the reference."}</div>
              ) : null}
            </div>

            {showProps ? (
              <div className="rv-props" id="rvProps">
                {selected ? (
                  selected.props.length ? (
                    <table>
                      <thead><tr><th>Property</th><th>Before</th><th>After</th></tr></thead>
                      <tbody>{selected.props.map((p, i) => <tr key={i}><td>{p.name}</td><td className="before" title={p.before}>{p.before}</td><td className="after" title={p.after}>{p.after}</td></tr>)}</tbody>
                    </table>
                  ) : <p className="note">{selected.label}: {selected.detail || CAT_NAME[selected.category].toLowerCase()}.</p>
                ) : <p className="note">{diff && diff.changes.length ? "Select a change in the tree to view details" : ""}</p>}
              </div>
            ) : null}
          </section>
        </div>

        <div className="kd-foot rv-foot">
          <span className="rv-summary" id="rvSummary">{notice || (diff ? (diff.changes.length ? `${diff.changes.length} change${diff.changes.length === 1 ? "" : "s"} detected: ${countsText(diff)}.` : "No differences detected.") : "")}</span>
          <span className="spacer" />
          <button type="button" className="btn" id="rvComment" disabled={!!commentWhy} title={commentWhy || "Start a comment thread pinned to this change"} onClick={comment}>Comment on Change…</button>
          <button type="button" className="btn" id="rvCopy" disabled={!diff} onClick={() => { void copySummary(); }}>Copy Summary</button>
          <button type="button" className="btn" id="rvImage" disabled={!diff} onClick={saveImage}>Save Image</button>
          <button type="button" className="btn primary" id="rvClose" onClick={() => closeCompare()}>Close</button>
        </div>
      </div>
    </div>
  );
}

function Divider({ split, onSplit, left, right }: { split: number; onSplit(v: number): void; left: string; right: string }) {
  const down = (ev: RPointerEvent<HTMLDivElement>) => {
    ev.preventDefault();
    const host = ev.currentTarget.parentElement; if (!host) return;
    const el = ev.currentTarget;
    try { el.setPointerCapture(ev.pointerId); } catch { /* not capturable */ }
    const move = (m: PointerEvent) => { const r = host.getBoundingClientRect(); onSplit(Math.min(0.98, Math.max(0.02, (m.clientX - r.left) / r.width))); };
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
  };
  return (
    <>
      <span className="rv-tag left">{left}</span><span className="rv-tag right">{right}</span>
      <div className="rv-divider" style={{ left: `${split * 100}%` }} onPointerDown={down} role="separator" aria-orientation="vertical" aria-label="Drag to compare"><i /></div>
    </>
  );
}
