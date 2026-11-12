// pcbdialogs/canvas — typed handles on the pure modules of the canvas bundle (one copy of their state:
// the reader's quote marks live in a WeakMap of that bundle, so nodes must be built and written by it).
import type { boardSetup } from "../../canvas/board-setup";
import type { pcbNetlist } from "../../canvas/pcb-netlist";

interface Extras { boardSetup: typeof boardSetup; pcbNetlist: typeof pcbNetlist }
const extras = (): Extras => KiCadCanvas as unknown as Extras;
export const BS = (): typeof boardSetup => extras().boardSetup;
export const NL = (): typeof pcbNetlist => extras().pcbNetlist;
import type { plotParams } from "../../canvas/plot-params";
import type { PlotItem, DocPlotOptions } from "../../canvas/plot-rec";
interface PlotExtras { plot: { params: typeof plotParams; plotItems(doc: unknown, o?: DocPlotOptions): PlotItem[]; sheetPlotItems(doc: unknown, color: string): PlotItem[]; blackAndWhite(c: string, fill: boolean): string } }
/** KiCadCanvas.plot: pcbplotparams and the painter recorded as plot items. */
export const PLOT = (): PlotExtras["plot"] => (KiCadCanvas as unknown as PlotExtras).plot;
