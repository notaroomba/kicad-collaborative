// wheel-model.ts — WX_VIEW_CONTROLS::onWheel (common/view/wx_view_controls.cpp:440-551) and KiCad's zoom
// controllers (common/view/zoom_controller.cpp), as plain functions over the browser's wheel event so the node
// tests can run them.  gestures.ts applies what they answer.
//
// A browser wheel delta is in CSS pixels down / right (about 100 a notch); wxWidgets reports a rotation up / left
// in units of 120 a notch, so rotation = -delta × 1.2.

/** COMMON_SETTINGS::m_Input as the wheel reads it (common/settings/common_settings.cpp:245-318). */
export interface WheelSettings {
  /** 0 (none), "ctrl", "shift" or "alt": the modifier for each vertical-scroll action (scroll_modifier_zoom / pan_h / pan_v) */
  zoomMod: ScrollMod; panHMod: ScrollMod; panVMod: ScrollMod;
  reverseZoom: boolean; reversePanH: boolean;
  /** input.horizontal_pan: a horizontal wheel or tilt pans left / right (otherwise it is ignored) */
  horizontalPan: boolean;
  zoomAcceleration: boolean; zoomSpeed: number; zoomSpeedAuto: boolean;
  /** input.center_on_zoom: CenterOnCursor before the zoom (IsCursorWarpingEnabled) */
  centerOnZoom: boolean;
  /** input.touchpad_mode: "native" pinch-zooms and pans with two fingers; "scroll" maps the gestures like a wheel */
  touchpadMode: "native" | "scroll";
}
export type ScrollMod = "" | "ctrl" | "shift" | "alt";
export type Platform = "mac" | "win" | "linux";

export const DEFAULT_WHEEL: WheelSettings = { zoomMod: "", panHMod: "ctrl", panVMod: "shift", reverseZoom: false, reversePanH: false, horizontalPan: true,
  zoomAcceleration: false, zoomSpeed: 1, zoomSpeedAuto: true, centerOnZoom: false, touchpadMode: "scroll" };

/** CONSTANT_ZOOM_CONTROLLER's platform scales and MANUAL_SCALE_FACTOR (include/view/zoom_controller.h). */
export const GTK3_SCALE = 0.002, MAC_SCALE = 0.01, MSW_SCALE = 0.005, MANUAL_SCALE_FACTOR = 0.001, DEFAULT_ACCELERATION_SCALE = 5.0, ACC_TIMEOUT_MS = 500;
const MAX_MERGED_NOTCHES = 10;
function notchCount(rotation: number, wheelDelta: number): number { return wheelDelta <= 0 ? 1 : Math.min(MAX_MERGED_NOTCHES, Math.max(1, Math.abs(rotation) / wheelDelta)); }

/** CONSTANT_ZOOM_CONTROLLER::GetScaleForRotation. */
export function constantZoomScale(scale: number, rotation: number, wheelDelta: number): number {
  const stepCap = wheelDelta > 0 ? Math.min(wheelDelta, 100) : 100;
  const oneStep = Math.min(Math.abs(rotation), stepCap);
  const factor = Math.pow(1 + oneStep * scale, notchCount(rotation, wheelDelta));
  return rotation > 0 ? factor : 1 / factor;
}
/** ACCELERATING_ZOOM_CONTROLLER: remembers the previous event's time and direction. */
export class AcceleratingZoom {
  private prevT = -Infinity; private prevPositive = false;
  constructor(private scale = DEFAULT_ACCELERATION_SCALE, private timeout = ACC_TIMEOUT_MS) {}
  scaleFor(rotation: number, wheelDelta: number, now: number): number {
    const minStep = 1.05, dt = now - this.prevT; this.prevT = now;
    let z: number;
    if (dt < this.timeout && (rotation > 0) === this.prevPositive) { z = Math.max(2.05 * this.scale / 5 - dt / this.timeout, minStep); if (rotation < 0) z = 1 / z; }
    else z = rotation > 0 ? minStep : 1 / minStep;
    this.prevPositive = rotation > 0;
    const n = notchCount(rotation, wheelDelta); if (n > 1) z = Math.pow(z, n);
    return z;
  }
}

/** The zoom controller WX_VIEW_CONTROLS::LoadSettings picks (wx_view_controls.cpp:58-73, 197-215). */
export function makeZoomController(s: WheelSettings, platform: Platform): (rotation: number, wheelDelta: number, now: number) => number {
  if (s.zoomSpeedAuto) {
    if (platform === "mac") return (r, d) => constantZoomScale(MAC_SCALE, r, d);
    if (platform === "linux") return (r, d) => constantZoomScale(GTK3_SCALE, r, d);
    if (s.zoomAcceleration) { const a = new AcceleratingZoom(); return (r, d, t) => a.scaleFor(r, d, t); }
    return (r, d) => constantZoomScale(MSW_SCALE, r, d);
  }
  if (s.zoomAcceleration) { const a = new AcceleratingZoom(s.zoomSpeed); return (r, d, t) => a.scaleFor(r, d, t); }
  const scale = MANUAL_SCALE_FACTOR * s.zoomSpeed;
  return (r, d) => constantZoomScale(scale, r, d);
}

export interface WheelInput { deltaX: number; deltaY: number; shiftKey: boolean; ctrlKey: boolean; altKey: boolean }
/** What a wheel event does: zoom by a rotation, pan the view by screen pixels, or nothing (handed to the tools). */
export type WheelAction = { kind: "zoom"; rotation: number } | { kind: "pan"; dx: number; dy: number } | null;

/**
 * onWheel's routing for one event whose deltas are already in CSS pixels.  `w` × `h` is the canvas size (the
 * pan is rotation × 0.001 of it, GetLayoutPixelSize × wheelPanSpeed); `dx` / `dy` of a pan are how far the
 * drawing moves on screen.
 */
export function wheelAction(ev: WheelInput, s: WheelSettings, w: number, h: number): WheelAction {
  const PAN = 0.001;
  // a horizontal-axis event (tilt wheel, touchpad sideways): wxMOUSE_WHEEL_HORIZONTAL
  if (ev.deltaX !== 0 && Math.abs(ev.deltaX) > Math.abs(ev.deltaY) && !ev.shiftKey) {
    if (!s.horizontalPan) return null;
    const rot = ev.deltaX * 1.2;   // wx: positive rotation scrolls right, the centre moves right
    return { kind: "pan", dx: -rot * PAN * w, dy: 0 };
  }
  // Shift beats Ctrl beats Alt; more than one modifier goes to the tools
  const n = (ev.shiftKey ? 1 : 0) + (ev.ctrlKey ? 1 : 0) + (ev.altKey ? 1 : 0);
  if (n > 1) return null;
  const mod: ScrollMod = ev.shiftKey ? "shift" : ev.ctrlKey ? "ctrl" : ev.altKey ? "alt" : "";
  // browsers turn Shift+wheel into a horizontal delta: whichever axis carries it is the vertical wheel's rotation
  const delta = ev.deltaY !== 0 ? ev.deltaY : ev.deltaX;
  const rotation = -delta * 1.2;
  if (mod === s.zoomMod) return delta !== 0 ? { kind: "zoom", rotation: rotation * (s.reverseZoom ? -1 : 1) } : null;
  // SetCenter( center + delta ): the drawing moves the other way on screen
  if (mod === s.panHMod) return { kind: "pan", dx: (s.reversePanH ? -1 : 1) * rotation * PAN * w, dy: 0 };
  return { kind: "pan", dx: 0, dy: rotation * PAN * h };
}

/** Parse a stored modifier ("", "ctrl", "shift", "alt"); anything else is none. */
export const scrollMod = (v: unknown): ScrollMod => (v === "ctrl" || v === "shift" || v === "alt" ? v : "");

/**
 * PANEL_MOUSE_SETTINGS::OnScrollRadioButton: choosing `mod` for one action takes it from the others, which move to
 * the first column (none, Ctrl, Shift, Alt) no action holds.
 */
export function assignScrollMod(cur: { zoom: ScrollMod; panh: ScrollMod; panv: ScrollMod }, which: "zoom" | "panh" | "panv", mod: ScrollMod): { zoom: ScrollMod; panh: ScrollMod; panv: ScrollMod } {
  const next = { ...cur, [which]: mod };
  const order: ScrollMod[] = ["", "ctrl", "shift", "alt"];
  for (const other of ["zoom", "panh", "panv"] as const) {
    if (other === which || next[other] !== mod || mod === "") continue;
    const taken = (m: ScrollMod) => next.zoom === m || next.panh === m || next.panv === m;
    const free = order.find((m) => m !== mod && !taken(m)); if (free !== undefined) next[other] = free;
  }
  return next;
}
