// kicad-dialogs.js — KiCad's property dialogs for the web editor.  Double-click an item (or
// press E) for its properties dialog, double-click a symbol / footprint field for the
// "Edit Text and Field Properties" dialog.  Edits are staged on a cloned node and committed
// as one change on OK; Cancel discards them — the desktop dialog contract.  The item dialogs
// reuse props.js's per-kind rows (renderInto with a staging hook); the field dialog is its own
// form built from the (property …) node.  Registers window.KDialogs.
(function (root) {
"use strict";
const K = () => root.KiCadCanvas;
const PROPS = () => root.CollabTools && root.CollabTools.props;
const clone = (n) => K().cloneNode(n);   // not JSON: that drops the reader's record of which atoms were quoted
const str = (v) => v === undefined || v === null ? "" : String(v);
const num = (v, d = 0) => { if (typeof v === "number") return v; if (v === undefined || v === null || v === "") return d; const x = Number(v); return isNaN(x) ? d : x; };
const r4 = (v) => +(+v).toFixed(4);
const isList = Array.isArray;
const esc = (s) => str(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function kid(node, key) { for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) return c; } return null; }
function kids(node, key) { const out = []; for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) out.push(c); } return out; }
function has(node, tok) { for (let j = 1; j < node.length; j++) if (node[j] === tok) return true; return false; }
function idxOf(node, key) { for (let j = 1; j < node.length; j++) if (isList(node[j]) && node[j][0] === key) return j; return -1; }
function delKid(node, key) { const i = idxOf(node, key); if (i > 0) node.splice(i, 1); }
function yesKid(node, key) { const k = kid(node, key); return !!k && str(k[1]) !== "no"; }
/** Set (key …values), replacing an existing child or inserting before the first of `before`. */
function setKid(node, key, values, before) {
  const i = idxOf(node, key);
  if (i > 0) { node[i] = [key, ...values]; return node[i]; }
  let at = node.length;
  for (const b of before || []) { const j = idxOf(node, b); if (j > 0) { at = j; break; } }
  const c = [key, ...values]; node.splice(at, 0, c); return c;
}

const TITLES = { symbol: "Symbol Properties", footprint: "Footprint Properties", wire: "Wire & Bus Line Properties", bus: "Wire & Bus Line Properties", polyline: "Line Properties",
  label: "Label Properties", global_label: "Global Label Properties", hierarchical_label: "Hierarchical Label Properties", netclass_flag: "Directive Label Properties", directive_label: "Directive Label Properties",
  text: "Text Properties", gr_text: "Text Properties", text_box: "Text Box Properties", gr_text_box: "Text Box Properties", junction: "Junction Properties", no_connect: "No Connect Properties",
  bus_entry: "Bus Entry Properties", sheet: "Sheet Properties", segment: "Track & Via Properties", arc: "Track & Via Properties", via: "Track & Via Properties", zone: "Zone Properties",
  dimension: "Dimension Properties", image: "Image Properties", table: "Table Properties", rectangle: "Graphic Item Properties", circle: "Graphic Item Properties", bezier: "Graphic Item Properties",
  gr_line: "Graphic Item Properties", gr_rect: "Graphic Item Properties", gr_circle: "Graphic Item Properties", gr_arc: "Graphic Item Properties", gr_poly: "Graphic Item Properties", gr_curve: "Graphic Item Properties", rule_area: "Rule Area Properties" };

// ---------------------------------------------------------------- field helpers (pure; tested under node)
/** The (property "Name" …) node, or for legacy boards the (fp_text reference|value …) node. */
function fieldNode(node, name) {
  for (const p of kids(node, "property")) if (str(p[1]) === name) return p;
  const t = name === "Reference" ? "reference" : name === "Value" ? "value" : null;
  if (t) for (const p of kids(node, "fp_text")) if (str(p[1]) === t) return p;
  return null;
}
function fieldText(p) { return p[0] === "fp_text" ? str(p[2]) : str(p[2]); }
function setFieldText(p, text) { p[2] = str(text); }
/** {size, thick, bold, italic, h, v, mirror} from (effects …) with KiCad's defaults. */
function fieldEffects(p) {
  const e = kid(p, "effects"), f = e && kid(e, "font"), sz = f && kid(f, "size"), th = f && kid(f, "thickness"), j = e && kid(e, "justify");
  return { size: sz ? num(sz[2], num(sz[1], 1.27)) : 1.27, thick: th ? num(th[1]) : 0,
    bold: !!(f && (has(f, "bold") || yesKid(f, "bold"))), italic: !!(f && (has(f, "italic") || yesKid(f, "italic"))),
    h: j ? (has(j, "left") ? "left" : has(j, "right") ? "right" : "center") : "center",
    v: j ? (has(j, "top") ? "top" : has(j, "bottom") ? "bottom" : "center") : "center",
    mirror: !!(j && has(j, "mirror")) };
}
/** Write font size / thickness / bold / italic / justify the way KiCad 9 does; hide is handled separately. */
function setFieldEffects(p, fx) {
  let e = kid(p, "effects"); if (!e) e = setKid(p, "effects", [], ["uuid"]);
  let f = kid(e, "font"); if (!f) { f = ["font"]; e.splice(1, 0, f); }
  setKid(f, "size", [r4(fx.size), r4(fx.size)]);
  if (fx.thick !== undefined) { if (fx.thick > 0) setKid(f, "thickness", [r4(fx.thick)], ["bold", "italic", "color"]); else delKid(f, "thickness"); }
  for (const flag of ["bold", "italic"]) { const i = f.indexOf(flag); if (i > 0) f.splice(i, 1); delKid(f, flag); if (fx[flag]) setKid(f, flag, ["yes"], [flag === "bold" ? "italic" : "color"]); }
  const jv = []; if (fx.h && fx.h !== "center") jv.push(fx.h); if (fx.v && fx.v !== "center") jv.push(fx.v); if (fx.mirror) jv.push("mirror");
  if (jv.length) setKid(e, "justify", jv, ["hide", "href"]); else delKid(e, "justify");
}
function fieldAt(p) { const a = kid(p, "at"); return a ? [num(a[1]), num(a[2]), num(a[3])] : [0, 0, 0]; }
function setFieldAt(p, x, y, rot) { const a = kid(p, "at"); const keep = a ? a.slice(4) : []; setKid(p, "at", [r4(x), r4(y), r4(rot), ...keep], ["layer", "hide", "uuid", "effects"]); }
function fieldLayer(p) { const l = kid(p, "layer"); return l ? str(l[1]) : ""; }
function setFieldLayer(p, layer) { if (layer) setKid(p, "layer", [layer], ["hide", "uuid", "effects"]); }
function fieldUnlocked(p) { const a = kid(p, "at"); return !!(a && has(a, "unlocked")) || yesKid(p, "unlocked"); }
function setFieldUnlocked(p, on) { const a = kid(p, "at"); if (a) { const i = a.indexOf("unlocked"); if (i > 0) a.splice(i, 1); } delKid(p, "unlocked"); if (on) setKid(p, "unlocked", ["yes"], ["layer", "hide", "uuid", "effects"]); }
function fieldHidden(p) { const H = PROPS() && PROPS().helpers; if (H && H.isHidden) return H.isHidden(p); const h = kid(p, "hide"); if (h) return str(h[1]) !== "no"; const e = kid(p, "effects"); return !!(e && (has(e, "hide") || yesKid(e, "hide"))); }
function setFieldHidden(node, p, hidden) {
  const H = PROPS() && PROPS().helpers;
  if (H && H.setFieldHidden && p[0] === "property" && H.setFieldHidden(node, str(p[1]), hidden)) return;
  const e = kid(p, "effects"); if (e) { const i = e.indexOf("hide"); if (i > 0) e.splice(i, 1); delKid(e, "hide"); }
  delKid(p, "hide"); if (hidden) setKid(p, "hide", ["yes"], ["uuid", "effects"]);
}

// ---------------------------------------------------------------- dialog shell (DOM)
let current = null;
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }
function close() { if (current) { current.ov.remove(); current = null; } }
/** open({title, width, build(body, api), ok() -> false keeps it open, extra:[{label, fn}], readOnly}) */
function open(spec) {
  close();
  const ov = el("div", "kd-overlay"), dlg = el("div", "kd-dialog"); if (spec.width) dlg.style.width = spec.width + "px";
  const tt = el("div", "kd-title", `<span>${esc(spec.title)}</span><span class="kd-x" title="Close (Esc)">×</span>`);
  const body = el("div", "kd-body"), foot = el("div", "kd-foot");
  for (const b of spec.extra || []) { const btn = el("button", "btn", esc(b.label)); btn.addEventListener("click", () => b.fn()); foot.appendChild(btn); }
  foot.appendChild(el("span", "spacer"));
  const cancel = el("button", "btn", "Cancel"), ok = el("button", "btn primary", spec.okLabel || "OK");
  if (spec.readOnly) ok.disabled = true;
  foot.append(cancel, ok); dlg.append(tt, body, foot); ov.appendChild(dlg); document.body.appendChild(ov);
  const finish = (apply) => { if (apply) { const a = document.activeElement; if (a && a !== document.body && dlg.contains(a)) a.blur(); if (spec.ok && spec.ok() === false) return; } close(); if (!apply && spec.cancel) spec.cancel(); };
  cancel.addEventListener("click", () => finish(false)); ok.addEventListener("click", () => finish(true)); tt.querySelector(".kd-x").addEventListener("click", () => finish(false));
  ov.addEventListener("pointerdown", (ev) => { if (ev.target === ov) finish(false); });
  ov.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
    else if (ev.key === "Enter" && !(ev.target && ev.target.tagName === "TEXTAREA") && !(ev.target && ev.target.tagName === "BUTTON")) { ev.preventDefault(); finish(true); }
  });
  // the title bar drags the dialog around, like a desktop window
  let dragFrom = null;
  tt.addEventListener("pointerdown", (ev) => { if (ev.target.classList.contains("kd-x")) return; const r = dlg.getBoundingClientRect(); dragFrom = [ev.clientX - r.left, ev.clientY - r.top]; dlg.style.position = "fixed"; dlg.style.margin = "0"; dlg.style.left = r.left + "px"; dlg.style.top = r.top + "px"; tt.setPointerCapture(ev.pointerId); });
  tt.addEventListener("pointermove", (ev) => { if (!dragFrom) return; dlg.style.left = Math.max(0, ev.clientX - dragFrom[0]) + "px"; dlg.style.top = Math.max(0, ev.clientY - dragFrom[1]) + "px"; });
  tt.addEventListener("pointerup", () => { dragFrom = null; });
  current = { ov, dlg, body, spec };
  const api = { body, close, refocus(key) { const c = key !== undefined && body.querySelector(`[data-k="${key}"]`); if (c) { c.focus(); if (c.select && c.type === "text") c.select(); } } };
  spec.build(body, api);
  const first = body.querySelector("input:not([type=checkbox]), select, textarea, input"); if (first && !spec.readOnly) { first.focus(); if (first.select && first.type === "text") first.select(); }
  return api;
}

// ---------------------------------------------------------------- item properties (props.js rows, staged)
function openItem(ctx, item, opts) {
  const P = PROPS(); if (!P || !P.renderInto || !item) return null;
  const doc = ctx.doc, Kc = K();
  const staged = clone(item.node); let dirty = false;
  const work = () => Object.assign({}, item, { node: staged });
  const sctx = Object.assign({}, ctx, { commit() {}, setSelected() {} });
  const title = (opts && opts.title) || TITLES[item.kind] || ((P.KIND_NAMES && P.KIND_NAMES[item.kind]) || item.kind) + " Properties";
  const extra = [];
  if (item.kind === "sheet" && ctx.enterSheet) { const file = str((kids(item.node, "property").find((p) => str(p[1]) === "Sheetfile") || [])[2]); if (file) extra.push({ label: "Enter Sheet", fn: () => { close(); ctx.enterSheet(file); } }); }
  const fieldNames = (item.kind === "symbol" || item.kind === "footprint") ? kids(item.node, "property").map((p) => str(p[1])).filter((n) => !n.startsWith("ki_")) : [];
  let api = null;
  const render = (focusKey) => {
    api.body.innerHTML = "";
    const host = el("div"); api.body.appendChild(host);
    P.renderInto(host, sctx, work(), { quiet: true, stage(label, fn) { const a = document.activeElement; const key = a && a.dataset ? a.dataset.k : undefined; if (fn(staged) !== false) dirty = true; render(key); } });
    if (fieldNames.length) {
      const row = el("div", "kd-note"); row.style.marginTop = "10px"; row.textContent = "Field properties: ";
      for (const n of fieldNames) { const b = el("button", "btn sm", esc(n) + "…"); b.style.marginRight = "4px"; b.addEventListener("click", () => { commitStaged(); openField(ctx, doc.items.get(item.id) || item, n); }); row.appendChild(b); }
      api.body.appendChild(row);
    }
    if (focusKey !== undefined) api.refocus(focusKey);
  };
  const commitStaged = () => {
    if (!dirty || ctx.viewOnly) return;
    const change = Kc.replaceChange(doc, Object.assign({}, item, { node: staged, geom: [], bbox: null }));
    ctx.commit([change], (opts && opts.label) || "properties"); dirty = false;
    if (ctx.setSelected) ctx.setSelected((ctx.items || []).find((f) => f.id === item.id) || { id: item.id });
  };
  api = open({ title, width: opts && opts.width, extra, readOnly: !!ctx.viewOnly, build(body, a) { api = a; render(); }, ok() { commitStaged(); } });   // build runs inside open(): take the api from it
  return api;
}

// ---------------------------------------------------------------- field properties ("Edit Text and Field Properties")
const H_OPTS = [["left", "Left"], ["center", "Center"], ["right", "Right"]], V_OPTS = [["top", "Top"], ["center", "Center"], ["bottom", "Bottom"]];
function openField(ctx, item, name) {
  const p0 = fieldNode(item.node, name); if (!p0) { if (ctx.toast) ctx.toast("No field named " + name); return null; }
  const isPcb = !ctx.isSch, Kc = K(), doc = ctx.doc;
  const fx = fieldEffects(p0), [x, y, rot] = fieldAt(p0), hidden = fieldHidden(p0), text = fieldText(p0);
  const layers = isPcb && PROPS() && PROPS().helpers.boardLayers ? PROPS().helpers.boardLayers(doc, false) : [];
  const ro = ctx.viewOnly ? " disabled" : "";
  const sel = (id, value, opts) => `<select id="${id}"${ro}>${opts.map((o) => `<option value="${esc(o[0])}"${String(o[0]) === String(value) ? " selected" : ""}>${esc(o[1])}</option>`).join("")}</select>`;
  const numIn = (id, v, step) => `<input id="${id}" type="number" step="${step || 0.01}" value="${(+v || 0).toFixed(4).replace(/\.?0+$/, "") || 0}"${ro}>`;
  const cb = (id, on, label) => `<label style="display:flex;gap:6px;align-items:center;color:var(--ink)"><input id="${id}" type="checkbox" style="width:auto;margin:0"${on ? " checked" : ""}${ro}>${esc(label)}</label>`;
  const orient = isPcb ? numIn("kd-rot", rot, 1) : sel("kd-rot", ((Math.round(rot) % 360) + 360) % 360 === 90 || ((Math.round(rot) % 360) + 360) % 360 === 270 ? 90 : 0, [[0, "Horizontal"], [90, "Vertical"]]);
  let api = null;
  api = open({ title: "Edit Text and Field Properties", width: 520, readOnly: !!ctx.viewOnly,
    build(body) {
      body.innerHTML = `<p class="kd-note">${esc(name)} of ${esc(item.ref || item.kind)}</p>
        <div class="kv" style="margin-bottom:10px"><label>Text</label><input id="kd-text" type="text" value="${esc(text)}"${ro}>
        <label></label>${cb("kd-show", !hidden, isPcb ? "Show on board" : "Show on sheet")}</div>
        <h3>Font</h3><div class="kd-cols">
          <div class="kv"><label>Size (mm)</label>${numIn("kd-size", fx.size)}${isPcb ? `<label>Thickness (mm)</label>${numIn("kd-thick", fx.thick)}` : ""}</div>
          <div class="kv"><label></label>${cb("kd-bold", fx.bold, "Bold")}<label></label>${cb("kd-italic", fx.italic, "Italic")}${isPcb ? `<label></label>${cb("kd-mirror", fx.mirror, "Mirrored")}` : ""}</div>
        </div>
        <h3>Orientation and justification</h3><div class="kd-cols">
          <div class="kv"><label>${isPcb ? "Rotation (°)" : "Orientation"}</label>${orient}${isPcb ? `<label></label>${cb("kd-upright", fieldUnlocked(p0), "Keep upright")}` : ""}</div>
          <div class="kv"><label>Horizontal</label>${sel("kd-h", fx.h, H_OPTS)}<label>Vertical</label>${sel("kd-v", fx.v, V_OPTS)}</div>
        </div>
        <h3>Position</h3><div class="kd-cols">
          <div class="kv"><label>${isPcb ? "Offset X (mm)" : "X (mm)"}</label>${numIn("kd-x", x)}<label>${isPcb ? "Offset Y (mm)" : "Y (mm)"}</label>${numIn("kd-y", y)}</div>
          ${isPcb ? `<div class="kv"><label>Layer</label>${sel("kd-layer", fieldLayer(p0), layers.map((l) => [l, l]))}</div>` : ""}
        </div>`;
    },
    ok() {
      if (ctx.viewOnly) return;
      const g = (id) => api.body.querySelector("#" + id);
      const staged = clone(item.node); const p = fieldNode(staged, name); if (!p) return;
      const newText = g("kd-text").value;
      if (p[0] === "property" && PROPS() && PROPS().helpers.setField) PROPS().helpers.setField(staged, name, newText); else setFieldText(p, newText);
      setFieldHidden(staged, p, !g("kd-show").checked);
      const nfx = { size: Math.max(0.01, num(g("kd-size").value, fx.size)), bold: g("kd-bold").checked, italic: g("kd-italic").checked, h: g("kd-h").value, v: g("kd-v").value, mirror: isPcb ? g("kd-mirror").checked : fx.mirror };
      if (isPcb) nfx.thick = num(g("kd-thick").value, 0);
      setFieldEffects(p, nfx);
      const nrot = isPcb ? num(g("kd-rot").value, rot) : num(g("kd-rot").value, 0);
      setFieldAt(p, num(g("kd-x").value, x), num(g("kd-y").value, y), nrot);
      if (isPcb) { setFieldLayer(p, g("kd-layer").value); setFieldUnlocked(p, g("kd-upright").checked); }
      if (JSON.stringify(staged) === JSON.stringify(item.node)) return;
      ctx.commit([Kc.replaceChange(doc, Object.assign({}, item, { node: staged, geom: [], bbox: null }))], name.toLowerCase() + " field");
      if (ctx.setSelected) ctx.setSelected((ctx.items || []).find((f) => f.id === item.id) || { id: item.id });
    } });
  return api;
}

root.KDialogs = { open, close, openItem, openField, isOpen: () => !!current, TITLES,
  _: { fieldNode, fieldEffects, setFieldEffects, fieldAt, setFieldAt, fieldHidden, setFieldHidden, fieldUnlocked, setFieldUnlocked, fieldLayer, setFieldLayer, fieldText, setFieldText } };
if (typeof module !== "undefined" && module.exports) module.exports = root.KDialogs;
})(typeof window !== "undefined" ? window : globalThis);
