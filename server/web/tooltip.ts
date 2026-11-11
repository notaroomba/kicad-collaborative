// tooltip.ts — the toolbars' tooltips, after wxWidgets: "Label (Hotkey)" plus the action's description, shown
// once the pointer has rested on a button for the platform tooltip delay (500 ms), and at once while moving
// along the same toolbar (wx's reshow).  The text is the button's own title (web/actions.ts titleFor); it is
// lifted off while the tip shows so the browser does not draw its own, and put back afterwards.

const DELAY = 500, RESHOW = 100, AFTER = 600;
const ROOTS = "#ui-tbTop, #ui-tbAux, #ui-tbLeft, #ui-tbRight";

let tip: HTMLDivElement | null = null;
let target: HTMLElement | null = null;
let timer = 0, lastHide = 0;

function element(): HTMLDivElement {
  if (!tip) {
    tip = document.createElement("div"); tip.className = "ktip"; tip.setAttribute("role", "tooltip");
    document.body.appendChild(tip);
  }
  return tip;
}

function restore(): void {
  if (target && target.dataset.tip !== undefined) {
    if (!target.hasAttribute("title")) target.setAttribute("title", target.dataset.tip);
    delete target.dataset.tip;
  }
}

function hide(): void {
  if (timer) { clearTimeout(timer); timer = 0; }
  if (tip && tip.classList.contains("on")) { tip.classList.remove("on"); lastHide = performance.now(); }
  restore(); target = null;
}

function show(el: HTMLElement): void {
  timer = 0;
  if (!el.isConnected || target !== el) return;
  const text = el.dataset.tip || ""; if (!text) return;
  const t = element(); t.textContent = text; t.classList.add("on");
  const r = el.getBoundingClientRect(), w = t.offsetWidth, h = t.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
  // below the button, or beside it for the vertical toolbars; kept inside the window
  const side = !!el.closest("#ui-tbLeft, #ui-tbRight");
  let x = side ? (el.closest("#ui-tbRight") ? r.left - w - 6 : r.right + 6) : r.left + r.width / 2 - w / 2;
  let y = side ? r.top + r.height / 2 - h / 2 : r.bottom + 6;
  x = Math.max(4, Math.min(vw - w - 4, x)); y = Math.max(4, Math.min(vh - h - 4, y));
  t.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

export function installToolbarTooltips(): void {
  document.addEventListener("pointerover", (ev) => {
    if (ev.pointerType === "touch") return;
    const el = (ev.target as Element | null)?.closest?.("[title], [data-tip]") as HTMLElement | null;
    if (!el || !el.closest(ROOTS)) { if (target) hide(); return; }
    if (el === target) return;
    const quick = !!(tip && tip.classList.contains("on")) || performance.now() - lastHide < AFTER;
    hide();
    const text = el.getAttribute("title"); if (!text) return;
    target = el; el.dataset.tip = text; el.removeAttribute("title");
    timer = window.setTimeout(() => show(el), quick ? RESHOW : DELAY);
  }, true);
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("keydown", hide, true);
  window.addEventListener("blur", hide);
  document.addEventListener("pointerleave", hide);
}
