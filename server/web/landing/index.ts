// The public home page (static/landing.html).  Built by `npm run build:landing` into
// static/dist/landing.js.

import { startLettering } from "./lettering";
import { startMini } from "./mini";
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

/** The hero window starts leaning back and straightens as it scrolls up into view. */
function lean(): void {
  const win = document.getElementById("hero");
  if (!win || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let raf = 0;
  const set = () => {
    raf = 0;
    const r = win.getBoundingClientRect(), vh = window.innerHeight;
    // 1 while its top edge is low in the viewport, 0 once the top is a third of the way up.
    const k = Math.max(0, Math.min(1, (r.top - vh * 0.3) / (vh * 0.45)));
    win.style.setProperty("--lean", k.toFixed(3));
  };
  window.addEventListener("scroll", () => { if (!raf) raf = requestAnimationFrame(set); }, { passive: true });
  window.addEventListener("resize", set);
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

/** Someone already signed in who opens this page gets a way back to their projects.  The
 *  server marks the document, so there is no request to make. */
function session(): void {
  if (!document.documentElement.dataset.me) return;
  document.querySelectorAll<HTMLAnchorElement>("[data-template]").forEach((a) => { a.href = "/?new=template"; });
  document.querySelectorAll<HTMLAnchorElement>("[data-signin]").forEach((a) => {
    a.href = "/";
    const label = a.dataset.long !== undefined ? "Open your projects" : "Projects";
    const span = a.querySelector("span");
    if (span) span.textContent = label; else a.textContent = label;
    a.querySelector("svg")?.remove();
  });
}

function start(): void {
  theme(); nav(); lean(); reveals();
  const hero = document.getElementById("hero"), story = document.getElementById("make");
  startLettering();
  if (hero) startMini(hero);
  if (story) startStory(story);
  session();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
