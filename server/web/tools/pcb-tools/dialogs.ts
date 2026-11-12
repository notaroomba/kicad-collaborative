// pcb-tools/dialogs.ts — the dialogs (KDialogs at runtime, a swappable form for the tests) and the pad properties.
import type { BoardDoc, FormSpec, PcbCtx } from "./types";
import { root } from "../root";
import { boardNets, replacedChange } from "./changes";
import { designSettings } from "./drc";
import { padsOf } from "./route-geom";
import { K, S, bind, lastCtx } from "./state";
import { clone, isList, norm180, r6 } from "./util";

// ---------------------------------------------------------------- dialogs (KDialogs at runtime, a swappable form for the tests)
// A form spec: { title, width, fields: [{ k, label, type: num | text | select | check | note | table, value, options,
// columns, rows, onRow }], apply(values) -> false keeps the dialog open }.  The default implementation lays it out
// in KDialogs.open; pcb.setForm swaps it (the node tests call spec.apply themselves).
export const KD = () => root.KDialogs;
export const PROPS = () => root.CollabTools && root.CollabTools.props && root.CollabTools.props.helpers;
export let formImpl = function (spec: FormSpec): boolean {
  const kd = KD(); if (!kd || typeof document === "undefined") { if (lastCtx) lastCtx.toast(`${spec.title}: dialogs are unavailable here`); return false; }
  const inputs: Record<string, HTMLInputElement | HTMLSelectElement | { type: "radio"; value: unknown }> = {};
  kd.open({
    title: spec.title, width: spec.width || 420, readOnly: !!spec.readOnly,
    build(body) {
      for (const f of spec.fields) {
        if (f.type === "note") { const p = document.createElement("p"); p.className = "note"; p.style.margin = "4px 0"; p.textContent = f.value as string; body.appendChild(p); continue; }
        if (f.type === "table") {
          const box = document.createElement("div"); box.style.cssText = "max-height:320px;overflow:auto;border:1px solid var(--line,#24374E);border-radius:3px;font:12px var(--mono,ui-monospace,monospace);margin:4px 0";
          const head = document.createElement("div"); head.style.cssText = `display:grid;grid-template-columns:${f.columns!.map((c) => c.width || "1fr").join(" ")};gap:0 10px;padding:3px 6px;position:sticky;top:0;background:var(--panel,#111D2C);opacity:.8`;
          head.innerHTML = f.columns!.map((c) => `<span>${esc(c.label)}</span>`).join(""); box.appendChild(head);
          f.rows!.forEach((row, i: number) => { const r = document.createElement("div"); r.style.cssText = head.style.cssText.replace("position:sticky;top:0;", "") + ";cursor:pointer;opacity:1"; r.innerHTML = row.map((v) => `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(String(v))}">${esc(String(v))}</span>`).join(""); if (f.onRow) r.addEventListener("click", () => f.onRow!(i, r)); box.appendChild(r); });
          if (!f.rows!.length) { const p = document.createElement("div"); p.style.padding = "6px"; p.className = "note"; p.textContent = f.empty || "Nothing to show."; box.appendChild(p); }
          body.appendChild(box); continue;
        }
        if (f.type === "radio") {   // a wxRadioBox: the title over one choice per line
          const box = document.createElement("fieldset"); box.style.cssText = "border:1px solid var(--line,#24374E);border-radius:3px;margin:4px 0;padding:4px 8px 6px";
          const lg = document.createElement("legend"); lg.textContent = f.label!; lg.style.padding = "0 4px"; box.appendChild(lg);
          const name = "kf-" + f.k + "-" + Math.random().toString(36).slice(2, 8); const radios: HTMLInputElement[] = [];
          for (const o of f.options as string[][]) {
            const l = document.createElement("label"); l.style.cssText = "display:flex;gap:6px;align-items:center;margin:3px 0";
            const r = document.createElement("input"); r.type = "radio"; r.name = name; r.value = o[0]; r.checked = o[0] === f.value; r.style.width = "auto"; r.style.margin = "0";
            if (o[2]) l.title = o[2];   // wxRadioBox::SetItemToolTip
            l.appendChild(r); l.appendChild(document.createTextNode(o[1])); box.appendChild(l); radios.push(r);
          }
          inputs[f.k!] = { type: "radio", get value() { const r = radios.find((x) => x.checked); return r ? r.value : f.value; } };
          body.appendChild(box); continue;
        }
        const row = document.createElement("label"); row.style.cssText = "display:grid;grid-template-columns:150px 1fr;gap:8px;align-items:center;margin:4px 0"; if (f.tip) row.title = f.tip;
        const span = document.createElement("span"); span.textContent = f.label!; row.appendChild(span);
        let inp: HTMLInputElement | HTMLSelectElement;
        if (f.type === "select") { inp = document.createElement("select"); for (const o of f.options!) { const op = document.createElement("option"); op.value = (isList(o) ? o[0] : o) as string; op.textContent = (isList(o) ? o[1] : o) as string; inp.appendChild(op); } inp.value = f.value as string; }
        else if (f.type === "check") { inp = document.createElement("input"); inp.type = "checkbox"; inp.checked = !!f.value; inp.style.width = "auto"; inp.style.justifySelf = "start"; }
        else { inp = document.createElement("input"); inp.type = f.type === "num" ? "number" : "text"; if (f.type === "num") inp.step = f.step || "any"; inp.value = (f.value === undefined || f.value === null ? "" : f.value) as string; }
        inp.dataset.k = f.k; inp.style.cssText += ";font:inherit;background:var(--panel,#0A1421);color:inherit;border:1px solid var(--line,#24374E);border-radius:3px;padding:3px 5px";
        inputs[f.k!] = inp; row.appendChild(inp); body.appendChild(row);
      }
    },
    ok() {
      const v: Record<string, unknown> = {}; for (const [k, i] of Object.entries(inputs)) v[k] = i.type === "checkbox" ? (i as HTMLInputElement).checked : i.type === "number" ? (i.value === "" ? NaN : parseFloat(i.value as string)) : i.value;
      return spec.apply ? spec.apply(v) : undefined;
    },
  });
  return true;
};
export function esc(s: unknown) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
export const openForm = <V>(spec: FormSpec<V>) => formImpl(spec as unknown as FormSpec);   // V: the values by key, as the fields give them
export const copperOf = (doc: BoardDoc) => doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
/** The design rules in force: ctx.designSettings (a .kicad_pro object, a legacy board text or our shape), pcb.setDesignSettings, else KiCad's defaults. */
export function settingsOf(ctx: PcbCtx) {
  const src = ctx && ctx.designSettings; if (src) { if (S.settingsSrc !== src) { S.settingsSrc = src; S.settingsCache = designSettings(src); } return S.settingsCache!; }
  return S.settings || (S.settings = designSettings(null));
}
export const num0 = (v: unknown, d: number) => (typeof v === "number" && !isNaN(v)) ? v : d;
export function padProperties(ctx: PcbCtx, fpItem: KItem, index: number) {
  bind(ctx); const H = PROPS(); if (!H || !H.setPad) { ctx.toast("Pad editing needs props.js"); return false; }
  const doc = ctx.doc, fp = doc.items.get(fpItem.id) || fpItem; const pads = padsOf(fp); const p = pads[index]; if (!p) return false;
  const info = H.padInfo(doc, p.node); const frot = K.atOf(fp.node)[2]; const nets = boardNets(doc).map((n) => n.name);
  const LAYER_SETS = [["F.Cu F.Paste F.Mask", "Front SMD (F.Cu F.Paste F.Mask)"], ["B.Cu B.Paste B.Mask", "Back SMD (B.Cu B.Paste B.Mask)"], ["*.Cu *.Mask", "Through hole (*.Cu *.Mask)"], ["F.Cu F.Mask", "Front copper + mask"], ["B.Cu B.Mask", "Back copper + mask"], ["*.Cu", "All copper"]];
  const cur = info.layers.join(" "); if (!LAYER_SETS.some((l) => l[0] === cur)) LAYER_SETS.unshift([cur, cur]);
  return openForm({
    title: `Pad Properties — ${fp.ref || "footprint"} pad ${info.number}`, width: 460, readOnly: !!ctx.viewOnly,
    fields: [
      { k: "number", label: "Pad number", type: "text", value: info.number },
      { k: "type", label: "Pad type", type: "select", value: info.type, options: [["smd", "SMD"], ["thru_hole", "Through-hole"], ["np_thru_hole", "NPTH, mechanical"], ["connect", "Edge connector"]] },
      { k: "shape", label: "Pad shape", type: "select", value: info.shape, options: [["circle", "Circular"], ["oval", "Oval"], ["rect", "Rectangular"], ["roundrect", "Rounded rectangle"], ["trapezoid", "Trapezoid"], ["custom", "Custom"]] },
      { k: "w", label: "Size X (mm)", type: "num", value: info.w }, { k: "h", label: "Size Y (mm)", type: "num", value: info.h },
      { k: "rot", label: "Orientation (°)", type: "num", value: r6(norm180(info.rot - frot)) },
      { k: "drill", label: "Hole size (mm, or WxH)", type: "text", value: info.drill },
      { k: "layers", label: "Copper layers", type: "select", value: cur, options: LAYER_SETS },
      { k: "net", label: "Net", type: "select", value: info.net, options: [["", "<no net>"]].concat(nets.includes(info.net) || !info.net ? [] : [[info.net, info.net]]).concat(nets.map((n) => [n, n])) },
      { k: "maskMargin", label: "Solder mask margin (mm)", type: "num", value: info.maskMargin === null ? "" : info.maskMargin },
      { k: "rratio", label: "Corner radius ratio", type: "num", value: info.rratio === null ? "" : info.rratio },
    ],
    apply(v: { number: string; type: string; shape: string; w: number; h: number; rot: number; drill: string; layers: string; net: string; maskMargin: number; rratio: number }) {
      if (ctx.viewOnly) return;
      const node = clone(fp.node); const drill = /^\s*$/.test(v.drill) ? "" : /x/i.test(v.drill) ? v.drill.split(/x/i).map((s) => parseFloat(s)) : parseFloat(v.drill);
      H.setPad(node, index, { number: v.number, type: v.type, shape: v.shape, w: num0(v.w, info.w), h: num0(v.h, info.h), rot: num0(v.rot, 0) + frot, drill, layers: v.layers.split(/\s+/).filter(Boolean), net: v.net, maskMargin: isNaN(v.maskMargin) ? null : v.maskMargin, rratio: isNaN(v.rratio) ? null : v.rratio }, doc);
      ctx.commit([replacedChange(fp, node)], "pad"); ctx.requestRender();
    },
  });
}
/** pcb.setForm: swaps the form implementation (the node tests). */
export function setFormImpl(fn: (spec: FormSpec) => boolean) { formImpl = fn; }
