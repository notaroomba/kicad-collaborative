// pcbdialogs/canvas — typed handles on the pure modules of the canvas bundle (one copy of their state:
// the reader's quote marks live in a WeakMap of that bundle, so nodes must be built and written by it).
import type { boardSetup } from "../../canvas/board-setup";
import type { pcbNetlist } from "../../canvas/pcb-netlist";

interface Extras { boardSetup: typeof boardSetup; pcbNetlist: typeof pcbNetlist }
const extras = (): Extras => KiCadCanvas as unknown as Extras;
export const BS = (): typeof boardSetup => extras().boardSetup;
export const NL = (): typeof pcbNetlist => extras().pcbNetlist;
