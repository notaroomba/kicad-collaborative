// Snap to Grid — a plugin that changes the design.
//
// It asks with a dialog the editor draws (kicad.ui.prompt), then describes the change as
// structured edits (kicad.design.apply).  The editor validates them and commits them as one
// collaborative edit: collaborators see it happen, and one Undo takes it back.

const GRIDS = { schematic: ["1.27", "2.54", "0.635"], pcb: ["0.5", "1", "0.25", "0.1", "1.27", "2.54"] };
const snap = (v, g) => Math.round(Math.round(v / g) * g * 1e4) / 1e4;

kicad.actions.register("snap", async ({ editor }) => {
  if (editor.viewOnly) { await kicad.ui.toast("You have view-only access to this project."); return; }
  const sel = await kicad.design.selection();
  const picked = (sel.selected || []).filter((s) => s.kind === "symbol" || s.kind === "footprint");
  const noun = editor.scope === "pcb" ? "footprints" : "symbols";

  const answer = await kicad.ui.prompt({
    title: "Snap to Grid",
    message: picked.length ? `Move the ${picked.length} selected ${noun} onto the grid.` : `Nothing is selected: every one of the ${noun} is moved onto the grid.`,
    fields: [{ name: "grid", label: "Grid (mm)", type: "select", options: GRIDS[editor.scope] || GRIDS.pcb, default: await kicad.storage.get("grid") || undefined }],
    okLabel: "Snap",
  });
  if (!answer) return;
  const grid = Number(answer.grid);
  await kicad.storage.set({ key: "grid", value: answer.grid });      // remembered for next time

  const { items } = await kicad.design.items({ kinds: [editor.scope === "pcb" ? "footprint" : "symbol"], ids: picked.length ? picked.map((p) => p.id) : undefined, sexpr: false });
  const edits = [];
  for (const it of items) {
    const x = snap(it.x, grid), y = snap(it.y, grid);
    if (x !== it.x || y !== it.y) edits.push({ op: "move", id: it.id, x, y });
  }
  if (!edits.length) { await kicad.ui.toast(`All ${items.length} ${noun} are already on the ${grid} mm grid.`); return; }

  await kicad.design.apply({ title: `snap ${edits.length} ${noun} to ${grid} mm`, edits });
  console.log(`Moved ${edits.length} of ${items.length} ${noun} onto the ${grid} mm grid`);
});
