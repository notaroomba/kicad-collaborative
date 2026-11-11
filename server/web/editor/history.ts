// history.ts — the names the rest of the editor already calls; version history lives in versions.ts.
import { loadVersions, versionsCommand } from "./versions";
import type { AppState } from "../store";
import { store } from "./appstore";

/** Re-read the project's versions, timeline and branches. */
export function loadHistory(): void { void loadVersions(); }

/** Ask before restoring the newest version called `name` (the old checkpoint action). */
export function restoreCheckpoint(name: string): void {
  const v = (store.get() as unknown as AppState).versions.list.find((x) => x.name === name);
  if (v) versionsCommand({ cmd: "dialog", dialog: { kind: "restore", versionId: v.id, label: `"${name}"` } });
}
