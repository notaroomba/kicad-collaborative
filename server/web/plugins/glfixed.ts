// glfixed.ts — the drawing end of the OpenGL a KiCad plugin uses (PyOpenGL on a wx.glcanvas.GLCanvas), on WebGL.
//
// A desktop plugin that shows a 3D preview draws it with OpenGL 1.x: matrix stacks, glBegin/glEnd, vertex arrays
// and the fixed lighting model.  WebGL has none of those, only shaders.  The state (matrices, lights, material,
// client arrays) is kept by plugins/python/OpenGL/GL.py in the plugin's interpreter; what reaches this file is
// already a plain list of vertices with the matrices and lights to draw them under, and one shader pair here does
// what the fixed pipeline did: per-vertex lighting (ambient, diffuse, specular; directional and positional
// lights), one texture, flat colour or colour per vertex.
//
// It is built by scripts/build-python.mjs into the Python runtime's files (kicad_gl.js) and registers
// globalThis.__kcGL.  No imports: it must stand alone in the plugin's sandboxed frame.

/* eslint-disable @typescript-eslint/no-explicit-any */

const VERT = `
attribute vec3 aPos; attribute vec3 aNormal; attribute vec4 aColor; attribute vec2 aUV;
uniform mat4 uMV; uniform mat4 uP; uniform mat3 uN;
uniform bool uLit; uniform bool uColorMaterial; uniform bool uVertexColor; uniform bool uNormalize;
uniform vec4 uColor; uniform vec4 uMatAmbient; uniform vec4 uMatDiffuse; uniform vec4 uMatSpecular; uniform vec4 uMatEmission; uniform float uShininess;
uniform vec4 uSceneAmbient; uniform float uPointSize;
uniform int uLights; uniform vec4 uLightPos[8]; uniform vec4 uLightAmbient[8]; uniform vec4 uLightDiffuse[8]; uniform vec4 uLightSpecular[8];
varying vec4 vColor; varying vec2 vUV;
void main() {
  vec4 eye = uMV * vec4(aPos, 1.0);
  gl_Position = uP * eye; gl_PointSize = uPointSize; vUV = aUV;
  vec4 base = uVertexColor ? aColor : uColor;
  if (!uLit) { vColor = base; return; }
  vec3 n = uN * aNormal; if (uNormalize) n = normalize(n);
  vec4 ma = uColorMaterial ? base : uMatAmbient; vec4 md = uColorMaterial ? base : uMatDiffuse;
  vec3 c = uMatEmission.rgb + ma.rgb * uSceneAmbient.rgb;
  vec3 v = normalize(-eye.xyz);
  for (int i = 0; i < 8; i++) {
    if (i >= uLights) break;
    vec3 l = uLightPos[i].w == 0.0 ? normalize(uLightPos[i].xyz) : normalize(uLightPos[i].xyz - eye.xyz);
    float d = max(dot(n, l), 0.0);
    c += ma.rgb * uLightAmbient[i].rgb + md.rgb * uLightDiffuse[i].rgb * d;
    if (d > 0.0 && uShininess > 0.0) { vec3 h = normalize(l + v); c += uMatSpecular.rgb * uLightSpecular[i].rgb * pow(max(dot(n, h), 0.0), uShininess); }
  }
  vColor = vec4(clamp(c, 0.0, 1.0), md.a);
}`;
const FRAG = `
precision mediump float;
uniform bool uTextured; uniform sampler2D uTex;
varying vec4 vColor; varying vec2 vUV;
void main() { gl_FragColor = uTextured ? vColor * texture2D(uTex, vUV) : vColor; }`;

interface DrawCall {
  mode: number; count: number;
  pos: Float32Array | string;            // the vertices, or the name of a buffer kept from before
  normal?: Float32Array | string | null; color?: Float32Array | null; uv?: Float32Array | null;
  mv: number[]; p: number[]; n: number[];
  lit?: boolean; colorMaterial?: boolean; normalize?: boolean;
  rgba: number[]; ambient?: number[]; diffuse?: number[]; specular?: number[]; emission?: number[]; shininess?: number; sceneAmbient?: number[];
  lights?: number[];                     // 16 numbers a light: position (eye space), ambient, diffuse, specular
  texture?: number; pointSize?: number;
}

class Context {
  private gl: WebGLRenderingContext; private prog: WebGLProgram; private loc: Record<string, WebGLUniformLocation | null> = {}; private attr: Record<string, number> = {};
  private kept = new Map<string, { buf: WebGLBuffer; n: number }>(); private scratch: Record<string, WebGLBuffer> = {};
  private textures = new Map<number, WebGLTexture>(); private nextTexture = 1;
  private overlay: HTMLCanvasElement | null = null; private white: WebGLTexture;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = (canvas.getContext("webgl", { alpha: false, antialias: true, depth: true, preserveDrawingBuffer: true }) || canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (!gl) throw new Error("this browser gave no WebGL context");
    this.gl = gl;
    const shader = (type: number, src: string): WebGLShader => { const s = gl.createShader(type) as WebGLShader; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("shader: " + gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram() as WebGLProgram; gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("program: " + gl.getProgramInfoLog(prog));
    this.prog = prog; gl.useProgram(prog);
    for (const a of ["aPos", "aNormal", "aColor", "aUV"]) this.attr[a] = gl.getAttribLocation(prog, a);
    for (const u of ["uMV", "uP", "uN", "uLit", "uColorMaterial", "uVertexColor", "uNormalize", "uColor", "uMatAmbient", "uMatDiffuse", "uMatSpecular", "uMatEmission", "uShininess", "uSceneAmbient",
      "uPointSize", "uLights", "uLightPos", "uLightAmbient", "uLightDiffuse", "uLightSpecular", "uTextured", "uTex"]) this.loc[u] = gl.getUniformLocation(prog, u);
    this.white = gl.createTexture() as WebGLTexture; gl.bindTexture(gl.TEXTURE_2D, this.white);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  }

  /** The drawing buffer follows the element's size (glViewport is given in these pixels). */
  resize(w: number, h: number): void {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    if (this.overlay && (this.overlay.width !== w || this.overlay.height !== h)) { this.overlay.width = w; this.overlay.height = h; }
  }
  viewport(x: number, y: number, w: number, h: number): void { this.gl.viewport(x, y, w, h); }
  scissor(on: boolean, x: number, y: number, w: number, h: number): void { const gl = this.gl; if (on) { gl.enable(gl.SCISSOR_TEST); gl.scissor(x, y, w, h); } else gl.disable(gl.SCISSOR_TEST); }
  clearColor(r: number, g: number, b: number, a: number): void { this.gl.clearColor(r, g, b, a); }
  clear(color: boolean, depth: boolean): void {
    const gl = this.gl; gl.depthMask(true); gl.clear((color ? gl.COLOR_BUFFER_BIT : 0) | (depth ? gl.DEPTH_BUFFER_BIT : 0));
    if (color && this.overlay) { const c = this.overlay.getContext("2d"); if (c) c.clearRect(0, 0, this.overlay.width, this.overlay.height); }
  }
  /** Capabilities and fixed state: only what changed is sent. */
  state(s: Record<string, any>): void {
    const gl = this.gl; const cap = (name: string, what: number): void => { if (name in s) { if (s[name]) gl.enable(what); else gl.disable(what); } };
    cap("depthTest", gl.DEPTH_TEST); cap("blend", gl.BLEND); cap("cullFace", gl.CULL_FACE); cap("polygonOffsetFill", gl.POLYGON_OFFSET_FILL);
    if ("depthFunc" in s) gl.depthFunc(s.depthFunc);
    if ("depthMask" in s) gl.depthMask(!!s.depthMask);
    if ("blendFunc" in s) gl.blendFunc(s.blendFunc[0], s.blendFunc[1]);
    if ("cullFaceMode" in s) gl.cullFace(s.cullFaceMode);
    if ("frontFace" in s) gl.frontFace(s.frontFace);
    if ("polygonOffset" in s) gl.polygonOffset(s.polygonOffset[0], s.polygonOffset[1]);
    if ("lineWidth" in s) gl.lineWidth(Math.max(1, s.lineWidth));
    if ("colorMask" in s) gl.colorMask(!!s.colorMask[0], !!s.colorMask[1], !!s.colorMask[2], !!s.colorMask[3]);
  }
  /** Keep a large array on the graphics card under a name, so a mesh drawn every frame crosses once. */
  keep(name: string, data: Float32Array): void {
    const gl = this.gl; const old = this.kept.get(name); const buf = old ? old.buf : (gl.createBuffer() as WebGLBuffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); this.kept.set(name, { buf, n: data.length });
  }
  has(name: string): boolean { return this.kept.has(name); }
  drop(name: string): void { const k = this.kept.get(name); if (k) { this.gl.deleteBuffer(k.buf); this.kept.delete(name); } }

  private bind(attr: string, size: number, data: Float32Array | string | null | undefined): boolean {
    const gl = this.gl; const at = this.attr[attr]; if (at < 0) return false;
    if (data === null || data === undefined) { gl.disableVertexAttribArray(at); return false; }
    let buf: WebGLBuffer;
    if (typeof data === "string") { const k = this.kept.get(data); if (!k) { gl.disableVertexAttribArray(at); return false; } buf = k.buf; gl.bindBuffer(gl.ARRAY_BUFFER, buf); }
    else { buf = this.scratch[attr] || (this.scratch[attr] = gl.createBuffer() as WebGLBuffer); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW); }
    gl.enableVertexAttribArray(at); gl.vertexAttribPointer(at, size, gl.FLOAT, false, 0, 0); return true;
  }

  draw(d: DrawCall): void {
    const gl = this.gl; const L = this.loc; gl.useProgram(this.prog);
    this.bind("aPos", 3, d.pos);
    if (!this.bind("aNormal", 3, d.normal)) gl.vertexAttrib3f(this.attr.aNormal, 0, 0, 1);
    const vc = this.bind("aColor", 4, d.color);
    const uv = this.bind("aUV", 2, d.uv);
    gl.uniformMatrix4fv(L.uMV, false, new Float32Array(d.mv)); gl.uniformMatrix4fv(L.uP, false, new Float32Array(d.p)); gl.uniformMatrix3fv(L.uN, false, new Float32Array(d.n));
    gl.uniform1i(L.uLit, d.lit ? 1 : 0); gl.uniform1i(L.uColorMaterial, d.colorMaterial ? 1 : 0); gl.uniform1i(L.uVertexColor, vc ? 1 : 0); gl.uniform1i(L.uNormalize, d.normalize ? 1 : 0);
    gl.uniform4fv(L.uColor, new Float32Array(d.rgba));
    gl.uniform4fv(L.uMatAmbient, new Float32Array(d.ambient || [0.2, 0.2, 0.2, 1])); gl.uniform4fv(L.uMatDiffuse, new Float32Array(d.diffuse || [0.8, 0.8, 0.8, 1]));
    gl.uniform4fv(L.uMatSpecular, new Float32Array(d.specular || [0, 0, 0, 1])); gl.uniform4fv(L.uMatEmission, new Float32Array(d.emission || [0, 0, 0, 1]));
    gl.uniform1f(L.uShininess, d.shininess || 0); gl.uniform4fv(L.uSceneAmbient, new Float32Array(d.sceneAmbient || [0.2, 0.2, 0.2, 1])); gl.uniform1f(L.uPointSize, d.pointSize || 1);
    const lights = d.lit && d.lights ? d.lights : []; const n = Math.min(8, Math.floor(lights.length / 16));
    gl.uniform1i(L.uLights, n);
    if (n) {
      const part = (o: number): Float32Array => { const out = new Float32Array(32); for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) out[i * 4 + k] = lights[i * 16 + o + k]; return out; };
      gl.uniform4fv(L.uLightPos, part(0)); gl.uniform4fv(L.uLightAmbient, part(4)); gl.uniform4fv(L.uLightDiffuse, part(8)); gl.uniform4fv(L.uLightSpecular, part(12));
    }
    const tex = d.texture && uv ? this.textures.get(d.texture) : undefined;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex || this.white); gl.uniform1i(L.uTex, 0); gl.uniform1i(L.uTextured, tex ? 1 : 0);
    gl.drawArrays(d.mode, 0, d.count);
  }

  // ---- textures
  texture(): number { const id = this.nextTexture++; this.textures.set(id, this.gl.createTexture() as WebGLTexture); return id; }
  deleteTexture(id: number): void { const t = this.textures.get(id); if (t) { this.gl.deleteTexture(t); this.textures.delete(id); } }
  /** Pixels for a texture: `channels` bytes a pixel (1 luminance, 3 RGB, 4 RGBA), rows from the first given. */
  texImage(id: number, w: number, h: number, channels: number, data: Uint8Array | null): void {
    const gl = this.gl; const t = this.textures.get(id); if (!t) return;
    const fmt = channels === 4 ? gl.RGBA : channels === 3 ? gl.RGB : channels === 2 ? gl.LUMINANCE_ALPHA : gl.LUMINANCE;
    gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, fmt, gl.UNSIGNED_BYTE, data);
    // sizes that are not powers of two cannot repeat or use mipmaps in WebGL 1
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }
  texFilter(id: number, min: boolean, linear: boolean): void {
    const gl = this.gl; const t = this.textures.get(id); if (!t) return;
    gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, min ? gl.TEXTURE_MIN_FILTER : gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
  }

  // ---- bitmap text (glutBitmapCharacter): drawn on a 2D canvas laid over the GL one
  text(x: number, y: number, text: string, px: number, family: string, rgba: number[]): void {
    if (!this.overlay) {
      const o = document.createElement("canvas"); o.width = this.canvas.width; o.height = this.canvas.height;
      o.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none";
      const host = this.canvas.parentElement; if (host) { if (getComputedStyle(host).position === "static") host.style.position = "relative"; host.appendChild(o); }
      this.overlay = o;
    }
    const c = this.overlay.getContext("2d"); if (!c) return;
    c.font = `${px}px ${family}`; c.textBaseline = "alphabetic";
    c.fillStyle = `rgba(${Math.round(rgba[0] * 255)},${Math.round(rgba[1] * 255)},${Math.round(rgba[2] * 255)},${rgba[3]})`;
    c.fillText(text, x, y);
  }

  /** The picture as drawn so far, as RGBA rows from the bottom (glReadPixels). */
  pixels(x: number, y: number, w: number, h: number): Uint8Array { const out = new Uint8Array(w * h * 4); this.gl.readPixels(x, y, w, h, this.gl.RGBA, this.gl.UNSIGNED_BYTE, out); return out; }
  finish(): void { this.gl.flush(); }
  lost(): boolean { return this.gl.isContextLost(); }
}

(globalThis as any).__kcGL = { create(canvas: HTMLCanvasElement): Context { return new Context(canvas); } };
