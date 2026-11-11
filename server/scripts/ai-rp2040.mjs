// End-to-end run of "a board from a prompt" through the design assistant's own tools: an
// RP2040 dev board (USB-C, 3.3 V regulator, QSPI flash, 12 MHz crystal, BOOTSEL and reset
// buttons, LED, Pico-style headers, SWD) drawn block by block on a blank project, moved to the
// board, placed and routed, each step one accepted proposal — exactly the calls a model makes
// (get_library_part, propose_changes, run_checks, get_board_info), with the plan written here
// by hand, so the run needs no API key and repeats exactly.
//
// Server as for ai-ui.mjs (KC_DEV_LOGIN=1, KICAD_LIBS_URL reachable).
//   E2E_PG_URL=… E2E_JWT_SECRET=… [SHOTS=dir] [OUT=dir] [STOP=sch|place] node ai-rp2040.mjs
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import pg from 'pg';

const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '', OUT = process.env.OUT || '', STOP = process.env.STOP || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
for (const d of [SHOTS, OUT]) if (d) fs.mkdirSync(d, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
const uid = (await db.query(`INSERT INTO users (github_id, login, name) VALUES (9311, 'ai-rp', 'ai-rp')
  ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`)).rows[0].id;
const NAME = process.env.NAME || 'rp2040-devboard';
await db.query(`DELETE FROM projects WHERE owner_id = $1 AND name = $2`, [uid, NAME]);
const now = Math.floor(Date.now() / 1000);
const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub: uid, login: 'ai-rp', iat: now, exp: now + 7200 });
const jwt = `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;

const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});   // PW_CHANNEL=chrome uses an installed Chrome
const ctx = await browser.newContext({ viewport: { width: 1700, height: 1100 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERR', String(e).slice(0, 300)));
await page.goto(`${BASE}/auth/dev?jwt=${jwt}&next=/`);
const made = await page.evaluate((name) => fetch('/api/projects/blank', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).then((r) => r.json()), NAME);
const doc = (t) => made.docs.find((d) => d.docType === t).docId;
const open = async (t) => { await page.goto(`${BASE}/p/${made.projectId}/edit?doc=${doc(t)}`); await page.waitForFunction(() => window.KcAssistant && window.CollabEditor && window.CollabEditor.kdoc, null, { timeout: 30000 }); await page.waitForTimeout(1500); };
const tool = (name, input) => page.evaluate(([n, i]) => window.KcAssistant.tool(n, i), [name, input || {}]);
const propose = async (input) => {
  const r = await page.evaluate((i) => window.KcAssistant.propose(i, true).catch((e) => ({ error: String(e && e.message || e) })), input);
  await page.waitForTimeout(500);
  check(`proposal accepted: ${input.title}`, r && r.applied === true, r && (r.error || r.reason) || `${r.changes} changes${r.connectivity ? '; ' + JSON.stringify(r.connectivity).slice(0, 160) : ''}`);
  return r;
};
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
// The document as a KiCad file: the stored header with the live items (the server keeps ops, not files, between checkpoints).
const save = async (file) => { if (!OUT) return; const text = await page.evaluate(async (id) => {
  const K = window.KiCadCanvas, d = window.CollabEditor.kdoc;
  const base = K.parse(await (await fetch(`/api/docs/${id}/content?v=${Date.now()}`)).text());
  const head = ['version', 'generator', 'generator_version', 'general', 'paper', 'layers', 'setup', 'uuid', 'title_block'];
  const out = [base[0]]; for (const n of base.slice(1)) if (Array.isArray(n) && head.includes(n[0])) out.push(n);
  if (d.type === 'sch') out.push(['lib_symbols', ...d.lib.values()]);
  for (const it of d.items.values()) out.push(it.node);
  if (d.type === 'sch') { const si = base.find((n) => Array.isArray(n) && n[0] === 'sheet_instances'); if (si) out.push(si); }
  out.push(['embedded_fonts', 'no']);
  return K.serialize(out);
}, doc(file.endsWith('sch') ? 'kicad_sch' : 'kicad_pcb')); fs.writeFileSync(path.join(OUT, file), text + '\n'); };

// The project file holds the board rules; desktop KiCad checks against its own defaults without it.
const savePro = async (file) => { if (!OUT) return; const id = (made.docs.find((d) => d.docType === 'kicad_pro') || {}).docId; if (!id) return;
  fs.writeFileSync(path.join(OUT, file), await page.evaluate((i) => fetch(`/api/docs/${i}/content?v=${Date.now()}`).then((r) => r.text()), id)); };

// ------------------------------------------------------------------ the plan: schematic
await open('kicad_sch');
const LIBS = ['MCU_RaspberryPi:RP2040', 'Memory_Flash:W25Q16JVSS', 'Connector:USB_C_Receptacle_USB2.0_16P', 'Regulator_Linear:AP2112K-3.3', 'Device:Crystal_GND24',
  'Switch:SW_Push', 'Device:LED', 'Device:R', 'Device:C', 'Connector_Generic:Conn_01x20', 'Connector_Generic:Conn_01x03'];
const facts = {};
for (const id of LIBS) facts[id] = await tool('get_library_part', { id });
check('library symbols read', LIBS.every((id) => facts[id].units[0].pins.length > 0));

const FP = {
  R: 'Resistor_SMD:R_0402_1005Metric', C: 'Capacitor_SMD:C_0402_1005Metric', C6: 'Capacitor_SMD:C_0603_1608Metric',
  U1: 'Package_DFN_QFN:QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm', U2: 'Package_TO_SOT_SMD:SOT-23-5', U3: 'Package_SO:SOIC-8_5.3x5.3mm_P1.27mm',
  J1: 'Connector_USB:USB_C_Receptacle_HRO_TYPE-C-31-M-12', Y1: 'Crystal:Crystal_SMD_3225-4Pin_3.2x2.5mm', SW: 'Button_Switch_SMD:SW_Push_SPST_NO_Alps_SKRK',
  D1: 'LED_SMD:LED_0603_1608Metric', H20: 'Connector_PinHeader_2.54mm:PinHeader_1x20_P2.54mm_Vertical', H3: 'Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical',
};
const r2 = (v) => Math.round(v * 100) / 100;
const rotate = (dx, dy, rot) => rot === 90 ? [dy, -dx] : rot === 180 ? [-dx, -dy] : rot === 270 ? [-dy, dx] : [dx, dy];

/** One block of the schematic, collected as the edits of one proposal. */
class Block {
  constructor(title, rationale) { this.title = title; this.rationale = rationale; this.edits = []; }
  sym(lib_id, reference, value, x, y, o = {}) {
    const rot = o.rot || 0, fields = { ...(o.fp ? { Footprint: o.fp } : {}), ...(o.fields || {}) };
    this.edits.push({ op: 'add_symbol', lib_id, reference, value, x, y, rotation: rot, ...(Object.keys(fields).length ? { fields } : {}) });
    const pins = facts[lib_id].units[0].pins;
    return (n) => { const p = pins.find((q) => q.number === String(n)); if (!p) throw new Error(`${lib_id} has no pin ${n}`); const [dx, dy] = rotate(p.dx, p.dy, rot); return [r2(x + dx), r2(y + dy)]; };
  }
  /** A resistor or capacitor standing upright with its first pin at `top`, or lying with it at the left. */
  two(lib, ref, value, top, o = {}) { const fp = o.fp || (lib === 'Device:C' ? FP.C : FP.R);
    return o.flat ? this.sym(lib, ref, value, r2(top[0] + 3.81), top[1], { rot: 90, fp }) : this.sym(lib, ref, value, top[0], r2(top[1] + 3.81), { fp }); }
  pwr(name, x, y, rot = 0) { this.edits.push({ op: 'add_symbol', lib_id: `power:${name}`, x, y, rotation: rot }); return this; }
  wire(...points) { this.edits.push({ op: 'add_wire', points }); return this; }
  label(text, x, y, rot = 0) { this.edits.push({ op: 'add_label', kind: 'label', text, x, y, rotation: rot }); return this; }
  /** A short wire sideways from a pin, ending in a net label that reads away from the pin. */
  stub(p, dx, text) { const e = [r2(p[0] + dx), p[1]]; this.wire(p, e); return this.label(text, e[0], e[1], dx < 0 ? 180 : 0); }
  /** A short wire sideways from a pin to a power symbol pointing away from it. */
  rail(p, dx, name) { const e = [r2(p[0] + dx), p[1]]; this.wire(p, e); const up = name !== 'GND'; return this.pwr(name, e[0], e[1], dx < 0 ? (up ? 90 : 270) : (up ? 270 : 90)); }
  gnd(p, drop = 2.54) { const e = [p[0], r2(p[1] + drop)]; this.wire(p, e); return this.pwr('GND', e[0], e[1]); }
  up(p, name, rise = 2.54) { const e = [p[0], r2(p[1] - rise)]; this.wire(p, e); return this.pwr(name, e[0], e[1]); }
  junction(x, y) { this.edits.push({ op: 'add_junction', x, y }); return this; }
  nc(p) { this.edits.push({ op: 'add_no_connect', x: p[0], y: p[1] }); return this; }
  text(text, x, y) { this.edits.push({ op: 'add_text', text, x, y }); return this; }
  input() { return { title: this.title, rationale: this.rationale, edits: this.edits }; }
}
const blocks = [];

{ // USB-C: power in, CC pull-downs so a C-to-C cable supplies 5 V, both D+/D- pairs joined
  const b = new Block('USB-C connector', 'USB 2.0 device port: 5.1 k on each CC line to ground asks the host for 5 V, and the two D+ and two D- contacts are joined so the plug works either way up.');
  b.text('USB-C  (5 V in, USB 2.0 data)', 15.24, 20.32);
  const j = b.sym('Connector:USB_C_Receptacle_USB2.0_16P', 'J1', 'USB-C', 33.02, 48.26, { fp: FP.J1 });
  b.wire(j('A4'), [58.42, 33.02]); b.up([58.42, 33.02], 'VBUS');
  b.wire(j('A5'), [78.74, 38.1], [78.74, 55.88]); b.two('Device:R', 'R1', '5.1k', [78.74, 55.88]); b.gnd([78.74, 63.5]);
  b.wire(j('B5'), [68.58, 40.64], [68.58, 55.88]); b.two('Device:R', 'R2', '5.1k', [68.58, 55.88]); b.gnd([68.58, 63.5]);
  b.wire(j('A7'), [50.8, 45.72]).wire(j('B7'), [50.8, 48.26], [50.8, 45.72]).stub([50.8, 45.72], 2.54, 'USB_D-');
  b.wire(j('A6'), [50.8, 50.8]).wire(j('B6'), [50.8, 53.34], [50.8, 50.8]).stub([50.8, 50.8], 2.54, 'USB_D+');
  b.junction(50.8, 45.72).junction(50.8, 50.8);
  b.nc(j('A8')).nc(j('B8'));
  b.wire(j('A1'), [33.02, 73.66]).wire(j('SH'), [25.4, 73.66], [33.02, 73.66]).junction(33.02, 73.66);
  b.wire([33.02, 73.66], [43.18, 73.66]).gnd([43.18, 73.66]); b.edits.push({ op: 'add_symbol', lib_id: 'power:PWR_FLAG', x: 43.18, y: 73.66 });
  blocks.push(b);
}
{ // 3.3 V regulator
  const b = new Block('3.3 V regulator', 'AP2112K-3.3 LDO from VBUS (600 mA, 250 mV dropout) with the 1 µF input and output capacitors its datasheet asks for; EN tied to the input so it runs whenever USB power is present.');
  b.text('3.3 V regulator', 15.24, 88.9);
  const u = b.sym('Regulator_Linear:AP2112K-3.3', 'U2', 'AP2112K-3.3', 50.8, 104.14, { fp: FP.U2 });
  b.wire([25.4, 101.6], [33.02, 101.6]).wire([33.02, 101.6], [40.64, 101.6]).wire([40.64, 101.6], u(1)); b.up([25.4, 101.6], 'VBUS');
  b.edits.push({ op: 'add_symbol', lib_id: 'power:PWR_FLAG', x: 33.02, y: 101.6 });
  b.wire(u(3), [40.64, 104.14], [40.64, 101.6]).junction(40.64, 101.6);
  b.wire([33.02, 101.6], [33.02, 104.14]).junction(33.02, 101.6); b.two('Device:C', 'C1', '1uF', [33.02, 104.14]); b.gnd([33.02, 111.76]);
  b.gnd(u(2));
  b.wire(u(5), [66.04, 101.6]).wire([66.04, 101.6], [73.66, 101.6]); b.up([73.66, 101.6], '+3V3');
  b.wire([66.04, 101.6], [66.04, 104.14]).junction(66.04, 101.6); b.two('Device:C', 'C2', '1uF', [66.04, 104.14]); b.gnd([66.04, 111.76]);
  blocks.push(b);
}
const GP = (n) => n >= 26 ? `GPIO${n}_ADC${n - 26}` : `GPIO${n}`;
{ // The microcontroller: every signal leaves on a named stub
  const b = new Block('RP2040 microcontroller', 'The RP2040 with its supplies: IOVDD, USB_VDD, ADC_AVDD and the core regulator input on +3V3, the regulator output feeding DVDD as +1V1, TESTEN grounded. Every signal pin gets a short named stub so the blocks around it connect by net name.');
  b.text('RP2040', 124.46, 48.26);
  const u = b.sym('MCU_RaspberryPi:RP2040', 'U1', 'RP2040', 149.86, 105.41, { fp: FP.U1 });
  const top = (n) => u(n)[0];
  for (const n of [48, 43, 44]) b.wire(u(n), [top(n), 57.15]);
  b.wire([132.08, 57.15], [top(48), 57.15]).wire([top(48), 57.15], [top(43), 57.15]).wire([top(43), 57.15], [top(1), 57.15]).wire([top(1), 57.15], [top(44), 57.15]);
  b.wire(u(1), [top(1), 57.15]).up([132.08, 57.15], '+3V3').junction(top(48), 57.15).junction(top(43), 57.15).junction(top(1), 57.15);
  b.wire(u(45), [top(45), 57.15], [top(23), 57.15]).wire(u(23), [top(23), 57.15]).up([top(23), 57.15], '+1V1').junction(top(23), 57.15);
  b.gnd(u(57));
  b.rail(u(19), -2.54, 'GND');
  b.stub(u(26), -2.54, 'RUN');
  // USB data through 27 ohm series resistors, fanned apart so each has room for its text
  b.wire(u(46), [121.92, 90.17], [121.92, 87.63], [111.76, 87.63]); b.two('Device:R', 'R3', '27', [104.14, 87.63], { flat: true }); b.stub([104.14, 87.63], -2.54, 'USB_D-');
  b.wire(u(47), [121.92, 92.71], [121.92, 95.25], [111.76, 95.25]); b.two('Device:R', 'R4', '27', [104.14, 95.25], { flat: true }); b.stub([104.14, 95.25], -2.54, 'USB_D+');
  for (const [n, name] of [[56, 'QSPI_SS'], [52, 'QSPI_SCLK'], [53, 'QSPI_SD0'], [55, 'QSPI_SD1'], [54, 'QSPI_SD2'], [51, 'QSPI_SD3'], [20, 'XIN'], [21, 'XOUT'], [24, 'SWCLK'], [25, 'SWDIO']]) b.stub(u(n), -2.54, name);
  const gpioPin = [2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 27, 28, 29, 30, 31, 32, 34, 35, 36, 37, 38, 39, 40, 41];
  gpioPin.forEach((pin, n) => { if (n === 23 || n === 24 || n === 29) b.nc(u(pin)); else b.stub(u(pin), 2.54, GP(n)); });
  blocks.push(b);
}
{ // Decoupling
  const b = new Block('Decoupling capacitors', 'One 100 nF per supply pin as the RP2040 hardware design guide lays out: six for IOVDD, one each for USB_VDD and ADC_AVDD, 1 µF on the core regulator input and output, and two 100 nF on the 1.1 V core rail.');
  b.text('Decoupling: place each capacitor at its RP2040 supply pin', 177.8, 20.32);
  const P = 11.43;   // room for each capacitor's reference and value beside it
  const row = (x0, y, n, rail, first, values) => {
    b.wire([x0 - 5.08, y], [x0, y]).pwr(rail, x0 - 5.08, y); b.wire([x0 - 5.08, y + 7.62], [x0, y + 7.62]); b.pwr('GND', x0 - 5.08, y + 7.62);
    for (let i = 0; i < n; i++) { const x = r2(x0 + P * i); b.two('Device:C', `C${first + i}`, values[i] || '100nF', [x, y]);
      if (i) { b.wire([r2(x - P), y], [x, y]).wire([r2(x - P), y + 7.62], [x, y + 7.62]); } }
  };
  row(182.88, 27.94, 9, '+3V3', 3, { 8: '1uF' });
  row(182.88, 45.72, 3, '+1V1', 12, { 2: '1uF' });
  blocks.push(b);
}
{ // Flash and BOOTSEL
  const b = new Block('QSPI flash and BOOTSEL', '2 MB W25Q16JV boot flash on the QSPI pins with its own 100 nF. QSPI_SS is pulled up so the chip stays deselected through reset, and the BOOTSEL button pulls it low through 1 k to enter the USB bootloader.');
  b.text('QSPI flash (2 MB)', 25.4, 127);
  const u = b.sym('Memory_Flash:W25Q16JVSS', 'U3', 'W25Q16JVSS', 60.96, 152.4, { fp: FP.U3 });
  for (const [n, name] of [[1, 'QSPI_SS'], [6, 'QSPI_SCLK'], [5, 'QSPI_SD0'], [2, 'QSPI_SD1'], [3, 'QSPI_SD2'], [7, 'QSPI_SD3']]) b.stub(u(n), -2.54, name);
  b.wire(u(8), [60.96, 137.16]).up([60.96, 137.16], '+3V3').wire([60.96, 137.16], [81.28, 137.16]).junction(60.96, 137.16);
  b.two('Device:C', 'C15', '100nF', [81.28, 137.16]); b.gnd([81.28, 144.78]);
  b.gnd(u(4));
  b.text('BOOTSEL', 83.82, 160.02);
  b.two('Device:R', 'R5', '10k', [91.44, 167.64]); b.up([91.44, 167.64], '+3V3');
  b.wire([91.44, 175.26], [91.44, 177.8]).stub([91.44, 177.8], -5.08, 'QSPI_SS').junction(91.44, 177.8);
  b.wire([91.44, 177.8], [96.52, 177.8]); b.two('Device:R', 'R6', '1k', [96.52, 177.8], { flat: true });
  const s = b.sym('Switch:SW_Push', 'SW1', 'BOOTSEL', 111.76, 177.8, { fp: FP.SW });
  b.wire([104.14, 177.8], s(1)).wire(s(2), [119.38, 177.8]).gnd([119.38, 177.8]);
  blocks.push(b);
}
{ // Crystal
  const b = new Block('12 MHz crystal', '12 MHz crystal the USB bootloader expects, with 15 pF load capacitors (for a 10 pF load crystal and about 2.5 pF of stray) and 1 k in series with XOUT to limit drive, as in the RP2040 hardware design guide.');
  b.text('12 MHz crystal', 124.46, 167.64);
  const X = 139.7, Y = 177.8, y = b.sym('Device:Crystal_GND24', 'Y1', '12MHz', X, Y, { fp: FP.Y1 });
  const xl = r2(X - 11.43), xr = r2(X + 8.89);
  b.wire(y(1), [xl, Y]).stub([xl, Y], -2.54, 'XIN'); b.two('Device:C', 'C16', '15pF', [xl, Y]);
  b.wire(y(3), [xr, Y]).wire([xr, Y], [r2(xr + 7.62), Y]); b.two('Device:C', 'C17', '15pF', [xr, Y]);
  b.two('Device:R', 'R7', '1k', [r2(xr + 7.62), Y], { flat: true }); b.stub([r2(xr + 15.24), Y], 2.54, 'XOUT');
  b.wire([xl, Y + 7.62], [xl, Y + 10.16], [X, Y + 10.16]).wire([X, Y + 10.16], [xr, Y + 10.16]).wire([xr, Y + 7.62], [xr, Y + 10.16]).wire(y(2), [X, Y + 10.16]).gnd([xr, Y + 10.16]).junction(X, Y + 10.16).junction(xr, Y + 10.16);
  blocks.push(b);
}
{ // Reset and LED
  const b = new Block('Reset button and LED', 'RUN pulled up with 10 k and a button to ground for reset; a status LED on GPIO25 through 1 k (about 1.3 mA), the pin the Pico uses.');
  b.text('Reset', 193.04, 96.52);
  b.two('Device:R', 'R8', '10k', [200.66, 104.14]); b.up([200.66, 104.14], '+3V3');
  b.wire([200.66, 111.76], [200.66, 114.3]).stub([200.66, 114.3], -5.08, 'RUN').junction(200.66, 114.3);
  const s = b.sym('Switch:SW_Push', 'SW2', 'RESET', 210.82, 114.3, { fp: FP.SW });
  b.wire([200.66, 114.3], s(1)).gnd(s(2));
  b.text('Status LED', 193.04, 142.24);
  b.label('GPIO25', 195.58, 149.86, 180).wire([195.58, 149.86], [198.12, 149.86]); b.two('Device:R', 'R9', '1k', [198.12, 149.86], { flat: true });
  const d = b.sym('Device:LED', 'D1', 'LED', 212.09, 149.86, { rot: 180, fp: FP.D1 });
  b.wire([205.74, 149.86], d(2)).wire(d(1), [218.44, 149.86]).gnd([218.44, 149.86]);
  blocks.push(b);
}
{ // Headers
  const b = new Block('Pin headers and SWD', 'Two 1x20 headers in the Raspberry Pi Pico pin order so Pico shields and pinout cards apply, and a 3-pin SWD header (SWCLK, GND, SWDIO).');
  b.text('Headers (Raspberry Pi Pico pinout)', 233.68, 68.58);
  const left = [0, 1, 'GND', 2, 3, 4, 5, 'GND', 6, 7, 8, 9, 'GND', 10, 11, 12, 13, 'GND', 14, 15];
  const right = [16, 17, 'GND', 18, 19, 20, 21, 'GND', 22, 'RUN', 26, 27, 'GND', 28, '+3V3', '+3V3', 'NC', 'GND', 'VBUS', 'VBUS'];
  const header = (ref, x, nets) => { const j = b.sym('Connector_Generic:Conn_01x20', ref, 'Conn_01x20', x, 100.33, { fp: FP.H20 });
    nets.forEach((n, i) => { const p = j(i + 1); if (n === 'NC') b.nc(p); else if (typeof n === 'number') b.stub(p, -12.7, GP(n)); else if (n === 'RUN') b.stub(p, -12.7, n); else b.rail(p, -2.54, n); }); };   // signal names start clear of the supply symbols on the rows between them
  header('J2', 246.38, left); header('J3', 279.4, right);
  b.text('SWD', 238.76, 139.7);
  const j = b.sym('Connector_Generic:Conn_01x03', 'J4', 'SWD', 246.38, 147.32, { fp: FP.H3 });
  b.stub(j(1), -12.7, 'SWCLK').rail(j(2), -2.54, 'GND').stub(j(3), -12.7, 'SWDIO');
  blocks.push(b);
}

for (const b of blocks) await propose(b.input());
await page.evaluate(() => window.CollabEditor.api.fitView());
await page.waitForTimeout(600);
await shot('rp2040-01-schematic');
const erc = await tool('run_checks', {});
console.log('ERC', JSON.stringify(erc).slice(0, 1500));
const parts = await tool('list_components', {});
console.log('parts', JSON.stringify(parts).slice(0, 300));
await save('rp2040-devboard.kicad_sch');
if (STOP === 'sch') { await browser.close(); await db.end(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }

// ------------------------------------------------------------------ the plan: board
await open('kicad_pcb');
const sync = await propose({ title: 'Bring the schematic to the board', rationale: 'Every part of the schematic gets its footprint with each pad on its net.', edits: [{ op: 'update_from_schematic' }] });
const usync = sync.details && sync.details[0] && sync.details[0].update_from_schematic;
check('all 37 parts reached the board', usync && usync.added.length === 37 && !usync.problems.length, usync ? `${usync.added.length} added, ${usync.nets} nets, problems: ${JSON.stringify(usync.problems)}` : '');

// A long two-layer board with the headers down the long edges in Pico order, 22.86 mm apart, USB at the top.
const NARROW = process.env.NARROW === '1', ROWS = NARROW ? 17.78 : 22.86;   // NARROW=1: the Pico's own 21 mm width and row spacing
const X0 = 100, Y0 = 50, W = NARROW ? 21 : 26, H = 51.1;
await propose({ title: `Board outline ${W} x ${H} mm`, rationale: `Pico length with the header rows ${ROWS} mm apart: breadboard friendly, and wide enough to keep every part on the top side of a two-layer board.`, edits: [{ op: 'add_item',
  sexpr: `(gr_rect (start ${X0} ${Y0}) (end ${X0 + W} ${Y0 + H}) (stroke (width 0.05) (type solid)) (fill no) (layer "Edge.Cuts") (uuid "${crypto.randomUUID()}"))` }] });
// The floorplan, in mm from the board's top left corner: [x, y, rotation].
const FLOOR = NARROW ? {
  J1: [10.46, 2.5, 180], J4: [10.46, H - 1.61, 90],
  R2: [6.96, 9.0, 0], R1: [13.96, 9.0, 0], R4: [9.86, 9.2, 90], R3: [11.06, 9.2, 90],   // D+ on the left, D- on the right, as U1's pins 47 and 46 are: the pair never has to cross
  U2: [14.5, 12.2, 0], C1: [11.5, 12.2, 90], C2: [17.1, 12.2, 90],
  U3: [6.4, 15.6, 90], C15: [10.2, 15.5, 90], R5: [10.2, 17.6, 90], R6: [10.2, 19.7, 90], SW1: [15.3, 17.6, 90],   // flash turned on end to fit between the header rows
  U1: [10.46, 31, 0],
  C3: [5.26, 25.9, 0], C10: [13.4, 24.9, 90], C11: [14.6, 24.9, 90], C14: [15.8, 24.9, 90], C9: [17.0, 24.9, 90],
  C4: [5.26, 27.2, 0], C5: [5.26, 35.4, 0], C7: [15.66, 27.2, 0], C8: [15.66, 35.4, 0],
  C6: [13.86, 37.1, 90], C13: [15.06, 37.1, 90], C12: [16.26, 37.1, 90],
  Y1: [7.96, 40.5, 0], R7: [9.06, 37.3, 0], C16: [4.86, 40.0, 90], C17: [11.06, 41.0, 90],
  D1: [15.9, 41.5, 0], R9: [15.9, 39.8, 0], SW2: [14.6, 45.5, 0], R8: [10.9, 43.6, 90],
} : {
  J1: [13, 2.5, 180], J4: [10.46, H - 1.61, 90],
  R2: [9.5, 9.2, 0], R1: [16.5, 9.2, 0], R4: [12.4, 9.4, 90], R3: [13.6, 9.4, 90],              // CC pull-downs either side, USB series resistors under the data pins
  U2: [19.3, 12.5, 0], C1: [16.6, 12.5, 90], C2: [22.0, 14.5, 90],                             // regulator by the connector
  U3: [8.2, 15, 0], C15: [8.2, 11.3, 0], R5: [6.5, 19.2, 0], R6: [9.9, 19.2, 0], SW1: [18.5, 19.5, 90],   // flash above the QSPI pins, a clear lane for USB beside it
  U1: [13, 31, 0],
  C3: [7.8, 25.9, 0], C10: [16.4, 24.9, 90], C11: [17.6, 24.9, 90], C14: [18.8, 24.9, 90], C9: [20.0, 24.9, 90],   // top edge supplies
  C4: [7.8, 27.2, 0], C5: [7.8, 35.4, 0], C7: [18.2, 27.2, 0], C8: [18.2, 35.4, 0],            // the four corner IOVDD pins
  C6: [16.4, 37.1, 90], C13: [17.6, 37.1, 90], C12: [18.8, 37.1, 90],                          // bottom edge supplies
  Y1: [10.5, 40.5, 0], R7: [11.6, 37.3, 0], C16: [7.4, 40.0, 90], C17: [13.6, 41.0, 90],       // crystal straight below XIN/XOUT
  D1: [20.5, 41.5, 0], R9: [20.5, 39.8, 0], SW2: [18.5, 45.5, 0], R8: [14.6, 43.6, 90],
};
// Rules for a 0.4 mm pitch QFN: the RP2040's pads are 0.2 mm wide with 0.2 mm between them, so a track leaves a pin
// only when clearance is 0.15 mm. Both values are inside what the usual two-layer fabricators make as standard.
await propose({ title: 'Board rules for the RP2040', rationale: 'Clearance 0.15 mm and a 0.15 mm minimum track so tracks can leave the 0.4 mm pitch QFN; default track 0.2 mm, vias 0.6/0.3 mm, copper 0.3 mm from the edge.',
  edits: [{ op: 'set_rules', clearance: 0.15, track_width: 0.2, via_diameter: 0.6, via_drill: 0.3, min_track_width: 0.15, min_clearance: 0.15, edge_clearance: 0.3 }] });
await page.waitForTimeout(1500);
const place = await propose({ title: 'Place the parts', rationale: 'Connectors where a Pico has them, the RP2040 in the middle, and each support part beside the pin it serves: decoupling at the supply pins, the crystal under XIN/XOUT, flash above the QSPI pins, the regulator by the USB connector, with a clear lane for the USB pair.',
  edits: [{ op: 'auto_place', outline: [X0, Y0, X0 + W, Y0 + H], parts: Object.entries(FLOOR).map(([ref, [x, y, rotation]]) => ({ ref, fixed: { x: r2(X0 + x), y: r2(Y0 + y), rotation } })) },
    // the header rows exactly 22.86 mm apart, off the placement grid
    { op: 'move', ref: 'J2', x: X0 + 1.57, y: Y0 + 1.42, rotation: 0 }, { op: 'move', ref: 'J3', x: X0 + 1.57 + ROWS, y: Y0 + 1.42 + 48.26, rotation: 180 }] });   // pin 21 at the bottom right, as on a Pico
const pl = place.details && place.details[0] && place.details[0].auto_place;
console.log('place', JSON.stringify(pl && pl.score));
check('no two courtyards clash', pl && pl.score.courtyardClashes === 0, JSON.stringify(pl && pl.score));
await page.evaluate(() => window.CollabEditor.api.fitView()); await page.waitForTimeout(600);
await shot('rp2040-02-placed');
await save('rp2040-devboard.placed.kicad_pcb');
if (STOP === 'place') { await browser.close(); await db.end(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }

// Routing in the order a layout engineer works: the nets that must be short and direct first, then
// power, then the rest, ground last.  Each stage is one proposal; its report says what was left.
const nets = (await tool('list_nets', {})).nets.map((n) => n.name);
const named = (re) => nets.filter((n) => re.test(n));
const tally = {};
const route = async (title, rationale, edit) => {
  const r = await page.evaluate((i) => window.KcAssistant.propose(i, true).catch((e) => ({ error: String(e && e.message || e) })), { title, rationale, edits: [Object.assign({ op: 'autoroute' }, edit)] });
  await page.waitForTimeout(500);
  const d = r && r.details && r.details.find((x) => x.autoroute); const a = d && d.autoroute;
  tally[title] = a ? { routed: a.routed, of: a.connections, vias: a.vias, unrouted: a.unrouted.map((u) => `${u.net} (${u.from} to ${u.to}): ${u.reason}${u.blocked_by_nets ? ' by ' + u.blocked_by_nets.join(', ') : ''}`) } : { routed: 0, of: 0, note: (r && (r.error || r.reason) || '').slice(0, 200) };
  console.log(`  ${title}: ${a ? `${a.routed} of ${a.connections}, ${a.vias} vias, ${a.length_mm} mm` : 'nothing more could be routed'}`);
  for (const u of tally[title].unrouted || []) console.log(`      left: ${u}`);
  return a;
};
// FINE=0.15 forces that width on every net of the RP2040; left unset, the engine necks down at its 0.2 mm pads by itself.
const u1 = (await tool('get_component', { ref: 'U1' })).pads || [];
const fine = {}; if (process.env.FINE) for (const p of u1) if (p.net && p.net !== '(no net)') fine[p.net] = { width: +process.env.FINE };
const T = +(process.env.TIME || 200);
const usb = [...named(/USB_D-/), ...named(/USB_D\+/), ...named(/\(R3-|\(R4-/)], tight = [...named(/XIN|XOUT|Y1/), ...named(/QSPI/)];
const critical = [...usb, ...tight];
const power = ['VBUS', '+3V3', '+1V1'];
const rest = nets.filter((n) => n && n !== 'GND' && !critical.includes(n) && !power.includes(n));
const stages = {
  // One call for the whole board: tracks from an earlier call are fixed copper the engine cannot rip up, and it orders the
  // RP2040's fan-out itself. Only the nets that must be shortest are named in order.
  A: () => route('Route the board', 'Everything in one pass so the router can move its own tracks: the USB pair, crystal and flash bus first, VBUS wider, ground into the plane.', { order: critical, net_options: { ...fine, VBUS: { width: 0.4 } }, time_s: T }),
  // The staged plan, kept for comparison (ORDER=UCPZGS): each stage is its own proposal.
  U: () => route('Route USB', 'The USB pair before anything else.', { nets: usb, order: usb, net_options: fine, time_s: T }),
  C: () => route('Route crystal and flash', 'The crystal loop and the QSPI bus on the top layer with no vias.', { nets: tight, order: tight, layers: ['F.Cu'], allow_vias: false, net_options: fine, time_s: T }),
  S: () => route('Route the signals', 'GPIO fan-out to the headers, buttons, LED and SWD.', { nets: rest, net_options: fine, time_s: T }),
  P: () => route('Route power', 'VBUS and the 3.3 V and 1.1 V rails, VBUS wider for the regulator input.', { nets: power, order: power, net_options: { ...fine, VBUS: { width: 0.4 } }, time_s: T }),
  Z: () => propose({ title: 'Ground plane on the bottom layer', rationale: 'A solid ground pour under the whole board: every ground pad then needs only a short via, and every signal has an unbroken return path beneath it. The RP2040 exposed pad, its only ground, gets vias straight down into it, and TESTEN is tied to the pad beside it.', edits: [
    { op: 'add_via', net: 'GND', x: X0 + 13, y: Y0 + 31 },
    { op: 'add_track', net: 'GND', layer: 'F.Cu', width: 0.15, points: [[X0 + 12, Y0 + 34.4375], [X0 + 12, Y0 + 32.3]] },
    { op: 'add_item',
    sexpr: `(zone (net "GND") (layer "B.Cu") (uuid "${crypto.randomUUID()}") (hatch edge 0.5) (connect_pads (clearance 0.3)) (min_thickness 0.25) (fill (thermal_gap 0.3) (thermal_bridge_width 0.4)) (polygon (pts (xy ${X0} ${Y0}) (xy ${X0 + W} ${Y0}) (xy ${X0 + W} ${Y0 + H}) (xy ${X0} ${Y0 + H}))))` }] }),
  G: () => route('Route ground', 'Ground pads down to the plane, and to each other where they are neighbours.', { nets: ['GND'], net_options: fine, time_s: T }),
};
for (const k of (process.env.ORDER || 'ZA')) await stages[k]();
const left = Object.values(tally).flatMap((t) => t.unrouted || []);
if (left.length) await route('Route what is left', 'A second look at the connections the first pass could not make.', { net_options: fine, time_s: T });
const total = Object.entries(tally).filter(([k]) => k !== 'Route what is left').reduce((a, [, t]) => a + t.of, 0), routed = Object.values(tally).reduce((a, t) => a + t.routed, 0);
check('at least 95% of the connections routed', total > 0 && routed >= 0.95 * total, `${routed} of ${total}`);
await page.evaluate(() => window.CollabEditor.api.fitView()); await page.waitForTimeout(600);
await shot('rp2040-03-routed');
await savePro('rp2040-devboard.kicad_pro'); await save('rp2040-devboard.kicad_pcb');
const drc = await tool('run_checks', {});
const byCode = {}; for (const v of drc.violations || []) byCode[v.code] = (byCode[v.code] || 0) + 1;
console.log('DRC', JSON.stringify(byCode));
if (OUT) fs.writeFileSync(path.join(OUT, 'rp2040-report.json'), JSON.stringify({ routing: tally, drc: byCode, drc_violations: drc.violations }, null, 1));
const info = await tool('get_board_info', {});
console.log('board', JSON.stringify({ size: info.size_mm, stats: info.statistics, layout: info.layout, widths: info.track_widths_in_use_mm }));

await browser.close(); await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
