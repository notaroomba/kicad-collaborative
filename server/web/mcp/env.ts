// mcp/env — first import of the headless host: the browser modules it reuses were written against
// `window`, so the global object answers to that name here.  `document` is deliberately left
// undefined: the shared code already checks for it before touching the DOM (dialogs, canvases).

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;
if (typeof g.window === "undefined") g.window = g;

// Everything this process prints on stdout is a reply to the server (one JSON object per line), so
// the modules' own console output goes to stderr, where the server logs it.
for (const level of ["log", "info", "debug", "warn"] as const) g.console[level] = (...a: unknown[]) => g.console.error(...a);

export {};
