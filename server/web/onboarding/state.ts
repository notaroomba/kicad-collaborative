// state.ts — the guided first project: which project it is, how far the person got, and the
// start of one (from the projects home, or carrying on from the home page's small editor).
//
// The guide belongs to one project and one browser: its state is a small record in localStorage,
// so closing the tab and coming back picks up at the same step.  Nothing here touches the design.
import { createFromTemplate } from "../home/api";

export type StepId = "schematic" | "board" | "route" | "check" | "share";
export const STEPS: StepId[] = ["schematic", "board", "route", "check", "share"];

export interface GuideState {
  projectId: string;
  /** where it was started: the projects home, or the small editor on the home page */
  from: "home" | "mini";
  /** steps finished or skipped */
  done: Partial<Record<StepId, "done" | "skipped">>;
  /** the panel is folded down to its title */
  folded?: boolean;
  /** the person closed it, or finished and said so */
  closed?: boolean;
}

const KEY = "kc.guide";
/** Where the home page's small editor leaves the board its visitor was routing (web/landing/mini.ts). */
export const MINI_KEY = "kc.onboard.mini";
/** The template the guided project is made from. */
export const GUIDED_TEMPLATE = "blinker";

const listeners = new Set<() => void>();
let current: GuideState | null | undefined;

function read(): GuideState | null {
  try {
    const raw = localStorage.getItem(KEY); if (!raw) return null;
    const g = JSON.parse(raw) as GuideState;
    return g && typeof g.projectId === "string" && g.done && typeof g.done === "object" ? g : null;
  } catch { return null; }
}
export function getGuide(): GuideState | null { if (current === undefined) current = read(); return current; }
export function setGuide(next: GuideState | null): void {
  current = next;
  try { if (next) localStorage.setItem(KEY, JSON.stringify(next)); else localStorage.removeItem(KEY); } catch { /* private mode: the guide lasts for this page */ }
  listeners.forEach((fn) => fn());
}
export function patchGuide(patch: Partial<GuideState>): void { const g = getGuide(); if (g) setGuide({ ...g, ...patch }); }
export function markStep(id: StepId, how: "done" | "skipped" = "done"): void {
  const g = getGuide(); if (!g || g.done[id] === "done" || (g.done[id] && how === "skipped")) return;
  setGuide({ ...g, done: { ...g.done, [id]: how } });
}
export function subscribeGuide(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
// Another tab finishing a step, or starting a new guide, shows here too.
if (typeof window !== "undefined") window.addEventListener("storage", (ev) => { if (ev.key === KEY) { current = read(); listeners.forEach((fn) => fn()); } });

export const nextStep = (g: GuideState): StepId | null => STEPS.find((s) => !g.done[s]) || null;
export const stepsDone = (g: GuideState): number => STEPS.filter((s) => g.done[s]).length;

/** The board left by the home page's small editor, if there is one and it is recent enough to still be wanted. */
export function miniBoard(): string | null {
  try {
    const raw = localStorage.getItem(MINI_KEY); if (!raw) return null;
    const j = JSON.parse(raw) as { board?: string; at?: number };
    if (!j || typeof j.board !== "string" || !j.board.startsWith("(kicad_pcb")) return null;
    if (typeof j.at === "number" && Date.now() - j.at > 24 * 3600 * 1000) return null;
    return j.board;
  } catch { return null; }
}
export function clearMiniBoard(): void { try { localStorage.removeItem(MINI_KEY); } catch { /* nothing kept */ } }

/**
 * Make the guided project and remember it.  From the home page it starts with the visitor's own
 * board; otherwise with the blinker and four connections left to route.
 */
export async function startGuidedProject(from: "home" | "mini"): Promise<{ projectId: string; name: string }> {
  const board = from === "mini" ? miniBoard() : null;
  const r = await createFromTemplate({ template: GUIDED_TEMPLATE, name: "My first board", guided: !board, board: board || undefined });
  if (board) clearMiniBoard();
  setGuide({ projectId: r.projectId, from: board ? "mini" : "home", done: {} });
  return { projectId: r.projectId, name: r.name };
}
