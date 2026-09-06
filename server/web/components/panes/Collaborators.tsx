// Collaborators.tsx — who is in the session; Follow keeps your view on theirs.
import { dispatch, useApp } from "../../store";

// .peer row: flex, centred, 8px gap, 4px pad, 2px radius, panel fill on hover.
const PEER = "peer flex items-center gap-2 p-1 rounded-xs hover:bg-panel";
// .peer .dot: 10px circle (the fill is the peer's own colour, set inline below).
const DOT = "dot w-2.5 h-2.5 rounded-[50%]";
// .peer .who: takes the remaining width and ellipsises.
const WHO = "who flex-1 truncate";

export function CollaboratorsPane() {
  const me = useApp((s) => s.me);
  const peers = useApp((s) => s.peers.list);
  const follow = useApp((s) => s.peers.follow);
  return (
    <div className="kbody overflow-auto px-2 py-1.5 min-h-0 flex-auto bg-paper text-sm" id="peers">
      {me ? <div className={PEER}><span className={DOT} style={{ background: "#ffb43a" }} /><span className={WHO}>{me.name || me.login}</span><span className="me text-ink-3 text-xs font-mono font-normal leading-[normal]">you</span></div> : null}
      {peers.length ? peers.map((p) => (
        <div className={PEER} key={p.cid}>
          <span className={DOT} style={{ background: p.color }} /><span className={WHO}>{p.name}</span>
          <button type="button" className="btn sm" data-follow={p.cid} onClick={() => dispatch({ type: "follow", cid: follow === p.cid ? null : p.cid })}>{follow === p.cid ? "Following ✔" : "Follow"}</button>
        </div>
      )) : <p className="note">No one else is here right now. Share the link to invite collaborators.</p>}
    </div>
  );
}
