// menufit.ts — popup menus stay on screen the way native menus do.
//
// A desktop menu never runs off the screen: a context menu opens at the pointer and flips above / to the left of
// it when there is no room, a drop-down opens under its title (above it when there is more room there), a
// sub-menu opens beside its row and flips to the other side of its parent, and a menu taller than the screen is
// cut to the screen and scrolls, with the arrows macOS (and GTK) put at its ends: hovering one scrolls the menu,
// the wheel scrolls it too.  Every popup list of the web (menu bar, app menu, context menus, toolbar drop-downs,
// k-select lists, the Symbol Editor's and 3D Viewer's menus) is placed with menuPlacement / fitMenu and scrolls
// with menuScroller.

import { IS_MAC } from "./keys";

export interface MenuAnchor {
  /** a context menu: its top-left corner at the pointer */
  at?: { x: number; y: number };
  /** a drop-down: under this rectangle (a menu title, a button, a combo box) */
  below?: DOMRect | { left: number; top: number; right: number; bottom: number };
  /** a sub-menu: beside this row of `parent` */
  row?: DOMRect | { left: number; top: number; right: number; bottom: number };
  parent?: DOMRect | { left: number; top: number; right: number; bottom: number } | null;
  /** a drop-down that may not flip above its anchor (the menu bar: native menus always drop down and scroll) */
  noFlip?: boolean;
  /** horizontal overlap of a sub-menu with its parent, and the gap under a drop-down's anchor */
  overlap?: number; gap?: number;
}

export interface MenuPlacement { left: number; top: number; maxHeight: number }

const MARGIN = 4;

/** The part of the window a menu may use (the layout viewport without scrollbars). */
export function menuViewport(): { w: number; h: number } {
  const de = typeof document !== "undefined" ? document.documentElement : null;
  const w = Math.min(window.innerWidth, (de && de.clientWidth) || window.innerWidth);
  const h = Math.min(window.innerHeight, (de && de.clientHeight) || window.innerHeight);
  return { w, h };
}

/** The menu's natural size: whatever max-height its classes give it, the full height of its rows. */
export function menuSize(el: HTMLElement): { w: number; h: number } {
  const prev = el.style.maxHeight, scrolled = el.scrollTop; el.style.maxHeight = "none";
  const w = el.offsetWidth, h = el.offsetHeight;
  el.style.maxHeight = prev; if (scrolled) el.scrollTop = scrolled;   // measuring uncut puts the scroll back at the top
  return { w, h };
}

/** Where a menu of this size goes for this anchor, and how tall it may be (it scrolls past that). */
export function placeMenu(size: { w: number; h: number }, a: MenuAnchor): MenuPlacement {
  const { w: vw, h: vh } = menuViewport(), m = MARGIN, w = size.w, h = size.h, room = vh - 2 * m;
  const clampX = (x: number) => Math.max(m, Math.min(x, vw - w - m));
  let left: number, top: number, maxHeight: number;
  if (a.row) {
    const p = a.parent || a.row, ov = a.overlap ?? 3;
    left = p.right - ov;
    if (left + w > vw - m) left = p.left - w + ov;                    // flip to the other side of the parent
    if (left < m) left = clampX(p.right - ov);
    top = a.row.top - 5;                                               // the first row level with the parent's row
    if (top + h > vh - m) top = Math.max(m, vh - m - h);               // slide up
    maxHeight = vh - m - top;
  } else if (a.below) {
    const r = a.below, gap = a.gap ?? 2;
    left = clampX(r.left);
    const under = vh - m - (r.bottom + gap), over = r.top - gap - m;
    if (h <= under || a.noFlip || under >= over) { top = r.bottom + gap; maxHeight = Math.max(under, 40); }
    else { maxHeight = over; top = r.top - gap - Math.min(h, over); }
  } else {
    const x = a.at ? a.at.x : m, y = a.at ? a.at.y : m;
    left = x + w <= vw - m ? x : x - w >= m ? x - w : clampX(x);      // flip to the left of the pointer
    if (y + h <= vh - m) top = y;
    else if (y - h >= m) top = y - h;                                   // flip above the pointer
    else top = Math.max(m, vh - m - h);                                 // slide up; taller than the window: scroll
    maxHeight = vh - m - top;
  }
  return { left: Math.round(left), top: Math.round(top), maxHeight: Math.max(Math.floor(Math.min(maxHeight, room)), 24) };
}

/** Place a plain-DOM menu (position: fixed) and give it the scroll arrows when it is cut. */
export function fitMenu(el: HTMLElement, a: MenuAnchor): MenuPlacement {
  const p = placeMenu(menuSize(el), a);
  el.style.position = "fixed"; el.style.left = p.left + "px"; el.style.top = p.top + "px"; el.style.maxHeight = p.maxHeight + "px";
  el.style.overflowY = "auto";
  menuScroller(el);
  return p;
}

// ---------------------------------------------------------------- the scroll arrows
const ARROW = 16;          // px: the arrow strips, as tall as macOS's
const SPEED = 0.5;         // px per ms while the pointer rests on an arrow
interface Scroller { up: HTMLDivElement; down: HTMLDivElement; dir: -1 | 0 | 1; last: number; raf: number }
const SCROLLERS = new WeakMap<HTMLElement, Scroller>();

function arrow(dir: "up" | "down"): HTMLDivElement {
  const d = document.createElement("div");
  d.className = "kmenu-arrow " + dir; d.setAttribute("aria-hidden", "true"); d.dataset.menuArrow = dir;
  d.innerHTML = dir === "up" ? '<svg viewBox="0 0 10 6" width="10" height="6"><path d="M1 5.5L5 1.5l4 4" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 10 6" width="10" height="6"><path d="M1 .5l4 4 4-4" fill="currentColor"/></svg>';
  return d;
}

/**
 * The arrows of a menu cut to the window: a strip at the top while rows are hidden above, one at the bottom
 * while rows are hidden below; resting the pointer on a strip scrolls the menu.  The strips sit over the menu
 * (in the body, so neither React nor the menu's own code sees them) and go away with it.  Idempotent.
 */
export function menuScroller(el: HTMLElement, opts: { combo?: boolean } = {}): void {
  if (typeof document === "undefined") return;
  // A combo box's list (wxChoice, wxComboBox, wxBitmapComboBox) is a menu only on a Mac (an NSPopUpButton's
  // NSMenu, with the arrows); on Windows and GTK it is a list box with a scroll bar, which it keeps.
  if (opts.combo && !IS_MAC) return;
  // cut now, not on the first frame: a scrollIntoView right after this already keeps clear of the arrows
  el.classList.toggle("kmenu-cut", el.scrollHeight > el.clientHeight + 1);
  if (SCROLLERS.has(el)) return;
  el.classList.add("kmenu-scrolls");
  const s: Scroller = { up: arrow("up"), down: arrow("down"), dir: 0, last: 0, raf: 0 };
  SCROLLERS.set(el, s);
  document.body.append(s.up, s.down);
  const z = () => { let n: Element | null = el, best = 0; while (n && n !== document.body) { const v = parseInt(getComputedStyle(n).zIndex, 10); if (v > best) best = v; n = n.parentElement; } return best + 1; };
  const zi = String(Math.max(z(), 50));
  s.up.style.zIndex = zi; s.down.style.zIndex = zi;
  const onMove = (ev: PointerEvent) => {
    const r = el.getBoundingClientRect();
    s.dir = s.up.classList.contains("on") && ev.clientY < r.top + ARROW + 1 ? -1 : s.down.classList.contains("on") && ev.clientY > r.bottom - ARROW - 1 ? 1 : 0;
  };
  const onLeave = () => { s.dir = 0; };
  // a click on an arrow scrolls, it does not pick the row under it
  const onClick = (ev: MouseEvent) => { onMove(ev as PointerEvent); if (s.dir) { ev.preventDefault(); ev.stopPropagation(); } };
  el.addEventListener("pointermove", onMove); el.addEventListener("pointerleave", onLeave); el.addEventListener("click", onClick, true);
  const tick = (t: number) => {
    if (!el.isConnected) { s.up.remove(); s.down.remove(); el.removeEventListener("pointermove", onMove); el.removeEventListener("pointerleave", onLeave); el.removeEventListener("click", onClick, true); SCROLLERS.delete(el); return; }
    const dt = s.last ? Math.min(50, t - s.last) : 16; s.last = t;
    if (s.dir) el.scrollTop += s.dir * SPEED * dt;
    const r = el.getBoundingClientRect(), cut = el.scrollHeight > el.clientHeight + 1, shown = r.width > 0 && getComputedStyle(el).visibility !== "hidden";
    const above = shown && cut && el.scrollTop > 0.5, below = shown && cut && el.scrollTop + el.clientHeight < el.scrollHeight - 0.5;
    if (!above && s.dir < 0) s.dir = 0;
    if (!below && s.dir > 0) s.dir = 0;
    s.up.classList.toggle("on", above); s.down.classList.toggle("on", below);
    el.classList.toggle("kmenu-cut", cut);
    if (shown) {
      const bl = el.clientLeft, inner = el.clientWidth;
      for (const [a, y] of [[s.up, r.top + el.clientTop], [s.down, r.top + el.clientTop + el.clientHeight - ARROW]] as const) {
        a.style.left = r.left + bl + "px"; a.style.top = y + "px"; a.style.width = inner + "px"; a.style.height = ARROW + "px";
      }
    }
    s.raf = requestAnimationFrame(tick);
  };
  s.raf = requestAnimationFrame(tick);
}

/**
 * How far a row must stay from the top and the bottom of a menu's visible part to be seen: the arrow strips cover
 * that much of a menu cut by menuScroller (theme.css gives .kmenu-cut the same scroll-padding).  0 elsewhere.
 */
export function menuArrowPad(el: HTMLElement): number {
  return SCROLLERS.has(el) && el.scrollHeight > el.clientHeight + 1 ? ARROW + 2 : 0;
}
