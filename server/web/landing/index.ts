// The public home page (static/landing.html).  Built by `npm run build:landing` into
// static/dist/landing.js.

import { startHero } from "./hero";
import { startStory } from "./story";

function theme(): void {
  const btn = document.getElementById("theme");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const root = document.documentElement;
    const cur = root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    // The same key the editor reads, so the choice carries over after sign-in.
    try { localStorage.setItem("kui.theme", next); } catch (e) { /* no storage */ }
  });
}

function nav(): void {
  const el = document.getElementById("nav");
  if (!el) return;
  const set = () => el.classList.toggle("stuck", window.scrollY > 8);
  window.addEventListener("scroll", set, { passive: true });
  set();
}

function reveals(): void {
  const els = Array.from(document.querySelectorAll<HTMLElement>(".rv"));
  if (!("IntersectionObserver" in window)) { els.forEach((e) => e.classList.add("in")); return; }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
  els.forEach((e) => io.observe(e));
}

/** The feature list: picking a row shows its screenshot. */
function bom(): void {
  const rows = Array.from(document.querySelectorAll<HTMLButtonElement>(".bom-r"));
  const shots = Array.from(document.querySelectorAll<HTMLImageElement>("#bomShots img"));
  const cap = document.getElementById("bomCap");
  const load = (img: HTMLImageElement) => { if (img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src; } };
  const pick = (row: HTMLButtonElement) => {
    rows.forEach((r) => r.setAttribute("aria-selected", String(r === row)));
    for (const img of shots) { const on = img.dataset.shot === row.dataset.shot; if (on) load(img); img.classList.toggle("on", on); }
    if (cap) cap.textContent = `${row.querySelector(".ref")!.textContent} / ${row.querySelector("b")!.textContent}`;
  };
  rows.forEach((row, i) => {
    row.addEventListener("click", () => pick(row));
    row.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const next = rows[(i + d + rows.length) % rows.length];
      next.focus(); pick(next);
    });
  });
  // Fetch the rest once the list is near, so a click never waits on the network.
  const host = document.getElementById("bomShots");
  if (host && "IntersectionObserver" in window) {
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { shots.forEach(load); io.disconnect(); } }, { rootMargin: "600px" });
    io.observe(host);
  }
}

/** Someone already signed in who opens this page gets a way back to their projects.  The
 *  server marks the document, so there is no request to make. */
function session(): void {
  if (!document.documentElement.dataset.me) return;
  document.querySelectorAll<HTMLAnchorElement>("[data-signin]").forEach((a) => {
    a.href = "/";
    const label = a.dataset.long !== undefined ? "Open your projects" : "Projects";
    const span = a.querySelector("span");
    if (span) span.textContent = label; else a.textContent = label;
    a.querySelector("svg")?.remove();
  });
}

function start(): void {
  theme(); nav(); reveals(); bom();
  const hero = document.getElementById("hero"), story = document.getElementById("make");
  if (hero) startHero(hero);
  if (story) startStory(story);
  session();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
