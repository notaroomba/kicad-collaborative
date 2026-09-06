// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { state, store } from "./appstore";
import { $, NS } from "./dom";
import { E } from "./state";
import { setTool } from "./tools";
import { ago, api, esc, toast } from "./util";
import { applyView, cmtG, cmtPanel, mmH, mmW, mmX0, mmY0, pxPerMm, stage, world, worldMm } from "./view";
export function renderThreads() { store.set({ comments: E.comments.slice() }); }

export function openThreadAction(id) { const c = E.comments.find((x) => x.id === id); if (c) { centerOn(c.x / E.IU, c.y / E.IU); showThread(c.id); } }

export function centerOn(xMm, yMm) {
  const w = world.clientWidth, h = w * mmH() / mmW();
  E.panX = stage.clientWidth / 2 - ((xMm - mmX0()) / mmW()) * w * E.zoom;
  E.panY = stage.clientHeight / 2 - ((yMm - mmY0()) / mmH()) * h * E.zoom;
  applyView();
}


// ---- comments ----
export async function loadComments() {
  if (!state.docId) return;
  try { E.comments = (await api(`/api/docs/${state.docId}/comments`)).comments || []; } catch { E.comments = []; }
  drawComments(); renderThreads();
}

export function noteCommentMsg(msg) {
  const c = msg.comment || {}, inner = c.comment || {};
  if (c.action === "deleted") E.comments = E.comments.filter((x) => x.id !== inner.id && x.parentId !== inner.id);
  else if (c.action === "updated") E.comments = E.comments.map((x) => (x.id === inner.id ? inner : x));
  else if (c.action === "added" && !E.comments.some((x) => x.id === inner.id)) E.comments.push(inner);
  drawComments(); renderThreads();
  if (E.openThread !== null) showThread(E.openThread);
}

export function drawComments() {
  cmtG.replaceChildren();
  const s = pxPerMm();
  for (const c of E.comments) {
    if (c.resolved) continue;   // resolved threads leave the canvas; the Comments pane still lists them
    if (c.parentId) continue;
    const x = c.x / E.IU, y = c.y / E.IU, r = 9 / s;
    const pin = document.createElementNS(NS, "g"); pin.setAttribute("cursor", "pointer");
    const bubble = document.createElementNS(NS, "circle");
    bubble.setAttribute("cx", x); bubble.setAttribute("cy", y); bubble.setAttribute("r", r);
    bubble.setAttribute("fill", c.resolved ? "#7a8794" : "#ffb43a"); bubble.setAttribute("stroke", "#001023"); bubble.setAttribute("stroke-width", 1.5 / s);
    pin.appendChild(bubble);
    const glyph = document.createElementNS(NS, "text");
    glyph.setAttribute("x", x); glyph.setAttribute("y", y + 3.2 / s); glyph.setAttribute("text-anchor", "middle");
    glyph.setAttribute("fill", "#001023"); glyph.setAttribute("font-size", 10 / s); glyph.setAttribute("font-family", "system-ui, sans-serif"); glyph.setAttribute("font-weight", "700");
    glyph.textContent = String(E.comments.filter((x) => x.id === c.id || x.parentId === c.id).length);
    pin.appendChild(glyph);
    pin.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    pin.addEventListener("click", (ev) => { ev.stopPropagation(); showThread(c.id); });
    cmtG.appendChild(pin);
  }
}

export function panelAt(xNm, yNm) {
  const wr = world.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  const px = wr.left - sr.left + ((xNm / E.IU - mmX0()) / mmW()) * wr.width;
  const py = wr.top - sr.top + ((yNm / E.IU - mmY0()) / mmH()) * wr.height;
  cmtPanel.style.left = Math.max(0, Math.min(px + 14, sr.width - 350)) + "px";
  cmtPanel.style.top = Math.max(0, Math.min(py - 10, sr.height - 160)) + "px";
  cmtPanel.style.display = "block";
}

export function showThread(rootId) {
  const root = E.comments.find((c) => c.id === rootId);
  if (!root) { cmtPanel.style.display = "none"; E.openThread = null; return; }
  E.openThread = rootId;
  const thread = [root, ...E.comments.filter((c) => c.parentId === rootId)];
  cmtPanel.innerHTML = thread.map((c) => `<div class="meta">${esc(c.authorLogin)} · ${ago(c.createdAt)}</div><div class="cbody">${esc(c.body)}</div>`).join("")
    + (E.canJoin ? `<textarea id="replyText" rows="2" placeholder="Reply…"></textarea>
       <p><button class="btn sm primary" id="replyBtn">Reply</button><button class="btn sm" id="resolveBtn">${root.resolved ? "Reopen" : "Resolve"}</button><button class="btn sm" id="closeBtn">Close</button></p>`
     : `<p><button class="btn sm" id="closeBtn">Close</button></p>`);
  panelAt(root.x, root.y);
  $("#closeBtn").onclick = () => { cmtPanel.style.display = "none"; E.openThread = null; };
  const rb = $("#replyBtn");
  if (rb) rb.onclick = async () => { const text = $("#replyText").value.trim(); if (!text) return;
    await api(`/api/docs/${state.docId}/comments`, { method: "POST", body: JSON.stringify({ body: text, parentId: rootId }) }); };
  const sb = $("#resolveBtn");
  if (sb) sb.onclick = () => api(`/api/comments/${rootId}`, { method: "PATCH", body: JSON.stringify({ resolved: !root.resolved }) });
}

export function placeComment(ev) {
  setTool("select");
  const [x, y] = worldMm(ev), xNm = Math.round(x * E.IU), yNm = Math.round(y * E.IU);
  E.openThread = null;
  cmtPanel.innerHTML = `<div class="meta">New comment</div><textarea id="newText" rows="3" placeholder="Say something about this spot…"></textarea>
    <p><button class="btn sm primary" id="postBtn">Post</button><button class="btn sm" id="cancelBtn">Cancel</button></p>`;
  panelAt(xNm, yNm);
  $("#newText").focus();
  $("#cancelBtn").onclick = () => cmtPanel.style.display = "none";
  $("#postBtn").onclick = async () => { const text = $("#newText").value.trim(); if (!text) return; cmtPanel.style.display = "none";
    try { await api(`/api/docs/${state.docId}/comments`, { method: "POST", body: JSON.stringify({ body: text, x: xNm, y: yNm }) }); }
    catch (e) { toast("Couldn't post: " + e.message, 4000); } };
}
