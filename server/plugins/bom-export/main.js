// BOM Export — an exporter and an action that share one function.
//
// Reads only: kicad.design.documents() and kicad.design.components().  The file is handed to
// the editor, which saves it (the "files:export" permission); the plugin itself cannot touch
// the disk or the network.

const cell = (v) => (/[",\r\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
const byRef = (a, b) => a.localeCompare(b, undefined, { numeric: true });

async function buildBom() {
  const docs = await kicad.design.documents();
  const open = docs.find((d) => d.open);
  if (!open) throw new Error("Open a schematic or a board first.");
  // A schematic BOM is the whole hierarchy; a board BOM is the board.
  const sources = open.type === "schematic" ? docs.filter((d) => d.type === "schematic") : [open];

  const groups = new Map();
  const seen = new Set();
  for (const d of sources) {
    const { components } = await kicad.design.components({ doc: d.path });
    for (const c of components) {
      if (!c.ref || c.ref.startsWith("#") || seen.has(c.ref)) continue;   // power flags; other units of a part already counted
      seen.add(c.ref);
      const key = c.value + "\u0000" + c.footprint;
      if (!groups.has(key)) groups.set(key, { value: c.value, footprint: c.footprint, refs: [] });
      groups.get(key).refs.push(c.ref);
    }
  }

  const rows = [["Item", "Qty", "Reference(s)", "Value", "Footprint"]];
  const sorted = Array.from(groups.values()).map((g) => ({ ...g, refs: g.refs.sort(byRef) })).sort((a, b) => byRef(a.refs[0], b.refs[0]));
  sorted.forEach((g, i) => rows.push([i + 1, g.refs.length, g.refs.join(", "), g.value, g.footprint]));

  const stem = open.path.split("/").pop().replace(/\.kicad_(sch|pcb)$/, "");
  console.log(`BOM: ${seen.size} parts in ${sorted.length} lines from ${sources.length} document(s)`);
  return { filename: `${stem}-bom.csv`, mime: "text/csv", text: rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n" };
}

// File → Export → Bill of Materials (CSV)…: return the file and the editor saves it.
kicad.exporters.register("bom-csv", buildBom);

// The toolbar button and Tools → External Plugins → Export BOM (CSV).
kicad.actions.register("export-bom", async () => {
  await kicad.files.save(await buildBom());
});
