// A canvas that tracks its element's size and the device pixel ratio, and only asks for frames
// while it is on screen.

export interface Stage {
  ctx: CanvasRenderingContext2D;
  w: number; h: number; dpr: number;
  visible: boolean;
  /** Ask for a redraw on the next frame. */
  invalidate(): void;
}

export const reducedMotion = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** `draw(stage, now, dt)` returns true to keep animating. */
export function makeStage(canvas: HTMLCanvasElement, draw: (s: Stage, now: number, dt: number) => boolean): Stage {
  const ctx = canvas.getContext("2d")!;
  let raf = 0, last = 0;
  const s: Stage = {
    ctx, w: 0, h: 0, dpr: 1, visible: false,
    invalidate() { if (!raf && s.visible) raf = requestAnimationFrame(frame); },
  };
  function resize(): void {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (w === s.w && h === s.h && dpr === s.dpr) return;
    s.w = w; s.h = h; s.dpr = dpr;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    // Paint at once: a resized canvas is blank until the next frame otherwise.
    if (s.visible) { if (raf) cancelAnimationFrame(raf); raf = 0; frame(performance.now()); }
  }
  function frame(now: number): void {
    raf = 0;
    if (!s.w) return;
    const dt = last ? Math.min(64, now - last) : 16;
    last = now;
    const more = draw(s, now, dt);
    if (more && s.visible) raf = requestAnimationFrame(frame); else last = 0;
  }
  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver((es) => {
    s.visible = es[es.length - 1].isIntersecting;
    if (s.visible) { resize(); s.invalidate(); }
  }, { rootMargin: "80px" }).observe(canvas);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) s.invalidate(); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => s.invalidate());
  return s;
}

export const MONO = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
export const SANS = '"IBM Plex Sans", -apple-system, "Segoe UI", system-ui, sans-serif';
