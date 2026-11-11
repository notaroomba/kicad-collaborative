// A stand-in for the part vendors, for tests on a network that cannot reach them.
//
// LCSC / JLCPCB / EasyEDA answers are REAL responses, replayed from
// tests/fixtures/vendor (captured by scripts/capture-vendor-fixtures.sh).  Mouser and
// DigiKey need credentials to answer at all, so their answers here are written by hand
// in the shape their API documentation gives — the one part of this file that is not
// recorded data.  Their no-credential error bodies are the recorded ones.
//
//   node server/scripts/fake-vendors.mjs            # listens on 127.0.0.1:8097
//
// Point the server at it:
//   EASYEDA_API_URL=http://127.0.0.1:8097 EASYEDA_MODELS_URL=http://127.0.0.1:8097
//   JLCPCB_API_URL=http://127.0.0.1:8097 JLCSEARCH_URL=http://127.0.0.1:8097
//   MOUSER_API_URL=http://127.0.0.1:8097 DIGIKEY_API_URL=http://127.0.0.1:8097
//
// Test controls:  POST /__ctl/down {"easyeda":true,"jlcpcb":true,…}   take a vendor offline
//                 GET  /__ctl/hits                                    request counts per route
//                 POST /__ctl/reset
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'vendor');
const PORT = +(process.env.FAKE_VENDORS_PORT || 8097);
export const MOUSER_KEY = 'test-mouser-key';
export const DIGIKEY_ID = 'test-digikey-id', DIGIKEY_SECRET = 'test-digikey-secret';

const read = (f) => fs.readFileSync(path.join(DIR, f));
const json = (f) => JSON.parse(read(f).toString('utf8'));
const files = fs.readdirSync(DIR);

// every part JLCPCB's search returned in any capture, as one index
const jlc = new Map();
for (const f of files.filter((f) => f.startsWith('jlcpcb_search_')))
  for (const c of json(f).data.componentPageInfo.list) jlc.set(c.componentCode, c);
const jlcIndex = new Map();
for (const f of files.filter((f) => f.startsWith('jlcsearch_api_'))) {
  const j = json(f); for (const c of j.components || []) jlcIndex.set(c.lcsc, c);
}
const models = new Map();   // model uuid → file
for (const f of files.filter((f) => f.startsWith('easyeda_C'))) {
  const m = /"uuid\\":\\"([0-9a-f]{32})\\",\\"c_etype\\":\\"outline3D/.exec(read(f).toString('utf8'));
  const step = 'model_' + f.slice(8, -5) + '.step';
  if (m && files.includes(step)) models.set(m[1], step);
}

const mouserParts = [
  { mpn: 'STM32F103C8T6', mfr: 'STMicroelectronics', no: '511-STM32F103C8T6', desc: 'ARM Microcontrollers - MCU 32BIT Cortex M3 64K Flash 20K RAM', stock: 6609, pkg: 'LQFP-48', price: [[1, 5.61], [10, 4.2], [100, 3.56]] },
  { mpn: 'AMS1117-3.3', mfr: 'Advanced Monolithic Systems', no: '926-AMS1117-3.3', desc: 'LDO Voltage Regulators 1A Low Dropout Regulator 3.3V', stock: 12040, pkg: 'SOT-223-3', price: [[1, 0.48], [100, 0.31]] },
  { mpn: 'RP2040', mfr: 'Raspberry Pi', no: '358-SC0914(13)', desc: 'ARM Microcontrollers - MCU Dual core ARM Cortex-M0+ 133MHz', stock: 88000, pkg: 'QFN-56', price: [[1, 1.0], [500, 0.8]] },
  { mpn: 'LT8640SEV#PBF', mfr: 'Analog Devices', no: '584-LT8640SEV#PBF', desc: 'Switching Voltage Regulators 42V, 5A Synchronous Step-Down Silent Switcher 2', stock: 950, pkg: 'LQFN-20', price: [[1, 11.87], [25, 9.2]] },
];
const mouserJson = (p) => ({
  Availability: `${p.stock} In Stock`, AvailabilityInStock: String(p.stock), DataSheetUrl: `https://www.mouser.com/datasheet/${encodeURIComponent(p.mpn)}.pdf`,
  Description: p.desc, ImagePath: '', Category: 'Semiconductors', LifecycleStatus: null, Manufacturer: p.mfr, ManufacturerPartNumber: p.mpn,
  MouserPartNumber: p.no, ProductDetailUrl: `https://www.mouser.com/ProductDetail/${encodeURIComponent(p.no)}`, ROHSStatus: 'RoHS Compliant',
  PriceBreaks: p.price.map(([q, v]) => ({ Quantity: q, Price: `$${v.toFixed(2)}`, Currency: 'USD' })),
  ProductAttributes: [{ AttributeName: 'Package / Case', AttributeValue: p.pkg }, { AttributeName: 'Packaging', AttributeValue: 'Tray' }],
});
const dkParts = mouserParts.map((p, i) => ({ ...p, dk: ['497-6063-ND', 'AMS1117-3.3TR-ND', '2648-SC0914(13)CT-ND', 'LT8640SEV#PBF-ND'][i] }));
const dkJson = (p) => ({
  Description: { ProductDescription: p.desc.slice(0, 40), DetailedDescription: p.desc }, Manufacturer: { Id: 1, Name: p.mfr },
  ManufacturerProductNumber: p.mpn, UnitPrice: p.price[0][1], ProductUrl: `https://www.digikey.com/en/products/detail/x/${1000 + p.stock}`,
  DatasheetUrl: `//www.digikey.com/ds/${encodeURIComponent(p.mpn)}.pdf`, PhotoUrl: '', QuantityAvailable: p.stock + 500,
  ProductVariations: [
    { DigiKeyProductNumber: p.dk, PackageType: { Id: 2, Name: 'Cut Tape (CT)' }, MinimumOrderQuantity: 1, StandardPricing: p.price.map(([q, v]) => ({ BreakQuantity: q, UnitPrice: v, TotalPrice: q * v })) },
    { DigiKeyProductNumber: p.dk.replace('-ND', '-2-ND'), PackageType: { Id: 1, Name: 'Tape & Reel (TR)' }, MinimumOrderQuantity: 2500, StandardPricing: [{ BreakQuantity: 2500, UnitPrice: p.price[0][1] * 0.5, TotalPrice: 2500 * p.price[0][1] * 0.5 }] },
  ],
  ProductStatus: { Id: 0, Status: 'Active' }, Category: { CategoryId: 32, Name: 'Integrated Circuits (ICs)' },
  Parameters: [{ ParameterId: 16, ParameterText: 'Package / Case', ValueId: '1', ValueText: p.pkg }, { ParameterId: 252, ParameterText: 'Operating Temperature', ValueText: '-40°C ~ 85°C' }],
});

let down = {}; let hits = {};
const body = (req) => new Promise((res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => res(Buffer.concat(c).toString('utf8'))); });
const send = (res, status, data, type = 'application/json') => { const b = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)); res.writeHead(status, { 'Content-Type': type, 'Content-Length': b.length }); res.end(b); };
const hit = (k) => { hits[k] = (hits[k] || 0) + 1; };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const p = url.pathname;
  const text = req.method === 'GET' ? '' : await body(req);
  let j = {}; try { j = text ? JSON.parse(text) : {}; } catch { /* a form body */ }

  if (p === '/__ctl/down') { down = j; return send(res, 200, { ok: true }); }
  if (p === '/__ctl/reset') { down = {}; hits = {}; return send(res, 200, { ok: true }); }
  if (p === '/__ctl/hits') return send(res, 200, hits);

  // ---- EasyEDA: one part with its drawings
  let m = /^\/api\/products\/(C\d+)\/components$/.exec(p);
  if (m) {
    hit('easyeda');
    if (down.easyeda) return send(res, 503, 'upstream down', 'text/plain');
    const f = `easyeda_${m[1]}.json`;
    return files.includes(f) ? send(res, 200, read(f)) : send(res, 200, { success: false, code: 404, result: [] });
  }
  // ---- EasyEDA: a STEP model
  m = /^\/qAxj6KHrDKw4blvCG8QJPs7Y\/([0-9a-f]+)$/.exec(p);
  if (m) {
    hit('model');
    if (down.easyeda) return send(res, 503, 'upstream down', 'text/plain');
    return models.has(m[1]) ? send(res, 200, read(models.get(m[1])), 'text/plain') : send(res, 404, 'not found', 'text/plain');
  }
  // ---- JLCPCB parts search
  if (p === '/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList') {
    hit('jlcpcb');
    if (down.jlcpcb) return send(res, 503, 'upstream down', 'text/plain');
    const kw = String(j.keyword || '').trim(); const exact = `jlcpcb_search_${kw.replace(/ /g, '_')}.json`;
    if (files.includes(exact)) return send(res, 200, read(exact));
    const words = kw.toLowerCase().split(/\s+/).filter(Boolean);
    const list = [...jlc.values()].filter((c) => { const hay = `${c.componentCode} ${c.componentModelEn} ${c.componentBrandEn} ${c.describe} ${c.componentSpecificationEn}`.toLowerCase(); return words.every((w) => hay.includes(w)); }).slice(0, j.pageSize || 25);
    return send(res, 200, { code: 200, data: list.length ? { componentPageInfo: { total: list.length, list } } : null, message: null });
  }
  // ---- the public JLCPCB index (fallback search)
  if (p === '/api/search') {
    hit('jlcsearch');
    if (down.jlcsearch) return send(res, 500, { error: 'down' });
    const words = (url.searchParams.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
    return send(res, 200, { components: [...jlcIndex.values()].filter((c) => words.every((w) => `C${c.lcsc} ${c.mfr} ${c.description} ${c.package}`.toLowerCase().includes(w))) });
  }
  // ---- Mouser
  m = /^\/api\/v1\/search\/(keyword|partnumber)$/.exec(p);
  if (m) {
    hit('mouser');
    if (down.mouser) return send(res, 503, 'upstream down', 'text/plain');
    const key = url.searchParams.get('apiKey') || '';
    if (!key) return send(res, 200, read('mouser_nokey.json'));
    if (key !== MOUSER_KEY) return send(res, 200, { Errors: [{ Id: 0, Code: 'Invalid', Message: 'Invalid unique identifier.', ResourceKey: 'InvalidIdentifier', PropertyName: 'API Key' }], SearchResults: null });
    let parts;
    if (m[1] === 'keyword') { const kw = String(j.SearchByKeywordRequest?.keyword || '').toLowerCase(); parts = mouserParts.filter((x) => `${x.mpn} ${x.mfr} ${x.desc} ${x.no}`.toLowerCase().includes(kw)); }
    else { const no = String(j.SearchByPartRequest?.mouserPartNumber || ''); parts = mouserParts.filter((x) => x.no === no); }
    return send(res, 200, { Errors: [], SearchResults: { NumberOfResult: parts.length, Parts: parts.map(mouserJson) } });
  }
  // ---- DigiKey
  if (p === '/v1/oauth2/token') {
    hit('digikey-token');
    const f = new URLSearchParams(text);
    if (f.get('client_id') !== DIGIKEY_ID || f.get('client_secret') !== DIGIKEY_SECRET) return send(res, 401, { ErrorMessage: 'Invalid clientId or clientSecret', ErrorDetails: 'invalid_client' });
    return send(res, 200, { access_token: 'dk-token-1', expires_in: 599, token_type: 'Bearer' });
  }
  if (p.startsWith('/products/v4/search/')) {
    hit('digikey');
    if (down.digikey) return send(res, 503, 'upstream down', 'text/plain');
    if (!req.headers['x-digikey-client-id']) return send(res, 400, read('digikey_nokey.json'));
    if (req.headers.authorization !== 'Bearer dk-token-1') return send(res, 401, { title: 'Unauthorized', status: 401, detail: 'The Bearer token is invalid' });
    if (p === '/products/v4/search/keyword') { const kw = String(j.Keywords || '').toLowerCase(); const parts = dkParts.filter((x) => `${x.mpn} ${x.mfr} ${x.desc} ${x.dk}`.toLowerCase().includes(kw)); return send(res, 200, { Products: parts.map(dkJson), ProductsCount: parts.length, ExactMatches: [] }); }
    m = /^\/products\/v4\/search\/(.+)\/productdetails$/.exec(p);
    if (m) { const no = decodeURIComponent(m[1]); const part = dkParts.find((x) => x.dk === no || x.mpn === no); return part ? send(res, 200, { Product: dkJson(part) }) : send(res, 404, { title: 'Not Found', status: 404, detail: `The product ${no} was not found.` }); }
  }
  send(res, 404, { error: 'not found', path: p });
});
server.listen(PORT, '127.0.0.1', () => console.log(`fake vendors on http://127.0.0.1:${PORT} — ${jlc.size} parts in the JLCPCB index, ${files.filter((f) => f.startsWith('easyeda_C')).length} with drawings, ${models.size} 3D models`));
