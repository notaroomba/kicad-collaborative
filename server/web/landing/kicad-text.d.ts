// The demo design is bundled as text (esbuild --loader:.kicad_sch=text --loader:.kicad_pcb=text).
declare module "*.kicad_sch" { const text: string; export default text; }
declare module "*.kicad_pcb" { const text: string; export default text; }
