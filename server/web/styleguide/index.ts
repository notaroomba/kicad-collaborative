// The style guide page (/styleguide, static/styleguide.html).  It only reads the theme: each
// swatch shows the value its token has right now, and the switch sets the same `kui.theme`
// the editor and the home page use, so the guide is always a picture of the live theme.

type Mode = "system" | "light" | "dark";

function stored(): Mode {
  try { const t = localStorage.getItem("kui.theme"); return t === "dark" || t === "light" ? t : "system"; } catch (e) { return "system"; }
}

function apply(mode: Mode): void {
  const root = document.documentElement;
  if (mode === "system") delete root.dataset.theme; else root.dataset.theme = mode;
  try { if (mode === "system") localStorage.removeItem("kui.theme"); else localStorage.setItem("kui.theme", mode); } catch (e) { /* no storage */ }
  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => {
    const on = b.dataset.mode === mode; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
  });
  values();
}

/** Write each token's current value under its swatch. */
function values(): void {
  const cs = getComputedStyle(document.documentElement);
  document.querySelectorAll<HTMLElement>("[data-token]").forEach((el) => {
    const out = el.querySelector<HTMLElement>(".val"); if (!out) return;
    const v = cs.getPropertyValue(el.dataset.token || "").trim();
    out.textContent = /^#[0-9a-f]{3,8}$/i.test(v) ? v.toUpperCase() : "mixed from --blue";
  });
}

document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => b.addEventListener("click", () => apply(b.dataset.mode as Mode)));
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", values);
apply(stored());
