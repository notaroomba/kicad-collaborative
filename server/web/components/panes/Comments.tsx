// Comments.tsx — the comment threads pinned to the document; clicking one centres the view on it.
import { dispatch, useApp } from "../../store";
import { runUiAction, useAvail } from "../../actions";
import { ago, cx } from "../../util";

/** `.thread .meta`: the 11px mono caption row (author · age, replies · resolved). */
const META = "flex justify-between text-ink-3 text-xs font-mono font-normal leading-[normal]";

export function CommentsPane() {
  const a = useAvail();
  const comments = useApp((s) => s.comments);
  const roots = comments.filter((c) => !c.parentId);
  return (
    <div className="kbody flex-auto min-h-0 overflow-auto px-2 py-1.5 bg-paper text-sm">
      {/* app.html's .actions sets margin-top: 8px after ui.css loads; `mt-0!` keeps the old inline `margin: 0 0 8px` */}
      <div className="actions mt-0! mb-2">
        <button type="button" className="kbtn bg-panel border border-line rounded-[3px] px-2.5 py-0.75 text-ink text-sm hover:border-ink-3 disabled:opacity-45" data-uiact="collabComment" onClick={(ev) => runUiAction(a, "collabComment", ev.currentTarget)}>+ Add comment</button>
      </div>
      <div id="threads">
        {roots.length ? roots.map((c) => {
          const n = comments.filter((x) => x.parentId === c.id).length;
          return (
            <div key={c.id} className={cx("thread mb-2 p-2 rounded-[3px] border border-line bg-panel cursor-pointer hover:border-blue resolved:opacity-55", c.resolved && "resolved")} data-thread={c.id} onClick={() => dispatch({ type: "openThread", id: c.id })}>
              <div className={META}><span>{c.authorLogin}</span><span>{ago(c.createdAt)}</span></div>
              <div className="mt-0.75 whitespace-pre-wrap">{c.body}</div>
              <div className={META}><span>{n} {n === 1 ? "reply" : "replies"}</span><span>{c.resolved ? "resolved" : ""}</span></div>
            </div>
          );
        }) : <p className="note">No comments yet. Use the comment tool to pin a note to the board.</p>}
      </div>
    </div>
  );
}
