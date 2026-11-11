// Comments.tsx — the review threads of the open document, and the open ones on the project's other
// documents.  A thread shows what it is pinned to (a part, a net, or a place on the sheet); clicking it
// brings its pin into view and opens the thread there.
import { useState } from "react";
import { dispatch, useApp, type Comment } from "../../store";
import { runUiAction, useAvail } from "../../actions";
import { ago, cx } from "../../util";

type Tab = "open" | "resolved" | "all";

function AnchorChip({ c }: { c: Comment }) {
  const a = c.anchor;
  return <span className={cx("cmt-anchor", a ? a.kind : "spot")} data-anchor={a ? a.kind : "spot"}><i />{a ? (a.kind === "net" ? `Net ${a.label || a.id}` : a.label || "Item") : "On the sheet"}</span>;
}

function Card({ c, all, docId, open }: { c: Comment; all: Comment[]; docId?: string; open?: boolean }) {
  const replies = all.filter((x) => x.parentId === c.id);
  const last = replies.length ? replies[replies.length - 1] : null;
  return (
    <div className={cx("thread cmt-card", c.resolved && "resolved", open && "open")} data-thread={c.id} onClick={() => dispatch({ type: "openThread", id: c.id, docId })}>
      <div className="top"><AnchorChip c={c} /><span className="when">{ago((last || c).createdAt)}</span></div>
      <div className="text">{c.body}</div>
      <div className="foot"><span>{c.authorLogin}{replies.length ? ` · ${replies.length} ${replies.length === 1 ? "reply" : "replies"}` : ""}</span><span>{c.resolved ? "resolved" : ""}</span></div>
    </div>
  );
}

export function CommentsPane() {
  const a = useAvail();
  const comments = useApp((s) => s.comments);
  const others = useApp((s) => s.otherComments) || [];
  const openThread = useApp((s) => s.openThread);
  const canComment = useApp((s) => !!s.canComment);
  const [tab, setTab] = useState<Tab>("open");
  const roots = comments.filter((c) => !c.parentId);
  const nOpen = roots.filter((c) => !c.resolved).length, nResolved = roots.length - nOpen;
  const shown = roots.filter((c) => (tab === "all" ? true : tab === "open" ? !c.resolved : !!c.resolved)).sort((x, y) => y.id - x.id);
  const elsewhere = others.map((d) => ({ d, roots: d.comments.filter((c) => !c.parentId && (tab === "all" ? true : tab === "open" ? !c.resolved : !!c.resolved)) })).filter((x) => x.roots.length);
  return (
    <div className="kbody flex-auto min-h-0 overflow-auto px-2 py-1.5 bg-paper text-sm">
      <div className="cmt-tabs">
        <div className="seg" role="group" aria-label="Show">
          <button type="button" className={cx(tab === "open" && "on")} data-tab="open" onClick={() => setTab("open")}>Open<b>{nOpen}</b></button>
          <button type="button" className={cx(tab === "resolved" && "on")} data-tab="resolved" onClick={() => setTab("resolved")}>Resolved<b>{nResolved}</b></button>
          <button type="button" className={cx(tab === "all" && "on")} data-tab="all" onClick={() => setTab("all")}>All</button>
        </div>
        <span className="flex-1" />
        <button type="button" className="btn sm" data-uiact="collabComment" disabled={!canComment} title={canComment ? "Click a part or a place to comment on it. Right-click an item to comment on it or its net." : "Sign in to comment"} onClick={(ev) => runUiAction(a, "collabComment", ev.currentTarget)}>+ Add comment</button>
      </div>
      <div id="threads">
        {shown.map((c) => <Card key={c.id} c={c} all={comments} open={openThread === c.id} />)}
        {!shown.length ? <p className="note">{roots.length
          ? (tab === "open" ? "No open comments on this document." : "No resolved comments on this document.")
          : "No comments yet. Use the comment tool on a part, or right-click a part, a track or a wire to comment on it or its net."}</p> : null}
        {elsewhere.map(({ d, roots: r }) => (
          <div key={d.docId} data-doc-threads={d.docId}>
            <div className="cmt-doc">{d.path}</div>
            {r.map((c) => <Card key={c.id} c={c} all={d.comments} docId={d.docId} />)}
          </div>
        ))}
      </div>
    </div>
  );
}
