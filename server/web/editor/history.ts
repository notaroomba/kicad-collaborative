// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/editor/index.ts — edit these modules, not the bundle).
// @ts-nocheck — moved verbatim from the original module; typing is being tightened module by module
import { state, store } from "./appstore";
import { E } from "./state";
import { api, toast } from "./util";
import { scheduleRenderRefresh } from "./view";
export async function loadHistory() {
  store.slice("history", { loading: true });
  try {
    const j = await api(`/api/projects/${state.project.projectId}/checkpoints`);
    const byName = {};
    for (const c of j.checkpoints || []) (byName[c.name] ||= { name: c.name, at: c.createdAt, docs: [] }).docs.push(c);
    const list = Object.values(byName).sort((a, b) => new Date(b.at) - new Date(a.at));
    store.set({ history: { groups: list.map((c) => ({ name: c.name, at: c.at, docs: c.docs.length })), loading: false, error: null } });
  } catch (e) { store.set({ history: { groups: [], loading: false, error: e.message } }); }
}

export async function restoreCheckpoint(name) {
  if (!name || E.viewOnly || !state.project || !confirm(`Restore "${name}"? Everyone in the session gets this version.`)) return;
  try { await api(`/api/projects/${state.project.projectId}/restore`, { method: "POST", body: JSON.stringify({ name }) }); toast("Restored — rendering…"); scheduleRenderRefresh(); }
  catch (e) { toast("Restore failed: " + e.message, 4000); }
}
