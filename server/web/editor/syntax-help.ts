// syntax-help — PCB_TEXT::ShowSyntaxHelp / SCH_TEXT::ShowSyntaxHelp: a modeless "Syntax Help" HTML_MESSAGE_BOX
// (320 × 320 dialog units) holding KiCad's help table.  The "Syntax help" hyperlink of the text, textbox, table and
// table-cell dialogs opens it (tooltip "Show syntax help window").
import { PCB_TEXT_HELP, SCH_TEXT_HELP } from "./syntax-help-text";

export const SYNTAX_HELP_TOOLTIP = "Show syntax help window";

/** The help's HTML for a board (true) or schematic (false). */
export function syntaxHelpHtml(isPcb: boolean): string { return isPcb ? PCB_TEXT_HELP : SCH_TEXT_HELP; }

/** Open the modeless Syntax Help window. */
export function syntaxHelp(isPcb: boolean): void {
  if (typeof document === "undefined" || typeof KDialogs === "undefined" || !KDialogs) return;
  KDialogs.open({ title: "Syntax Help", width: 640, modeless: true, okLabel: "Close",
    build(body: HTMLElement) {
      const div = document.createElement("div");
      div.className = "kd-help kd-syntax-help"; div.setAttribute("data-k", "syntax-help-body");
      div.style.cssText = "max-height:60vh;overflow:auto;font-size:12px;line-height:1.35";
      div.innerHTML = syntaxHelpHtml(isPcb);   // KiCad's own static help text
      for (const t of Array.from(div.querySelectorAll("table"))) (t as HTMLElement).style.borderSpacing = "6px 0";
      body.append(div);
    },
    ok: () => true });
}

/** The "Syntax help" hyperlink the dialogs put beside or below their text entry. */
export function syntaxHelpLink(isPcb: boolean): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = "#"; a.textContent = "Syntax help"; a.title = SYNTAX_HELP_TOOLTIP; a.setAttribute("data-k", "syntax-help");
  a.style.whiteSpace = "nowrap";
  a.addEventListener("click", (ev) => { ev.preventDefault(); syntaxHelp(isPcb); });
  return a;
}
