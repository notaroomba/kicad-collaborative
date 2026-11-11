// Footprint Placement CSV — an importer and an exporter.
//
// The exporter returns a file for the editor to save.  The importer is handed the file the
// person picked under File → Import ({ name, text, bytes }), works out which footprints move,
// asks before changing anything, and applies the moves as one collaborative edit.

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const cell = (v) => (/[",\r\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));

kicad.exporters.register("placement-csv", async () => {
  const { document, components } = await kicad.design.components({});
  const rows = [["Ref", "Value", "Footprint", "X", "Y", "Rot", "Side"]];
  for (const c of components) rows.push([c.ref, c.value, c.footprint, c.x, c.y, c.rotation, c.side === "back" ? "bottom" : "top"]);
  return { filename: document.split("/").pop().replace(/\.kicad_pcb$/, "") + "-placement.csv", mime: "text/csv", text: rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n" };
});

/** Split one CSV line (quotes, commas or semicolons or tabs) into cells. */
function splitLine(line, sep) {
  const out = []; let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === sep) { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function parse(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  if (lines.length < 2) throw new Error("The file has no rows.");
  const sep = [",", ";", "\t"].sort((a, b) => lines[0].split(b).length - lines[0].split(a).length)[0];
  const head = splitLine(lines[0], sep).map((h) => h.toLowerCase());
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const ref = col("ref", "reference", "designator", "refdes"), x = col("x", "posx", "pos x", "mid x", "center-x(mm)"), y = col("y", "posy", "pos y", "mid y", "center-y(mm)"), rot = col("rot", "rotation", "angle");
  if (ref < 0 || x < 0 || y < 0) throw new Error("The file needs Ref, X and Y columns (Rot is optional).");
  const rows = [];
  for (const line of lines.slice(1)) {
    const c = splitLine(line, sep); const px = parseFloat(c[x]), py = parseFloat(c[y]);
    if (!c[ref] || !isFinite(px) || !isFinite(py)) continue;
    const pr = rot >= 0 ? parseFloat(c[rot]) : NaN;
    rows.push({ ref: c[ref], x: px, y: py, rot: isFinite(pr) ? pr : undefined });
  }
  return rows;
}

kicad.importers.register("placement-csv", async (file) => {
  const rows = parse(file.text);
  const { components } = await kicad.design.components({});
  const byRef = new Map(components.map((c) => [c.ref, c]));

  const edits = [], unknown = [];
  for (const row of rows) {
    const c = byRef.get(row.ref);
    if (!c) { unknown.push(row.ref); continue; }
    const rot = row.rot === undefined ? undefined : ((row.rot % 360) + 360) % 360;
    if (r4(row.x) === r4(c.x) && r4(row.y) === r4(c.y) && (rot === undefined || rot === c.rotation)) continue;   // already there
    edits.push({ op: "move", ref: row.ref, x: r4(row.x), y: r4(row.y), rotation: rot });
  }
  if (!edits.length) { await kicad.ui.toast(`${file.name}: every footprint is already where the file says.`); return; }

  const ok = await kicad.ui.confirm({
    title: "Place Footprints from CSV",
    message: `${file.name} moves ${edits.length} of ${components.length} footprints.` + (unknown.length ? `\n\nNot on this board and skipped: ${unknown.slice(0, 12).join(", ")}${unknown.length > 12 ? "…" : ""}` : ""),
    okLabel: "Move footprints",
  });
  if (!ok) return;
  await kicad.design.apply({ title: `place ${edits.length} footprint${edits.length === 1 ? "" : "s"} from ${file.name}`, edits });
});
