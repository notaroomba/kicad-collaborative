// The board autorouter (bundled into static/dist/autoroute.js; registers PcbAutoRouter on the global).
import { route, Router, isSupply } from "./route";
import { probe, featuresOf, costOf } from "./probe";
import { DEFAULT_WEIGHTS, PROVENANCE, TRAINED } from "./weights";
import { autoroute, install, open, summaryText } from "./ui";
import { place, placementChanges } from "./place";
import { evaluate } from "./evaluate";
import { autoplace, openPlace, placeSummaryText } from "./placeui";

const api = { route, Router, isSupply, place, placementChanges, evaluate, autoplace, openPlace, placeSummaryText, autoroute, open, summaryText, probe, featuresOf, costOf, DEFAULT_WEIGHTS, TRAINED, PROVENANCE };
(globalThis as unknown as { PcbAutoRouter: typeof api }).PcbAutoRouter = api;
install();
export default api;
