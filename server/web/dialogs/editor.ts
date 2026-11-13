// dialogs/editor.ts — the typed face of the editor modules the dialogs use (web/editor/*.ts are still untyped).
import * as appstore from "../editor/appstore";
import * as comments from "../editor/comments";
import * as doc from "../editor/doc";
import * as net from "../editor/net";
import * as state from "../editor/state";
import * as tools from "../editor/tools";
import * as util from "../editor/util";
import * as view from "../editor/view";
import type { GridDef } from "../units";

export interface DialogCtx extends ToolCtx { setSelection(ids: Iterable<string>): void; setMarkers?(list: unknown[]): void }
export interface UndoEntry { label: string; changes: unknown[]; inverse: unknown[]; undoOthers?: () => void; redoOthers?: () => void }
/** The editor's mutable state (web/editor/state.ts); the fields the dialogs read and set. */
export interface EditorState {
  kdoc: (KDoc & { schSettings?: { junctionDiameter: number }; paper?: string; portrait?: boolean; titleBlock?: Record<string, string>; sheetCount?: number; pageNumber?: string }) | null;
  viewOnly: boolean; DOC_TYPE: string; units: string; tool: string; zoom: number; viewTouched: boolean; gridPitch: number; proSettings: string | null; druText: string | null;
  selection: Set<string>; selected: { id: string } | null; drag: { fp?: { id: string } } | null; fdrag: unknown; renderOpts: Record<string, unknown>;
  zoomStep?: number; middleDragPan?: boolean; rightDragPan?: boolean; gridFor?: () => number; gridDefault?: () => number; gridPicked?: (mm: number) => void; lastImperial?: string; dialogs?: unknown;
}
export const E = state.E as EditorState;
export const toolCtx = tools.toolCtx as unknown as (extra?: Record<string, unknown>) => DialogCtx;
export const undoStack = tools.undoStack as unknown as UndoEntry[];
export const redoStack = tools.redoStack as unknown as UndoEntry[];
export const publishUndo = tools.publishUndo as () => void;
export const pushUndoFor = tools.pushUndoFor as unknown as (docId: string, entry: UndoEntry) => void;
export const applyChanges = doc.applyChanges as unknown as (changes: unknown[]) => void;
export const sendOp = net.sendOp as unknown as (changes: unknown[], transient?: boolean) => void;
export const toast = util.toast as unknown as (msg: string, ms?: number) => void;
export const api = util.api as unknown as (path: string, opts?: RequestInit) => Promise<unknown>;
export const isSch = view.isSch as () => boolean;
export const requestRender = view.requestRender as () => void;
export const applyView = view.applyView as () => void;
export const centerOn = comments.centerOn as (xMm: number, yMm: number) => void;
export const openDocId = doc.openDocId as (id: string) => void;
/** The project's root schematic (the .kicad_sch named after the .kicad_pro, else the shallowest). */
export const rootSchematic = doc.rootSchematic as unknown as () => DocEntry | undefined;
export const updateGridStatus = doc.updateGridStatus as () => void;
export const applySheetContext = doc.applySheetContext as unknown as (d: KDoc) => void;
export const GRID_CHOICES = doc.GRID_CHOICES as unknown as Record<string, GridDef[]>;
export const setToggle = appstore.setToggle as unknown as (id: string, on: boolean) => void;
export const setToggles = appstore.setToggles as unknown as (map: Record<string, boolean>) => void;
export const setStatusBar = appstore.setStatusBar as unknown as (f: { message?: string; mode?: string }) => void;
interface Store { get(): { view: string }; slice(key: string, patch: Record<string, unknown>): void; subscribe(fn: () => void): () => void }
export const store = appstore.store as unknown as Store;
export interface DocEntry { docId: string; path: string; docType: string }
export const appState = appstore.state as unknown as { project: { projectId: string; name: string; docs: DocEntry[] } | null; docs: DocEntry[]; docId: string | null };
export const cloneNode = (n: SNode): SNode => (KiCadCanvas.cloneNode as (n: SNode) => SNode)(n);
