// wakatime/api.ts — the WakaTime settings and the time views (server: src/timetrack.rs).
// The browser editor's heartbeats are sent by the server, with the key saved here, so the key
// never sits in a page script: these calls only store it, test it and read the time back.

export interface Preset { id: string; label: string; apiUrl: string; keyUrl: string }
export interface WakaSettings {
  enabled: boolean; hasKey: boolean; hint: string; apiUrl: string; defaultApiUrl: string; presets: Preset[];
  last: { at: string; ok: boolean; status: string } | null;
}
export interface DaySpan { day: string; seconds: number }
export interface MyTime {
  days: DaySpan[]; total: number;
  projects: { projectId: string; name: string; seconds: number; lastAt: string }[];
  clients: { client: string; seconds: number }[];
}
export interface ProjectTime {
  projectId: string; name: string; days: DaySpan[]; total: number;
  people: { userId: number; login: string; name: string | null; avatarUrl: string | null; seconds: number; lastAt: string }[];
  docs: { path: string; seconds: number }[];
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let r: Response;
  try { r = await fetch(path, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...(init.headers || {}) } }); }
  catch { throw new Error("Can't reach the server. Check your connection."); }
  const text = await r.text().catch(() => "");
  if (!r.ok) {
    let msg = text;
    try { const j = JSON.parse(text) as { message?: string }; if (j.message) msg = j.message; } catch { /* plain text */ }
    throw new Error(r.status === 401 ? "Sign in to change this." : msg || `The server answered ${r.status}.`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

export const getSettings = () => call<WakaSettings>("/api/me/wakatime");
export const saveSettings = (s: { enabled?: boolean; apiKey?: string; apiUrl?: string }) => call<WakaSettings>("/api/me/wakatime", { method: "PUT", body: JSON.stringify(s) });
export const forgetSettings = () => call<WakaSettings>("/api/me/wakatime", { method: "DELETE" });
export const testSettings = () => call<{ ok: boolean; status: string; settings: WakaSettings }>("/api/me/wakatime/test", { method: "POST" });
const tz = () => new Date().getTimezoneOffset();
export const myTime = (days: number) => call<MyTime>(`/api/me/time?days=${days}&tz=${tz()}`);
export const projectTime = (id: string, days: number) => call<ProjectTime>(`/api/projects/${encodeURIComponent(id)}/time?days=${days}&tz=${tz()}`);

/** Which preset an API URL is ("" is WakaTime itself), or "custom". */
export function presetOf(s: WakaSettings, url: string): string {
  const p = s.presets.find((x) => x.apiUrl === url);
  return p ? p.id : "custom";
}

/** 2 hrs 5 mins, as WakaTime writes it. */
export function duration(sec: number): string {
  const m = Math.floor(sec / 60), hrs = Math.floor(m / 60), mins = m % 60;
  if (hrs && mins) return `${hrs} hr${hrs === 1 ? "" : "s"} ${mins} min${mins === 1 ? "" : "s"}`;
  if (hrs) return `${hrs} hr${hrs === 1 ? "" : "s"}`;
  if (mins) return `${mins} min${mins === 1 ? "" : "s"}`;
  return sec > 0 ? "under a minute" : "0 mins";
}

export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  return new Date(iso).toLocaleDateString();
}
