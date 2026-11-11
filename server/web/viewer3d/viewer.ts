// viewer3d/viewer.ts — the WebGL canvas of the 3D viewer: renderer, camera and mouse control.
//
// As in KiCad's viewer (common/gal/3d/camera.cpp, track_ball.cpp) the camera stays on the Z axis and the
// board turns in front of it: left-drag orbits, middle- or right-drag pans, the wheel zooms about the
// cursor.  The toolbar's rotations turn the board about its own axes by the rotation increment (10°,
// eda_3d_viewer_settings.cpp "camera.rotation_increment") and the view commands use the angles of
// CAMERA::ViewCommand_T1.  Frames are drawn on demand only.
import * as THREE from "three";
import { BACKGROUND_BOTTOM, BACKGROUND_TOP, RGBA, css } from "./colors";
import { BoardScene, BoardStats, DEFAULT_VISIBILITY, Visibility } from "./scene";

export type ViewName = "top" | "bottom" | "front" | "back" | "left" | "right";
export type Axis = "x" | "y" | "z";

const FOV = 45;                          // CAMERA: m_frustum.angle
const ZOOM_STEP = 1.26;                  // EDA_3D_CANVAS::SetView3D: three steps per doubling
const ROTATION_INCREMENT = 10;           // degrees
const MIN_ZOOM = 0.05, MAX_ZOOM = 80;
const rad = (d: number) => d * Math.PI / 180;
const TAN = Math.tan(rad(FOV) / 2);

// CAMERA::ViewCommand_T1: the board's rotation (about X, then Y, then Z) for each standard view
const VIEWS: Record<ViewName, [number, number, number]> = {
  top: [0, 0, 0], bottom: [0, 180, 0], front: [-90, 0, 0], back: [-90, 0, 180], left: [-90, 0, 90], right: [-90, 0, -90],
};

/** Is WebGL drawn on the CPU here?  (Asked of a throw-away context, since antialiasing is fixed at creation.) */
function softwareGL(): boolean {
  try {
    const c = document.createElement("canvas"); const gl = c.getContext("webgl2") || c.getContext("webgl"); if (!gl) return false;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    const lose = gl.getExtension("WEBGL_lose_context"); if (lose) lose.loseContext();
    return /swiftshader|llvmpipe|software|softpipe/i.test(name);
  } catch { return false; }
}

export class Viewer {
  readonly canvas: HTMLCanvasElement;
  visibility: Visibility = Object.assign({}, DEFAULT_VISIBILITY);
  background: { top: RGBA; bottom: RGBA } = { top: BACKGROUND_TOP, bottom: BACKGROUND_BOTTOM };
  ortho = false;
  /** called after every drawn frame (tests and the status line read it) */
  onFrame: (() => void) | null = null;
  frames = 0;

  private host: HTMLElement;
  private wheel = true;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private pivot = new THREE.Group();
  private persp = new THREE.PerspectiveCamera(FOV, 1, 0.1, 5000);
  private orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
  private board: BoardScene | null = null;
  /** the camera's position; it always looks down −Z */
  private cam = new THREE.Vector3(0, 0, 300);
  private width = 1; private height = 1;
  private raf = 0;
  private drag: { id: number; mode: "orbit" | "pan"; x: number; y: number; depth: number } | null = null;
  private resizeObs: ResizeObserver | null = null;
  private disposed = false;
  private software = false;
  /** the camera is where Zoom to Fit left it (so a resized window refits) */
  private fitted = true;
  // a view change in flight (KiCad's 3D viewer animates them: "Enable animation", eda_3d_viewer_settings);
  // the objects are reused from one animation to the next
  private anim = { raf: 0, t0: 0, q0: new THREE.Quaternion(), q1: new THREE.Quaternion(), c0: new THREE.Vector3(), c1: new THREE.Vector3() };
  private tmpQ = new THREE.Quaternion(); private tmpQ2 = new THREE.Quaternion(); private tmpV = new THREE.Vector3();
  /** milliseconds a view change takes (0: none) */
  animationMs = 220;

  /** `wheel: false` leaves the mouse wheel to the page (a viewer embedded in a scrolling page). */
  constructor(host: HTMLElement, opts: { wheel?: boolean } = {}) {
    this.host = host; this.wheel = opts.wheel !== false;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "v3d-canvas";
    this.canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none;outline:none";
    host.appendChild(this.canvas);
    // a software rasteriser (SwiftShader, llvmpipe) pays dearly for multisampling and anisotropic filtering
    this.software = softwareGL();
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: !this.software, alpha: true, powerPreference: "high-performance" });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(this.software ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    // KiCad lights the board from the camera's side: a key light over the left shoulder, a fill from the right
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 1.7); key.position.set(-0.45, 0.6, 1); this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5); fill.position.set(0.7, -0.4, 0.6); this.scene.add(fill);
    this.scene.add(this.pivot);
    this.applyBackground();
    this.bind();
    this.resize();
    if (typeof ResizeObserver === "function") { this.resizeObs = new ResizeObserver(() => this.resize()); this.resizeObs.observe(host); }
  }

  // ---------------------------------------------------------------- board

  /** Build (or rebuild) the board from a document; the camera is kept unless `fit`. */
  setDoc(doc: KDoc, fit: boolean): BoardStats {
    const gl = this.renderer.getContext();
    const maxTex = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096;
    const next = new BoardScene(doc, maxTex, this.software ? 1 : this.renderer.capabilities.getMaxAnisotropy(), this.visibility, this.board);
    if (this.board) { this.pivot.remove(this.board.group); this.board.dispose(); }
    this.board = next;
    // turn about the middle of the laminate, not its front face
    next.group.position.set(0, 0, next.size.t / 2);
    this.pivot.add(next.group);
    if (fit || this.fitted) { this.cam.set(0, 0, this.fitDistance()); this.fitted = true; }
    this.requestRender();
    return next.stats;
  }

  get stats(): BoardStats | null { return this.board ? this.board.stats : null; }

  setVisibility(patch: Partial<Visibility>): void {
    Object.assign(this.visibility, patch);
    if (this.board) this.board.applyVisibility(this.visibility);
    this.requestRender();
  }

  setBackground(top: RGBA, bottom: RGBA): void { this.background = { top, bottom }; this.applyBackground(); }

  private applyBackground(): void {
    this.host.style.background = `linear-gradient(to bottom, ${css(this.background.top, 1)}, ${css(this.background.bottom, 1)})`;
  }

  // ---------------------------------------------------------------- camera

  private boardSize(): { w: number; h: number; t: number } { return this.board ? this.board.size : { w: 100, h: 80, t: 1.6 }; }
  private aspect(): number { return this.width / Math.max(1, this.height); }

  /** Camera distance at which the whole board fits the view (seen from the top): zoom 1. */
  private fitDistance(): number {
    const s = this.boardSize();
    const half = Math.max(s.h / 2, s.w / 2 / this.aspect(), 1) * 1.08;
    return half / TAN;
  }

  /** The ray through a point of the canvas (pixels; the centre when omitted), in the camera's frame. */
  private rayDir(at?: { x: number; y: number }): THREE.Vector3 {
    const nx = at ? (at.x / this.width) * 2 - 1 : 0, ny = at ? 1 - (at.y / this.height) * 2 : 0;
    return new THREE.Vector3(nx * this.aspect() * TAN, ny * TAN, -1);
  }

  /**
   * Where the view ray through a canvas point meets the board (its mid-plane, as currently turned), or —
   * when it misses the board or the board is edge-on — the plane through the pivot that faces the camera.
   * Returned with its depth in front of the camera.
   */
  private target(at?: { x: number; y: number }): { point: THREE.Vector3; depth: number } {
    const dir = this.rayDir(at); const s = this.boardSize(); const reach = Math.hypot(s.w, s.h) / 2 * 1.15;
    const origin = this.ortho ? this.cam.clone().addScaledVector(new THREE.Vector3(dir.x, dir.y, 0), this.depth0()) : this.cam;
    const d = this.ortho ? new THREE.Vector3(0, 0, -1) : dir;
    const n = new THREE.Vector3(0, 0, 1).applyQuaternion(this.pivot.quaternion); const dn = d.dot(n);
    if (Math.abs(dn) > 0.05) {
      const t = -origin.dot(n) / dn; const hit = origin.clone().addScaledVector(d, t);
      if (t > 0 && hit.length() <= reach) return { point: hit, depth: t };
    }
    const t = Math.max(0.5, origin.z); return { point: origin.clone().addScaledVector(d, t), depth: t };
  }

  /** Depth of the pivot plane in front of the camera: the orthographic view's scale. */
  private depth0(): number { return Math.max(0.5, this.cam.z); }

  private camera(): THREE.Camera {
    const s = this.boardSize(); const radius = Math.hypot(s.w, s.h, s.t) / 2 + 20; const aspect = this.aspect();
    if (this.ortho) {
      const hh = this.depth0() * TAN; const c = this.orthoCam;
      c.left = -hh * aspect; c.right = hh * aspect; c.top = hh; c.bottom = -hh; c.near = 0.01; c.far = 4 * radius;
      c.position.set(this.cam.x, this.cam.y, 2 * radius); c.rotation.set(0, 0, 0); c.updateProjectionMatrix(); c.updateMatrixWorld();
      return c;
    }
    const c = this.persp;
    c.aspect = aspect; c.near = 0.2; c.far = this.cam.length() + 2 * radius;
    c.position.copy(this.cam); c.rotation.set(0, 0, 0); c.updateProjectionMatrix(); c.updateMatrixWorld();
    return c;
  }

  setOrtho(on: boolean): void { this.ortho = on; this.requestRender(); }

  /** Zoom by a factor about a canvas point (the centre when omitted): the board under it stays put. */
  zoomBy(factor: number, at?: { x: number; y: number }): void {
    this.stopAnimation(true);
    const fit = this.fitDistance(); this.fitted = false;
    if (this.ortho) {
      const before = this.depth0(); const after = Math.max(fit / MAX_ZOOM, Math.min(fit / MIN_ZOOM, before / factor));
      const dir = this.rayDir(at);
      this.cam.x += dir.x * (before - after); this.cam.y += dir.y * (before - after); this.cam.z = after;
    } else {
      // dolly towards the point of the board under the cursor, never through it
      const { point, depth } = this.target(at);
      const f = factor >= 1 ? Math.max(1, Math.min(factor, depth / 1.5)) : Math.min(1, Math.max(factor, depth / (fit / MIN_ZOOM)));
      if (!(f > 0) || !isFinite(f)) return;
      this.cam.sub(point).multiplyScalar(1 / f).add(point);
    }
    this.requestRender();
  }

  zoomIn(): void { this.zoomBy(ZOOM_STEP); }
  zoomOut(): void { this.zoomBy(1 / ZOOM_STEP); }
  /** Zoom to Fit / Home: the camera back to its distance and centre, the board's rotation kept. */
  fit(): void { this.animateTo(this.anim.raf ? this.anim.q1 : this.pivot.quaternion, this.tmpV.set(0, 0, this.fitDistance())); this.fitted = true; }

  view(name: ViewName): void {
    const v = VIEWS[name];
    this.tmpQ2.setFromEuler(new THREE.Euler(rad(v[0]), rad(v[1]), rad(v[2]), "XYZ"));
    this.animateTo(this.tmpQ2, this.tmpV.set(0, 0, this.fitDistance())); this.fitted = true;
  }

  /** Put the board in a pose at once: its rotation about X, then Y, then Z (degrees, as the standard views are given) and the zoom (1: fitted). */
  pose(x: number, y: number, z: number, zoom = 1): void {
    this.stopAnimation(false);
    this.pivot.quaternion.setFromEuler(new THREE.Euler(rad(x), rad(y), rad(z), "XYZ"));
    this.cam.set(0, 0, this.fitDistance() / Math.max(0.05, zoom)); this.fitted = zoom === 1;
    this.requestRender();
  }

  /** Ease the board's rotation and the camera to a new pose over animationMs (at once when animation is off). */
  private animateTo(q: THREE.Quaternion, cam: THREE.Vector3): void {
    const a = this.anim;
    a.q1.copy(q); a.c1.copy(cam);
    let reduce = false; try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { /* old browser */ }
    if (this.animationMs <= 0 || reduce || this.disposed) { this.stopAnimation(false); this.pivot.quaternion.copy(a.q1); this.cam.copy(a.c1); this.requestRender(); return; }
    a.q0.copy(this.pivot.quaternion); a.c0.copy(this.cam); a.t0 = performance.now();
    if (a.raf) return;
    const step = (now: number): void => {
      a.raf = 0; if (this.disposed) return;
      const t = Math.min(1, (now - a.t0) / this.animationMs), e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.pivot.quaternion.slerpQuaternions(a.q0, a.q1, e); this.cam.lerpVectors(a.c0, a.c1, e);
      this.renderNow();
      if (t < 1) a.raf = requestAnimationFrame(step);
    };
    a.raf = requestAnimationFrame(step);
  }

  /** Stop a view change: where it is now, or (`finish`) at its end. */
  private stopAnimation(finish: boolean): void {
    const a = this.anim; if (!a.raf) return;
    cancelAnimationFrame(a.raf); a.raf = 0;
    if (finish) { this.pivot.quaternion.copy(a.q1); this.cam.copy(a.c1); }
    this.requestRender();
  }

  /** Rotate the board about one of its own axes; `cw` as the toolbar names it (EDA_3D_CONTROLLER::RotateView). */
  rotate(axis: Axis, cw: boolean, degrees = ROTATION_INCREMENT): void {
    // "Y rotations are backward b/c the RHR has Y pointing into the screen" (eda_3d_controller.cpp)
    const sign = axis === "y" ? (cw ? 1 : -1) : (cw ? -1 : 1);
    const v = axis === "x" ? new THREE.Vector3(1, 0, 0) : axis === "y" ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    const from = this.anim.raf ? this.anim.q1 : this.pivot.quaternion;
    this.tmpQ2.copy(from).multiply(this.tmpQ.setFromAxisAngle(v, sign * rad(degrees))).normalize();
    this.animateTo(this.tmpQ2, this.anim.raf ? this.anim.c1 : this.cam);
  }

  flip(): void {
    const from = this.anim.raf ? this.anim.q1 : this.pivot.quaternion;
    this.tmpQ2.copy(from).multiply(this.tmpQ.setFromAxisAngle(this.tmpV.set(0, 1, 0), Math.PI)).normalize();
    this.animateTo(this.tmpQ2, this.anim.raf ? this.anim.c1 : this.cam);
  }

  /** Move the board on the screen by a fraction of the view (the arrow keys). */
  move(dx: number, dy: number): void {
    this.stopAnimation(true);
    const step = 0.2 * this.target().depth * TAN;
    this.cam.x -= dx * step; this.cam.y -= dy * step; this.fitted = false; this.requestRender();
  }

  private orbit(dxPx: number, dyPx: number): void {
    const k = Math.PI / Math.max(200, Math.min(this.width, this.height));
    const q = this.tmpQ.setFromAxisAngle(this.tmpV.set(0, 1, 0), dxPx * k).multiply(this.tmpQ2.setFromAxisAngle(this.tmpV.set(1, 0, 0), dyPx * k));
    this.pivot.quaternion.premultiply(q).normalize();
    this.requestRender();
  }

  /** Drag the board with the pointer: `depth` is how far in front of the camera the grabbed point lies. */
  private panPx(dxPx: number, dyPx: number, depth: number): void {
    const mmPerPx = 2 * (this.ortho ? this.depth0() : depth) * TAN / Math.max(1, this.height);
    this.cam.x -= dxPx * mmPerPx; this.cam.y += dyPx * mmPerPx; this.fitted = false; this.requestRender();
  }

  /** The board's rotation as a quaternion [x, y, z, w] (tests). */
  get orientation(): [number, number, number, number] { const q = this.anim.raf ? this.anim.q1 : this.pivot.quaternion; return [q.x, q.y, q.z, q.w]; }
  /** Magnification relative to Zoom to Fit, measured at the centre of the view. */
  get zoomLevel(): number { return this.fitDistance() / (this.ortho ? this.depth0() : this.target().depth); }
  /** Camera position [x, y, z] in millimetres (tests). */
  get cameraPosition(): [number, number, number] { const c = this.anim.raf ? this.anim.c1 : this.cam; return [c.x, c.y, c.z]; }

  // ---------------------------------------------------------------- input

  private bind(): void {
    const c = this.canvas;
    c.addEventListener("pointerdown", (ev) => {
      if (this.drag) return;
      this.stopAnimation(false);
      const mode = ev.button === 0 && !ev.shiftKey ? "orbit" : "pan";
      const r = c.getBoundingClientRect();
      this.drag = { id: ev.pointerId, mode, x: ev.clientX, y: ev.clientY, depth: this.target({ x: ev.clientX - r.left, y: ev.clientY - r.top }).depth };
      try { c.setPointerCapture(ev.pointerId); } catch { /* synthetic pointer */ }
      c.style.cursor = mode === "orbit" ? "grabbing" : "move";
      ev.preventDefault();
    });
    c.addEventListener("pointermove", (ev) => {
      const d = this.drag; if (!d || d.id !== ev.pointerId) return;
      const dx = ev.clientX - d.x, dy = ev.clientY - d.y; d.x = ev.clientX; d.y = ev.clientY;
      if (d.mode === "orbit") this.orbit(dx, dy); else this.panPx(dx, dy, d.depth);
    });
    const end = (ev: PointerEvent) => {
      if (!this.drag || this.drag.id !== ev.pointerId) return;
      this.drag = null; c.style.cursor = "";
      try { c.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
    };
    c.addEventListener("pointerup", end); c.addEventListener("pointercancel", end);
    c.addEventListener("contextmenu", (ev) => ev.preventDefault());
    c.addEventListener("auxclick", (ev) => ev.preventDefault());
    if (this.wheel) c.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      this.stopAnimation(false);
      const r = c.getBoundingClientRect();
      const steps = Math.max(-3, Math.min(3, -ev.deltaY / 100));
      this.zoomBy(Math.pow(ZOOM_STEP, steps || (ev.deltaY < 0 ? 1 : -1)), { x: ev.clientX - r.left, y: ev.clientY - r.top });
    }, { passive: false });
  }

  // ---------------------------------------------------------------- frames

  resize(): void {
    const w = Math.max(1, Math.floor(this.host.clientWidth)), h = Math.max(1, Math.floor(this.host.clientHeight));
    if (w === this.width && h === this.height) return;
    this.width = w; this.height = h;
    this.renderer.setSize(w, h, false);
    if (this.fitted) this.cam.set(0, 0, this.fitDistance());   // still at Zoom to Fit: stay fitted to the new size
    this.requestRender();
  }

  requestRender(): void {
    if (this.raf || this.disposed) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.renderNow(); });
  }

  renderNow(): void {
    if (this.disposed) return;
    this.renderer.render(this.scene, this.camera());
    this.frames++;
    if (this.onFrame) this.onFrame();
  }

  /** The current view with its background gradient, as a PNG (File → Export Image…). */
  snapshot(type = "image/png"): Promise<Blob> {
    this.renderNow();   // the drawing buffer is only valid until the browser composites: draw and copy in one task
    const src = this.canvas; const out = document.createElement("canvas"); out.width = src.width; out.height = src.height;
    const ctx = out.getContext("2d");
    if (!ctx) return Promise.reject(new Error("no 2D context"));
    const g = ctx.createLinearGradient(0, 0, 0, out.height);
    g.addColorStop(0, css(this.background.top, 1)); g.addColorStop(1, css(this.background.bottom, 1));
    ctx.fillStyle = g; ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, 0);
    return new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error("could not encode the image"))), type));
  }

  dispose(): void {
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.anim.raf) cancelAnimationFrame(this.anim.raf);
    if (this.resizeObs) this.resizeObs.disconnect();
    if (this.board) { this.pivot.remove(this.board.group); this.board.dispose(); this.board = null; }
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}
