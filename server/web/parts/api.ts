// api.ts — the server's vendor-part and saved-library endpoints (server/src/parts).

export interface PriceBreak { qty: number; price: number; currency: string }

/** What a vendor says about a part (a search hit, or the head of a fetched part). */
export interface PartInfo {
  vendor: string; vendor_name: string; vendor_id: string; mpn: string; manufacturer: string; description: string;
  package: string; category: string; datasheet: string; image: string; url: string; stock: number | null;
  prices: PriceBreak[]; attributes: Record<string, string>; assembly: string; lifecycle: string; cached?: boolean;
}

export interface PartCad {
  source: { vendor: string; vendor_id: string }; lib: string; reference: string;
  symbol: { name: string; lib_id: string; sexpr: string; units: number; pins: number } | null;
  footprint: { name: string; fpid: string; sexpr: string; pads: number; through_hole: boolean } | null;
  model: { title: string; url: string } | null;
}

/** A fetched part: its data, the KiCad drawings when there are any, and the fields a placed symbol carries. */
export interface Part extends PartInfo {
  cad: PartCad | null; fields: Record<string, string>; fetched_at: string | null; stale: boolean; stale_reason: string | null;
}

export interface Vendor {
  id: string; name: string; note: string; signup: string; configured: boolean; key_source: string | null; drawings: boolean;
  fields: { id: string; label: string }[];
}

export interface LibrarySummary {
  id: string; name: string; description: string; project_id: string | null; project_name: string | null;
  owner_login: string; mine: boolean; items: number; can_edit: boolean; updated_at: string;
}

export interface LibraryItem {
  id: string; vendor: string; vendor_name: string; vendor_id: string; mpn: string; manufacturer: string; note: string;
  cached: boolean; has_cad: boolean; description: string; package: string; stock: number | null; prices: PriceBreak[];
  datasheet: string; url: string; assembly: string;
}

export interface Library {
  id: string; name: string; nickname: string; description: string; project_id: string | null; project_name: string | null;
  mine: boolean; can_edit: boolean; items: LibraryItem[];
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, { method, credentials: "same-origin", headers: body !== undefined ? { "Content-Type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, "offline", "The server could not be reached.");
  }
  let j: unknown = null;
  try { j = await r.json(); } catch { /* an empty or non-JSON body */ }
  if (!r.ok) {
    const e = (j || {}) as { error?: string; message?: string };
    throw new ApiError(r.status, e.error || "error", r.status === 401 ? "Sign in to use vendor parts." : e.message || `The server answered ${r.status}.`);
  }
  return j as T;
}

const qs = (o: Record<string, string | undefined>) => Object.entries(o).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`).join("&");

export const api = {
  vendors: () => call<{ vendors: Vendor[] }>("GET", "/api/parts/vendors").then((r) => r.vendors),
  search: (q: string, vendor: string) => call<{ results: PartInfo[]; errors: { vendor: string; code: string; message: string }[] }>("GET", `/api/parts/search?${qs({ q, vendor })}`),
  part: (vendor: string, id: string, opts: { lib?: string; refresh?: boolean } = {}) => call<Part>("GET", `/api/parts/part?${qs({ vendor, id, lib: opts.lib, refresh: opts.refresh ? "1" : undefined })}`),
  linkCad: (vendor: string, id: string, lcsc: string | null, lib?: string) => call<Part>("PUT", `/api/parts/cad?${qs({ vendor, id, lib })}`, { lcsc }),
  putKey: (vendor: string, body: Record<string, string>) => call<{ ok: boolean; verified: boolean }>("PUT", `/api/parts/keys/${vendor}`, body),
  deleteKey: (vendor: string) => call<{ ok: boolean }>("DELETE", `/api/parts/keys/${vendor}`),
  libraries: (project?: string | null) => call<{ libraries: LibrarySummary[] }>("GET", `/api/libraries${project ? `?project=${project}` : ""}`).then((r) => r.libraries),
  library: (id: string) => call<Library>("GET", `/api/libraries/${id}`),
  createLibrary: (name: string, project_id?: string | null) => call<Library>("POST", "/api/libraries", { name, project_id: project_id || undefined }),
  updateLibrary: (id: string, body: { name?: string; description?: string; project_id?: string | null }) => call<Library>("PATCH", `/api/libraries/${id}`, body),
  deleteLibrary: (id: string) => call<{ ok: boolean }>("DELETE", `/api/libraries/${id}`),
  addItem: (id: string, vendor: string, vendor_id: string) => call<Library>("POST", `/api/libraries/${id}/items`, { vendor, vendor_id }),
  setNote: (id: string, item: string, note: string) => call<Library>("PATCH", `/api/libraries/${id}/items/${item}`, { note }),
  removeItem: (id: string, item: string) => call<Library>("DELETE", `/api/libraries/${id}/items/${item}`),
  refreshLibrary: (id: string) => call<{ refreshed: number; failed: { vendor: string; vendor_id: string; message: string; kept: boolean }[]; library: Library }>("POST", `/api/libraries/${id}/refresh`),
  exportUrl: (id: string) => `/api/libraries/${id}/export.zip`,
};
