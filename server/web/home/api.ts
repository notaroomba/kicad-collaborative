// api.ts — the REST surface the home view uses (server/src/http.rs), typed.
export interface Project {
  projectId: string; name: string; description?: string;
  ownerId?: number; ownerLogin: string; ownerAvatarUrl?: string | null;
  role?: string | null; public?: boolean; docCount?: number; memberCount?: number; starred?: boolean;
  /** False when the owner does not let viewers and commenters download or copy the project. */
  canCopy?: boolean;
  createdAt?: string; updatedAt: string;
  /** The GitHub repository the project is linked to, if any. */
  github?: { repo: string; branch: string } | null;
}
export interface Member { userId: number; login: string; avatarUrl?: string | null; role: Role }
export interface Invite { inviteId: number; login?: string | null; email?: string | null; role: Role }
export interface Members {
  ownerId: number; owner?: { userId: number; login: string; avatarUrl?: string | null } | null;
  canManage: boolean; canShare?: boolean; myRole?: Role; permissions?: Permissions; members: Member[]; pending: Invite[];
}
export interface ShareLink { token: string; url: string; role: Role; label?: string | null; uses?: number; createdBy?: string; canRevoke?: boolean; createdAt?: string; expiresAt?: string | null }
export interface FoundUser { login: string; name?: string | null; avatarUrl?: string | null; userId?: number | null; source: "server" | "github" }
export type Role = "editor" | "commenter" | "viewer";
/** The per-project permission settings (server/src/access.rs). */
export interface Permissions { public: boolean; publicRole: "viewer" | "commenter"; editorsCanShare: boolean; viewersCanCopy: boolean; linksRequireSignin: boolean }
/** How a role reads in a sentence and on a control. */
export const ROLE_VERB: Record<Role, string> = { editor: "edit", commenter: "comment on", viewer: "view" };
export const ROLE_LABEL: Record<Role, string> = { editor: "Can edit", commenter: "Can comment", viewer: "Can view" };

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** The server answers errors as plain text or `{ "error": "…" }`; either way, a sentence a person can read. */
function errorText(status: number, body: string): string {
  let msg = body.trim();
  try { const j = JSON.parse(body); if (j && typeof j.message === "string") msg = j.message; else if (j && typeof j.error === "string") msg = j.error; } catch { /* plain text */ }
  const generic = /^(forbidden|not found|unauthorized|internal server error|not_found|bad_request|internal)$/i.test(msg);
  if (msg && !generic && msg.length < 200 && !msg.startsWith("<")) return msg.charAt(0).toUpperCase() + msg.slice(1);
  if (status === 401) return "You need to sign in again.";
  if (status === 403) return "You don't have permission to do that.";
  if (status === 404) return "That no longer exists.";
  if (status === 413) return "That upload is too large.";
  if (status >= 500) return "The server had a problem. Try again in a moment.";
  return `The server answered ${status}.`;
}

/** The session ended behind the page's back (expired, signed out in another tab): the home view hears this and
 *  falls back to its signed-out state.  At most once in a while, so a server that keeps answering 401 cannot make a loop. */
export const SIGNED_OUT = "kc-signed-out";
let lastSignedOut = 0;
function signedOut() {
  const now = Date.now();
  if (now - lastSignedOut < 10000) return;
  lastSignedOut = now;
  window.dispatchEvent(new Event(SIGNED_OUT));
}
/** Where "Sign in" leads: GitHub, and then back to the page the person is on. */
export const loginUrl = (next: string = location.pathname) => `/auth/github/login?next=${encodeURIComponent(next)}`;

export async function api<T = unknown>(path: string, opts: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = opts;
  const init: RequestInit = { credentials: "same-origin", ...rest };
  if (json !== undefined) { init.body = JSON.stringify(json); init.headers = { "content-type": "application/json", ...(rest.headers || {}) }; }
  let r: Response;
  try { r = await fetch(path, init); } catch { throw new ApiError(0, "Can't reach the server. Check your connection."); }
  if (!r.ok) { if (r.status === 401) signedOut(); throw new ApiError(r.status, errorText(r.status, await r.text().catch(() => ""))); }
  const ct = r.headers.get("content-type") || "";
  return (ct.includes("json") ? await r.json() : await r.text()) as T;
}

export const listProjects = () => api<{ projects: Project[] }>("/api/projects").then((j) => j.projects);
export const listGallery = () => api<{ projects: Project[] }>("/api/gallery").then((j) => j.projects);
export const patchProject = (id: string, patch: { name?: string; description?: string; public?: boolean }) =>
  api(`/api/projects/${id}`, { method: "PATCH", json: patch });
/** Moves the project to the Trash (restorable for 30 days); `permanent` destroys it, trashed or not. */
export const deleteProject = (id: string, permanent = false) => api(`/api/projects/${id}${permanent ? "?permanent=true" : ""}`, { method: "DELETE" });
export const undeleteProject = (id: string) => api(`/api/projects/${id}/undelete`, { method: "POST" });
export interface Trashed { projectId: string; name: string; docCount: number; deletedAt: string; purgeAt: string }
export const listTrash = () => api<{ projects: Trashed[] }>("/api/trash").then((j) => j.projects);
export const setStar = (id: string, on: boolean) => api(`/api/projects/${id}/star`, { method: on ? "PUT" : "DELETE" });
export const transferProject = (id: string, userId: number) => api(`/api/projects/${id}/transfer`, { method: "POST", json: { userId } });
export const createBlank = (name: string) => api<UploadResult>("/api/projects/blank", { method: "POST", json: { name } });
/** A starter template (server/src/templates.rs): a finished KiCad project a new one can begin from. */
export interface Template {
  id: string; title: string; summary: string; detail: string; level: string; tags: string[];
  parts: number; nets: number; size: [number, number]; layers: number;
  /** pictures KiCad drew: the board as its 3D viewer shows it, and the schematic */
  board: string; schematic: string;
  /** has a board with connections left open, for the guided first project */
  guided: boolean;
}
let templates: Promise<Template[]> | null = null;
/** The list does not change while the page is open, so it is asked for once. */
export const listTemplates = () => (templates ||= api<{ templates: Template[] }>("/api/templates").then((j) => j.templates).catch((e) => { templates = null; throw e; }));
export const createFromTemplate = (req: { template: string; name?: string; guided?: boolean; board?: string }) =>
  api<UploadResult & { template: string }>("/api/projects/from-template", { method: "POST", json: req });
export const leaveProject = (id: string) => api(`/api/projects/${id}/leave`, { method: "POST" });
export const cloneProject = (id: string) => api<{ projectId: string; name: string }>(`/api/projects/${id}/clone`, { method: "POST" });
export const claimLink = (token: string) => api<{ projectId: string; role: Role }>(`/api/join/${token}`, { method: "POST" });

export const listMembers = (id: string) => api<Members>(`/api/projects/${id}/members`);
export const invite = (id: string, who: { login?: string; email?: string }, role: Role) =>
  api<{ ok: boolean; status: "granted" | "pending"; login?: string; role?: Role }>(`/api/projects/${id}/invites`, { method: "POST", json: { ...who, role } });
export const setMemberRole = (id: string, userId: number, role: Role) => api(`/api/projects/${id}/members/${userId}`, { method: "PATCH", json: { role } });
export const removeMember = (id: string, userId: number) => api(`/api/projects/${id}/members/${userId}`, { method: "DELETE" });
export const setInviteRole = (id: string, inviteId: number, role: Role) => api(`/api/projects/${id}/invites/${inviteId}`, { method: "PATCH", json: { role } });
export const revokeInvite = (id: string, inviteId: number) => api(`/api/projects/${id}/invites/${inviteId}`, { method: "DELETE" });
export const listLinks = (id: string) => api<{ links: ShareLink[] }>(`/api/projects/${id}/links`).then((j) => j.links);
export const createLink = (id: string, role: Role, expiresInDays?: number, label?: string) =>
  api<ShareLink>(`/api/projects/${id}/links`, { method: "POST", json: { role, ...(expiresInDays ? { expiresInDays } : {}), ...(label ? { label } : {}) } });
export const setPermissions = (id: string, patch: Partial<Omit<Permissions, "public">>) =>
  api<{ ok: boolean; permissions: Permissions }>(`/api/projects/${id}/permissions`, { method: "PATCH", json: patch }).then((j) => j.permissions);
export const revokeLink = (token: string) => api(`/api/links/${token}`, { method: "DELETE" });
export const searchUsers = (q: string, signal?: AbortSignal) =>
  api<{ users: FoundUser[] }>(`/api/users/search?q=${encodeURIComponent(q)}`, { signal }).then((j) => j.users);

/** A share link, or the bare token of one. */
export function linkToken(raw: string): string | null {
  const s = raw.trim();
  const m = s.match(/\/j\/([A-Za-z0-9_-]+)/) || s.match(/^kicad-collab:\/\/join\/([A-Za-z0-9_-]+)/) || s.match(/^([A-Za-z0-9_-]{16,})$/);
  return m ? m[1] : null;
}

export interface UploadFile { path: string; file: File }
export interface UploadResult { projectId: string; name: string; docs: unknown[]; skipped?: string[] }

/** POST /api/projects with upload progress (fetch has none): a single .zip goes as `archive`, anything else as loose `file` parts. */
export function uploadProject(name: string, files: UploadFile[], onProgress: (fraction: number) => void): { promise: Promise<UploadResult>; abort: () => void } {
  const form = new FormData();
  if (name.trim()) form.append("name", name.trim());
  if (files.length === 1 && /\.zip$/i.test(files[0].path)) form.append("archive", files[0].file, files[0].path);
  else for (const f of files) form.append("file", f.file, f.path);
  const xhr = new XMLHttpRequest();
  const promise = new Promise<UploadResult>((resolve, reject) => {
    xhr.open("POST", "/api/projects");
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) onProgress(ev.loaded / ev.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new ApiError(xhr.status, "The server sent an answer that could not be read.")); } }
      else { if (xhr.status === 401) signedOut(); reject(new ApiError(xhr.status, errorText(xhr.status, xhr.responseText || ""))); }
    };
    xhr.onerror = () => reject(new ApiError(0, "Can't reach the server. Check your connection."));
    xhr.onabort = () => reject(new ApiError(0, "Upload cancelled."));
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

/** What the server keeps from an upload (server/src/http.rs allowed_file) — used to preview a drop before sending it. */
export function isProjectFile(path: string): boolean {
  const base = path.split("/").pop() || path;
  if (base === "sym-lib-table" || base === "fp-lib-table" || base === "design-block-lib-table") return true;
  return /\.(kicad_pro|kicad_sch|kicad_pcb|kicad_prl|kicad_sym|kicad_mod|kicad_dru|kicad_wks|step|stp|wrl|wrz)$/i.test(base);
}
export function isLocalState(path: string): boolean {
  return path.split("/").some((d) => d.endsWith(".collab") || d.endsWith("-backups") || d === ".history" || d === ".git");
}
