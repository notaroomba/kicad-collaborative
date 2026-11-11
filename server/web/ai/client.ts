// client.ts — the assistant's conversation engine and its state.
//
// One call to the server is one model turn (src/ai.rs): the conversation goes up, the reply
// streams back as the Messages API's own server-sent events.  When the model asks for a design
// tool, it runs here against the live document and the loop calls again with the result.  Web
// search and web fetch run on Anthropic's side and arrive already answered.
//
// The history sent back is exactly what was received, block for block (thinking blocks with
// their signatures, server tool calls and their results): the API ties a reply's thinking to the
// conversation that produced it, so an edited history is a rejected one.  New material is only
// ever appended.

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as design from "./design";
import { ToolError } from "./design";
import { applyProposal, buildProposal, clearPreview, previewing, showPreview, staleReason, type Proposal } from "./proposals";

export type UiBlock =
  | { t: "text"; text: string; sources?: { url: string; title: string }[] }
  | { t: "thinking"; text: string; done: boolean }
  | { t: "tool"; id: string; name: string; label: string; detail?: string; status: "running" | "done" | "error"; server: boolean }
  | { t: "proposal"; proposalId: string }
  | { t: "notice"; text: string; tone: "error" | "info" };
export interface UiMessage { role: "user" | "assistant"; blocks: UiBlock[] }

export interface AiStatus {
  available: boolean; source: "own" | "server" | "none"; ownKeyHint: string | null; serverKey: boolean;
  model: string; webTools: boolean; usage: { requestsToday: number; dailyLimit: number };
}

export interface AiState {
  open: boolean; width: number; projectId: string | null;
  status: AiStatus | null; statusError: string | null;
  messages: UiMessage[]; busy: boolean; activity: string;
  proposals: Record<string, Proposal>; previewId: string | null; settings: boolean;
}

const LS_OPEN = "kui.ai.open", LS_WIDTH = "kui.ai.width", lsChat = (pid: string) => `kui.ai.chat.${pid}`;
const ls = { get(k: string) { try { return localStorage.getItem(k); } catch { return null; } }, set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* full or blocked */ } }, del(k: string) { try { localStorage.removeItem(k); } catch { /* blocked */ } } };

let S: AiState = { open: ls.get(LS_OPEN) === "1", width: Math.min(640, Math.max(300, Number(ls.get(LS_WIDTH)) || 380)), projectId: null, status: null, statusError: null,
  messages: [], busy: false, activity: "", proposals: {}, previewId: null, settings: false };
/** The conversation as the API sees it.  Kept beside the UI messages, never derived from them. */
let history: any[] = [];
/** What happened to proposals since the last message, told to the model at the start of the next one. */
let decisions: string[] = [];
let abort: AbortController | null = null;

const subs = new Set<() => void>(); let scheduled = false;
function emit() { if (scheduled) return; scheduled = true; queueMicrotask(() => { scheduled = false; subs.forEach((f) => f()); }); }
/** The streaming code edits the reply's blocks in place; this publishes them (a fresh array, so React sees a change). */
function touch() { S = Object.assign({}, S, { messages: S.messages.slice() }); emit(); }
function set(patch: Partial<AiState>) { S = Object.assign({}, S, patch); emit(); }
export const aiStore = { get: () => S, subscribe(fn: () => void) { subs.add(fn); return () => { subs.delete(fn); }; } };

// ---------------------------------------------------------------- persistence (per project, in this browser)

let saveTimer = 0;
function save() {
  if (!S.projectId) return; const pid = S.projectId;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const blob = JSON.stringify({ v: 1, messages: S.messages, history, proposals: S.proposals, decisions });
    // a conversation with fetched datasheets in it can outgrow localStorage: then it simply is not kept
    if (blob.length < 3_000_000) ls.set(lsChat(pid), blob); else ls.del(lsChat(pid));
  }, 400);
}
function load(pid: string) {
  history = []; decisions = []; let messages: UiMessage[] = [], proposals: Record<string, Proposal> = {};
  try {
    const j = JSON.parse(ls.get(lsChat(pid)) || "null");
    if (j && j.v === 1 && Array.isArray(j.messages) && Array.isArray(j.history)) {
      messages = j.messages; history = j.history; proposals = j.proposals || {}; decisions = j.decisions || [];
      // a reload mid-reply leaves tool chips spinning and thoughts open: settle them
      for (const m of messages) for (const b of m.blocks) { if (b.t === "tool" && b.status === "running") b.status = "error"; if (b.t === "thinking") b.done = true; }
      // and a history that ends on an unanswered tool call cannot be continued: drop back to the last complete turn
      while (history.length && !endsCleanly(history)) history.pop();
    }
  } catch { /* unreadable: start fresh */ }
  set({ messages, proposals, previewId: null, busy: false, activity: "" });
}
function endsCleanly(h: any[]): boolean {
  const last = h[h.length - 1]; if (!last) return true;
  if (last.role !== "assistant") return false;
  return !(Array.isArray(last.content) && last.content.some((b: any) => b.type === "tool_use"));
}

// ---------------------------------------------------------------- pane, project, status

export function setOpen(open: boolean) {
  ls.set(LS_OPEN, open ? "1" : "0"); if (!open) hidePreview();
  set({ open });
  if (open && !S.status) refreshStatus();
  syncToggle();
}
export const toggleOpen = () => setOpen(!S.open);
export function setWidth(w: number) { const width = Math.min(720, Math.max(300, Math.round(w))); ls.set(LS_WIDTH, String(width)); set({ width }); }
export function showSettings(on: boolean) { set({ settings: on }); }
/** The View menu's check mark reads the editor store's toggles. */
function syncToggle() {
  const st = design.ED()?.api?.store; if (!st) return;
  const t = st.get().toggles || {}; if (!!t.showAssistant !== S.open) st.set({ toggles: Object.assign({}, t, { showAssistant: S.open }) });
}

export function setProject(pid: string | null) {
  if (pid === S.projectId) return;
  stop(); hidePreview();
  S = Object.assign({}, S, { projectId: pid });
  if (pid) load(pid); else { history = []; decisions = []; set({ messages: [], proposals: {} }); }
  syncToggle();
}

export async function refreshStatus() {
  try {
    const r = await fetch("/api/ai");
    if (r.status === 401) { set({ status: null, statusError: "Sign in to use the assistant." }); return; }
    if (!r.ok) throw new Error(String(r.status));
    set({ status: await r.json(), statusError: null });
  } catch { set({ statusError: "The assistant is not available on this server." }); }
}

export async function saveKey(key: string): Promise<string | null> {
  const r = await fetch("/api/ai/key", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
  if (!r.ok) { const j = await r.json().catch(() => null); return (j && j.message) || `Could not save the key (${r.status}).`; }
  await refreshStatus(); return null;
}
export async function removeKey() { await fetch("/api/ai/key", { method: "DELETE" }); await refreshStatus(); }

export function newChat() {
  stop(); hidePreview(); history = []; decisions = [];
  set({ messages: [], proposals: {} });
  if (S.projectId) ls.del(lsChat(S.projectId));
}

// ---------------------------------------------------------------- proposals

export function preview(id: string | null) {
  const p = id ? S.proposals[id] : null;
  if (!p) { hidePreview(); return; }
  showPreview(p); set({ previewId: previewing() });
}
function hidePreview() { clearPreview(); if (S.previewId) set({ previewId: null }); }

function settle(id: string, status: Proposal["status"], note?: string) {
  const p = S.proposals[id]; if (!p) return;
  set({ proposals: Object.assign({}, S.proposals, { [id]: Object.assign({}, p, { status, note }) }) });
  save();
}
export function accept(id: string) {
  const p = S.proposals[id]; if (!p || p.status !== "pending") return;
  const r = applyProposal(p);
  if (!r.ok) {
    // an item changed under the proposal: it must not be applied over someone's newer work
    if (/edited since|deleted since|already been applied/.test(r.reason || "")) { settle(id, "stale", r.reason); decisions.push(`The proposal "${p.title}" could not be applied: ${r.reason} It was discarded; propose it again from the current design if it is still wanted.`); hidePreview(); }
    else set({ proposals: Object.assign({}, S.proposals, { [id]: Object.assign({}, p, { note: r.reason }) }) });
    return;
  }
  settle(id, "accepted"); set({ previewId: null });
  decisions.push(`The proposal "${p.title}" was accepted and applied to ${p.docPath}.`);
}
export function reject(id: string) {
  const p = S.proposals[id]; if (!p || p.status !== "pending") return;
  settle(id, "rejected"); if (S.previewId === id) hidePreview();
  decisions.push(`The proposal "${p.title}" was rejected; nothing was changed.`);
}
export const whyBlocked = (p: Proposal): string | null => (p.status === "pending" ? staleReason(p) : null);

// ---------------------------------------------------------------- tools

type ToolFn = (input: any) => unknown | Promise<unknown>;
const TOOLS: Record<string, { run: ToolFn; label: (input: any) => string; summary?: (out: any) => string }> = {
  get_design_overview: { run: () => design.overview(), label: () => "Looked over the design" },
  list_components: { run: (i) => design.listComponents(i), label: (i) => `Read the components${i.doc ? ` of ${i.doc}` : ""}${i.filter ? ` matching “${i.filter}”` : ""}`, summary: (o) => `${o.count} found` },
  get_component: { run: (i) => design.getComponent(i), label: (i) => `Inspected ${i.ref}` },
  list_nets: { run: (i) => design.listNets(i), label: (i) => `Read the nets${i.doc ? ` of ${i.doc}` : ""}${i.filter ? ` matching “${i.filter}”` : ""}`, summary: (o) => `${o.count} nets` },
  run_checks: { run: (i) => design.runChecks(i), label: (i) => `Ran the rules check${i.doc ? ` on ${i.doc}` : ""}`, summary: (o) => `${o.check}: ${o.errors} error${o.errors === 1 ? "" : "s"}, ${o.warnings} warning${o.warnings === 1 ? "" : "s"}` },
  get_board_info: { run: () => design.boardInfo(), label: () => "Read the board's statistics and rules" },
  get_selection: { run: () => design.getSelection(), label: () => "Looked at the selection", summary: (o) => (o.count ? `${o.count} selected` : "nothing selected") },
  get_items: { run: (i) => design.getItems(i), label: (i) => `Read ${i.kinds ? i.kinds.join(", ") + " items" : i.net ? `the items on ${i.net}` : "items"}${i.near ? " around a point" : ""}`, summary: (o) => `${o.count} found` },
  find_datasheets: { run: (i) => design.findDatasheets(i), label: () => "Looked up datasheet links", summary: (o) => `${o.with_datasheet_link} linked, ${o.without} without` },
  focus_view: { run: (i) => design.focusView(i), label: (i) => `Showed ${i.refs && i.refs.length ? i.refs.join(", ") : "a point"} on the canvas` },
  open_document: { run: (i) => design.openDocument(i), label: (i) => `Opened ${i.doc}` },
  propose_changes: { run: () => { throw new Error("handled by the loop"); }, label: (i) => `Prepared a proposal: ${i.title || "changes"}` },
};

const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
function serverToolLabel(name: string, input: any): string | null {
  if (name === "web_search") return `Searched the web for “${input && input.query ? input.query : "…"}”`;
  if (name === "web_fetch") return `Read ${input && input.url ? hostOf(input.url) : "a page"}`;
  return null;   // the code the web tools run to filter their results is plumbing, not something to show
}

async function runTool(name: string, input: any, ui: UiMessage): Promise<{ content: string; is_error?: boolean }> {
  try {
    if (name === "propose_changes") {
      const p = buildProposal(input || {});
      S = Object.assign({}, S, { proposals: Object.assign({}, S.proposals, { [p.id]: p }) });
      ui.blocks.push({ t: "proposal", proposalId: p.id });
      const viewOnly = !!design.ED()?.viewOnly;
      return { content: JSON.stringify({ proposal_id: p.id, status: "shown", document: p.docPath, edits: p.lines.map((l) => l.text),
        note: viewOnly ? "The card is shown, but this person has view-only access and cannot accept it; someone with edit access would have to." : "The card is shown. It is not applied until a person accepts it; you will be told in a later message whether it was accepted or rejected." }) };
    }
    const t = TOOLS[name]; if (!t) return { content: `Unknown tool ${name}.`, is_error: true };
    const out = await t.run(input || {});
    let content = JSON.stringify(out);
    if (content.length > 120_000) content = content.slice(0, 120_000) + "… (cut: too long; ask for less with a filter)";
    return { content };
  } catch (e) {
    if (!(e instanceof ToolError)) console.warn("assistant: tool failed", name, e);
    return { content: e instanceof ToolError ? e.message : `The tool failed: ${e instanceof Error ? e.message : String(e)}`, is_error: true };
  }
}

// ---------------------------------------------------------------- one streamed turn

class ApiFailure extends Error { constructor(message: string, public code: string) { super(message); } }

/** POST the conversation, follow the event stream, and return the assistant message it describes. */
async function streamTurn(ui: UiMessage, signal: AbortSignal): Promise<{ content: any[]; stop: string }> {
  const r = await fetch(`/api/projects/${S.projectId}/ai/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: history }), signal });
  if (!r.ok || !r.body) {
    const j = await r.json().catch(() => null);
    throw new ApiFailure((j && j.message) || `The assistant request failed (${r.status}).`, (j && j.error) || String(r.status));
  }
  const blocks: any[] = []; const partial: Record<number, string> = {}; const uiOf: Record<number, UiBlock | null> = {};
  let stop = "end_turn";
  const onEvent = (ev: any) => {
    switch (ev.type) {
      case "content_block_start": {
        const b = Object.assign({}, ev.content_block); blocks[ev.index] = b; let u: UiBlock | null = null;
        if (b.type === "text") u = { t: "text", text: b.text || "" };
        else if (b.type === "thinking") u = { t: "thinking", text: b.thinking || "", done: false };
        else if (b.type === "tool_use") { partial[ev.index] = ""; u = { t: "tool", id: b.id, name: b.name, label: TOOLS[b.name] ? "Working…" : b.name, status: "running", server: false }; }
        else if (b.type === "server_tool_use") { partial[ev.index] = ""; if (serverToolLabel(b.name, null)) u = { t: "tool", id: b.id, name: b.name, label: b.name === "web_search" ? "Searching the web…" : "Reading a page…", status: "running", server: true }; }
        else if (/_tool_result$/.test(b.type)) {
          const call = ui.blocks.find((x) => x.t === "tool" && x.id === b.tool_use_id) as Extract<UiBlock, { t: "tool" }> | undefined;
          if (call) { const err = b.content && !Array.isArray(b.content) && /error/.test(String(b.content.type || "")); call.status = err ? "error" : "done"; if (err) call.detail = String(b.content.error_code || "failed").replace(/_/g, " "); else if (Array.isArray(b.content)) call.detail = `${b.content.length} result${b.content.length === 1 ? "" : "s"}`; }
        }
        uiOf[ev.index] = u; if (u) ui.blocks.push(u);
        set({ activity: u && u.t === "thinking" ? "Thinking…" : u && u.t === "tool" ? u.label : S.activity });
        touch();
        break;
      }
      case "content_block_delta": {
        const b = blocks[ev.index], u = uiOf[ev.index], d = ev.delta || {}; if (!b) break;
        if (d.type === "text_delta") { b.text = (b.text || "") + d.text; if (u && u.t === "text") u.text = b.text; }
        else if (d.type === "thinking_delta") { b.thinking = (b.thinking || "") + d.thinking; if (u && u.t === "thinking") u.text = b.thinking; }
        else if (d.type === "signature_delta") b.signature = (b.signature || "") + d.signature;
        else if (d.type === "input_json_delta") partial[ev.index] = (partial[ev.index] || "") + d.partial_json;
        else if (d.type === "citations_delta" && d.citation) {
          (b.citations = b.citations || []).push(d.citation);
          const url = d.citation.url || (d.citation.source && d.citation.source.url);
          if (u && u.t === "text" && url && !(u.sources || []).some((s) => s.url === url)) (u.sources = u.sources || []).push({ url, title: d.citation.title || d.citation.document_title || hostOf(url) });
        }
        touch();
        break;
      }
      case "content_block_stop": {
        const b = blocks[ev.index], u = uiOf[ev.index]; if (!b) break;
        if (b.type === "tool_use" || b.type === "server_tool_use") {
          const raw = partial[ev.index];
          if (raw) { try { b.input = JSON.parse(raw); } catch { b.input = {}; b.__bad = true; } } else if (b.input === undefined) b.input = {};
          if (u && u.t === "tool") { const label = u.server ? serverToolLabel(b.name, b.input) : TOOLS[b.name] ? TOOLS[b.name].label(b.input) : null; if (label) u.label = label; }
        }
        if (u && u.t === "thinking") u.done = true;
        touch();
        break;
      }
      case "message_delta": if (ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason; break;
      case "error": throw new ApiFailure((ev.error && ev.error.message) || "The model service reported an error.", (ev.error && ev.error.type) || "stream_error");
      default: break;
    }
  };
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let at: number;
    while ((at = buf.search(/\r?\n\r?\n/)) >= 0) {
      const frame = buf.slice(0, at); buf = buf.slice(at).replace(/^\r?\n\r?\n/, "");
      const data = frame.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") continue;
      let ev: any; try { ev = JSON.parse(data); } catch { continue; }
      onEvent(ev);
    }
  }
  // What goes back into the history: every block as received, minus text blocks that stayed empty
  // (the API refuses an empty text block on the way back in).
  const content = blocks.filter((b) => b && !(b.type === "text" && !b.text));
  return { content, stop };
}

// ---------------------------------------------------------------- the loop

export function stop() { if (abort) { abort.abort(); abort = null; } }

export async function send(text: string): Promise<void> {
  const say = text.trim(); if (!say || S.busy || !S.projectId) return;
  const user: UiMessage = { role: "user", blocks: [{ t: "text", text: say }] };
  const ui: UiMessage = { role: "assistant", blocks: [] };
  const notes = decisions.splice(0);
  const preface = [design.contextBlock(), ...notes.map((n) => `<proposal_update>${n}</proposal_update>`)].filter(Boolean).join("\n");
  const mark = history.length;
  history.push({ role: "user", content: [{ type: "text", text: preface ? `${preface}\n\n${say}` : say }] });
  set({ messages: [...S.messages, user, ui], busy: true, activity: "Thinking…" });
  const ctl = (abort = new AbortController());
  let completedTurns = 0;
  try {
    for (let round = 0; round < 40; round++) {
      const { content, stop: why } = await streamTurn(ui, ctl.signal);
      history.push({ role: "assistant", content: content.map(clean) }); completedTurns++;
      if (why === "tool_use") {
        const results: any[] = [];
        for (const b of content) {
          if (b.type !== "tool_use") continue;
          const chip = ui.blocks.find((x) => x.t === "tool" && x.id === b.id) as Extract<UiBlock, { t: "tool" }> | undefined;
          const res = b.__bad ? { content: "The tool input was not valid JSON; call the tool again.", is_error: true } : await runTool(b.name, b.input, ui);
          if (chip) { chip.status = res.is_error ? "error" : "done"; if (res.is_error) chip.detail = res.content.split("\n")[0].slice(0, 140); else { const t = TOOLS[b.name]; if (t && t.summary) { try { chip.detail = t.summary(JSON.parse(res.content)); } catch { /* cut output */ } } } }
          results.push({ type: "tool_result", tool_use_id: b.id, content: res.content, ...(res.is_error ? { is_error: true } : {}) });
          touch();
        }
        // every result goes back in one message, in the order the calls were made
        history.push({ role: "user", content: results });
        save();
        if (ctl.signal.aborted) break;
        set({ activity: "Thinking…" });
        continue;
      }
      if (why === "pause_turn") continue;   // a long server-side tool run: the same conversation resumes it
      if (why === "max_tokens") ui.blocks.push({ t: "notice", tone: "info", text: "The reply was cut off at its length limit. Ask it to continue." });
      if (why === "refusal") ui.blocks.push({ t: "notice", tone: "info", text: "The assistant declined to answer this." });
      break;
    }
  } catch (e) {
    const aborted = ctl.signal.aborted || (e instanceof DOMException && e.name === "AbortError");
    // A turn that did not complete is not part of the conversation.  If nothing completed, the question goes too.
    if (!completedTurns) history.length = mark;
    else while (history.length > mark + 1 && !endsCleanly(history)) history.pop();
    for (const b of ui.blocks) { if (b.t === "tool" && b.status === "running") b.status = "error"; if (b.t === "thinking") b.done = true; }
    if (aborted) ui.blocks.push({ t: "notice", tone: "info", text: "Stopped." });
    else {
      const f = e instanceof ApiFailure ? e : null; if (!f) console.warn("assistant: request failed", e);
      ui.blocks.push({ t: "notice", tone: "error", text: f ? f.message : "The connection to the assistant was lost. Try again." });
      if (f && (f.code === "ai_not_configured" || f.code === "ai_key_rejected" || f.code === "ai_daily_limit")) set({ settings: true });
    }
  } finally {
    if (abort === ctl) abort = null;
    for (const b of ui.blocks) if (b.t === "thinking") b.done = true;
    set({ busy: false, activity: "", messages: S.messages.slice() });
    save(); refreshStatus();
  }
}
/** Drop the bookkeeping fields this file adds to a block before it goes back to the API. */
function clean(b: any): any { if (b && b.__bad !== undefined) { const c = Object.assign({}, b); delete c.__bad; return c; } return b; }

/** For the browser test and the console: run one design tool against the open document. */
(window as any).KcAssistant = { tool: (name: string, input: unknown) => { const t = TOOLS[name]; if (!t) throw new Error(`unknown tool ${name}`); return t.run(input || {}); }, state: () => S };
