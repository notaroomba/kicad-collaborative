// hotkey-popup.ts — KiCad's HOTKEY_CYCLE_POPUP (common/dialogs/hotkey_cycle_popup.cpp): the small list a
// cycling hotkey (H for the inactive layer mode) flashes over the canvas, with the new choice selected.
// It hides itself after SHOW_TIME_MS; pressing the hotkey again while it shows restarts the timer.
const SHOW_TIME_MS = 1000;
let box: HTMLDivElement | null = null, timer: ReturnType<typeof setTimeout> | null = null;

export function hotkeyCyclePopup(title: string, items: string[], selection: number): void {
  if (typeof document === "undefined") return;
  if (!box) {
    box = document.createElement("div");
    box.className = "khotkey-cycle";
    // editor modules are not scanned by tailwind: the theme tokens of static/theme.css directly
    box.style.cssText = "position:fixed;z-index:450;padding:6px 8px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-2);" +
      "box-shadow:var(--shadow);font:var(--fs-sm)/1.4 var(--font);color:var(--ink);pointer-events:none;min-width:120px";
    box.setAttribute("role", "status");
    document.body.appendChild(box);
  }
  const head = document.createElement("div"); head.style.cssText = "font-weight:600;margin-bottom:4px"; head.textContent = title;
  const list = document.createElement("div");
  items.forEach((label, i) => {
    const row = document.createElement("div"); row.textContent = label; row.dataset.cycleItem = String(i);
    const on = i === Math.min(selection, items.length - 1);
    row.style.cssText = "padding:1px 6px;border-radius:var(--r-1);" + (on ? "background:var(--sel);color:var(--ink)" : "color:var(--ink-2)");
    if (on) row.setAttribute("aria-current", "true");
    list.appendChild(row);
  });
  box.replaceChildren(head, list);
  // centred over the drawing canvas (HOTKEY_CYCLE_POPUP is centred on the parent frame's canvas)
  const host = document.getElementById("stage") || document.getElementById("canvas"), r = host ? host.getBoundingClientRect() : null;
  box.style.visibility = "hidden"; box.style.display = "block";
  const w = box.offsetWidth, h = box.offsetHeight;
  const cx = r ? r.left + r.width / 2 : window.innerWidth / 2, cy = r ? r.top + r.height / 2 : window.innerHeight / 2;
  box.style.left = Math.round(cx - w / 2) + "px"; box.style.top = Math.round(cy - h / 2) + "px"; box.style.visibility = "visible";
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { if (box) box.style.display = "none"; timer = null; }, SHOW_TIME_MS);
}
