// The administrators' dashboard (/admin, static/admin.html).  It reads /api/admin/stats
// (server/src/admin.rs) and draws it: headline numbers, per-day charts for the last 30 or
// 90 days, and short ranked lists.  Every colour comes from the theme tokens.

export {};

type Day = [string, number];
type Pair = [string, number];
interface Person { login: string; name?: string | null; avatarUrl?: string | null; at?: string; edits?: number; projects?: number }
interface Stats {
  generatedAt: string; days: number;
  users: { total: number; new1d: number; new7d: number; new30d: number; withEmail: number; before: number; signups: Day[]; recent: Person[] };
  activity: { dau: number; wau: number; mau: number; liveUsers: number; liveProjects: number; openDocsHere: number; daily: Day[]; hours30d: number; clients30d: Pair[]; topEditors30d: Person[] };
  projects: { total: number; public: number; private: number; trashed: number; branches: number; new30d: number; owners: number; created: Day[]; documents: Pair[] };
  collaboration: { edits30d: number; multiplayerProjects30d: number; sharedProjects: number; pendingInvites: number; activeLinks: number; threads: number; openThreads: number; comments30d: number; versions: number; versions30d: number; edits: Day[] };
  ai: { requests30d: number; inputTokens30d: number; outputTokens30d: number; users30d: number; ownKeys: number; mcpUsers: number; mcpGrantsUsed30d: number; mcpChanges30d: number; mcpUndone30d: number; requests: Day[]; mcpClients: Pair[] };
  integrations: { githubProjects: number; githubUsers: number; githubAppUsers: number; registryPlugins: number; openPluginReports: number; wakatimeUsers: number };
  storage: { databaseBytes: number; tables: { name: string; bytes: number; rows: number }[]; snapshots: number; snapshotDocs: number };
}

const app = document.getElementById("app") as HTMLElement;
const tip = document.getElementById("tip") as HTMLElement;
const stamp = document.getElementById("stamp") as HTMLElement;
let range = 30;
let data: Stats | null = null;
try { if (localStorage.getItem("admin.range") === "90") range = 90; } catch { /* no storage */ }

// ---- formatting ----
const nf = new Intl.NumberFormat();
const num = (n: number): string => nf.format(Math.round(n));
function compact(n: number): string {
  if (n < 10000) return num(n);
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}
function bytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}
const pct = (a: number, b: number): string => (b > 0 ? `${Math.round((a / b) * 100)}%` : "–");
function day(s: string, long = false): string {
  const d = new Date(s + "T00:00:00Z");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(long ? { year: "numeric" } : {}), timeZone: "UTC" });
}
function ago(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 45) return `${Math.round(s / 86400)} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
const sum = (d: Day[]): number => d.reduce((a, [, n]) => a + n, 0);
const DOC_NAMES: Record<string, string> = { sch: "Schematics", pcb: "Boards", kicad_sch: "Schematics", kicad_pcb: "Boards", schematic: "Schematics", board: "Boards", pro: "Project files", kicad_pro: "Project files",
  footprint: "Footprints", kicad_mod: "Footprints", symbol_lib: "Symbol libraries", kicad_sym: "Symbol libraries", kicad_symbol_lib: "Symbol libraries", lib_table: "Library tables",
  kicad_wks: "Drawing sheets", wks: "Drawing sheets", kicad_dru: "Design rules", dru: "Design rules", kicad_prl: "Local settings", text: "Text files", other: "Other files" };

// ---- tiny DOM helper ----
type Kids = (Node | string | null | undefined | false)[];
function h(tag: string, attrs: Record<string, string> = {}, ...kids: Kids): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const k of kids) if (k !== null && k !== undefined && k !== false) el.append(k);
  return el;
}
const SVG = "http://www.w3.org/2000/svg";
function s(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

// ---- tooltip ----
function showTip(x: number, y: number, label: string, value: string): void {
  tip.replaceChildren(h("span", {}, label), h("b", {}, value));
  tip.style.display = "block";
  const w = tip.offsetWidth;
  tip.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, x - w / 2))}px`;
  tip.style.top = `${Math.max(8, y - tip.offsetHeight - 10)}px`;
}
const hideTip = (): void => { tip.style.display = "none"; };

// ---- charts ----
const W = 600, H = 150;

/** One series per day as thin bars, with a hover tooltip on each day. */
function bars(name: string, series: Day[], unit: string, peak = false): HTMLElement {
  const d = series.slice(-range);
  const max = Math.max(1, ...d.map(([, n]) => n));
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", role: "img", "aria-label": `${name}, last ${range} days` }) as SVGSVGElement;
  for (const f of [0.5, 1]) svg.append(s("line", { class: "grid", x1: 0, x2: W, y1: H - (H - 4) * f, y2: H - (H - 4) * f, "vector-effect": "non-scaling-stroke" }));
  const slot = W / d.length, bw = Math.max(1, slot - 2);
  const rects: SVGElement[] = [];
  d.forEach(([, n], i) => {
    const bh = n > 0 ? Math.max(2, (n / max) * (H - 4)) : 0;
    const r = s("rect", { class: "bar", x: i * slot + (slot - bw) / 2, y: H - bh, width: bw, height: bh, rx: Math.min(2, bw / 2) });
    rects.push(r); svg.append(r);
  });
  svg.append(s("line", { class: "grid", x1: 0, x2: W, y1: H, y2: H, "vector-effect": "non-scaling-stroke" }));
  const pick = (e: PointerEvent): void => {
    const box = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(d.length - 1, Math.floor(((e.clientX - box.left) / box.width) * d.length)));
    rects.forEach((r, j) => r.classList.toggle("hot", j === i));
    showTip(box.left + ((i + 0.5) / d.length) * box.width, box.top + box.height * (1 - d[i][1] / max), day(d[i][0], true), `${num(d[i][1])} ${unit}`);
  };
  svg.addEventListener("pointermove", pick);
  svg.addEventListener("pointerleave", () => { rects.forEach((r) => r.classList.remove("hot")); hideTip(); });
  return chartFrame(name, peak ? `peak ${num(Math.max(0, ...d.map(([, n]) => n)))} ${unit} in a day` : `${num(sum(d))} ${unit} in ${range} days`, svg, max, d);
}

/** A running total as a line, for the count of people over time. */
function line(name: string, series: Day[], start: number, unit: string): HTMLElement {
  let acc = start;
  const all = series.map(([dd, n]) => [dd, (acc += n)] as Day);
  const d = all.slice(-range);
  const lo = Math.min(...d.map(([, n]) => n)), hi = Math.max(...d.map(([, n]) => n));
  const min = Math.max(0, lo - Math.max(1, (hi - lo) * 0.15)), max = Math.max(hi, min + 1);
  const x = (i: number): number => (d.length < 2 ? W / 2 : (i / (d.length - 1)) * W);
  const y = (n: number): number => H - 4 - ((n - min) / (max - min)) * (H - 12);
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", role: "img", "aria-label": `${name}, last ${range} days` }) as SVGSVGElement;
  for (const f of [0.5, 1]) svg.append(s("line", { class: "grid", x1: 0, x2: W, y1: H - (H - 4) * f, y2: H - (H - 4) * f, "vector-effect": "non-scaling-stroke" }));
  const pts = d.map(([, n], i) => `${x(i).toFixed(1)},${y(n).toFixed(1)}`).join(" ");
  svg.append(s("polygon", { class: "area", points: `0,${H} ${pts} ${W},${H}` }));
  svg.append(s("polyline", { class: "line", points: pts, "vector-effect": "non-scaling-stroke" }));
  svg.append(s("line", { class: "grid", x1: 0, x2: W, y1: H, y2: H, "vector-effect": "non-scaling-stroke" }));
  const cross = s("line", { class: "cross", y1: 0, y2: H, x1: -10, x2: -10, "vector-effect": "non-scaling-stroke" });
  svg.append(cross);
  svg.addEventListener("pointermove", (e: PointerEvent) => {
    const box = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(d.length - 1, Math.round(((e.clientX - box.left) / box.width) * (d.length - 1))));
    cross.setAttribute("x1", String(x(i))); cross.setAttribute("x2", String(x(i)));
    showTip(box.left + (x(i) / W) * box.width, box.top + (y(d[i][1]) / H) * box.height, day(d[i][0], true), `${num(d[i][1])} ${unit}`);
  });
  svg.addEventListener("pointerleave", () => { cross.setAttribute("x1", "-10"); cross.setAttribute("x2", "-10"); hideTip(); });
  const grew = d.length ? d[d.length - 1][1] - (d[0][1] - (series.slice(-range)[0]?.[1] ?? 0)) : 0;
  return chartFrame(name, `+${num(grew)} in ${range} days`, svg, max, d);
}

function chartFrame(name: string, sub: string, svg: SVGElement, max: number, d: Day[]): HTMLElement {
  return h("div", { class: "chart" },
    h("p", { class: "name" }, h("b", {}, name), ` · ${sub}`),
    h("div", { style: "position:relative" }, svg, h("span", { class: "ymax" }, compact(max))),
    h("div", { class: "axis" }, h("span", {}, d.length ? day(d[0][0]) : ""), h("span", {}, "Today")));
}

// ---- building blocks ----
function tile(label: string, value: string, sub: string, live = false): HTMLElement {
  return h("div", { class: "tile" }, h("span", { class: "label" }, label),
    h("span", { class: "v" }, live ? h("i", { class: "live", "aria-hidden": "true" }) : null, value),
    h("span", { class: "sub" }, sub));
}
function facts(items: [string, string][]): HTMLElement {
  return h("div", { class: "facts" }, ...items.map(([v, k]) => h("div", {}, h("b", {}, v), h("span", {}, k))));
}
function box(title: string, aside: string, ...kids: Kids): HTMLElement {
  return h("section", { class: "box" }, h("h2", {}, title, h("span", { class: "sp" }), aside ? h("small", {}, aside) : null), h("div", { class: "in" }, ...kids));
}
function ranked(items: Pair[], fmt: (n: number) => string, empty: string): HTMLElement {
  if (!items.length) return h("p", { class: "empty" }, empty);
  const max = Math.max(1, ...items.map(([, n]) => n));
  return h("div", { class: "rows" }, ...items.map(([k, n]) => h("div", { class: "row" },
    h("span", { class: "k", title: k }, k), h("span", { class: "n" }, fmt(n)),
    h("span", { class: "meter" }, h("i", { style: `width:${Math.max(2, (n / max) * 100)}%` })))));
}
function split(parts: [string, number][]): HTMLElement {
  const total = parts.reduce((a, [, n]) => a + n, 0);
  return h("div", {},
    h("div", { class: "split", role: "img", "aria-label": parts.map(([k, n]) => `${k} ${n}`).join(", ") },
      ...parts.map(([, n]) => h("i", { style: `flex:${total ? n : 1} 1 0` }))),
    h("div", { class: "legend" }, ...parts.map(([k, n], i) => h("span", {},
      h("i", { style: `background:var(${["--ink", "--ink-3", "--line-2"][i]})` }), `${k} ${num(n)} (${pct(n, total)})`))));
}
function avatar(p: Person): HTMLElement {
  return p.avatarUrl ? h("img", { src: p.avatarUrl + (p.avatarUrl.includes("?") ? "&" : "?") + "s=40", alt: "", loading: "lazy" }) : h("span", { class: "ph" });
}
function people(rows: Person[], cols: [string, (p: Person) => string][], empty: string): HTMLElement {
  if (!rows.length) return h("p", { class: "empty" }, empty);
  return h("table", { class: "people" },
    h("thead", {}, h("tr", {}, h("th", {}, "Person"), ...cols.map(([c]) => h("th", { class: "n" }, c)))),
    h("tbody", {}, ...rows.map((p) => h("tr", {},
      h("td", {}, h("a", { href: `https://github.com/${encodeURIComponent(p.login)}`, target: "_blank", rel: "noopener" }, avatar(p), p.login)),
      ...cols.map(([, f]) => h("td", { class: "n" }, f(p)))))));
}

// ---- the page ----
function render(): void {
  if (!data) return;
  const d = data;
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Chart range" },
    ...[30, 90].map((n) => {
      const b = h("button", { type: "button", "aria-pressed": String(range === n) }, `${n} days`);
      if (range === n) b.classList.add("on");
      b.addEventListener("click", () => { range = n; try { localStorage.setItem("admin.range", String(n)); } catch { /* no storage */ } render(); });
      return b;
    }));
  // kinds that share a name (sch / kicad_sch) are one row
  const docSum = new Map<string, number>();
  for (const [t, n] of d.projects.documents) { const k = DOC_NAMES[t] || t; docSum.set(k, (docSum.get(k) || 0) + Number(n)); }
  const docs = [...docSum].sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, n] as Pair);
  const tokens = d.ai.inputTokens30d + d.ai.outputTokens30d;

  app.replaceChildren(
    h("div", { class: "top" },
      h("div", {}, h("h1", {}, "Admin dashboard"), h("p", {}, "Everyone on this server, what they make and how they work together.")),
      h("span", { class: "sp" }), seg),

    h("div", { class: "tiles" },
      tile("Users", num(d.users.total), `+${num(d.users.new7d)} this week · +${num(d.users.new30d)} in 30 days`),
      tile("Active (30 days)", num(d.activity.mau), `${num(d.activity.wau)} this week · ${num(d.activity.dau)} today`),
      tile("Online now", num(d.activity.liveUsers), `in ${num(d.activity.liveProjects)} project${d.activity.liveProjects === 1 ? "" : "s"}`, d.activity.liveUsers > 0),
      tile("Projects", num(d.projects.total), `${num(d.projects.public)} public · ${num(d.projects.private)} private`),
      tile("Edits (30 days)", compact(d.collaboration.edits30d), `${num(d.collaboration.multiplayerProjects30d)} project${d.collaboration.multiplayerProjects30d === 1 ? "" : "s"} edited together`),
      tile("Design time (30 days)", `${num(d.activity.hours30d)} h`, `${(d.activity.mau ? d.activity.hours30d / d.activity.mau : 0).toFixed(1)} h per active person`),
      tile("AI requests (30 days)", num(d.ai.requests30d), `${compact(tokens)} tokens · ${num(d.ai.mcpChanges30d)} MCP edits`),
      tile("Database", bytes(d.storage.databaseBytes), `${num(d.storage.snapshots)} file snapshots`)),

    h("div", { class: "grid2" },
      box("People", `${pct(d.activity.mau, d.users.total)} active in 30 days`,
        line("Users", d.users.signups, d.users.before, "users"),
        h("div", { style: "height:14px" }),
        bars("Sign-ups", d.users.signups, "sign-ups")),
      box("Activity", `${num(d.activity.openDocsHere)} document${d.activity.openDocsHere === 1 ? "" : "s"} open on this server`,
        bars("Active people", d.activity.daily, "people", true),
        h("div", { style: "height:14px" }),
        facts([[num(d.activity.dau), "today"], [num(d.activity.wau), "this week"], [num(d.activity.mau), "in 30 days"], [d.activity.wau ? (d.activity.dau / d.activity.wau).toFixed(2) : "–", "daily / weekly"]]),
        h("p", { class: "label" }, "Editors used (people, 30 days)"),
        ranked(d.activity.clients30d.map(([c, n]) => [c === "web" ? "Browser" : c === "desktop" ? "Desktop app" : c, n]), num, "No editor heartbeats yet."))),

    h("div", { class: "grid2" },
      box("Projects", `${num(d.projects.owners)} people own one`,
        split([["Public", d.projects.public], ["Private", d.projects.private]]),
        h("div", { style: "height:12px" }),
        facts([[num(d.projects.new30d), "new in 30 days"], [num(d.projects.branches), "branches"], [num(d.projects.trashed), "in Trash"], [d.projects.owners ? (d.projects.total / d.projects.owners).toFixed(1) : "–", "per owner"]]),
        bars("Projects created", d.projects.created, "projects"),
        h("div", { style: "height:14px" }),
        h("p", { class: "label" }, "Documents"),
        ranked(docs, num, "No documents yet.")),
      box("Working together", "",
        bars("Edits", d.collaboration.edits, "edits"),
        h("div", { style: "height:14px" }),
        facts([
          [num(d.collaboration.sharedProjects), "shared projects"], [num(d.collaboration.multiplayerProjects30d), "edited by 2+ people (30 days)"],
          [num(d.collaboration.activeLinks), "live share links"], [num(d.collaboration.pendingInvites), "invites waiting"],
          [num(d.collaboration.threads), "comment threads"], [num(d.collaboration.openThreads), "still open"],
          [num(d.collaboration.comments30d), "comments (30 days)"], [num(d.collaboration.versions), `named versions (${num(d.collaboration.versions30d)} in 30 days)`],
        ]))),

    h("div", { class: "grid2" },
      box("AI and MCP", "",
        bars("Assistant requests", d.ai.requests, "requests"),
        h("div", { style: "height:14px" }),
        facts([
          [num(d.ai.users30d), "assistant users (30 days)"], [compact(d.ai.inputTokens30d), "input tokens"],
          [compact(d.ai.outputTokens30d), "output tokens"], [num(d.ai.ownKeys), "use their own key"],
          [num(d.ai.mcpUsers), "connected an MCP app"], [num(d.ai.mcpGrantsUsed30d), "connections used (30 days)"],
          [num(d.ai.mcpChanges30d), "MCP edits (30 days)"], [pct(d.ai.mcpUndone30d, d.ai.mcpChanges30d), "of them undone"],
        ]),
        h("p", { class: "label" }, "MCP apps (people)"),
        ranked(d.ai.mcpClients, num, "Nobody has connected an MCP app yet.")),
      box("Integrations", "",
        facts([
          [num(d.integrations.githubProjects), "projects synced with GitHub"], [num(d.integrations.githubUsers), "people connected GitHub"],
          [num(d.integrations.githubAppUsers), "through the GitHub App"], [num(d.integrations.wakatimeUsers), "send time to WakaTime"],
          [num(d.integrations.registryPlugins), "plugins in the registry"], [num(d.integrations.openPluginReports), "open plugin reports"],
        ]),
        d.integrations.openPluginReports ? h("p", { class: "note" }, "Plugin reports are handled from the editor's Plugin Manager.") : null)),

    h("div", { class: "grid2" },
      box("Most active (30 days)", "by edits",
        people(d.activity.topEditors30d, [["Edits", (p) => num(p.edits || 0)], ["Projects", (p) => num(p.projects || 0)]], "No edits in the last 30 days.")),
      box("Newest people", "",
        people(d.users.recent, [["Joined", (p) => (p.at ? ago(p.at) : "")]], "Nobody has signed up yet."))),

    box("Storage", `${bytes(d.storage.databaseBytes)} in the database`,
      ranked(d.storage.tables.map((t) => [`${t.name} · ${compact(t.rows)} rows`, t.bytes] as Pair), bytes, "No tables."),
      h("p", { class: "note" }, `${num(d.storage.snapshots)} snapshots across ${num(d.storage.snapshotDocs)} documents. Row counts are Postgres statistics and can lag.`)),
  );
  stamp.textContent = `Updated ${new Date(d.generatedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

async function load(): Promise<void> {
  const btn = document.getElementById("refresh") as HTMLButtonElement;
  btn.disabled = true;
  try {
    const r = await fetch("/api/admin/stats", { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (r.status === 401) { location.href = "/auth/github/login?next=/admin"; return; }
    if (!r.ok) {
      let msg = `The server answered ${r.status}.`;
      try { const j = await r.json(); if (j && j.error) msg = String(j.message || j.error); } catch { /* not JSON */ }
      throw new Error(msg);
    }
    data = (await r.json()) as Stats;
    render();
  } catch (e) {
    if (!data) app.replaceChildren(h("div", { class: "state" }, h("p", {}, "Could not load the statistics."), h("p", { class: "note" }, (e as Error).message)));
    else stamp.textContent = "Refresh failed";
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("refresh")?.addEventListener("click", () => void load());
window.addEventListener("scroll", hideTip, { passive: true });
void load();
