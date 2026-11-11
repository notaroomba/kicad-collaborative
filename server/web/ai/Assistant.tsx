// Assistant.tsx — the Assistant dock: a chat about the open schematic or board, at the right edge
// of the editor.  It reads the design through tools (web/ai/design.ts), reads datasheets through
// the model's web tools, and changes nothing by itself: an edit arrives as a proposal card with
// Preview / Accept / Reject, and an accepted one goes through the editor's own commit path.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { useApp } from "../store";
import { cx } from "../util";
import { Markdown } from "./markdown";
import { accept, aiStore, newChat, preview, refreshStatus, reject, removeKey, saveKey, send, setOpen, setProject, setWidth, showSettings, stop, toggleOpen, whyBlocked,
  type AiState, type UiBlock, type UiMessage } from "./client";
import { refreshPreview, type Proposal } from "./proposals";

const useAi = <T,>(sel: (s: AiState) => T): T => useSyncExternalStore(aiStore.subscribe, () => sel(aiStore.get()), () => sel(aiStore.get()));

const QUICK: Record<"sch" | "pcb", [string, string][]> = {
  sch: [
    ["Review this sheet", "Review this schematic sheet. Read the components, the nets and the ERC results, then tell me what would stop it working, what is risky, and what is only polish, most important first."],
    ["Check the parts against their datasheets", "For the ICs and other non-trivial parts on this sheet, read their datasheets and check the design against them: pin functions, supply and decoupling requirements, absolute maximum ratings, and the recommended application circuit. Say which page each finding comes from."],
    ["Tidy this schematic", "Tidy this schematic so it reads like a professional production schematic: signal flow left to right, supplies up and ground down, parts grouped by function and aligned on the grid, decoupling next to its pins, short straight wires with labels instead of long runs, and readable reference and value text. Connectivity must not change. Start with the block that needs it most and propose the changes one block at a time."],
    ["Explain the selection", "Explain what the selected part or circuit does and how it is connected here."],
    ["Find missing decoupling and pull-ups", "Check every IC on this sheet for missing or wrong decoupling capacitors and for pins that need a pull-up or pull-down and do not have one."],
  ],
  pcb: [
    ["Review this board", "Review this board. Read the board statistics, the design rules, the nets and the DRC results, then tell me what would stop it working or being manufactured, what is risky, and what is only polish, most important first."],
    ["Summarise the DRC problems", "Run the design rules check and summarise the violations by cause, with what to do about each."],
    ["Route the unrouted nets", "Route the connections that are still unrouted on this board with the autorouter. First tell me which nets are unrouted and which of them should be routed by hand or first, then propose the routing, critical nets first."],
    ["Check power track widths", "Find the power and ground nets, look at the track widths and vias they use, and tell me whether they suit the currents these parts are likely to draw. Use the datasheets where the current is not obvious."],
    ["Explain the selection", "Explain what the selected footprint or copper is and what it connects to."],
  ],
};

const Glyphs = {
  plus: <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>,
  gear: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></svg>,
  send: <svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6" /></svg>,
  stop: <svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1" /></svg>,
};

function Tool({ b }: { b: Extract<UiBlock, { t: "tool" }> }) {
  return <div className={cx("ai-tool", b.status)} data-tool={b.name}><span className="dot" /><span className="what">{b.label}{b.detail ? <span className="detail"> · {b.detail}</span> : null}</span></div>;
}

function ProposalCard({ id }: { id: string }) {
  const p = useAi((s) => s.proposals[id]) as Proposal | undefined;
  const previewId = useAi((s) => s.previewId);
  const viewOnly = useApp((s) => s.viewOnly);
  useApp((s) => s.document.version); useApp((s) => s.document.docId);   // staleness depends on the live document
  if (!p) return null;
  const pending = p.status === "pending"; const blocked = pending ? whyBlocked(p) : null;
  const tag = { pending: "proposal", accepted: "applied", rejected: "rejected", stale: "out of date" }[p.status];
  const mark = { add: "+", modify: "~", remove: "−" };
  return (
    <div className={cx("ai-card", p.status)} data-proposal={p.id}>
      <header><b>{p.title}</b><span className="tag">{tag}</span></header>
      {p.rationale ? <div className="why">{p.rationale}</div> : null}
      <div className="doc">{p.docPath} · {p.lines.length} edit{p.lines.length === 1 ? "" : "s"}</div>
      <ul>{p.lines.map((l, i) => <li key={i} className={l.kind}><i>{mark[l.kind]}</i><span>{l.text}</span></li>)}</ul>
      {p.connectivity ? (p.connectivity.length
        ? <div className="conn changed" title={p.connectivity.join("\n")}>Changes {p.connectivity.length} connection{p.connectivity.length === 1 ? "" : "s"}: {p.connectivity.slice(0, 3).join(" · ")}{p.connectivity.length > 3 ? " …" : ""}</div>
        : <div className="conn">Connections unchanged</div>) : null}
      {pending ? (
        <footer>
          <button type="button" className={cx("ai-btn", previewId === p.id && "on")} disabled={!!blocked && !/edited since|deleted since/.test(blocked)} onClick={() => preview(previewId === p.id ? null : p.id)}>Preview</button>
          <span className="msg">{p.note || blocked || (viewOnly ? "View-only: you cannot apply this." : "")}</span>
          <button type="button" className="ai-btn" onClick={() => reject(p.id)}>Reject</button>
          <button type="button" className="ai-btn primary" disabled={viewOnly || (!!blocked && /^Open /.test(blocked))} onClick={() => accept(p.id)}>Accept</button>
        </footer>
      ) : p.note ? <footer><span className="msg">{p.note}</span></footer>
        : p.status === "accepted" ? <footer><span className="msg">Applied as one step. Undo (Ctrl+Z) reverts it.</span></footer> : null}
    </div>
  );
}

function Message({ m }: { m: UiMessage }) {
  if (m.role === "user") return <div className="ai-msg user">{m.blocks.map((b) => (b.t === "text" ? b.text : "")).join("")}</div>;
  const out: ReactNode[] = [];
  m.blocks.forEach((b, i) => {
    if (b.t === "text") { if (!b.text.trim()) return; out.push(<div className="ai-md" key={i}><Markdown text={b.text} /></div>); if (b.sources && b.sources.length) out.push(<div className="ai-src" key={i + "s"}>{b.sources.map((s) => <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer" title={s.url}>{s.title}</a>)}</div>); }
    else if (b.t === "thinking") { if (b.text.trim()) out.push(<details className="ai-think" key={i}><summary>{b.done ? "Thought it through" : "Thinking…"}</summary><div>{b.text}</div></details>); }
    else if (b.t === "tool") out.push(<Tool b={b} key={i} />);
    else if (b.t === "proposal") out.push(<ProposalCard id={b.proposalId} key={i} />);
    else out.push(<div className={cx("ai-notice", b.tone)} key={i}>{b.text}</div>);
  });
  return <div className="ai-msg assistant">{out}</div>;
}

function Settings() {
  const status = useAi((s) => s.status); const statusError = useAi((s) => s.statusError);
  const [key, setKey] = useState(""); const [err, setErr] = useState<string | null>(null); const [saving, setSaving] = useState(false);
  const submit = async () => { if (!key.trim() || saving) return; setSaving(true); const e = await saveKey(key.trim()); setSaving(false); setErr(e); if (!e) setKey(""); };
  return (
    <div className="ai-set" id="aiSettings">
      {statusError ? <div className="bad">{statusError}</div> : null}
      {status ? (
        <>
          <div>
            {status.source === "own" ? <>Using <b>your own API key</b> (ending …{status.ownKeyHint}). It is stored encrypted on the server and used only for your requests.</>
              : status.source === "server" ? <>Using <b>this server's key</b>: {status.usage.requestsToday} of {status.usage.dailyLimit} requests used today.</>
              : <><b>No API key yet.</b> Paste an Anthropic API key below to use the assistant, or ask the server's owner to set one for everyone.</>}
          </div>
          {status.source === "own" ? <div className="row"><button type="button" className="ai-btn" onClick={() => removeKey()}>Remove my key</button>{status.serverKey ? <span>Without it, the server's key is used.</span> : null}</div> : (
            <div className="row">
              <input type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-…" value={key} aria-label="Anthropic API key" onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
              <button type="button" className="ai-btn" disabled={!key.trim() || saving} onClick={submit}>{status.source === "server" ? "Use my key" : "Save"}</button>
            </div>
          )}
          {err ? <div className="bad">{err}</div> : null}
          <div>Model: <b>{status.model}</b>{status.webTools ? " · web search and datasheet reading on" : ""}</div>
        </>
      ) : !statusError ? <div>Checking…</div> : null}
    </div>
  );
}

function Composer() {
  const busy = useAi((s) => s.busy); const activity = useAi((s) => s.activity); const available = useAi((s) => !!s.status && s.status.available);
  const signedIn = useApp((s) => !!s.me);
  const [text, setText] = useState(""); const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { const el = ref.current; if (!el) return; el.style.height = "auto"; el.style.height = Math.min(140, el.scrollHeight) + "px"; }, [text]);
  const go = () => { if (busy || !text.trim()) return; const t = text; setText(""); void send(t); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => { e.stopPropagation(); if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); go(); } };
  return (
    <div className="ai-foot">
      <div className="ai-box">
        <textarea ref={ref} id="aiInput" rows={1} value={text} disabled={!signedIn} placeholder={signedIn ? (available ? "Ask about this design…" : "Add an API key in settings to start") : "Sign in to use the assistant"}
          onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onKeyUp={(e) => e.stopPropagation()} />
        {busy ? <button type="button" className="ai-send stop" id="aiStop" title="Stop" onClick={() => stop()}>{Glyphs.stop}</button>
          : <button type="button" className="ai-send" id="aiSend" title="Send (Enter)" disabled={!text.trim() || !signedIn} onClick={go}>{Glyphs.send}</button>}
      </div>
      <div className="ai-hint">{busy ? <span className="busy">{activity || "Working…"}</span> : <span>Enter to send · Shift+Enter for a new line</span>}<span className="sp" /><span>Changes are proposed, never applied silently</span></div>
    </div>
  );
}

/** The menu bar's button: the quickest way in, lit while the dock is open. */
export function AssistantToggle() {
  const open = useAi((s) => s.open);
  return (
    <button type="button" id="aiToggle" className={cx("ai-toggle", open && "on")} title="Design assistant" aria-pressed={open} onClick={() => toggleOpen()}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></svg>
      Assistant
    </button>
  );
}

export function AssistantDock() {
  const view = useApp((s) => s.view); const editor = useApp((s) => s.document.editor); const projectId = useApp((s) => (s.project ? s.project.projectId : null));
  const me = useApp((s) => s.me); const zoom = useApp((s) => s.viewport.zoom); const docId = useApp((s) => s.document.docId);
  const open = useAi((s) => s.open); const width = useAi((s) => s.width); const messages = useAi((s) => s.messages); const busy = useAi((s) => s.busy);
  const settings = useAi((s) => s.settings); const status = useAi((s) => s.status);
  const body = useRef<HTMLDivElement>(null); const stick = useRef(true); const [drag, setDrag] = useState(false);

  useEffect(() => { setProject(view === "editor" ? projectId : null); }, [view, projectId]);
  useEffect(() => { if (open && me) void refreshStatus(); }, [open, me]);
  useEffect(() => { refreshPreview(); }, [zoom]);
  useEffect(() => { preview(null); }, [docId]);
  // The View menu entry and the keyboard shortcut reach the pane through this event.
  useEffect(() => { const h = () => toggleOpen(); window.addEventListener("kc-assistant-toggle", h); return () => window.removeEventListener("kc-assistant-toggle", h); }, []);
  // Follow the reply as it streams, unless the person has scrolled up to read something.
  useLayoutEffect(() => { const el = body.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [messages]);
  // A resize of the dock changes the stage's size: let the canvas re-measure.
  useEffect(() => { window.dispatchEvent(new Event("resize")); }, [open, width, view]);

  const shown = view === "editor" && !!editor && open;
  const startDrag = (ev: React.PointerEvent) => {
    ev.preventDefault(); setDrag(true); const x0 = ev.clientX, w0 = width;
    const move = (e: PointerEvent) => setWidth(w0 + (x0 - e.clientX));
    const up = () => { setDrag(false); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const quick = editor ? QUICK[editor] : [];
  const needKey = !!status && !status.available;
  return (
    <aside id="dockAI" hidden={!shown} style={{ width }} onKeyDown={(e) => e.stopPropagation()}>
      <div className={cx("ai-grip", drag && "on")} onPointerDown={startDrag} />
      <div className="ai-head">
        Assistant<span className="ai-model">{status ? status.model : ""}</span><span className="ai-sp" />
        <button type="button" className="ai-ib" id="aiNew" title="New chat" disabled={busy} onClick={() => newChat()}>{Glyphs.plus}</button>
        <button type="button" className="ai-ib" id="aiGear" title="Assistant settings" onClick={() => showSettings(!settings)}>{Glyphs.gear}</button>
        <button type="button" className="ai-ib x" title="Close" onClick={() => setOpen(false)}>×</button>
      </div>
      {settings || needKey ? <Settings /> : null}
      <div className="ai-body" id="aiBody" ref={body} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        {messages.length ? messages.map((m, i) => <Message m={m} key={i} />) : (
          <div className="ai-empty">
            <h2>Design assistant</h2>
            <p>Ask about this {editor === "pcb" ? "board" : "schematic"}. It can read the components, nets and rule checks, look up datasheets, and propose changes for you to accept or reject.</p>
            <div className="ai-quick">{quick.map(([label, prompt]) => <button type="button" key={label} disabled={busy || needKey || !me} onClick={() => { stick.current = true; void send(prompt); }}>{label}</button>)}</div>
          </div>
        )}
      </div>
      <Composer />
    </aside>
  );
}
