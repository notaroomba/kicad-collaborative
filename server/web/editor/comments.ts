import { netLabel } from "../review/names";
// comments.ts — design review threads on the open document.
//
// A thread is pinned to a part or any other item (by uuid), to a net (by name), or to a bare spot.
// A pinned thread follows what it is pinned to: its bubble is drawn at the item wherever the item is
// now, opening it selects the part or highlights the net, and when the item is deleted the thread
// stays at the place it was started and says so.  The threads live on the server (REST) and reach
// every client over the document's socket; the canvas pins are SVG in the overlay, the open thread is
// the #cmtPanel card, and the Comments pane (components/panes/Comments.tsx) lists them from the store.
import { state, store } from "./appstore";
import { keyName } from "../keys";
import { NS } from "./dom";
import { clearAllSelection, selectItemId, selectionChanged } from "./gestures";
import { E } from "./state";
import { setTool } from "./tools";
import { ago, api, toast } from "./util";
import { applyView, cmtG, cmtPanel, mmH, mmW, mmX0, mmY0, pxPerMm, requestRender, stage, world, worldMm } from "./view";

export interface Anchor { kind: "item" | "net"; id: string; label: string; item?: string | null }
export interface CommentRow {
  id: number; docId: string; parentId: number | null; authorId: number; authorLogin: string;
  x: number; y: number; body: string; resolved: boolean; createdAt: string; editedAt?: string | null; anchor?: Anchor | null;
}
type Mm = [number, number];
interface Me { id: number; login: string }
interface Draft { xNm: number; yNm: number; anchor: Anchor | null; body: string }

const comments = (): CommentRow[] => E.comments as CommentRow[];
const kdoc = (): KDoc | null => E.kdoc as KDoc | null;
const IU = (): number => E.IU as number;
const me = (): Me | null => (state as unknown as { me: Me | null }).me;
const docId = (): string | null => { const id = (state as unknown as { docId: string | null }).docId; return id && !id.startsWith("board:") && !id.startsWith("lib:") ? id : null; };   // a board footprint's private copy (editor/fpedit.ts) has no comments of its own
const project = (): { projectId: string; ownerId?: number } | null => (state as unknown as { project: { projectId: string; ownerId?: number } | null }).project;
/** Who may write comments: the roles work publishes E.canComment; before it, anyone signed in. */
export const canComment = (): boolean => !!E.canComment;
const panel = cmtPanel as HTMLElement, pins = cmtG as SVGGElement, stageEl = stage as HTMLElement, worldEl = world as HTMLElement;
const request = api as (path: string, opts?: RequestInit) => Promise<unknown>;

let draft: Draft | null = null;
/** the net highlight this module put on the canvas for the open thread (cleared when the thread closes) */
let ownHighlight: Set<string> | null = null;

// ---------------------------------------------------------------- what a thread is pinned to
const PARTS = new Set(["symbol", "footprint", "sheet"]);

function describe(it: KItem): string {
  if (it.ref) return it.ref;
  if (it.name) return it.name;
  const names = (CollabTools.props && (CollabTools.props as unknown as { KIND_NAMES?: Record<string, string> }).KIND_NAMES) || {};
  const kind = names[it.kind] || it.kind.replace(/^gr_/, "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  const text = /label|text/.test(it.kind) ? KiCadCanvas.str(it.node[1]) : "";
  return text ? `${kind} ${text.length > 24 ? text.slice(0, 23) + "…" : text}` : kind;
}

/** The net an item is on, with the items of that net on this document; null when it has none. */
export function netOfItem(it: KItem, near?: Mm): { name: string; ids: string[] } | null {
  const d = kdoc(); if (!d) return null;
  if (d.type === "pcb") {
    let name = "";
    if (it.kind === "footprint") {
      if (!near) return null;
      const pad = (KiCadCanvas.padAt as (doc: KDoc, x: number, y: number) => { item: KItem; pad: SNode | null; netName?: string } | null)(d, near[0], near[1]);
      if (pad && pad.item === it) name = pad.netName || (pad.pad ? (KiCadCanvas.netNameOf as (doc: KDoc, n: SNode) => string)(d, pad.pad) : "");
    } else name = (KiCadCanvas.netNameOf as (doc: KDoc, n: SNode) => string)(d, it.node);
    return name ? { name, ids: boardNetIds(name) } : null;
  }
  const sch = CollabTools.sch; if (!sch || !/^(wire|bus|junction|label|global_label|hierarchical_label|bus_entry)$/.test(it.kind)) return null;
  let ids: string[];
  try { ids = Array.from(sch.netItems(d, it, near) as unknown as Iterable<string>); } catch { return null; }
  if (!ids.length) return null;
  return { name: schNetName(ids), ids };
}
function boardNetIds(name: string): string[] {
  const d = kdoc(), out: string[] = []; if (!d) return out;
  const netNameOf = KiCadCanvas.netNameOf as (doc: KDoc, n: SNode) => string;
  for (const it of d.items.values()) if ((it.kind === "segment" || it.kind === "arc" || it.kind === "via" || it.kind === "zone") && netNameOf(d, it.node) === name) out.push(it.id);
  return out;
}
/** A sheet's name for a net, as KiCad derives it: a global label, a hierarchical one, a local one, else a part. */
function schNetName(ids: string[]): string {
  const d = kdoc(); if (!d) return "";
  const items = ids.map((id) => d.items.get(id)).filter((x): x is KItem => !!x);
  for (const kind of ["global_label", "hierarchical_label", "label"]) { const l = items.find((it) => it.kind === kind); if (l) return KiCadCanvas.str(l.node[1]); }
  const sym = items.find((it) => it.kind === "symbol" && it.ref && !it.ref.startsWith("#"));
  return sym ? `Net-(${sym.ref})` : "unnamed net";
}
/** The items of a net anchor on the open document. */
function netIds(a: Anchor): string[] {
  const d = kdoc(); if (!d) return [];
  if (d.type === "pcb") return boardNetIds(a.id);
  const sch = CollabTools.sch; if (!sch) return [];
  const from = (a.item && d.items.get(a.item)) || Array.from(d.items.values()).find((it) => /label$/.test(it.kind) && KiCadCanvas.str(it.node[1]) === a.id);
  if (!from) return [];
  try { return Array.from(sch.netItems(d, from) as unknown as Iterable<string>); } catch { return []; }
}

/** Where a thread's bubble goes now (mm), and whether what it is pinned to still exists. */
export function pinOf(c: CommentRow): { x: number; y: number; found: boolean } {
  const d = kdoc(), sx = c.x / IU(), sy = c.y / IU(), a = c.anchor;
  if (!a || !d) return { x: sx, y: sy, found: true };
  const it = d.items.get(a.kind === "item" ? a.id : a.item || "");
  if (!it || !it.bbox) return { x: sx, y: sy, found: a.kind === "net" ? netIds(a).length > 0 : false };
  const b = it.bbox;
  if (a.kind === "item" && PARTS.has(it.kind)) return { x: b[2], y: b[1], found: true };   // a part: its top right corner, clear of the body
  // a track, a wire, a label: where the thread was started while that is still on the item, its middle after it moved
  const slack = 0.6;
  if (sx >= b[0] - slack && sx <= b[2] + slack && sy >= b[1] - slack && sy <= b[3] + slack) return { x: sx, y: sy, found: true };
  return { x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2, found: true };
}

/** The threads pinned to an item (open ones), for the right-click menu. */
export function threadsOnItem(id: string): CommentRow[] {
  return comments().filter((c) => !c.parentId && !c.resolved && c.anchor && ((c.anchor.kind === "item" && c.anchor.id === id) || (c.anchor.kind === "net" && c.anchor.item === id)));
}

// ---------------------------------------------------------------- store
export function renderThreads(): void { store.set({ comments: comments().slice() }); }

export async function loadComments(): Promise<void> {
  const id = docId(); if (!id) return;
  try { E.comments = ((await request(`/api/docs/${id}/comments`)) as { comments?: CommentRow[] }).comments || []; } catch { E.comments = []; }
  if (docId() !== id) return;
  drawComments(); renderThreads();
  void loadProjectComments();
  // a thread asked for before its document was open (the Comments pane's other sheets, a link)
  const want = E.pendingThread as number | null;
  if (want !== null && want !== undefined) { E.pendingThread = null; if (comments().some((c) => c.id === want)) openThreadAction(want); }
}

let projectLoad = 0;
/** The open threads on the project's other documents, for the Comments pane. */
export async function loadProjectComments(): Promise<void> {
  const p = project(); if (!p) return;
  const n = ++projectLoad;
  try {
    const j = (await request(`/api/projects/${p.projectId}/comments`)) as { comments: CommentRow[]; docs: { docId: string; path: string }[] };
    if (n !== projectLoad) return;
    const others = j.docs.filter((d) => d.docId !== docId()).map((d) => ({ docId: d.docId, path: d.path, comments: j.comments.filter((c) => c.docId === d.docId) })).filter((d) => d.comments.length);
    store.set({ otherComments: others });
  } catch { store.set({ otherComments: [] }); }
}

export function noteCommentMsg(msg: { comment?: { action?: string; comment?: CommentRow } }): void {
  const c = msg.comment || {}, inner = c.comment; if (!inner) return;
  let list = comments();
  if (c.action === "deleted") list = list.filter((x) => x.id !== inner.id && x.parentId !== inner.id);
  else if (c.action === "updated") list = list.map((x) => (x.id === inner.id ? inner : x));
  else if (c.action === "added" && !list.some((x) => x.id === inner.id)) list = [...list, inner];
  E.comments = list;
  drawComments(); renderThreads();
  if (E.openThread !== null) {
    if (!list.some((x) => x.id === E.openThread)) closeThread();
    else if (!panel.querySelector("textarea.editing")) showThread(E.openThread as number, true);   // an edit in progress is not thrown away
  }
}

// ---------------------------------------------------------------- canvas pins
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS as string, tag) as SVGElementTagNameMap[K];
  for (const k of Object.keys(attrs)) el.setAttribute(k, String(attrs[k]));
  return el;
}

export function drawComments(): void {
  pins.replaceChildren();
  if (!kdoc() && !comments().length) return;
  const s = (pxPerMm as () => number)();
  const list = comments();
  for (const c of list) {
    if (c.parentId || c.resolved) continue;   // resolved threads leave the canvas; the Comments pane still lists them
    const p = pinOf(c), r = 9 / s, open = E.openThread === c.id;
    const g = svg("g", { cursor: "pointer", "data-thread": c.id, "data-anchor": c.anchor ? c.anchor.kind : "spot" });
    const fill = p.found ? "#ffb43a" : "#8a939c";
    if (open) g.appendChild(svg("circle", { cx: p.x, cy: p.y, r: r + 3.5 / s, fill: "none", stroke: "#4d7fc4", "stroke-width": 2 / s }));
    // a part or item pin is a round bubble, a net pin a rounded square, so the two read apart at a glance
    if (c.anchor && c.anchor.kind === "net") g.appendChild(svg("rect", { x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r, rx: 3 / s, fill, stroke: "#001023", "stroke-width": 1.5 / s }));
    else g.appendChild(svg("circle", { cx: p.x, cy: p.y, r, fill, stroke: "#001023", "stroke-width": 1.5 / s }));
    const glyph = svg("text", { x: p.x, y: p.y + 3.4 / s, "text-anchor": "middle", fill: "#001023", "font-size": 10 / s, "font-family": "system-ui, sans-serif", "font-weight": 700 });
    glyph.textContent = String(list.filter((x) => x.id === c.id || x.parentId === c.id).length);
    g.appendChild(glyph);
    const title = svg("title", {}); title.textContent = `${c.anchor ? c.anchor.label + ": " : ""}${c.body.slice(0, 80)}`; g.appendChild(title);
    g.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    g.addEventListener("click", (ev) => { ev.stopPropagation(); showThread(c.id); });
    pins.appendChild(g);
  }
}

export function centerOn(xMm: number, yMm: number): void {
  const w = worldEl.clientWidth, h = (w * mmH()) / mmW();
  E.panX = stageEl.clientWidth / 2 - ((xMm - mmX0()) / mmW()) * w * E.zoom;
  E.panY = stageEl.clientHeight / 2 - ((yMm - mmY0()) / mmH()) * h * E.zoom;
  applyView();
}

function panelAt(xMm: number, yMm: number): void {
  const wr = worldEl.getBoundingClientRect(), sr = stageEl.getBoundingClientRect();
  const px = wr.left - sr.left + ((xMm - mmX0()) / mmW()) * wr.width;
  const py = wr.top - sr.top + ((yMm - mmY0()) / mmH()) * wr.height;
  panel.classList.add("open");
  const pw = panel.offsetWidth || 320, ph = panel.offsetHeight || 200;
  // beside the pin, on whichever side has the room
  const left = px + 16 + pw <= sr.width ? px + 16 : Math.max(8, px - 16 - pw);
  panel.style.left = Math.max(8, Math.min(left, sr.width - pw - 8)) + "px";
  panel.style.top = Math.max(8, Math.min(py - 14, sr.height - ph - 8)) + "px";
}

// ---------------------------------------------------------------- the thread card
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e;
}
function chip(a: Anchor | null | undefined, found: boolean, onClick?: () => void): HTMLElement {
  const label = a ? (a.kind === "net" ? `Net ${a.label || a.id}` : a.label || "Item") : "On the sheet";
  const c = el(onClick ? "button" : "span", `cmt-anchor ${a ? a.kind : "spot"}${found ? "" : " gone"}`);
  if (onClick) { (c as HTMLButtonElement).type = "button"; c.addEventListener("click", onClick); }
  c.appendChild(el("i")); c.appendChild(document.createTextNode(label));
  c.title = !a ? "Pinned to a place on the sheet" : !found ? `${label} is no longer on this ${E.DOC_TYPE === "kicad_sch" ? "sheet" : "board"}` : a.kind === "net" ? "Highlight this net" : "Select this item";
  c.dataset.anchor = a ? a.kind : "spot";
  return c;
}
function head(a: Anchor | null | undefined, found: boolean, stateText: string, onChip?: () => void): HTMLElement {
  const h = el("div", "cmt-head");
  h.appendChild(chip(a, found, onChip));
  if (stateText) h.appendChild(el("span", "cmt-state", stateText));
  const x = el("button", "cmt-x", "×"); x.type = "button"; x.title = "Close"; x.id = "closeBtn"; x.addEventListener("click", closeThread);
  h.appendChild(x);
  return h;
}
function submitOnCtrlEnter(ta: HTMLTextAreaElement, go: () => void): void {
  ta.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); go(); } ev.stopPropagation(); });
}
async function call(path: string, method: string, body?: unknown): Promise<boolean> {
  try { await request(path, { method, body: body === undefined ? undefined : JSON.stringify(body) }); return true; }
  catch (e) { toast(`That did not go through: ${(e as Error).message.replace(/^\d+ /, "").slice(0, 120)}`, 4000); return false; }
}

/** Select the part a thread is about, or highlight its net. */
function focusAnchor(c: CommentRow): void {
  const d = kdoc(), a = c.anchor; if (!d || !a) return;
  if (a.kind === "net") {
    const ids = netIds(a);
    if (ids.length) { ownHighlight = new Set(ids); E.highlightIds = ownHighlight; requestRender(); }
    return;
  }
  if (!d.items.has(a.id)) return;
  clearAllSelection(false); selectItemId(a.id); selectionChanged();
}
function dropHighlight(): void {
  if (ownHighlight && E.highlightIds === ownHighlight) { E.highlightIds = null; requestRender(); }
  ownHighlight = null;
}

export function closeThread(): void {
  panel.classList.remove("open"); panel.replaceChildren();
  const had = E.openThread !== null || !!draft;
  E.openThread = null; draft = null; dropHighlight();
  if (had) { drawComments(); store.set({ openThread: null }); }
}

export function showThread(rootId: number, keepPlace = false): void {
  const list = comments(), root = list.find((c) => c.id === rootId);
  if (!root) { closeThread(); return; }
  const was = E.openThread; E.openThread = rootId; draft = null;
  const p = pinOf(root), user = me(), owner = project()?.ownerId, write = canComment();
  const thread = [root, ...list.filter((c) => c.parentId === rootId)];
  panel.replaceChildren();
  panel.dataset.thread = String(rootId);
  panel.appendChild(head(root.anchor, p.found, root.resolved ? "resolved" : "", root.anchor && p.found ? () => { focusAnchor(root); centerOn(p.x, p.y); } : undefined));

  if (root.anchor && !p.found) {
    const what = root.anchor.kind === "net" ? `Net ${root.anchor.label || root.anchor.id}` : root.anchor.label || "The item";
    panel.appendChild(el("div", "cmt-gone", `${what} is no longer on this ${E.DOC_TYPE === "kicad_sch" ? "sheet" : "board"}. The thread stays where it was.`));
  }
  const listEl = el("div", "cmt-list");
  for (const c of thread) {
    const item = el("div", "cmt-item"); item.dataset.comment = String(c.id);
    const meta = el("div", "meta"); meta.appendChild(el("b", "", c.authorLogin)); meta.appendChild(el("span", "", ago(c.createdAt) + (c.editedAt ? " · edited" : "")));
    const body = el("div", "cbody", c.body);
    if (write && user && (c.authorId === user.id || owner === user.id)) {
      const acts = el("span", "acts");
      if (c.authorId === user.id) {
        const edit = el("button", "", "Edit"); edit.type = "button"; edit.dataset.edit = "";
        edit.addEventListener("click", () => {
          const ta = el("textarea", "editing"); ta.value = c.body; ta.rows = 3; ta.dataset.editText = "";
          const row = el("div", "row"), save = el("button", "btn sm primary", "Save"), cancel = el("button", "btn sm", "Cancel");
          save.type = "button"; cancel.type = "button"; save.dataset.editSave = "";
          const done = async () => { const text = ta.value.trim(); if (!text) return; if (text === c.body || (await call(`/api/comments/${c.id}`, "PATCH", { body: text }))) showThread(rootId, true); };
          save.addEventListener("click", () => { void done(); }); cancel.addEventListener("click", () => showThread(rootId, true));
          submitOnCtrlEnter(ta, () => { void done(); });
          row.append(save, cancel); body.replaceWith(ta, row); acts.remove(); ta.focus();
        });
        acts.appendChild(edit);
      }
      const del = el("button", "del", "Delete"); del.type = "button";
      del.addEventListener("click", () => {
        const whole = c.id === rootId && thread.length > 1;
        if (!confirm(whole ? "Delete this thread and its replies?" : "Delete this comment?")) return;
        void call(`/api/comments/${c.id}`, "DELETE");
      });
      acts.appendChild(del); meta.appendChild(acts);
    }
    item.append(meta, body); listEl.appendChild(item);
  }
  panel.appendChild(listEl);

  if (write) {
    const form = el("div", "cmt-form"), ta = el("textarea"); ta.id = "replyText"; ta.rows = 2; ta.placeholder = "Reply…";
    const row = el("div", "row"), reply = el("button", "btn sm primary", "Reply"), resolve = el("button", "btn sm", root.resolved ? "Reopen" : "Resolve");
    reply.type = "button"; reply.id = "replyBtn"; resolve.type = "button"; resolve.id = "resolveBtn";
    const send = async () => { const text = ta.value.trim(); if (!text) return; reply.disabled = true; if (await call(`/api/docs/${root.docId}/comments`, "POST", { body: text, parentId: rootId })) ta.value = ""; reply.disabled = false; };
    reply.addEventListener("click", () => { void send(); }); submitOnCtrlEnter(ta, () => { void send(); });
    resolve.addEventListener("click", () => { void call(`/api/comments/${rootId}`, "PATCH", { resolved: !root.resolved }); });
    row.append(reply, resolve); form.append(ta, row); panel.appendChild(form);
  } else if (!user) {
    const form = el("div", "cmt-form"); form.appendChild(el("span", "hint", "Sign in to reply.")); panel.appendChild(form);
  }
  if (!(keepPlace && was === rootId)) panelAt(p.x, p.y); else panel.classList.add("open");
  listEl.scrollTop = listEl.scrollHeight;
  if (was !== rootId) { dropHighlight(); if (root.anchor && root.anchor.kind === "net") focusAnchor(root); drawComments(); store.set({ openThread: rootId }); }
}

/** Open a thread from the Comments pane: bring its pin into view first. */
export function openThreadAction(id: number): void {
  const c = comments().find((x) => x.id === id);
  if (!c) return;
  const p = pinOf(c);
  centerOn(p.x, p.y); showThread(c.id);
  if (c.anchor && c.anchor.kind === "item") focusAnchor(c);
}

/** A thread on another document of the project: open that document, then the thread. */
export function openThreadOnDoc(targetDoc: string, id: number): void {
  if (targetDoc === docId()) { openThreadAction(id); return; }
  E.pendingThread = id;
  const app = window.CollabApp; if (app) app.dispatch({ type: "openDoc", docId: targetDoc });
}

// ---------------------------------------------------------------- starting a thread
/** The card for a new thread at a place, pinned to `anchor` when there is one. */
export function startThread(mm: Mm, anchor: Anchor | null, body = ""): void {
  if (!canComment()) { toast(me() ? "You can view this project but not comment on it" : "Sign in to comment"); return; }
  closeThread();
  draft = { xNm: Math.round(mm[0] * IU()), yNm: Math.round(mm[1] * IU()), anchor, body };
  const d = draft;
  panel.replaceChildren(); delete panel.dataset.thread;
  panel.appendChild(head(anchor, true, "new"));
  const form = el("div", "cmt-form"), ta = el("textarea"); ta.id = "newText"; ta.rows = 3; ta.value = body;
  ta.placeholder = anchor ? (anchor.kind === "net" ? `Say something about net ${anchor.label}…` : `Say something about ${anchor.label}…`) : "Say something about this spot…";
  const row = el("div", "row"), post = el("button", "btn sm primary", "Post"), cancel = el("button", "btn sm", "Cancel"), hint = el("span", "hint grow", `${keyName("Ctrl+Enter")} posts`);
  post.type = "button"; post.id = "postBtn"; cancel.type = "button"; cancel.id = "cancelBtn";
  const send = async () => {
    const text = ta.value.trim(); if (!text) { ta.focus(); return; }
    post.disabled = true;
    try {
      const made = (await request(`/api/docs/${docId()}/comments`, { method: "POST", body: JSON.stringify({ body: text, x: d.xNm, y: d.yNm, anchor: d.anchor || undefined }) })) as CommentRow;
      closeThread();
      if (made && typeof made.id === "number") { noteCommentMsg({ comment: { action: "added", comment: made } }); showThread(made.id); }
    } catch (e) { post.disabled = false; toast("Couldn't post: " + (e as Error).message.replace(/^\d+ /, "").slice(0, 120), 4000); }
  };
  post.addEventListener("click", () => { void send(); }); cancel.addEventListener("click", closeThread); submitOnCtrlEnter(ta, () => { void send(); });
  row.append(post, cancel, hint); form.append(ta, row); panel.appendChild(form);
  panelAt(mm[0], mm[1]);
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
}

/** What a comment started at `mm` would be pinned to: the part under it, else nothing. */
function anchorAt(mm: Mm): Anchor | null {
  const d = kdoc(); if (!d) return null;
  let id: string | null = null;
  try { id = KiCadCanvas.hitTest(d, mm[0], mm[1], 0.4); } catch { id = null; }
  const it = id ? d.items.get(id) : null;
  return it && PARTS.has(it.kind) ? { kind: "item", id: it.id, label: describe(it) } : null;
}

/** The comment tool: a click on a part pins the thread to it, a click elsewhere to the spot. */
export function placeComment(ev: { clientX: number; clientY: number }): void {
  (setTool as (t: string) => void)("select");
  const mm = (worldMm as (e: { clientX: number; clientY: number }) => Mm)(ev);
  startThread(mm, anchorAt(mm));
}

/** Comment on an item (the right-click menu, the Compare window). */
export function commentOnItem(id: string, mm?: Mm, body = ""): void {
  const d = kdoc(), it = d && d.items.get(id);
  if (!it) { if (mm) startThread(mm, null, body); return; }
  const b = it.bbox, at: Mm = mm || (b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [it.x || 0, it.y || 0]);
  startThread(at, { kind: "item", id: it.id, label: describe(it) }, body);
}
/** Comment on the net of an item (a track, a wire, a pad under `mm`). */
export function commentOnNet(id: string, mm: Mm): void {
  const d = kdoc(), it = d && d.items.get(id); if (!it) return;
  const net = netOfItem(it, mm); if (!net) { toast("That item is not on a net"); return; }
  startThread(mm, { kind: "net", id: net.name, label: netLabel(net.name), item: it.kind === "footprint" ? null : it.id });
}

/** dispatch({ type: "commentOn" }): from the Compare window — an item of the open document, or a place. */
export function commentOnAction(a: { itemId?: string; at?: [number, number]; body?: string }): void {
  const d = kdoc(); if (!d) return;
  const at = a.at ? ([a.at[0], a.at[1]] as Mm) : undefined;
  if (a.itemId && d.items.has(a.itemId)) { const it = d.items.get(a.itemId) as KItem; const b = it.bbox; if (b) centerOn((b[0] + b[2]) / 2, (b[1] + b[3]) / 2); commentOnItem(a.itemId, undefined, a.body || ""); return; }
  if (at) { centerOn(at[0], at[1]); startThread(at, null, a.body || ""); }
}

