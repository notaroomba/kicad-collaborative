// The board autorouter (bundled into static/dist/autoroute.js; registers PcbAutoRouter on the global).
import { route, Router } from "./route";
import { probe, featuresOf, costOf } from "./probe";
import { DEFAULT_WEIGHTS, PROVENANCE, TRAINED } from "./weights";
import { autoroute, install, open, summaryText } from "./ui";
import { place, placementChanges } from "./place";
import { evaluate } from "./evaluate";

const api = { route, Router, place, placementChanges, evaluate, autoroute, open, summaryText, probe, featuresOf, costOf, DEFAULT_WEIGHTS, TRAINED, PROVENANCE };
(globalThis as unknown as { PcbAutoRouter: typeof api }).PcbAutoRouter = api;
install();
export default api;
