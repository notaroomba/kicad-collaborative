// review/store.ts — whether the Compare window is open and what it was asked to show.  The editor core
// (another bundle) opens it through a window event, anything in the chrome through openCompare().
import type { VersionRef } from "./sources";

export interface CompareRequest {
  /** the older side; the newest saved version when left out */
  a?: VersionRef;
  /** the newer side; the document as it is now when left out */
  b?: VersionRef;
  /** the document to compare; the open one when left out */
  docId?: string;
  /** open the file chooser for the older side at once (File ▸ Compare … with File) */
  pickFile?: boolean;
}
export interface ReviewState { open: boolean; request: CompareRequest; /** bumped on every open, so the window starts afresh */ n: number }

let S: ReviewState = { open: false, request: {}, n: 0 };
const subs = new Set<() => void>();
export const reviewStore = {
  get: (): ReviewState => S,
  subscribe(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn); }; },
};
function set(next: ReviewState): void { S = next; for (const fn of Array.from(subs)) fn(); }

export function openCompare(request: CompareRequest = {}): void { set({ open: true, request, n: S.n + 1 }); }
export function closeCompare(): void { if (S.open) set({ open: false, request: {}, n: S.n }); }

/** The event the editor core raises for dispatch({ type: "compare" }) and the File menu entries. */
export const COMPARE_EVENT = "kc-compare";

declare global {
  interface Window { CollabReview?: { openCompare(request?: CompareRequest): void; closeCompare(): void } }
}
/** Whether the page was opened by a link that asks for the window (?compare=1).  Read when the page
 *  loads: the editor rewrites the address once a document is open. */
let linkAsked = false;
export function takeLinkRequest(): boolean { const asked = linkAsked; linkAsked = false; return asked; }

export function installReview(): void {
  try { linkAsked = !!new URLSearchParams(location.search).get("compare"); } catch { linkAsked = false; }
  window.CollabReview = { openCompare, closeCompare };
  window.addEventListener(COMPARE_EVENT, (ev) => openCompare(((ev as CustomEvent).detail || {}) as CompareRequest));
}
