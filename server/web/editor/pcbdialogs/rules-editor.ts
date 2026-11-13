// pcbdialogs/rules-editor — PANEL_SETUP_RULES's text editor (a wxStyledTextCtrl with SCINTILLA_TRICKS) and its errors
// report (m_errorsReport, a WX_HTML_REPORT_BOX whose "line:col" links move the caret).  The text is drawn over a
// highlighted copy (comments, strings, clause keywords, matching parentheses at the caret); the right-click menu is
// OnContextMenu's: Undo, Redo, Cut, Copy, Paste, Delete, Select All, Zoom In, Zoom Out, Show Matching Items.
import { popupMenu } from "../../dialogs/dom";
import { h } from "./ui";

const KEYWORDS = new Set(["version", "rule", "constraint", "condition", "layer", "severity", "min", "opt", "max", "within_diff_pairs"]);
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** The highlighted HTML of a rules text (DRC_RULES lexer classes: comment, string, keyword, number, paren). */
export function highlightRules(text: string): string {
  let out = "", i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "#") { const j = text.indexOf("\n", i); const e = j < 0 ? text.length : j; out += `<span class="c">${esc(text.slice(i, e))}</span>`; i = e; continue; }
    if (c === '"') { let j = i + 1; while (j < text.length && text[j] !== '"') { if (text[j] === "\\") j++; j++; } j = Math.min(text.length, j + 1); out += `<span class="s">${esc(text.slice(i, j))}</span>`; i = j; continue; }
    if (c === "(" || c === ")") { out += `<span class="p">${c}</span>`; i++; continue; }
    const m = /^[A-Za-z_][\w.]*/.exec(text.slice(i, i + 64));
    if (m) { out += KEYWORDS.has(m[0]) && text[i - 1] === "(" ? `<span class="k">${m[0]}</span>` : esc(m[0]); i += m[0].length; continue; }
    const n = /^-?\d+(\.\d+)?(mm|mil|mils|in|um|deg)?/.exec(text.slice(i, i + 32));
    if (n && !/[\w.]/.test(text[i - 1] || "")) { out += `<span class="n">${esc(n[0])}</span>`; i += n[0].length; continue; }
    out += esc(c); i++;
  }
  return out + "\n";
}

const CSS = `
.pd-rules { position: relative; flex: 1 1 auto; min-height: 160px; border: 1px solid var(--line); border-radius: var(--r-2); background: var(--panel); overflow: hidden; }
.pd-rules > pre, .pd-rules > textarea { position: absolute; inset: 0; margin: 0; padding: 6px 8px; font-family: var(--mono); font-size: var(--rules-fs, 12px); line-height: 1.4; white-space: pre; overflow: auto; tab-size: 4; border: 0; }
.pd-rules > pre { color: var(--ink); pointer-events: none; }
.pd-rules > textarea { color: transparent; caret-color: var(--ink); background: transparent; resize: none; outline: none; width: 100%; height: 100%; }
.pd-rules > textarea::selection { background: color-mix(in srgb, var(--blue) 30%, transparent); color: transparent; }
.pd-rules .c { color: var(--ink-3); } .pd-rules .s { color: var(--teal); } .pd-rules .k { font-weight: 600; } .pd-rules .n { color: var(--copper); }
.pd-rules[data-ro] > textarea { caret-color: transparent; }
.pd-errors { border: 1px solid var(--line); border-radius: var(--r-2); background: var(--panel); overflow: auto; height: 96px; padding: 4px 8px; font-size: 12px; margin-top: 6px; }
.pd-errors .ln { white-space: pre-wrap; } .pd-errors .ln.error { color: var(--err); } .pd-errors .ln.action { color: var(--ink); } .pd-errors .ln.info { color: var(--ink-2); }
`;
let cssDone = false;
function ensureCss(): void { if (cssDone || typeof document === "undefined") return; cssDone = true; const st = document.createElement("style"); st.textContent = CSS; document.head.append(st); }

export interface RulesEditor { el: HTMLElement; ta: HTMLTextAreaElement; get(): string; set(text: string): void; gotoLine(line: number, col?: number): void; caretLine(): number }
export function rulesEditor(text: string, opts: { ro?: boolean; onShowMatching?(): void }): RulesEditor {
  ensureCss();
  const pre = h("pre", { "aria-hidden": "true" });
  const ta = h("textarea", { spellcheck: "false", readOnly: !!opts.ro, "data-key": "customRules", "data-k": "customRules", "data-nopersist": "1", wrap: "off" }) as HTMLTextAreaElement;
  ta.value = text;
  const el = h("div", { class: "pd-rules", "data-ro": opts.ro ? "1" : undefined }, pre, ta);
  let fs = 12;
  const paint = (): void => { pre.innerHTML = highlightRules(ta.value); pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft; };
  ta.addEventListener("input", paint); ta.addEventListener("scroll", () => { pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft; });
  // SCINTILLA_TRICKS: Tab inserts a tab, Ctrl+wheel zooms
  ta.addEventListener("keydown", (ev) => {
    if (ev.key === "Tab" && !ev.ctrlKey && !ev.altKey && !opts.ro) { ev.preventDefault(); ev.stopPropagation(); document.execCommand("insertText", false, "\t"); }
    else if (ev.key === "Enter") ev.stopPropagation();
  });
  const zoom = (d: number): void => { fs = Math.max(6, Math.min(32, fs + d)); el.style.setProperty("--rules-fs", fs + "px"); };
  ta.addEventListener("wheel", (ev) => { if (ev.ctrlKey || ev.metaKey) { ev.preventDefault(); zoom(ev.deltaY < 0 ? 1 : -1); } }, { passive: false });
  ta.addEventListener("contextmenu", (ev) => {
    ev.preventDefault(); ta.focus();
    const sel = ta.selectionStart !== ta.selectionEnd, ro = !!opts.ro;
    const cmd = (c: string): void => { ta.focus(); document.execCommand(c); paint(); };
    popupMenu(ev.clientX, ev.clientY, [
      { label: "Undo", disabled: ro, run: () => cmd("undo") }, { label: "Redo", disabled: ro, run: () => cmd("redo") }, { sep: true },
      { label: "Cut", disabled: ro || !sel, run: () => { void navigator.clipboard?.writeText(ta.value.slice(ta.selectionStart, ta.selectionEnd)); cmd("delete"); } },
      { label: "Copy", disabled: !sel, run: () => { void navigator.clipboard?.writeText(ta.value.slice(ta.selectionStart, ta.selectionEnd)); } },
      { label: "Paste", disabled: ro, run: () => { void navigator.clipboard?.readText().then((t) => { ta.focus(); document.execCommand("insertText", false, t); paint(); }); } },
      { label: "Delete", disabled: ro || !sel, run: () => cmd("delete") }, { sep: true },
      { label: "Select All", run: () => { ta.focus(); ta.select(); } }, { sep: true },
      { label: "Zoom In", run: () => zoom(1) }, { label: "Zoom Out", run: () => zoom(-1) }, { sep: true },
      { label: "Show Matching Items", run: () => { if (opts.onShowMatching) opts.onShowMatching(); } }]);
  });
  paint();
  const lineStart = (line: number): number => { let pos = 0; for (let l = 1; l < line; l++) { const j = ta.value.indexOf("\n", pos); if (j < 0) return ta.value.length; pos = j + 1; } return pos; };
  return { el, ta, get: () => ta.value, set(t) { ta.value = t; paint(); },
    gotoLine(line, col) { const p = Math.min(ta.value.length, lineStart(line) + Math.max(0, (col || 1) - 1)); ta.focus(); ta.setSelectionRange(p, p); const lh = fs * 1.4; ta.scrollTop = Math.max(0, (line - 3) * lh); },
    caretLine: () => ta.value.slice(0, ta.selectionStart).split("\n").length };
}

export interface RuleError { line: number; col: number; message: string }
/** The rules' problems with where they are (DRC_RULES_PARSER's PARSE_ERROR line and offset). */
export function ruleErrors(text: string, compile?: (t: string) => { errors: string[] } | null): RuleError[] {
  let depth = 0, line = 1, col = 0, inStr = false, any = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]; col++;
    if (c === "\n") { line++; col = 0; if (!inStr) continue; }
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
    if (c === "#") { while (i + 1 < text.length && text[i + 1] !== "\n") i++; continue; }
    if (c === '"') inStr = true;
    else if (c === "(") { depth++; any = true; }
    else if (c === ")") { depth--; if (depth < 0) return [{ line, col, message: "Unexpected ')'." }]; }
  }
  if (inStr) return [{ line, col, message: "Unterminated string." }];
  if (depth) return [{ line, col, message: `Expecting ')'.` }];
  if (any && !/^\s*(#[^\n]*\n\s*)*\(version\s+\d+\)/.test(text)) return [{ line: 1, col: 1, message: "Missing '(version <number>)' header." }];
  const res = compile ? compile(text) : null;
  const out: RuleError[] = [];
  for (const e of res ? res.errors : []) {
    const m = /^rule '([^']*)'/.exec(e);
    let ln = 1, cl = 1;
    if (m) { const at = text.search(new RegExp("\\(rule\\s+\"?" + m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\"?[\\s)]")); if (at >= 0) { ln = text.slice(0, at).split("\n").length; cl = at - text.lastIndexOf("\n", at - 1); } }
    out.push({ line: ln, col: cl, message: e.replace(/^rule '/, "Rule '") });
  }
  return out;
}
/** The name of the top-level (rule …) block that holds `line` (1-based); null when the line is outside every rule. */
export function ruleAtLine(text: string, line: number): string | null {
  let depth = 0, ln = 1, inStr = false, start = -1, name = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") { ln++; if (ln > line && start < 0) return null; continue; }
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
    if (c === "#") { while (i + 1 < text.length && text[i + 1] !== "\n") i++; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === "(") {
      if (depth === 0) { const m = /^\(rule\s+("([^"]*)"|[^\s()]+)/.exec(text.slice(i, i + 300)); if (m) { start = ln; name = m[2] !== undefined ? m[2] : m[1]; } else start = -1; }
      depth++;
    } else if (c === ")") { depth--; if (depth === 0) { if (start >= 0 && start <= line && ln >= line) return name; start = -1; } }
  }
  return start >= 0 && start <= line ? name : null;
}
