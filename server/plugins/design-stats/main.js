// Design Statistics — a panel.  The frame this script runs in *is* the panel: panel.html is
// its body, and ordinary DOM code draws into it.  The editor tells the plugin when something
// changes (kicad.on), and the plugin asks for what it needs to show.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const LABELS = { symbol: "Symbols", wire: "Wires", junction: "Junctions", label: "Labels", global_label: "Global labels", hierarchical_label: "Hierarchical labels",
  sheet: "Sub-sheets", no_connect: "No-connect flags", footprint: "Footprints", segment: "Track segments", via: "Vias", zone: "Zones", gr_line: "Graphic lines", gr_text: "Texts" };

let selected = [];

async function refresh() {
  let o;
  try { o = await kicad.design.overview(); } catch (e) { $("counts").innerHTML = `<span class="muted">${esc(e.message)}</span>`; return; }
  const d = o.open_document;
  if (!d) { $("title").textContent = "Statistics"; $("counts").innerHTML = '<span class="muted">Open a document.</span>'; return; }
  $("title").textContent = d.path;
  const rows = [];
  if (d.type === "schematic") rows.push(["Components", d.components], ["Power symbols", d.power_symbols]);
  if (d.nets !== undefined) rows.push(["Nets", d.nets]);
  if (d.copper_layers) rows.push(["Copper layers", d.copper_layers.length]);
  for (const [kind, n] of Object.entries(d.item_counts)) if (LABELS[kind] && !(d.type === "schematic" && kind === "symbol")) rows.push([LABELS[kind], n]);
  rows.push(["All items", Object.values(d.item_counts).reduce((a, b) => a + b, 0)]);
  $("counts").innerHTML = rows.map(([k, v]) => `<span>${esc(k)}</span><b>${esc(v)}</b>`).join("");
}

function showSelection(sel) {
  selected = sel.ids;
  $("zoom").disabled = !selected.length;
  $("selNote").textContent = selected.length ? `${selected.length} item${selected.length === 1 ? "" : "s"} selected.` : "Nothing selected.";
  $("sel").hidden = !selected.length;
  $("sel").querySelector("tbody").innerHTML = sel.items.slice(0, 40).map((it) => `<tr><td>${esc(it.ref || "—")}</td><td>${esc(it.value || "")}</td><td class="muted">${esc(it.kind || "")}</td></tr>`).join("");
}

$("zoom").addEventListener("click", () => kicad.view.focus({ ids: selected }));

kicad.on("document", refresh);              // another sheet or the board was opened
kicad.on("change", refresh);                // someone — you, a collaborator, another plugin — edited it
kicad.on("selection", showSelection);
kicad.actions.register("show", () => kicad.ui.showPanel());

refresh();
kicad.design.selection().then((s) => showSelection({ ids: (s.selected || []).map((x) => x.id), items: s.selected || [] }), () => {});
