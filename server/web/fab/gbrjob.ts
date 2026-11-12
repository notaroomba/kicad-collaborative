// web/fab/gbrjob — GERBER_JOBFILE_WRITER (pcbnew/exporters/gerber_jobfile_writer.cpp): the <board>-job.gbrjob
// JSON a Gerber plot adds when "Generate Gerber job file" is on: Header, GeneralSpecs (project id, size,
// layer count, thickness, finish and the edge / castellation flags), DesignRules, FilesAttributes (every
// plotted Gerber with its file function and polarity) and the MaterialStackup from (setup (stackup …)).
import { boardFinish, stackupRows } from "../canvas/board-setup";
import { type BoardModel, type Node, isCopper } from "./model";
import { centrePoints } from "./plot";
import type { Prim } from "./prims";

export interface JobFileInput {
  m: BoardModel; setup: Node | null;
  files: { name: string; layer: string }[];
  projectName: string; guid: string; rev: string;
  version: string; date: string;
  /** the default netclass clearance (and the smallest of the others), mm */
  clearance?: number;
  thickness?: number;
  edge?: Prim[];
  layerName(layer: string): string;
}

/** mapValue: mm to 4 decimals, as a JSON number. */
const mv = (v: number): number => +(+v).toFixed(4);

function fileFunction(layer: string, copper: string[]): [string, string] | null {
  const i = copper.indexOf(layer);
  if (i >= 0) return [`Copper,L${i + 1},${i === 0 ? "Top" : i === copper.length - 1 ? "Bot" : "Inr"}`, "Positive"];
  if (/^User\.\d+$/.test(layer)) return ["Other,User", "Positive"];
  const map: Record<string, [string, string]> = { "B.Adhes": ["Glue,Bot", "Positive"], "F.Adhes": ["Glue,Top", "Positive"], "B.Paste": ["SolderPaste,Bot", "Positive"], "F.Paste": ["SolderPaste,Top", "Positive"],
    "B.SilkS": ["Legend,Bot", "Positive"], "F.SilkS": ["Legend,Top", "Positive"], "B.Mask": ["SolderMask,Bot", "Negative"], "F.Mask": ["SolderMask,Top", "Negative"], "Edge.Cuts": ["Profile", "Positive"],
    "B.Fab": ["AssemblyDrawing,Bot", "Positive"], "F.Fab": ["AssemblyDrawing,Top", "Positive"] };
  return map[layer] || null;
}

export function gerberJobFile(o: JobFileInput): string {
  const { m } = o;
  const finish = boardFinish(o.setup);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of centrePoints(o.edge || [])) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const size = x1 >= x0 ? { X: mv(x1 - x0), Y: mv(y1 - y0) } : { X: 0, Y: 0 };
  const general: Record<string, unknown> = { ProjectId: { Name: o.projectName, GUID: o.guid, Revision: o.rev || "rev?" }, Size: size, LayerNumber: m.copper.length, BoardThickness: mv(o.thickness ?? 1.6) };
  if (finish.copperFinish) general.Finish = finish.copperFinish;
  const st = o.setup ? (o.setup as unknown[]).find((c) => Array.isArray(c) && c[0] === "stackup") as unknown[] | undefined : undefined;
  if (st && st.some((c) => Array.isArray(c) && c[0] === "dielectric_constraints" && c[1] === "yes")) general.ImpedanceControlled = true;
  const pads = m.footprints.flatMap((f) => f.pads);
  if (pads.some((p) => p.property === "pad_prop_castellated")) general.Castellated = true;
  if (pads.some((p) => p.property === "pad_prop_pressfit")) general["Press-fit"] = true;
  if (finish.edgePlating) general.EdgePlating = true;
  if (finish.edgeConnector !== "no") { general.EdgeConnector = true; general.EdgeConnectorBevelled = finish.edgeConnector === "bevelled"; }

  const clr = o.clearance ?? 0.2;
  let wOuter = Infinity, wInner = Infinity;
  for (const t of m.tracks) { if (t.layer === "F.Cu" || t.layer === "B.Cu") wOuter = Math.min(wOuter, t.w); else if (isCopper(t.layer)) wInner = Math.min(wInner, t.w); }
  const outer: Record<string, unknown> = { Layers: "Outer", PadToPad: mv(clr), PadToTrack: mv(clr), TrackToTrack: mv(clr) };
  if (wOuter < Infinity) outer.MinLineWidth = mv(wOuter);
  const rules: Record<string, unknown>[] = [outer];
  if (m.copper.length > 2) { const inner: Record<string, unknown> = { Layers: "Inner", PadToPad: mv(clr), PadToTrack: mv(clr), TrackToTrack: mv(clr) }; if (wInner < Infinity) inner.MinLineWidth = mv(wInner); rules.push(inner); }

  const files: Record<string, unknown>[] = [];
  for (const f of o.files) { const ff = fileFunction(f.layer, m.copper); if (ff) files.push({ Path: f.name, FileFunction: ff[0], FilePolarity: ff[1] }); }

  const stack: Record<string, unknown>[] = [];
  let lastCu = m.copper[0];
  const rows = stackupRows(o.setup);
  for (const r of rows) {
    const j: Record<string, unknown> = {};
    if (r.type === "Copper") { j.Type = "Copper"; lastCu = r.layer; }
    else if (/Silk Screen/i.test(r.type)) j.Type = "Legend";
    else if (/Solder Mask/i.test(r.type)) j.Type = "SolderMask";
    else if (/Solder Paste/i.test(r.type)) j.Type = "SolderPaste";
    else j.Type = "Dielectric";
    if (r.color) { const hx = /^#([0-9a-f]{6})/i.exec(r.color); j.Color = hx ? `R${parseInt(hx[1].slice(0, 2), 16)}G${parseInt(hx[1].slice(2, 4), 16)}B${parseInt(hx[1].slice(4, 6), 16)}` : r.color; }
    if (r.thickness !== null) j.Thickness = mv(r.thickness);
    if (j.Type === "Dielectric") {
      if (r.material) j.Material = r.material;
      const idx = m.copper.indexOf(lastCu), next = m.copper[Math.min(idx + 1, m.copper.length - 1)];
      j.Name = `${o.layerName(lastCu)}/${o.layerName(next)}`;
      j.Notes = `Type: dielectric layer ${r.id} (from ${o.layerName(lastCu)} to ${o.layerName(next)})`;
    } else {
      j.Name = r.type === "Copper" ? o.layerName(r.layer) : r.layer;
    }
    stack.push(j);
  }
  const json = { Header: { GenerationSoftware: { Vendor: "KiCad", Application: "Pcbnew", Version: o.version }, CreationDate: o.date }, GeneralSpecs: general, DesignRules: rules, FilesAttributes: files, MaterialStackup: stack };
  return JSON.stringify(json, null, 2) + "\n";
}
