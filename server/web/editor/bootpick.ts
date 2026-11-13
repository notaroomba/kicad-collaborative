// bootpick.ts — which document a project opens on.  Pure, so the page's early loader (boot.ts) can ask for that
// document while the editor's scripts are still downloading, and the editor (doc.ts) decides the same way.

export interface BootDoc { docId: string; path: string; docType: string }

/** The documents the editor shows: boards first, then schematics by path. */
export function editorDocs<T extends BootDoc>(docs: T[]): T[] {
  return docs.filter((d) => d.docType === "kicad_pcb" || d.docType === "kicad_sch")
    .sort((a, b) => (a.docType === "kicad_pcb" ? 0 : 1) - (b.docType === "kicad_pcb" ? 0 : 1) || a.path.localeCompare(b.path));
}

/**
 * The root sheet: the schematic named like the project file, else the one highest in the folder tree
 * (a top-level sheet beats a nested one).  `shown` is editorDocs(), `all` every document of the project.
 */
export function rootSchematicOf<T extends BootDoc>(shown: T[], all: BootDoc[]): T | undefined {
  const sch = shown.filter((d) => d.docType === "kicad_sch");
  const pro = all.find((d) => d.docType === "kicad_pro");
  const stem = pro && pro.path.split("/").pop()!.replace(/\.kicad_pro$/, "");
  return sch.find((d) => d.path.split("/").pop() === stem + ".kicad_sch")
    || sch.sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.length - b.path.length)[0];
}

/**
 * A project opens on its root schematic, where a design starts and where KiCad's own project manager
 * leads first; the board is one click away (and ?doc= still opens exactly what a link names).  Only a
 * project with no schematic at all opens on the board.
 */
export function firstDoc<T extends BootDoc>(shown: T[], all: BootDoc[], wanted: string | null): T | null {
  return shown.find((d) => d.docId === wanted) || rootSchematicOf(shown, all) || shown.find((d) => d.docType === "kicad_pcb") || null;
}
