// autopan.ts — WX_VIEW_CONTROLS auto-panning (common/view/wx_view_controls.cpp handleAutoPanning / onTimer):
// while a tool drags with auto-pan on, a cursor within m_autoPanMargin (2 %) of the shorter canvas side of an edge
// — or past it — pans the view toward that edge on every timer tick (250 / 60 ms).  The pan per tick is the
// cursor's distance into the border, raised to the border size beyond half of it and to border × (0.5 +
// acceleration / 5) once it reaches the full border.

/** VIEW_CONTROLS defaults (view_controls.cpp:65-67). */
export const AUTOPAN_MARGIN = 0.02, AUTOPAN_ACCELERATION = 5, AUTOPAN_TICK_MS = 250 / 60;

/** handleAutoPanning's m_panDirection: the cursor's distance (px) past the border on each axis; [0, 0] outside the border. */
export function autoPanDirection(x: number, y: number, w: number, h: number, margin = AUTOPAN_MARGIN): [number, number] {
  const border = Math.max(Math.floor(Math.min(margin * w, margin * h)), 2);
  const ex = w - border, ey = h - border;
  const dx = x < border ? -(border - x) : x > ex ? x - ex : 0;
  const dy = y < border ? -(border - y) : y > ey ? y - ey : 0;
  return [dx + 0, dy + 0];
}

/** onTimer's AUTO_PANNING step: how far (screen px) the view centre moves on one tick for a cursor at (x, y) on a w × h canvas. */
export function autoPanStep(x: number, y: number, w: number, h: number, acceleration = AUTOPAN_ACCELERATION, margin = AUTOPAN_MARGIN): [number, number] {
  let [dx, dy] = autoPanDirection(x, y, w, h, margin);
  const n = Math.hypot(dx, dy); if (!n) return [0, 0];
  const border = Math.min(margin * w, margin * h), accel = 0.5 + acceleration / 5;
  const resize = (len: number) => { dx = dx / n * len; dy = dy / n * len; };
  if (n >= border) resize(border * accel); else if (n > border / 2) resize(border);
  return [dx, dy];
}
