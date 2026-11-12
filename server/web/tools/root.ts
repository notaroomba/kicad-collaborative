// tools/root.ts — what every classic tool script bundle starts from: the global object it registers on
// and the node hook that makes `require("static/<name>.js")` return the script's API.

/** window in the browser, globalThis under node (the tests require() the scripts). */
export const root = (typeof window !== "undefined" ? window : globalThis) as unknown as ToolsRoot;

// Node's CommonJS `module` of the bundle: a free variable that only exists when node loads the script.
declare const module: { exports?: unknown } | undefined;

/** Under node, make the script's API the value of require(); a no-op in the browser. */
export function exportToNode(api: unknown): void {
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}
