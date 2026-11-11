// "A board from a prompt" with the real model: opens a blank project, types one request into
// the assistant pane and plays the person who accepts every proposal and says "go on" until the
// assistant has nothing more to propose.  What comes out is whatever the model designed, so this
// is a measurement, not a pass/fail test: it saves the schematic and board as KiCad files,
// screenshots, the conversation, and a report (parts, nets, ERC, routed connections, DRC, how
// many model requests it took).
//
// The server needs a model key (ANTHROPIC_API_KEY) and KC_DEV_LOGIN=1.  Each round is at least
// one model request; ROUNDS caps how many times the script says "go on".
//   E2E_PG_URL=… E2E_JWT_SECRET=… [PROMPT=…] [ROUNDS=30] [SHOTS=dir] [OUT=dir] node ai-live.mjs
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import pg from 'pg';

const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '', OUT = process.env.OUT || '';
const ROUNDS = +(process.env.ROUNDS || 30), TURN_MIN = +(process.env.TURN_MIN || 20);
const PROMPT = process.env.PROMPT || `Design a complete RP2040 development board on this blank project, from schematic to routed board, without stopping to ask me anything: I will accept each proposal.
It should be a Pico-style board: USB-C for power and data, a 3.3 V regulator, QSPI flash, a 12 MHz crystal, BOOTSEL and reset buttons, a user LED, every GPIO on two 1x20 2.54 mm header rows 17.78 mm apart, and a 3-pin SWD header. Two layers, parts on the top, as small as is sensible (about 21 x 51 mm).
Draw the schematic, check it, move to the board, set the outline and rules, place the parts, add a ground pour, route everything and run the checks. Tell me when the board is finished.`;
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
for (const d of [SHOTS, OUT]) if (d) fs.mkdirSync(d, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
const uid = (await db.query(`INSERT INTO users (github_id, login, name) VALUES (9312, 'ai-live', 'ai-live')
  ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`)).rows[0].id;
const NAME = process.env.NAME || 'rp2040-live';
await db.query(`DELETE FROM projects WHERE owner_id = $1 AND name = $2`, [uid, NAME]);
await db.end();
const now = Math.floor(Date.now() / 1000);
const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub: uid, login: 'ai-live', iat: now, exp: now + 6 * 3600 });
const jwt = `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;

const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});   // PW_CHANNEL=chrome uses an installed Chrome
const ctx = await browser.newContext({ viewport: { width: 1700, height: 1100 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => log('PAGEERR', String(e).slice(0, 300)));
await page.goto(`${BASE}/auth/dev?jwt=${jwt}&next=/`);
const made = await page.evaluate((name) => fetch('/api/projects/blank', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).then((r) => r.json()), NAME);
const docId = (t) => made.docs.find((d) => d.docType === t).docId;
const ready = () => page.waitForFunction(() => window.KcAssistant && window.CollabEditor && window.CollabEditor.kdoc, null, { timeout: 30000 });
const open = async (t) => { await page.goto(`${BASE}/p/${made.projectId}/edit?doc=${docId(t)}`); await ready(); await page.waitForTimeout(1500); };
const tool = (name, input) => page.evaluate(([n, i]) => window.KcAssistant.tool(n, i).catch((e) => ({ error: String(e && e.message || e) })), [name, input || {}]);
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }).catch(() => {}); };
const status = () => page.evaluate(() => fetch('/api/ai').then((r) => r.json()).catch(() => null));
const save = async (file) => { if (!OUT) return; const text = await page.evaluate(async () => {
  const K = window.KiCadCanvas, d = window.CollabEditor.kdoc, id = new URL(location.href).searchParams.get('doc');
  const base = K.parse(await (await fetch(`/api/docs/${id}/content?v=${Date.now()}`)).text());
  const keep = ['version', 'generator', 'generator_version', 'general', 'paper', 'layers', 'setup', 'uuid', 'title_block'];
  const out = [base[0]]; for (const n of base.slice(1)) if (Array.isArray(n) && keep.includes(n[0])) out.push(n);
  if (d.type === 'sch') out.push(['lib_symbols', ...d.lib.values()]);
  for (const it of d.items.values()) out.push(it.node);
  if (d.type === 'sch') { const si = base.find((n) => Array.isArray(n) && n[0] === 'sheet_instances'); if (si) out.push(si); }
  out.push(['embedded_fonts', 'no']);
  return K.serialize(out);
}); fs.writeFileSync(path.join(OUT, file), text + '\n'); };

// The pane: one request, then accept whatever is proposed and say "go on" until nothing is.
const paneOpen = async () => { await ready(); if (!(await page.locator('#dockAI').isVisible().catch(() => false))) await page.click('#aiToggle'); await page.waitForSelector('#aiInput', { timeout: 10000 }); };
const idle = async () => {   // survives the editor reloading when the assistant switches document
  const end = Date.now() + TURN_MIN * 60000;
  for (let quiet = 0; Date.now() < end;) {
    const busy = await page.evaluate(() => !window.KcAssistant || !!document.querySelector('#aiStop')).catch(() => true);
    quiet = busy ? 0 : quiet + 1; if (quiet >= 3) return true;
    await page.waitForTimeout(1000);
  }
  return false;
};
const say = async (text) => { await paneOpen(); await page.fill('#aiInput', text); await page.press('#aiInput', 'Enter'); await page.waitForSelector('#aiStop', { timeout: 8000 }).catch(() => {}); return idle(); };
const acceptAll = async () => {
  let n = 0;
  for (let i = 0; i < 12; i++) {
    const btn = page.locator('[data-proposal]').getByRole('button', { name: /^accept$/i }).and(page.locator(':enabled')).first();
    if (!(await btn.count())) break;
    const title = (await btn.locator('xpath=ancestor::*[@data-proposal][1]').innerText().catch(() => '')).split('\n')[0];
    await btn.click(); await page.waitForTimeout(1500); n++;
    log('accepted:', title.slice(0, 100));
  }
  return n;
};
const lastSaid = () => page.evaluate(() => { const m = [...document.querySelectorAll('#aiBody .ai-msg.assistant')].pop(); return m ? m.innerText : ''; }).catch(() => '');
const kind = () => page.evaluate(() => window.CollabEditor && window.CollabEditor.kdoc && window.CollabEditor.kdoc.type).catch(() => null);

await open('kicad_sch');
const before = await status();
log('model:', before && before.model, '| requests today before:', before && before.usage && before.usage.requestsToday);
if (!before || !before.available) { console.error('The server has no model key: ' + JSON.stringify(before)); await browser.close(); process.exit(2); }

const rounds = []; let quietRounds = 0, stopped = 'round limit';
let ok = await say(PROMPT);
for (let r = 1; r <= ROUNDS; r++) {
  if (!ok) { stopped = 'a turn did not finish in time'; break; }
  const said = await lastSaid(), on = await kind();
  if (/daily|allowance|rate limit|could not reach|refused the request|busy right now/i.test(said.slice(-400))) { stopped = 'model service: ' + said.slice(-200).replace(/\s+/g, ' '); break; }
  const n = await acceptAll();
  rounds.push({ round: r, document: on, accepted: n, said: said.slice(-600) });
  log(`round ${r}: on ${on}, accepted ${n}; assistant ended with: ${said.slice(-160).replace(/\s+/g, ' ')}`);
  await shot(`live-round-${String(r).padStart(2, '0')}`);
  if (on === 'sch') await save(`${NAME}.kicad_sch`); else if (on) await save(`${NAME}.kicad_pcb`);
  if (n) quietRounds = 0; else if (++quietRounds >= 2) { stopped = 'nothing more proposed'; break; }
  ok = await say(n ? `Accepted ${n === 1 ? 'it' : `all ${n}`}. Go on with the next stage.` : 'Is the whole board finished: schematic checked, every part placed, every connection routed, checks run? If not, go on. If it is, give me a three-line summary.');
}

const tally = (r) => { const c = {}; for (const v of r.violations || []) c[v.code] = (c[v.code] || 0) + 1; return r.error ? { error: r.error } : c; };
// What it made.
const report = { prompt: PROMPT, model: before.model, stopped, rounds };
const after = await status();
report.requests = after && before.usage ? after.usage.requestsToday - before.usage.requestsToday : null;
if (OUT) fs.writeFileSync(path.join(OUT, `${NAME}.conversation.txt`), await page.locator('#aiBody').innerText().catch(() => ''));
await open('kicad_sch');
const comps = await tool('list_components', {}), nets = await tool('list_nets', {}), erc = await tool('run_checks', {});
report.schematic = { parts: (comps.components || []).length, nets: (nets.nets || []).length, erc: tally(erc), violations: (erc.violations || []).slice(0, 40) };
await page.evaluate(() => window.CollabEditor.api.fitView()).catch(() => {});
await shot(`${NAME}-schematic`); await save(`${NAME}.kicad_sch`);
await open('kicad_pcb');
const info = await tool('get_board_info', {}), drc = await tool('run_checks', {}), bnets = await tool('list_nets', {});
const open_ = (bnets.nets || []).reduce((s, n) => s + (n.unrouted_connections || 0), 0);
report.board = { info, unrouted_connections: open_, nets_with_open_connections: (bnets.nets || []).filter((n) => n.unrouted_connections).map((n) => `${n.name} (${n.unrouted_connections})`),
  drc: tally(drc), violations: (drc.violations || []).slice(0, 60) };
await page.evaluate(() => window.CollabEditor.api.fitView()).catch(() => {});
await shot(`${NAME}-board`); await save(`${NAME}.kicad_pcb`);
if (OUT) { const id = (made.docs.find((d) => d.docType === 'kicad_pro') || {}).docId;   // the board rules live in the project file
  if (id) fs.writeFileSync(path.join(OUT, `${NAME}.kicad_pro`), await page.evaluate((i) => fetch(`/api/docs/${i}/content?v=${Date.now()}`).then((r) => r.text()), id)); }
if (OUT) fs.writeFileSync(path.join(OUT, `${NAME}.report.json`), JSON.stringify(report, null, 1));
log(`stopped: ${stopped}; ${rounds.length} rounds, ${report.requests} model requests`);
log('schematic:', JSON.stringify(report.schematic).slice(0, 300));
log('board: open connections', open_, '| drc', JSON.stringify(report.board.drc).slice(0, 300));
await browser.close();
