// Field Check — a custom check that reports through the editor's own markers (the arrows ERC
// and DRC use), plus a tool for the design assistant.
//
// The assistant tool is declared in plugin.json, so the person saw it when they installed the
// plugin; the handler below is what runs when the assistant calls it.  It only reads.

const EMPTY = /^(~|\?+|)$/;

async function findProblems(requireDatasheet) {
  const { document, components } = await kicad.design.components({});
  const out = [];
  for (const c of components) {
    if (!c.ref || c.ref.startsWith("#")) continue;
    const missing = [];
    if (EMPTY.test((c.value || "").trim())) missing.push("value");
    if (EMPTY.test((c.footprint || "").trim())) missing.push("footprint");
    if (requireDatasheet && c.datasheet !== "yes") missing.push("datasheet");
    if (missing.length) out.push({ ref: c.ref, id: c.id, x: c.x, y: c.y, missing });
  }
  return { document, checked: components.length, problems: out };
}

kicad.actions.register("check", async () => {
  const answer = await kicad.ui.prompt({ title: "Check Component Fields", fields: [{ name: "datasheet", label: "Also require a datasheet link", type: "checkbox", default: false }], okLabel: "Check" });
  if (!answer) return;
  const { checked, problems } = await findProblems(answer.datasheet);
  await kicad.view.setMarkers({ markers: problems.map((p) => ({
    code: "field_check", severity: p.missing.includes("datasheet") && p.missing.length === 1 ? "warning" : "error",
    x: p.x, y: p.y, ids: p.id ? [p.id] : [], text: `${p.ref}: no ${p.missing.join(", no ")}` })) });
  if (problems.length) await kicad.view.select({ ids: problems.map((p) => p.id).filter(Boolean) });
  await kicad.ui.toast(problems.length ? `${problems.length} of ${checked} components need attention` : `All ${checked} components have their fields`);
});

kicad.assistant.registerTool("check_component_fields", async (input) => {
  const { document, checked, problems } = await findProblems(!!(input && input.require_datasheet));
  return { document, components_checked: checked, components_with_problems: problems.length, problems: problems.map(({ ref, x, y, missing }) => ({ ref, x, y, missing })) };
});
