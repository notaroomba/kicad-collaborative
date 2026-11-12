// dialogs/sim-ibis.ts — what the Simulation Model Editor needs of an IBIS file (eeschema/sim/kibis: IbisParser and
// KIBIS / KIBIS_COMPONENT / KIBIS_PIN / KIBIS_MODEL): the components with their [Pin] tables, each pin's models (its
// model name, or every entry of the [Model Selector] of that name), the [Diff Pin] pairs, the [Series Pin Mapping]
// partners and every [Model]'s Model_type.  The I-V / V-t tables are not read: the dialog never draws on them (the
// SPICE KIBIS writes from them is made when a simulation runs).  Pure: no DOM.

export interface IbisPin { number: string; signal: string; modelName: string; models: string[]; complementary: string }
export interface IbisSeriesPair { pin1: string; pin2: string; modelName: string; group: string }
export interface IbisComponent { name: string; manufacturer: string; pins: IbisPin[]; series: IbisSeriesPair[] }
export interface IbisModelDef { name: string; type: string }
export interface IbisFile { components: IbisComponent[]; models: IbisModelDef[]; selectors: Map<string, string[]>; errors: string[]; valid: boolean }

/** IbisParser::compareIbisWord after getKeyword: case-insensitive, spaces and underscores the same. */
const norm = (k: string) => k.trim().replace(/ /g, "_").toLowerCase();
/** Whitespace-separated words of a line (readTableLine / readWord). */
const words = (s: string) => s.trim().split(/[ \t]+/).filter(Boolean);

/** KIBIS( file ): m_valid false when the parser reports an error (the dialog then says "Invalid IBIS file"). */
export function parseIbis(text: string): IbisFile {
  const out: IbisFile = { components: [], models: [], selectors: new Map(), errors: [], valid: true };
  const err = (m: string) => { out.errors.push(m); out.valid = false; };
  let comment = "|";
  let comp: IbisComponent | null = null;
  let model: IbisModelDef | null = null;
  let selector: string[] | null = null;
  // the table the following lines belong to
  let section: "" | "pin" | "diffpin" | "series" | "selector" | "model" | "other" = "";
  let pinCols = 0;
  let sawVersion = false, ended = false;
  const diffPairs: { comp: IbisComponent; a: string; b: string }[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (const raw0 of lines) {
    if (ended) break;
    const ci = raw0.indexOf(comment); const raw = ci >= 0 ? raw0.slice(0, ci) : raw0;
    if (!raw.trim()) continue;
    const kw = /^\[([^\]]*)\]\s*(.*)$/.exec(raw);
    if (kw) {
      const k = norm(kw[1]), arg = kw[2].trim();
      if (k === "ibis_ver") { sawVersion = true; section = "other"; continue; }
      if (k === "comment_char") {
        // [Comment Char] <c>_char
        if (!/^[!"#$%&'()*,:;<>?@\\^`{|}~]_char$/.test(arg)) err("Invalid syntax. Should be |_char or &_char, etc...");
        else comment = arg[0];
        continue;
      }
      if (k === "end") { ended = true; break; }
      if (k === "component") {
        if (!arg) err("[Component] needs a name.");
        comp = { name: arg, manufacturer: "", pins: [], series: [] }; out.components.push(comp); model = null; selector = null; section = "other"; continue;
      }
      if (k === "model_selector") {
        selector = []; out.selectors.set(words(arg)[0] || "", selector); model = null; comp = null; section = "selector"; continue;
      }
      if (k === "model") {
        model = { name: words(arg)[0] || "", type: "" }; out.models.push(model); comp = null; selector = null; section = "model"; continue;
      }
      // the other contexts IbisParser::changeContext opens
      if (k === "submodel" || k === "define_package_model") { comp = null; model = null; selector = null; section = "other"; continue; }
      if (comp && k === "manufacturer") { comp.manufacturer = arg; section = "other"; continue; }
      if (comp && k === "pin") {
        // the header row: signal_name model_name [R_pin L_pin C_pin]
        const h = words(arg); pinCols = h.length + 1;
        if (h.length !== 2 && h.length !== 5) err("Missing argument in [Pin]");
        section = "pin"; continue;
      }
      if (comp && k === "diff_pin") { section = "diffpin"; continue; }
      if (comp && k === "series_pin_mapping") { section = "series"; continue; }
      // any other keyword ([Package], [Voltage Range], [Pulldown], …): its rows are not needed here
      section = "other";
      continue;
    }
    const f = words(raw);
    if (section === "pin" && comp) {
      if (f.length !== 3 && f.length !== 6) { err("Invalid pin entry."); continue; }
      if (f.length === 6 && pinCols !== 6) { err("Invalid pin entry: 6 values from a table with only 3."); continue; }
      comp.pins.push({ number: f[0], signal: f[1], modelName: f[2], models: [], complementary: "" });
    } else if (section === "diffpin" && comp) {
      if (f.length < 2) { err("Incorrect inv_pin name"); continue; }
      diffPairs.push({ comp, a: f[0], b: f[1] });
    } else if (section === "series" && comp) {
      if (f.length >= 3) comp.series.push({ pin1: f[0], pin2: f[1], modelName: f[2], group: f[3] || "" });
    } else if (section === "selector" && selector) {
      if (f[0]) selector.push(f[0]);
    } else if (section === "model" && model) {
      const m = /^Model_type\s+(\S+)/.exec(raw.trim());
      if (m) model.type = m[1];
    }
  }
  if (!sawVersion) err("Missing [IBIS Ver]");
  for (const m of out.models) if (!m.type) err(`Model ${m.name} has no Model_type.`);
  // KIBIS_PIN: the models of a pin are the [Model Selector] of its model name, else that model; only those defined
  for (const c of out.components) for (const p of c.pins) {
    const list = out.selectors.get(p.modelName) || [p.modelName];
    for (const n of list) if (out.models.some((m) => m.name === n)) p.models.push(n);
  }
  for (const d of diffPairs) {
    const a = d.comp.pins.find((p) => p.number === d.a), b = d.comp.pins.find((p) => p.number === d.b);
    if (a && b) { a.complementary = b.number; b.complementary = a.number; }
  }
  return out;
}

/** KIBIS_PIN::SeriesPartner: the other pin of the pin's [Series Pin Mapping] row. */
export function seriesPartner(c: IbisComponent, pin: string): string {
  for (const s of c.series) { if (s.pin1 === pin) return s.pin2; if (s.pin2 === pin) return s.pin1; }
  return "";
}
/** IBIS_MODEL_TYPE::SERIES / SERIES_SWITCH. */
export const isSeriesType = (t: string): boolean => /^series(_switch)?$/i.test(t);
export const isSeriesSwitchType = (t: string): boolean => /^series_switch$/i.test(t);
