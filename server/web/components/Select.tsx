// components/Select.tsx — the React face of <k-select> (components/kselect.ts), the themed drop-down the chrome uses
// wherever a <select> would go.  It takes the options as data and reports the picked value; `value` is controlled.
import { createElement, useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import { defineKSelect } from "./kselect";

defineKSelect();

/** An entry: a value and its text; `sep` draws a rule (a wxChoice "---" entry), `disabled` greys it. */
export interface SelectOption { value: string; label: string; disabled?: boolean; sep?: boolean; title?: string; /** consecutive entries with the same group sit under its caption (<optgroup>) */ group?: string }

export interface SelectProps {
  options: (SelectOption | string)[];
  value: string;
  onChange?(value: string, el: HTMLSelectElement): void;
  id?: string; className?: string; title?: string; style?: CSSProperties; disabled?: boolean;
  /** "aria-label" for a control with no visible label */
  label?: string;
  /** give the keyboard back (to the canvas) after a pick, as KiCad's toolbar choices do (m_canvas->SetFocus()) */
  blurOnPick?: boolean;
  data?: Record<string, string>;
  /** a key pressed on the closed control, before the control's own keys (a grid that dedicates Up / Down to its rows) */
  onKey?(ev: KeyboardEvent, el: HTMLSelectElement): void;
}

export function Select({ options, value, onChange, id, className, title, style, disabled, label, blurOnPick, data, onKey }: SelectProps) {
  const ref = useRef<HTMLSelectElement | null>(null);
  const cb = useRef(onChange); cb.current = onChange;
  const kb = useRef(onKey); kb.current = onKey;
  const want = useRef(value); want.current = value;
  // the options are children; set the value once they are in place, and again whenever either changes
  useLayoutEffect(() => { const el = ref.current; if (el && el.value !== value) el.value = value; });
  useLayoutEffect(() => { const el = ref.current; if (el) el.disabled = !!disabled; }, [disabled]);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    // controlled, like React's own <select>: a pick the owner does not take (an "Edit..." entry) snaps back
    const on = (): void => { const v = el.value; if (blurOnPick) el.blur(); if (cb.current) cb.current(v, el); setTimeout(() => { if (ref.current && ref.current.value !== want.current) ref.current.value = want.current; }, 0); };
    el.addEventListener("change", on); return () => el.removeEventListener("change", on);
  }, [blurOnPick]);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    // capture on the host: the key is seen before the shadow button's own handling; an open list keeps its keys
    const key = (ev: KeyboardEvent): void => { if (kb.current && !el.hasAttribute("data-popup-open")) kb.current(ev, el); };
    el.addEventListener("keydown", key, true); return () => el.removeEventListener("keydown", key, true);
  }, []);
  const attrs: Record<string, unknown> = { ref, id, class: className, title, style, "aria-label": label };
  if (data) for (const [k, v] of Object.entries(data)) attrs["data-" + k] = v;
  const opt = (o: SelectOption | string, i: number) => {
    const op = typeof o === "string" ? { value: o, label: o } : o;
    return createElement("option", { key: i + ":" + op.value, value: op.value, disabled: op.disabled || op.sep || undefined, "data-sep": op.sep ? "" : undefined, title: op.title }, op.sep ? "---" : op.label);
  };
  // runs of the same group become an <optgroup>
  const kids: ReturnType<typeof createElement>[] = [];
  for (let i = 0; i < options.length; ) {
    const o = options[i], g = typeof o === "string" ? undefined : o.group;
    if (!g) { kids.push(opt(o, i)); i++; continue; }
    const run: ReturnType<typeof createElement>[] = [];
    while (i < options.length && typeof options[i] !== "string" && (options[i] as SelectOption).group === g) { run.push(opt(options[i], i)); i++; }
    kids.push(createElement("optgroup", { key: "g" + i + ":" + g, label: g }, run));
  }
  return createElement("k-select", attrs, kids);
}
