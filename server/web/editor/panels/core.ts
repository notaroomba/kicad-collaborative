// panels/core.ts — the panel models' own observable store (window.CollabPanels reads it) and the
// small helpers the models share: local storage, the KiCad-style text-entry / list dialogs and the
// pieces of editor state they read.  See web/panels-api.ts for the contract with the React panes.
import type { AppearanceState, PanelsState } from "../../panels-api";
import { state } from "../appstore";
import { E } from "../state";
import { toolCtx } from "../tools";
import "../../components/kselect";   // <k-select>, the themed drop-down these use in place of <select>

const EMPTY_APPEARANCE: AppearanceState = {
  layers: [], active: "", objects: [], nets: [], netClasses: [], inactive: "normal", flip: false, netColorMode: "ratsnest", ratsnestMode: "all",
  presets: [], builtinPresets: [], preset: null, viewports: [], viewport: null,
};

let S: PanelsState = { appearance: EMPTY_APPEARANCE, hierarchy: { root: null, version: 0 }, netNav: { root: null, version: 0 }, selVersion: 0 };
const subs = new Set<() => void>();

export const panelStore = {
  get: (): PanelsState => S,
  set(patch: Partial<PanelsState>): void { S = Object.assign({}, S, patch); for (const fn of Array.from(subs)) { try { fn(); } catch (e) { console.warn(e); } } },
  subscribe(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn); }; },
};

// ---------------------------------------------------------------- storage
export function loadJson<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); if (v) { const j = JSON.parse(v) as T; if (j && typeof j === "object") return j; } } catch (e) { /* no storage / bad json */ }
  return fallback;
}
export function saveJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* no storage */ }
}

// ---------------------------------------------------------------- editor state the models read
export interface DocEntryLite { docId: string; path: string; docType: string }
export const projectId = (): string => (state.project && (state.project as { projectId: string }).projectId) || "";
export const projectName = (): string => (state.project && (state.project as { name: string }).name) || "";
export const openDocs = (): DocEntryLite[] => ((state as { docs?: DocEntryLite[] }).docs || []);
export const currentDocId = (): string | null => (state as { docId?: string | null }).docId || null;
export const kdoc = (): KDoc | null => (E.kdoc as KDoc | null) || null;
export const isSchDoc = (): boolean => E.DOC_TYPE === "kicad_sch";

/** The pcb tool module's helper table (window.PcbTools): connectivity, nets, the module's own selection. */
export interface PcbToolsLite {
  state: { sel: Set<string>; showRatsnest: boolean; hiddenNets: Set<string>; ratsnestColors?: Map<string, string> | null; hiddenSeverities?: Set<string> | null; highlightNet?: string | null };
  boardNets(doc: KDoc): { name: string; code: number }[];
  netItemIds(doc: KDoc, key: string): Set<string>;
  isLocked(node: SNode): boolean;
  setLocked(node: SNode, on: boolean): SNode;
  /** the one tuning pattern a selection is (its generator with only its own members beside it) */
  selectedTuningPattern?(ctx: unknown, ids?: Iterable<string>): KItem | null;
  /** PCB_TUNING_PATTERN EditStart / Update / EditFinish with an edited generator node (and member edits): one commit */
  editTuningPattern?(ctx: unknown, gen: KItem, node: SNode, memberEdit?: ((n: SNode) => boolean | void) | null): boolean;
}
export function pcbTools(): PcbToolsLite | null { return ((window as unknown as { PcbTools?: PcbToolsLite }).PcbTools) || null; }

/** The canvas library's helpers the panel models use beyond the ambient KiCadCanvasApi. */
export interface CanvasExtras {
  cloneNode(n: SNode): SNode; pcbColor(layer: string): string;
  bboxOf(doc: KDoc, ids: Iterable<string>): [number, number, number, number] | null;
}
export const KC = (): KiCadCanvasApi & CanvasExtras => window.KiCadCanvas as KiCadCanvasApi & CanvasExtras;

// ---------------------------------------------------------------- dialogs (wxTextEntryDialog / EDA_LIST_DIALOG)
function esc(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

/** KiCad's wxTextEntryDialog: a caption, one message line and a text field; resolves null on Cancel. */
export function textEntry(title: string, message: string, value: string): Promise<string | null> {
  return new Promise((resolve) => {
    const D = window.KDialogs;
    if (!D) { resolve(window.prompt(message, value)); return; }
    let done = false; const finish = (v: string | null) => { if (!done) { done = true; resolve(v); } };
    D.open({ title, width: 360,
      build(body: HTMLElement) { body.innerHTML = `<p style="margin:0 0 8px">${esc(message)}</p><input id="kd-entry" type="text" value="${esc(value)}" style="width:100%">`; },
      ok() { const inp = document.querySelector<HTMLInputElement>("#kd-entry"); finish(inp ? inp.value : null); },
      cancel() { finish(null); } });
  });
}

/** KiCad's EDA_LIST_DIALOG with one column: pick a row, OK; resolves null on Cancel. */
export function listPick(title: string, label: string, header: string, items: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const D = window.KDialogs;
    if (!D) { resolve(null); return; }
    let done = false; const finish = (v: string | null) => { if (!done) { done = true; resolve(v); } };
    D.open({ title, width: 360,
      build(body: HTMLElement) {
        body.innerHTML = `<p style="margin:0 0 8px">${esc(label)}</p><k-select id="kd-list" size="${Math.max(4, Math.min(10, items.length + 1))}" style="width:100%">
          <optgroup label="${esc(header)}">${items.map((n, i) => `<option${i === 0 ? " selected" : ""}>${esc(n)}</option>`).join("")}</optgroup></k-select>`;
      },
      ok() { const sel = document.querySelector<HTMLSelectElement>("#kd-list"); finish(sel && sel.value ? sel.value : null); },
      cancel() { finish(null); } });
  });
}

// ---------------------------------------------------------------- the tools' context (commit, selection, highlight)
export interface ToolCtxLite { commit(changes: unknown[], label: string): void; setHighlight(ids: Set<string> | null): void; setSelection(ids: Iterable<string>): void }
export const tctx = (): ToolCtxLite => (toolCtx as unknown as (extra?: unknown) => ToolCtxLite)();
