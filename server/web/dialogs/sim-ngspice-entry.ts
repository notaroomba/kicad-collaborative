// dialogs/sim-ngspice-entry.ts — the ngspice parameter tables (sim-model-ngspice.ts, ~8000 PARAM::INFO rows) as a
// bundle of their own, static/dist/sim-ngspice.js, which the Simulation Model Editor loads the first time it opens.
import { NGSPICE } from "./sim-model-ngspice";
(window as unknown as { KiCadSimNgspice: typeof NGSPICE }).KiCadSimNgspice = NGSPICE;
