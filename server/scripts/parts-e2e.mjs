// End-to-end test of vendor parts and saved part libraries, against the stand-in
// vendors in fake-vendors.mjs (which replays real LCSC / JLCPCB / EasyEDA answers).
//
//   node server/scripts/fake-vendors.mjs &
//
//   V=http://127.0.0.1:8097
//   DATABASE_URL=postgres://postgres@127.0.0.1:55432/collabtest JWT_SECRET=testsecret \
//   PUBLIC_URL=http://127.0.0.1:8099 PORT=8099 KC_DEV_LOGIN=1 \
//   EASYEDA_API_URL=$V EASYEDA_MODELS_URL=$V JLCPCB_API_URL=$V JLCSEARCH_URL=$V MOUSER_API_URL=$V DIGIKEY_API_URL=$V \
//     cargo run --manifest-path server/Cargo.toml
//
//   cd server/scripts && npm install && \
//   E2E_PG_URL=postgres://postgres@127.0.0.1:55432/collabtest E2E_JWT_SECRET=testsecret node parts-e2e.mjs
//
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import pg from 'pg';

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const FAKE = (process.env.E2E_FAKE_VENDORS || 'http://127.0.0.1:8097').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET;
const PG_URL = process.env.E2E_PG_URL;
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required (see the header comment).'); process.exit(2); }

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const eq = (name, got, want) => check(name, JSON.stringify(canon(got)) === JSON.stringify(canon(want)), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintJwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' }); const body = b64({ sub, login, iat: now, exp: now + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();

async function call(token, method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* not json */ }
  return { status: r.status, j };
}
const ctl = async (what, body) => (await fetch(`${FAKE}/__ctl/${what}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
const part = (t, vendor, id, extra = '') => call(t, 'GET', `/api/parts/part?vendor=${vendor}&id=${encodeURIComponent(id)}${extra}`);

/** Parentheses balance outside quoted strings. */
function balanced(s) {
  let d = 0, q = false, e = false;
  for (const c of s) { if (q) { if (e) e = false; else if (c === '\\') e = true; else if (c === '"') q = false; } else if (c === '"') q = true; else if (c === '(') d++; else if (c === ')') { if (--d < 0) return false; } }
  return d === 0 && !q;
}
/** The files in a zip: name → Buffer (central directory walk; deflate or stored). */
function unzip(buf) {
  const out = new Map(); let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let p = buf.readUInt32LE(eocd + 16); const n = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const ds = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28); const raw = buf.slice(ds, ds + csize);
    out.set(name, method === 8 ? zlib.inflateRawSync(raw) : raw); p += 46 + nlen + elen + clen;
  }
  return out;
}

// ---------------------------------------------------------------- setup
const tag = crypto.randomBytes(3).toString('hex');
const mkUser = async (login) => (await db.query(`INSERT INTO users (github_id, login, name) VALUES ($1, $2, $2) RETURNING id`, [Math.floor(Math.random() * 2e9), login])).rows[0].id;
const aliceId = await mkUser(`parts-alice-${tag}`), bobId = await mkUser(`parts-bob-${tag}`), carolId = await mkUser(`parts-carol-${tag}`);
const alice = mintJwt(aliceId, `parts-alice-${tag}`), bob = mintJwt(bobId, `parts-bob-${tag}`), carol = mintJwt(carolId, `parts-carol-${tag}`);
const projectId = (await db.query(`INSERT INTO projects (owner_id, name) VALUES ($1, $2) RETURNING id`, [aliceId, `parts project ${tag}`])).rows[0].id;
await db.query(`INSERT INTO permissions (project_id, user_id, role) VALUES ($1, $2, 'viewer')`, [projectId, bobId]);
await db.query(`DELETE FROM parts WHERE vendor IN ('lcsc','mouser','digikey','farnell')`);
await db.query(`DELETE FROM part_models`);
await ctl('reset', {});

// ---------------------------------------------------------------- vendors and auth
{
  const anon = await fetch(`${BASE}/api/parts/search?q=STM32F103C8T6`);
  eq('search needs a signed-in user', anon.status, 401);
  const v = (await call(alice, 'GET', '/api/parts/vendors')).j.vendors;
  eq('four vendors are offered', v.map((x) => x.id), ['lcsc', 'mouser', 'digikey', 'farnell']);
  eq('LCSC works without a key; Mouser and DigiKey wait for one', v.map((x) => x.configured), [true, false, false, false]);
}

// ---------------------------------------------------------------- LCSC search
{
  const r = await call(alice, 'GET', '/api/parts/search?q=STM32F103C8T6&vendor=lcsc');
  eq('search answers', r.status, 200);
  const top = r.j.results[0];
  eq('the first hit is the part itself', [top.vendor, top.vendor_id, top.mpn, top.manufacturer, top.package], ['lcsc', 'C8734', 'STM32F103C8T6', 'STMicroelectronics', 'LQFP-48(7x7)']);
  check('it carries stock, price breaks, a datasheet and attributes', top.stock > 1000 && top.prices.length >= 3 && top.prices[0].qty === 1 && /^https:\/\/.*\.pdf$/.test(top.datasheet) && Object.keys(top.attributes).length > 3, JSON.stringify(top).slice(0, 300));
  eq('JLCPCB assembly class is read', top.assembly, 'preferred');
  eq('nothing is cached by a search', (await db.query(`SELECT count(*)::int AS n FROM parts`)).rows[0].n, 0);

  const kw = await call(alice, 'GET', '/api/parts/search?q=10k%200603&vendor=lcsc');
  check('a keyword search finds resistors', kw.j.results.length >= 10 && kw.j.results.every((x) => x.vendor === 'lcsc' && /^C\d+$/.test(x.vendor_id)), `${kw.j.results.length} results`);
  const none = await call(alice, 'GET', '/api/parts/search?q=zzzznothingzzzz&vendor=lcsc');
  eq('no match is an empty list, not an error', [none.status, none.j.results.length, none.j.errors.length], [200, 0, 0]);
  eq('a one-letter search is refused', (await call(alice, 'GET', '/api/parts/search?q=a')).status, 400);

  // JLCPCB's search down: the public index answers instead
  await ctl('down', { jlcpcb: true });
  const fb = await call(alice, 'GET', '/api/parts/search?q=STM32F103C8T6&vendor=lcsc');
  eq('with JLCPCB search down the public index still finds the part', [fb.status, fb.j.results[0]?.vendor_id], [200, 'C8734']);
  await ctl('down', { jlcpcb: true, jlcsearch: true });
  const dead = await call(alice, 'GET', '/api/parts/search?q=STM32F103C8T6&vendor=lcsc');
  eq('with both down the search says the vendor is unreachable', [dead.status, dead.j.results.length, dead.j.errors[0]?.code], [200, 0, 'vendor_unreachable']);
  await ctl('down', {});
}

// ---------------------------------------------------------------- one LCSC part, with drawings
let stm;
{
  const r = await part(alice, 'lcsc', 'c8734');
  eq('a part is fetched by its LCSC number (any case)', [r.status, r.j.vendor_id, r.j.mpn, r.j.manufacturer], [200, 'C8734', 'STM32F103C8T6', 'ST']);
  stm = r.j;
  const cad = stm.cad;
  check('it comes with a symbol and a footprint', !!cad && !!cad.symbol && !!cad.footprint);
  eq('symbol: name, library id, 48 pins, one unit', [cad.symbol.name, cad.symbol.lib_id, cad.symbol.pins, cad.symbol.units], ['STM32F103C8T6', 'LCSC:STM32F103C8T6', 48, 1]);
  eq('footprint: library id and 48 pads', [cad.footprint.fpid, cad.footprint.pads, cad.footprint.through_hole], ['LCSC:LQFP-48_L7.0-W7.0-P0.50-LS9.0-BL', 48, false]);
  check('the symbol is a KiCad library symbol', cad.symbol.sexpr.startsWith('(symbol "STM32F103C8T6"') && balanced(cad.symbol.sexpr) && cad.symbol.sexpr.includes('(symbol "STM32F103C8T6_1_1"'));
  check('the footprint is a KiCad footprint', cad.footprint.sexpr.startsWith('(footprint "LQFP-48_L7.0-W7.0-P0.50-LS9.0-BL"') && balanced(cad.footprint.sexpr) && cad.footprint.sexpr.includes('(layer "F.Cu")'));
  check('the symbol points at its footprint and carries the reference fields',
    cad.symbol.sexpr.includes('(property "Footprint" "LCSC:LQFP-48_L7.0-W7.0-P0.50-LS9.0-BL"') && cad.symbol.sexpr.includes('(property "LCSC" "C8734"') && cad.symbol.sexpr.includes('(property "MPN" "STM32F103C8T6"') && cad.symbol.sexpr.includes('(property "Manufacturer" "ST"'));
  eq('the fields to put on a placed symbol', stm.fields, { MPN: 'STM32F103C8T6', Manufacturer: 'ST', LCSC: 'C8734' });
  check('the datasheet comes from the catalogue', /^https:\/\/www\.lcsc\.com\/datasheet\/.*C8734\.pdf$/.test(stm.datasheet), stm.datasheet);
  eq('fresh, not stale', [stm.stale, typeof stm.fetched_at], [false, 'string']);

  // the cache: a second read does not go back to the vendor
  const before = (await ctl('hits')).easyeda;
  const again = await part(bob, 'lcsc', 'C8734');
  eq('a second read (by anyone) is served from the cache', [again.status, (await ctl('hits')).easyeda], [200, before]);
  eq('the cached copy converts to the same symbol', again.j.cad.symbol.sexpr, cad.symbol.sexpr);

  const lib = await part(alice, 'lcsc', 'C8734', '&lib=My%20Parts');
  eq('a library nickname is applied to the ids', [lib.j.cad.symbol.lib_id, lib.j.cad.footprint.fpid], ['My_Parts:STM32F103C8T6', 'My_Parts:LQFP-48_L7.0-W7.0-P0.50-LS9.0-BL']);
  check('… and to the Footprint field', lib.j.cad.symbol.sexpr.includes('(property "Footprint" "My_Parts:LQFP-48_L7.0-W7.0-P0.50-LS9.0-BL"'));

  eq('an unknown LCSC number is a 404', [(await part(alice, 'lcsc', 'C999999999')).status, (await part(alice, 'lcsc', 'C999999999')).j.error], [404, 'part_not_found']);
  eq('a malformed number is refused', (await part(alice, 'lcsc', 'STM32')).status, 400);
  eq('an unknown vendor is refused', (await part(alice, 'arrow', '123')).status, 400);

  const direct = await call(alice, 'GET', '/api/parts/search?q=C25804');
  eq('searching an LCSC number returns exactly that part', [direct.j.results.length, direct.j.results[0]?.vendor_id, direct.j.results[0]?.mpn], [1, 'C25804', '0603WAF1002T5E']);
}

// ---------------------------------------------------------------- vendor outage: the cache keeps the part
{
  await ctl('down', { easyeda: true, jlcpcb: true, jlcsearch: true });
  const cached = await part(alice, 'lcsc', 'C8734');
  eq('with the vendor down a cached part still opens', [cached.status, cached.j.stale, !!cached.j.cad.symbol], [200, false, true]);
  const forced = await part(alice, 'lcsc', 'C8734', '&refresh=1');
  eq('a forced refresh that fails keeps the old copy and says it is stale', [forced.status, forced.j.stale, !!forced.j.stale_reason, !!forced.j.cad.footprint], [200, true, true, true]);
  const never = await part(alice, 'lcsc', 'C2040');
  eq('a part never fetched cannot be conjured: vendor unreachable', [never.status, never.j.error], [502, 'vendor_unreachable']);
  // a part whose information is old is refetched; when that fails, the old copy is served
  await db.query(`UPDATE parts SET info_fetched_at = now() - interval '3 days' WHERE vendor = 'lcsc' AND vendor_id = 'C8734'`);
  const old = await part(alice, 'lcsc', 'C8734');
  eq('an expired part is served stale while the vendor is down', [old.status, old.j.stale, old.j.cad.symbol.pins], [200, true, 48]);
  await ctl('down', {});
  const back = await part(alice, 'lcsc', 'C8734');
  eq('… and refreshed once the vendor is back', [back.status, back.j.stale], [200, false]);
}

// ---------------------------------------------------------------- 3D model
{
  await part(alice, 'lcsc', 'C25804');
  const r = await fetch(`${BASE}/api/parts/model.step?vendor=lcsc&id=C25804`, { headers: { Authorization: `Bearer ${alice}` } });
  const bytes = Buffer.from(await r.arrayBuffer());
  eq('the STEP model is served', [r.status, r.headers.get('content-type'), bytes.slice(0, 9).toString()], [200, 'model/step', 'ISO-10303']);
  const n = (await ctl('hits')).model;
  await fetch(`${BASE}/api/parts/model.step?vendor=lcsc&id=C25804`, { headers: { Authorization: `Bearer ${alice}` } });
  eq('… and cached after the first fetch', (await ctl('hits')).model, n);
}

// ---------------------------------------------------------------- Mouser and DigiKey: keys
{
  const none = await call(alice, 'GET', '/api/parts/search?q=STM32F103C8T6&vendor=mouser');
  eq('Mouser without a key says so', [none.status, none.j.errors[0]?.code], [200, 'vendor_not_configured']);
  eq('a wrong Mouser key is refused and not stored', [(await call(alice, 'PUT', '/api/parts/keys/mouser', { api_key: 'nope' })).j.error, (await db.query(`SELECT count(*)::int AS n FROM vendor_keys WHERE user_id = $1`, [aliceId])).rows[0].n], ['vendor_rejected_key', 0]);
  eq('an empty key is refused', (await call(alice, 'PUT', '/api/parts/keys/mouser', { api_key: ' ' })).status, 400);
  eq('the right Mouser key is checked and stored', (await call(alice, 'PUT', '/api/parts/keys/mouser', { api_key: 'test-mouser-key' })).j, { ok: true, verified: true });
  const stored = (await db.query(`SELECT secret FROM vendor_keys WHERE user_id = $1 AND vendor = 'mouser'`, [aliceId])).rows[0].secret;
  check('the key is encrypted at rest', !stored.toString('latin1').includes('test-mouser-key'));
  eq('a wrong DigiKey secret is refused', (await call(alice, 'PUT', '/api/parts/keys/digikey', { client_id: 'test-digikey-id', client_secret: 'bad' })).j.error, 'vendor_rejected_key');
  eq('the right DigiKey credentials are stored', (await call(alice, 'PUT', '/api/parts/keys/digikey', { client_id: 'test-digikey-id', client_secret: 'test-digikey-secret' })).j, { ok: true, verified: true });
  const v = (await call(alice, 'GET', '/api/parts/vendors')).j.vendors;
  eq('both now show as configured with the user\'s own keys', v.map((x) => [x.configured, x.key_source]), [[true, null], [true, 'yours'], [true, 'yours'], [false, null]]);
  eq('another user still has no keys', (await call(bob, 'GET', '/api/parts/vendors')).j.vendors.map((x) => x.configured), [true, false, false, false]);
}

// ---------------------------------------------------------------- Farnell / Newark / element14
{
  eq('Farnell without a key says so', (await call(alice, 'GET', '/api/parts/search?q=STM32F103C8T6&vendor=farnell')).j.errors[0]?.code, 'vendor_not_configured');
  eq('a wrong Farnell key is refused', (await call(alice, 'PUT', '/api/parts/keys/farnell', { api_key: 'nope' })).status >= 400, true);
  eq('a store that is not a host name is refused', (await call(alice, 'PUT', '/api/parts/keys/farnell', { api_key: 'test-farnell-key', store: 'not a host/../x' })).status, 400);
  eq('the right key is stored; the store defaults to uk.farnell.com', (await call(alice, 'PUT', '/api/parts/keys/farnell', { api_key: 'test-farnell-key' })).j, { ok: true, verified: true });
  const f = await call(alice, 'GET', '/api/parts/search?q=STM32F103C8T6&vendor=farnell'); const hit = f.j.results[0];
  eq('Farnell search', [f.status, hit.vendor, hit.vendor_name, hit.vendor_id, hit.mpn, hit.manufacturer, hit.stock, hit.package, hit.prices[1]], [200, 'farnell', 'Farnell', '1447637', 'STM32F103C8T6', 'STMICROELECTRONICS', 4521, 'LQFP', { qty: 10, price: 3.21, currency: 'GBP' }]);
  const p = await part(alice, 'farnell', '1447637');
  eq('a Farnell part borrows the LCSC drawings with the same MPN', [p.status, p.j.cad?.source, p.j.cad?.symbol?.pins], [200, { vendor: 'lcsc', vendor_id: 'C8734' }, 48]);
  eq('its fields name Farnell', [p.j.fields.Farnell, p.j.fields.MPN], ['1447637', 'STM32F103C8T6']);
  eq('an order code Farnell does not have is a 404', (await part(alice, 'farnell', '9999999')).status, 404);
  eq('another store answers in its own currency', [(await call(alice, 'PUT', '/api/parts/keys/farnell', { api_key: 'test-farnell-key', store: 'https://www.Newark.com/' })).j.ok, (await call(alice, 'GET', '/api/parts/search?q=STM32F103C8T6&vendor=farnell')).j.results[0].prices[0].currency], [true, 'USD']);
  eq('the key can be removed again', (await call(alice, 'DELETE', '/api/parts/keys/farnell')).j.ok, true);
}

// ---------------------------------------------------------------- Mouser and DigiKey: parts, with LCSC drawings by MPN
{
  const m = await call(alice, 'GET', '/api/parts/search?q=STM32F103C8T6&vendor=mouser');
  const hit = m.j.results[0];
  eq('Mouser search', [m.status, hit.vendor, hit.vendor_id, hit.mpn, hit.manufacturer, hit.stock, hit.package, hit.prices[0]], [200, 'mouser', '511-STM32F103C8T6', 'STM32F103C8T6', 'STMicroelectronics', 6609, 'LQFP-48', { qty: 1, price: 5.61, currency: 'USD' }]);
  const p = await part(alice, 'mouser', '511-STM32F103C8T6');
  eq('a Mouser part borrows the drawings of the LCSC listing with the same MPN', [p.status, p.j.cad?.source, p.j.cad?.symbol?.pins, p.j.cad?.footprint?.pads], [200, { vendor: 'lcsc', vendor_id: 'C8734' }, 48, 48]);
  eq('its fields name Mouser, and LCSC as the drawing source', p.j.fields, { MPN: 'STM32F103C8T6', Manufacturer: 'STMicroelectronics', Mouser: '511-STM32F103C8T6', LCSC: 'C8734' });
  check('the symbol carries the Mouser number', p.j.cad.symbol.sexpr.includes('(property "Mouser" "511-STM32F103C8T6"'));

  const odd = await part(alice, 'mouser', '584-LT8640SEV#PBF');
  eq('a part with no LCSC twin has data but no drawings', [odd.status, odd.j.mpn, odd.j.cad], [200, 'LT8640SEV#PBF', null]);
  const linked = await call(alice, 'PUT', `/api/parts/cad?vendor=mouser&id=${encodeURIComponent('584-LT8640SEV#PBF')}`, { lcsc: 'C6186' });
  eq('drawings can be linked by hand', [linked.status, linked.j.cad?.source?.vendor_id, !!linked.j.cad?.footprint], [200, 'C6186', true]);
  eq('linking to a part that does not exist is refused', (await call(alice, 'PUT', `/api/parts/cad?vendor=mouser&id=${encodeURIComponent('584-LT8640SEV#PBF')}`, { lcsc: 'C999999999' })).status, 404);

  const d = await call(alice, 'GET', '/api/parts/search?q=AMS1117&vendor=digikey');
  const dh = d.j.results[0];
  eq('DigiKey search', [d.status, dh.vendor, dh.vendor_id, dh.mpn, dh.manufacturer, dh.package, dh.lifecycle, dh.prices[0].price], [200, 'digikey', 'AMS1117-3.3TR-ND', 'AMS1117-3.3', 'Advanced Monolithic Systems', 'SOT-223-3', 'Active', 0.48]);
  const dp = await part(alice, 'digikey', 'AMS1117-3.3TR-ND');
  eq('a DigiKey part resolves to LCSC drawings too', [dp.status, dp.j.cad?.source?.vendor_id, dp.j.cad?.footprint?.name, dp.j.fields.DigiKey], [200, 'C6186', 'SOT-223-3_L6.5-W3.4-P2.30-LS7.0-BR', 'AMS1117-3.3TR-ND']);
  eq('a part number with awkward characters round-trips', [(await part(alice, 'digikey', '2648-SC0914(13)CT-ND')).j.mpn], ['RP2040']);
  eq('an unknown DigiKey number is a 404', (await part(alice, 'digikey', 'NOPE-ND')).status, 404);

  const all = await call(alice, 'GET', '/api/parts/search?q=STM32F103C8T6');
  eq('searching everywhere returns hits from all three vendors', [...new Set(all.j.results.map((x) => x.vendor))].sort(), ['digikey', 'lcsc', 'mouser']);
  check('… and marks the LCSC hit as already cached', all.j.results.find((x) => x.vendor_id === 'C8734').cached === true);
  eq('bob, without keys, searches LCSC only', [...new Set((await call(bob, 'GET', '/api/parts/search?q=STM32F103C8T6')).j.results.map((x) => x.vendor))], ['lcsc']);
}

// ---------------------------------------------------------------- saved libraries
let libId;
{
  eq('a library needs a name', (await call(alice, 'POST', '/api/libraries', { name: '  ' })).status, 400);
  const made = await call(alice, 'POST', '/api/libraries', { name: 'Motor Board', description: 'parts for the motor controller' });
  eq('a library is created', [made.status, made.j.name, made.j.nickname, made.j.items.length, made.j.mine, made.j.can_edit], [200, 'Motor Board', 'Motor_Board', 0, true, true]);
  libId = made.j.id;

  let lib = (await call(alice, 'POST', `/api/libraries/${libId}/items`, { vendor: 'lcsc', vendor_id: 'c25804', note: 'pull-ups' })).j;
  eq('an LCSC part is added by reference', lib.items.map((i) => [i.vendor, i.vendor_id, i.mpn, i.manufacturer, i.note, i.has_cad, i.cached]), [['lcsc', 'C25804', '0603WAF1002T5E', 'UNI-ROYAL', 'pull-ups', true, true]]);
  lib = (await call(alice, 'POST', `/api/libraries/${libId}/items`, { vendor: 'mouser', vendor_id: '511-STM32F103C8T6' })).j;
  lib = (await call(alice, 'POST', `/api/libraries/${libId}/items`, { vendor: 'digikey', vendor_id: 'AMS1117-3.3TR-ND' })).j;
  lib = (await call(alice, 'POST', `/api/libraries/${libId}/items`, { vendor: 'lcsc', vendor_id: 'C165948' })).j;
  eq('parts from all three vendors sit in one library', lib.items.map((i) => `${i.vendor}:${i.vendor_id}:${i.has_cad}`), ['lcsc:C25804:true', 'mouser:511-STM32F103C8T6:true', 'digikey:AMS1117-3.3TR-ND:true', 'lcsc:C165948:true']);
  lib = (await call(alice, 'POST', `/api/libraries/${libId}/items`, { vendor: 'lcsc', vendor_id: 'C25804' })).j;
  eq('adding the same part twice keeps one entry (and its note)', [lib.items.length, lib.items[0].note], [4, 'pull-ups']);
  eq('a part that does not exist cannot be added', (await call(alice, 'POST', `/api/libraries/${libId}/items`, { vendor: 'lcsc', vendor_id: 'C999999999' })).status, 404);

  // what the library stores is the reference only
  const cols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'part_library_items' ORDER BY ordinal_position`)).rows.map((r) => r.column_name);
  eq('a library entry holds only the reference', cols, ['id', 'library_id', 'vendor', 'vendor_id', 'mpn', 'manufacturer', 'note', 'added_by', 'added_at']);

  const itemId = lib.items[0].id;
  eq('a note can be edited', (await call(alice, 'PATCH', `/api/libraries/${libId}/items/${itemId}`, { note: '1% pull-ups' })).j.items[0].note, '1% pull-ups');
  eq('the library is renamed', (await call(alice, 'PATCH', `/api/libraries/${libId}`, { name: 'Motor Controller' })).j.nickname, 'Motor_Controller');

  // sharing through a project
  eq('a private library is invisible to others', [(await call(bob, 'GET', `/api/libraries/${libId}`)).status, (await call(bob, 'GET', '/api/libraries')).j.libraries.length], [404, 0]);
  eq('carol cannot share a library with a project she is not in', (await call(carol, 'POST', '/api/libraries', { name: 'x', project_id: projectId })).status, 403);
  eq('alice shares hers with her project', (await call(alice, 'PATCH', `/api/libraries/${libId}`, { project_id: projectId })).j.project_id, projectId);
  const seen = (await call(bob, 'GET', `/api/libraries?project=${projectId}`)).j.libraries;
  eq('a project member now sees it, read-only as a viewer', seen.map((l) => [l.name, l.items, l.can_edit, l.mine]), [['Motor Controller', 4, false, false]]);
  eq('the viewer can open it', (await call(bob, 'GET', `/api/libraries/${libId}`)).j.items.length, 4);
  eq('… but not add to it', (await call(bob, 'POST', `/api/libraries/${libId}/items`, { vendor: 'lcsc', vendor_id: 'C8734' })).status, 403);
  eq('… nor delete it', (await call(bob, 'DELETE', `/api/libraries/${libId}`)).status, 403);
  eq('someone outside the project still cannot see it', (await call(carol, 'GET', `/api/libraries/${libId}`)).status, 404);
  await db.query(`UPDATE permissions SET role = 'editor' WHERE project_id = $1 AND user_id = $2`, [projectId, bobId]);
  eq('an editor of the project can add to it', (await call(bob, 'POST', `/api/libraries/${libId}/items`, { vendor: 'lcsc', vendor_id: 'C6186' })).j.items.length, 5);
  eq('… but not take it out of the project', (await call(bob, 'PATCH', `/api/libraries/${libId}`, { project_id: null })).status, 403);
}

// ---------------------------------------------------------------- the reference outlives the cache
{
  // Throw the whole cache away: the library still lists its parts, and using it refetches them.
  await db.query(`DELETE FROM parts`); await db.query(`DELETE FROM part_models`);
  const lib = (await call(alice, 'GET', `/api/libraries/${libId}`)).j;
  eq('with the cache gone the library still lists every reference', lib.items.map((i) => [i.vendor_id, i.mpn, i.cached]), [['C25804', '0603WAF1002T5E', false], ['511-STM32F103C8T6', 'STM32F103C8T6', false], ['AMS1117-3.3TR-ND', 'AMS1117-3.3', false], ['C165948', 'TYPE-C-31-M-12', false], ['C6186', 'AMS1117-3.3', false]]);
  const r = await call(alice, 'POST', `/api/libraries/${libId}/refresh`);
  eq('refresh refetches every part', [r.status, r.j.refreshed, r.j.failed.length, r.j.library.items.every((i) => i.cached)], [200, 5, 0, true]);

  // export: every reference resolved into real KiCad library files
  const z = await fetch(`${BASE}/api/libraries/${libId}/export.zip`, { headers: { Authorization: `Bearer ${alice}` } });
  eq('the library exports as a zip', [z.status, z.headers.get('content-type'), z.headers.get('content-disposition')], [200, 'application/zip', 'attachment; filename="Motor_Controller.zip"']);
  const zip = unzip(Buffer.from(await z.arrayBuffer()));
  const names = [...zip.keys()].sort();
  eq('with a symbol library, a footprint folder, the 3D models and a README', names, [
    'Motor_Controller.3dshapes/R0603.step', 'Motor_Controller.kicad_sym',
    'Motor_Controller.pretty/LQFP-48_L7.0-W7.0-P0.50-LS9.0-BL.kicad_mod', 'Motor_Controller.pretty/R0603.kicad_mod',
    'Motor_Controller.pretty/SOT-223-3_L6.5-W3.4-P2.30-LS7.0-BR.kicad_mod', 'Motor_Controller.pretty/USB-C_SMD-TYPE-C-31-M-12_1.kicad_mod', 'README.txt']);
  const sym = zip.get('Motor_Controller.kicad_sym').toString('utf8');
  check('the symbol library is well formed', sym.startsWith('(kicad_symbol_lib') && balanced(sym));
  eq('it holds one symbol per distinct part (the two AMS1117 listings share one)', (sym.match(/^\t\(symbol "/gm) || []).length, 4);
  check('its symbols point into the exported footprint library', sym.includes('(property "Footprint" "Motor_Controller:R0603"') && sym.includes('(property "Footprint" "Motor_Controller:LQFP-48_L7.0-W7.0-P0.50-LS9.0-BL"'));
  const fp = zip.get('Motor_Controller.pretty/R0603.kicad_mod').toString('utf8');
  check('a footprint file is well formed and names its 3D model', fp.startsWith('(footprint "R0603"') && balanced(fp) && fp.includes('(model "${KICAD_COLLAB_3DMODELS}/Motor_Controller.3dshapes/R0603.step"'));
  check('the 3D model is a STEP file', zip.get('Motor_Controller.3dshapes/R0603.step').slice(0, 9).toString() === 'ISO-10303');
  check('the README explains the setup and lists what is missing', /Manage Symbol Libraries/.test(zip.get('README.txt').toString()) && /3D model could not be fetched/.test(zip.get('README.txt').toString()));

  // with the vendors down the export still works from the cache
  await ctl('down', { easyeda: true, jlcpcb: true, jlcsearch: true, mouser: true, digikey: true });
  const z2 = await fetch(`${BASE}/api/libraries/${libId}/export.zip?models=0`, { headers: { Authorization: `Bearer ${alice}` } });
  const zip2 = unzip(Buffer.from(await z2.arrayBuffer()));
  eq('with every vendor down the library still exports from the cache', [z2.status, [...zip2.keys()].filter((n) => n.endsWith('.kicad_mod')).length], [200, 4]);
  const r2 = await call(alice, 'POST', `/api/libraries/${libId}/refresh`);
  eq('a refresh during the outage fails softly and keeps every part', [r2.j.refreshed, r2.j.failed.length, r2.j.failed.every((f) => f.kept), r2.j.library.items.every((i) => i.cached)], [0, 5, true, true]);
  await ctl('down', {});
}

// ---------------------------------------------------------------- removing
{
  const lib = (await call(alice, 'GET', `/api/libraries/${libId}`)).j;
  const after = (await call(alice, 'DELETE', `/api/libraries/${libId}/items/${lib.items[4].id}`)).j;
  eq('an entry is removed', after.items.length, 4);
  eq('the part itself stays in the cache', (await db.query(`SELECT count(*)::int AS n FROM parts WHERE vendor_id = 'C6186'`)).rows[0].n, 1);
  eq('a key can be removed', [(await call(alice, 'DELETE', '/api/parts/keys/mouser')).j.ok, (await call(alice, 'GET', '/api/parts/vendors')).j.vendors[1].configured], [true, false]);
  eq('the owner deletes the library', (await call(alice, 'DELETE', `/api/libraries/${libId}`)).j.ok, true);
  eq('it is gone', (await call(alice, 'GET', `/api/libraries/${libId}`)).status, 404);
}

await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
