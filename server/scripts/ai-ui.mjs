// Browser test of the design assistant: drives the real editor in Chromium with
// fake-anthropic.mjs standing in for the model.  Covers the pane, a streamed turn with
// thinking, design tools, web search and a proposal; preview, accept (the edit reaches a
// second client and is one undo step), reject, a stale proposal, the board editor, upstream
// errors and the bring-your-own-key settings.  Saves a screenshot of each step.
//
// Server: KC_DEV_LOGIN=1 ANTHROPIC_API_KEY=sk-ant-test ANTHROPIC_API_URL=http://127.0.0.1:8097
//   E2E_PG_URL=… E2E_JWT_SECRET=… [SHOTS=/some/dir] node ai-ui.mjs
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import pg from 'pg';

const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const AI = (process.env.E2E_FAKE_AI || 'http://127.0.0.1:8097').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintJwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
const script = (turns) => post(`${AI}/__ctl/script`, { turns });
const requests = () => fetch(`${AI}/__ctl/requests`).then((r) => r.json());

// ---------------------------------------------------------------- fixtures: the ECC83 demo
const demo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../demos/ecc83');
async function user(githubId, login) {
  return (await db.query(`INSERT INTO users (github_id, login, name) VALUES ($1, $2, $2)
    ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [githubId, login])).rows[0].id;
}
const dana = await user(9301, 'ai-dana'), lee = await user(9302, 'ai-lee');
await db.query('DELETE FROM projects WHERE owner_id = $1', [dana]);
await db.query('DELETE FROM ai_usage WHERE user_id = ANY($1)', [[dana, lee]]);
await db.query('DELETE FROM ai_keys WHERE user_id = ANY($1)', [[dana, lee]]);
const projectId = (await db.query(`INSERT INTO projects (owner_id, name) VALUES ($1, 'ecc83-pp') RETURNING id`, [dana])).rows[0].id;
await db.query(`INSERT INTO permissions (project_id, user_id, role, created_by) VALUES ($1, $2, 'editor', $3)`, [projectId, lee, dana]);
const docs = {};
for (const [file, type] of [['ecc83-pp.kicad_sch', 'kicad_sch'], ['ecc83-pp.kicad_pcb', 'kicad_pcb'], ['ecc83-pp.kicad_pro', 'kicad_pro']]) {
  const id = (await db.query(`INSERT INTO documents (project_id, path, doc_type) VALUES ($1, $2, $3) RETURNING id`, [projectId, file, type])).rows[0].id;
  await db.query('INSERT INTO snapshots (doc_id, seq, content) VALUES ($1, 0, $2)', [id, fs.readFileSync(path.join(demo, file))]);
  docs[file] = id;
}
await post(`${AI}/__ctl/reset`);

// ---------------------------------------------------------------- browser
const browser = await chromium.launch();
const errors = [];
async function open(login, id, next) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1, colorScheme: 'light' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${login}: ${e}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|fonts\.g|ERR_|40[0-9]|status of (4|5)/.test(m.text())) errors.push(`${login}: ${m.text()}`); });
  await page.goto(`${BASE}/auth/dev?jwt=${mintJwt(id, login)}&next=${encodeURIComponent(next)}`);
  return page;
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
const idle = (page) => page.waitForFunction(() => !document.querySelector('#aiStop') && document.querySelectorAll('#aiBody .ai-msg.assistant').length > 0, null, { timeout: 20000 })
  .catch(async (e) => { console.log('STUCK  pane says:', (await page.locator('#dockAI').innerText()).slice(-600), '\n  errors:', errors.join(' | ')); await shot(page, 'stuck'); throw e; });
const ask = async (page, text) => { await page.fill('#aiInput', text); await page.press('#aiInput', 'Enter'); await page.waitForSelector('#aiStop', { timeout: 5000 }).catch(() => {}); await idle(page); };
const tool = (page, name, input) => page.evaluate(async ([n, i]) => { try { return await window.KcAssistant.tool(n, i); } catch (e) { return null; } }, [name, input || {}]);
const valueOf = async (page, ref) => { const c = await tool(page, 'get_component', { ref }); return c ? c.fields.Value : null; };
const hasText = async (page, text) => JSON.stringify(await tool(page, 'get_items', { kinds: ['text'] })).includes(text);
const editorReady = (page) => page.waitForFunction(() => window.CollabEditor && window.CollabEditor.api && document.querySelector('#aiToggle'), null, { timeout: 30000 });

const a = await open('ai-dana', dana, `/p/${projectId}/edit?doc=${docs['ecc83-pp.kicad_sch']}`);
await editorReady(a);
await a.waitForTimeout(1500);
check('assistant toggle is in the menu bar', await a.locator('#aiToggle').isVisible());
check('pane starts closed', !(await a.locator('#dockAI').isVisible()));
await a.click('#aiToggle');
await a.waitForSelector('#dockAI:not([hidden])');
await a.waitForFunction(() => /claude/.test(document.querySelector('.ai-model')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
check('pane opens with the model named', /claude/.test(await a.locator('.ai-model').innerText()));
{ // the box must be a real target: it once collapsed to 4 px when it was measured before the pane was laid out
  const box = await a.locator('#aiInput').boundingBox();
  check('the chat box is tall enough to click', box && box.height >= 20, JSON.stringify(box));
  await a.click('#aiInput'); await a.keyboard.type('route m x v 1');   // keys the editor uses as shortcuts
  check('typing reaches the chat box, not the editor shortcuts', (await a.inputValue('#aiInput')) === 'route m x v 1', await a.inputValue('#aiInput'));
  await a.fill('#aiInput', '');
}
check('quick actions offered', (await a.locator('.ai-quick button').count()) >= 3);
check('no key prompt when the server has a key', !(await a.locator('#aiSettings').count()));
await shot(a, '01-pane-empty');

// ---- a review turn: thinking, three design tools, a web search, then a proposal
await script([
  { content: [
    { type: 'thinking', thinking: 'The user wants a review. Read the design first, then the parts.' },
    { type: 'text', text: 'Let me read the sheet.' },
    { type: 'tool_use', id: 'toolu_1', name: 'get_design_overview', input: {} },
    { type: 'tool_use', id: 'toolu_2', name: 'list_components', input: {} },
    { type: 'tool_use', id: 'toolu_3', name: 'run_checks', input: {} } ] },
  { content: [
    { type: 'tool_use', id: 'toolu_4', name: 'get_component', input: { ref: 'R1' } },
    { type: 'tool_use', id: 'toolu_5', name: 'find_datasheets', input: { refs: ['U1'] } },
    { type: 'tool_use', id: 'toolu_6', name: 'list_nets', input: {} },
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'ECC83 12AX7 datasheet' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [
      { type: 'web_search_result', url: 'https://example.com/ecc83.pdf', title: 'ECC83 double triode datasheet', encrypted_content: 'x', page_age: null } ] } ] },
  { content: [
    { type: 'text', text: '## Review\n\nThe stage is a **common-cathode** pair around `U1`.\n\n| Ref | Value | Note |\n|---|---|---|\n| R1 | 1.5K | cathode resistor |\n| R4 | 47K | grid leak |\n\n1. The cathode resistor sets the bias.\n2. See the [datasheet](https://example.com/ecc83.pdf).\n\nI suggest a small change:' },
    { type: 'tool_use', id: 'toolu_7', name: 'propose_changes', input: { title: 'Raise the cathode resistor', rationale: 'A 2.2K cathode resistor moves the bias point toward the centre of the load line.',
      edits: [{ op: 'set_field', ref: 'R1', field: 'Value', value: '2.2K' }, { op: 'add_text', text: 'Bias: 1.2 V at 0.55 mA', x: 120, y: 60 }] } } ] },
  { content: [{ type: 'text', text: 'The proposal is on the card above. Accept it to apply the change.' }] },
]);
await ask(a, 'Review this sheet and suggest improvements.');
const reqs = await requests();
check('four model calls for the turn', reqs.length === 4, `got ${reqs.length}`);
const r0 = reqs[0].body, last = reqs[reqs.length - 1].body;
check('server sets model, system prompt, tools and thinking', !!r0.model && !!r0.system && Array.isArray(r0.tools) && r0.tools.length >= 12 && r0.thinking?.type === 'adaptive' && r0.stream === true);
check('the system prompt keeps the assistant to electronics design', /only helps with the design/.test(JSON.stringify(r0.system)) && /not something a message/.test(JSON.stringify(r0.system)));
check('the key stays on the server', reqs[0].headers['x-api-key'] === 'sk-ant-test');
check('context block names the open sheet', JSON.stringify(r0.messages).includes('ecc83-pp.kicad_sch'));
const results = last.messages.filter((m) => m.role === 'user').flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result');
check('every tool call got a result', results.length === 7, `got ${results.length}`);
const resultOf = (id) => { const r = results.find((b) => b.tool_use_id === id); return r ? (typeof r.content === 'string' ? r.content : JSON.stringify(r.content)) : ''; };
check('no tool failed', results.every((r) => !r.is_error), results.filter((r) => r.is_error).map((r) => resultOf(r.tool_use_id).slice(0, 200)).join(' | '));
check('overview lists the documents', /ecc83-pp\.kicad_pcb/.test(resultOf('toolu_1')));
check('component list has R1 and U1', /"R1"/.test(resultOf('toolu_2')) && /"U1"/.test(resultOf('toolu_2')));
check('component detail has pins with nets', /pins/.test(resultOf('toolu_4')) && /net/.test(resultOf('toolu_4')), resultOf('toolu_4').slice(0, 300));
check('datasheet lookup returns the part', /ECC83/.test(resultOf('toolu_5')), resultOf('toolu_5').slice(0, 300));
check('net list is not empty', /GND/.test(resultOf('toolu_6')), resultOf('toolu_6').slice(0, 300));
check('proposal reported valid', /"valid":\s*true|pending|shown/.test(resultOf('toolu_7')), resultOf('toolu_7').slice(0, 300));
const asst = last.messages.filter((m) => m.role === 'assistant');
check('thinking is passed back with its signature', asst[0].content.some((b) => b.type === 'thinking' && b.signature === 'sig-fake'));
check('server tool blocks are passed back unchanged', asst[1].content.some((b) => b.type === 'server_tool_use') && asst[1].content.some((b) => b.type === 'web_search_tool_result'));
check('reply renders a table, a list and a link', (await a.locator('#aiBody table').count()) === 1 && (await a.locator('#aiBody ol li').count()) === 2 && (await a.locator('#aiBody a[href="https://example.com/ecc83.pdf"]').count()) >= 1);
check('proposal card is shown', (await a.locator('[data-proposal]').count()) === 1);
check('nothing changed before accepting', (await valueOf(a, 'R1')) === '1.5K', String(await valueOf(a, 'R1')));
await shot(a, '02-review-with-proposal');

// ---- preview, then accept; a second person sees the change
const b = await open('ai-lee', lee, `/p/${projectId}/edit?doc=${docs['ecc83-pp.kicad_sch']}`);
await editorReady(b); await b.waitForTimeout(1500);
const card = a.locator('[data-proposal]').first();
await card.getByRole('button', { name: /preview/i }).click();
await a.waitForTimeout(600);
check('preview draws on the canvas', (await a.locator('#aiG *').count()) > 0);
check('preview does not change the design', (await valueOf(a, 'R1')) === '1.5K');
await shot(a, '03-preview');
const opsBefore = (await db.query('SELECT count(*)::int AS n FROM ops WHERE doc_id = $1', [docs['ecc83-pp.kicad_sch']])).rows[0].n;
await card.getByRole('button', { name: /accept/i }).click();
await a.waitForTimeout(800);
check('accepted: value changed and text added', (await valueOf(a, 'R1')) === '2.2K' && (await hasText(a, 'Bias: 1.2 V')), String(await valueOf(a, 'R1')));
check('preview cleared after accepting', (await a.locator('#aiG *').count()) === 0);
await b.waitForFunction(() => true); await b.waitForTimeout(800);
check('accepted: the second person sees it', (await valueOf(b, 'R1')) === '2.2K', String(await valueOf(b, 'R1')));
const opsAfter = (await db.query('SELECT count(*)::int AS n FROM ops WHERE doc_id = $1', [docs['ecc83-pp.kicad_sch']])).rows[0].n;
check('accepted: one op on the server', opsAfter === opsBefore + 1, `${opsBefore} -> ${opsAfter}`);
check('card shows it was applied', /applied|accepted/i.test(await card.innerText()));
await shot(a, '04-accepted');
await shot(b, '05-second-person');
await a.evaluate(() => window.CollabEditor.api.undoLast());
await a.waitForTimeout(800);
check('one undo reverts the whole proposal', (await valueOf(a, 'R1')) === '1.5K' && !(await hasText(a, 'Bias: 1.2 V')));
check('undo reaches the second person', (await valueOf(b, 'R1')) === '1.5K');

// ---- the decision is told to the model; a rejected proposal changes nothing
await post(`${AI}/__ctl/reset`);
await script([
  { content: [{ type: 'tool_use', id: 'toolu_8', name: 'propose_changes', input: { title: 'Remove the output capacitor', rationale: 'Testing rejection.', edits: [{ op: 'remove', ref: 'C1' }] } }] },
  { content: [{ type: 'text', text: 'Proposed.' }] },
  { content: [{ type: 'text', text: 'Understood, I will leave C1 alone.' }] },
]);
await ask(a, 'Remove C1.');
const card2 = a.locator('[data-proposal]').last();
await card2.getByRole('button', { name: /reject/i }).click();
await a.waitForTimeout(300);
check('rejected: C1 is still there', (await valueOf(a, 'C1')) !== null);
await ask(a, 'Thanks.');
const told = JSON.stringify((await requests()).pop().body.messages);
check('the model is told about accept and reject', /proposal_update/.test(told) && /accepted/.test(told) && /rejected/.test(told));
await shot(a, '06-rejected');

// ---- an invalid edit is reported to the model, with no card
await post(`${AI}/__ctl/reset`);
await script([
  { content: [{ type: 'tool_use', id: 'toolu_9', name: 'propose_changes', input: { title: 'Bad', edits: [{ op: 'set_field', ref: 'R99', field: 'Value', value: '1K' }] } }] },
  { content: [{ type: 'text', text: 'There is no R99 on this sheet.' }] },
]);
const cards = await a.locator('[data-proposal]').count();
await ask(a, 'Set R99 to 1K.');
const bad = JSON.stringify((await requests()).pop().body.messages.at(-1));
check('invalid edit: reason goes back to the model', /R99/.test(bad) && /is_error|valid\\":false|not found|no component/i.test(bad), bad.slice(0, 300));
check('invalid edit: no card', (await a.locator('[data-proposal]').count()) === cards);

// ---- a schematic proposal says whether it changes connections
await post(`${AI}/__ctl/reset`);
await script([
  { content: [{ type: 'tool_use', id: 'toolu_c1', name: 'propose_changes', input: { title: 'Move R1 alone', edits: [{ op: 'move', ref: 'R1', x: 200.66, y: 120.65 }] } }] },
  { content: [{ type: 'tool_use', id: 'toolu_c2', name: 'propose_changes', input: { title: 'Note', edits: [{ op: 'add_text', text: 'Output stage', x: 150, y: 50 }] } }] },
  { content: [{ type: 'text', text: 'Two cards.' }] },
]);
await ask(a, 'Tidy R1.');
const conn = (await requests()).pop().body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((x) => x.type === 'tool_result');
const c1 = conn.find((x) => x.tool_use_id === 'toolu_c1'), c2 = conn.find((x) => x.tool_use_id === 'toolu_c2');
check('a move that leaves wires behind is reported as changing connections', !!c1 && /"changed"/.test(c1.content) && /R1\.[12]: no longer connected/.test(c1.content), c1 && c1.content.slice(0, 400));
check('an edit that touches no wiring is reported unchanged', !!c2 && /unchanged/.test(c2.content), c2 && c2.content.slice(0, 300));
check('the cards say so too', (await a.locator('[data-proposal] .conn.changed').count()) === 1 && (await a.locator('[data-proposal] .conn:not(.changed)').count()) >= 1);
await shot(a, '06b-connectivity');
for (const c of await a.locator('[data-proposal]').all()) { const r = c.getByRole('button', { name: /reject/i }); if (await r.count()) await r.click(); }

// ---- a proposal goes stale when the item changes underneath it
await post(`${AI}/__ctl/reset`);
await script([
  { content: [{ type: 'tool_use', id: 'toolu_10', name: 'propose_changes', input: { title: 'Grid leak to 220K', edits: [{ op: 'set_field', ref: 'R3', field: 'Value', value: '220K' }] } }] },
  { content: [{ type: 'text', text: 'Proposed.' }] },
  { content: [{ type: 'tool_use', id: 'toolu_11', name: 'propose_changes', input: { title: 'Grid leak to 68K', edits: [{ op: 'set_field', ref: 'R3', field: 'Value', value: '68K' }] } }] },
  { content: [{ type: 'text', text: 'Proposed again.' }] },
]);
await ask(a, 'Change R3.');
await ask(a, 'Another option?');
const n = await a.locator('[data-proposal]').count();
await a.locator('[data-proposal]').nth(n - 1).getByRole('button', { name: /accept/i }).click();
await a.waitForTimeout(500);
check('second proposal applied', (await valueOf(a, 'R3')) === '68K', String(await valueOf(a, 'R3')));
const stale = a.locator('[data-proposal]').nth(n - 2);
const acceptStale = stale.getByRole('button', { name: /accept/i });
if (await acceptStale.count() && await acceptStale.isEnabled()) { await acceptStale.click(); await a.waitForTimeout(400); }
check('stale proposal is refused', (await valueOf(a, 'R3')) === '68K' && /changed|out of date|stale/i.test(await stale.innerText()), await stale.innerText());
await shot(a, '07-stale');

// ---- upstream trouble is said plainly, and the conversation survives it
await post(`${AI}/__ctl/reset`);
await script([{ status: 529, error: { type: 'overloaded_error', message: 'Overloaded' } }, { content: [{ type: 'text', text: 'Back again.' }] }]);
await a.fill('#aiInput', 'Are you there?'); await a.press('#aiInput', 'Enter');
await a.waitForFunction(() => !document.querySelector('#aiStop'), null, { timeout: 10000 });
await a.waitForTimeout(300);
check('overload is reported in the pane', /busy|overloaded|try again/i.test(await a.locator('#aiBody').innerText()), (await a.locator('#aiBody').innerText()).slice(-200));
await shot(a, '08-error');
await ask(a, 'Try again.');
const after = (await requests()).pop().body.messages;
check('history stays well-formed after an error', after.every((m, i) => i === 0 || m.role !== after[i - 1].role) && after[0].role === 'user', after.map((m) => m.role).join(','));

// ---- chat survives a reload; New chat clears it
await a.reload(); await editorReady(a);
await a.waitForSelector('#dockAI:not([hidden])', { timeout: 10000 });
check('pane and chat are restored after a reload', (await a.locator('#aiBody .ai-msg').count()) > 4);
await a.click('#aiNew');
check('new chat clears the pane', (await a.locator('#aiBody .ai-msg').count()) === 0);

// ---- the board editor
await post(`${AI}/__ctl/reset`);
await a.goto(`${BASE}/p/${projectId}/edit?doc=${docs['ecc83-pp.kicad_pcb']}`);
await editorReady(a); await a.waitForTimeout(2500);
const onBoard = await a.evaluate(() => (window.CollabEditor.kdoc || {}).type);
if (onBoard !== 'pcb' && onBoard !== 'board') {
  await script([{ content: [{ type: 'tool_use', id: 'toolu_o', name: 'open_document', input: { doc: 'ecc83-pp.kicad_pcb' } }] }, { content: [{ type: 'text', text: 'Opened the board.' }] }]);
  await ask(a, 'Open the board.'); await a.waitForTimeout(2500);
  check('open_document switches to the board', (await a.evaluate(() => (window.CollabEditor.kdoc || {}).type)) === 'pcb');
  await post(`${AI}/__ctl/reset`); await a.click('#aiNew');
}
await script([
  { content: [
    { type: 'tool_use', id: 'toolu_b1', name: 'get_board_info', input: {} },
    { type: 'tool_use', id: 'toolu_b2', name: 'run_checks', input: {} },
    { type: 'tool_use', id: 'toolu_b3', name: 'list_components', input: {} },
    { type: 'tool_use', id: 'toolu_b4', name: 'get_component', input: { ref: 'R1' } },
    { type: 'tool_use', id: 'toolu_b5', name: 'list_nets', input: {} },
    { type: 'tool_use', id: 'toolu_b6', name: 'focus_view', input: { refs: ['R1'] } } ] },
  { content: [
    { type: 'text', text: 'The board is two layers. I can move R1 away from the valve socket:' },
    { type: 'tool_use', id: 'toolu_b7', name: 'propose_changes', input: { title: 'Move R1', rationale: 'More clearance to the socket.', edits: [{ op: 'move', ref: 'R1', x: 150, y: 80 }] } } ] },
  { content: [{ type: 'text', text: 'Proposed on the card.' }] },
]);
await ask(a, 'Check the board layout.');
const breq = (await requests()).pop().body.messages;
const bres = breq.filter((m) => m.role === 'user').flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((x) => x.type === 'tool_result');
check('board tools all answer', bres.length === 7 && bres.every((r) => !r.is_error), bres.filter((r) => r.is_error).map((r) => JSON.stringify(r.content).slice(0, 200)).join(' | '));
const bcard = a.locator('[data-proposal]').last();
await bcard.getByRole('button', { name: /preview/i }).click(); await a.waitForTimeout(600);
check('board preview draws', (await a.locator('#aiG *').count()) > 0);
await shot(a, '09-board-preview');
await bcard.getByRole('button', { name: /accept/i }).click(); await a.waitForTimeout(800);
const moved = await tool(a, 'get_component', { ref: 'R1' }); const at = moved ? `${moved.x},${moved.y}` : null;
check('board move applied', at === '150,80', String(at));
await shot(a, '10-board-accepted');

// ---- the autorouter as a proposal: unroute one net, then ask for it back
const netName = 'Net-(P1-PM)';
const tracks = (await tool(a, 'get_items', { net: netName, kinds: ['segment'] })).items.map((it) => it.id);
check('fixture net has tracks to remove', tracks.length > 3, String(tracks.length));
await post(`${AI}/__ctl/reset`);
await script([
  { content: [{ type: 'tool_use', id: 'toolu_r1', name: 'propose_changes', input: { title: 'Unroute the input net', edits: tracks.map((id) => ({ op: 'remove', id })) } }] },
  { content: [{ type: 'text', text: 'Proposed.' }] },
  { content: [{ type: 'tool_use', id: 'toolu_r2', name: 'propose_changes', input: { title: 'Route the input net', rationale: 'Autorouted within the net class rules.', edits: [{ op: 'autoroute', nets: [netName] }] } }] },
  { content: [{ type: 'text', text: 'Routed on the card.' }] },
]);
await ask(a, 'Rip up the input net.');
await a.locator('[data-proposal]').last().getByRole('button', { name: /accept/i }).click(); await a.waitForTimeout(800);
const unrouted = (await tool(a, 'list_nets', { filter: netName })).nets[0];
check('net is unrouted after the rip-up', unrouted.tracks === 0 && unrouted.unrouted_connections > 0, JSON.stringify(unrouted));
await ask(a, 'Route it again.');
const rres = (await requests()).pop().body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((x) => x.tool_use_id === 'toolu_r2');
check('autoroute reports what it routed', !!rres && !rres.is_error && /"routed":\s*[1-9]/.test(rres.content), rres && rres.content.slice(0, 500));
check('autoroute changes nothing before it is accepted', (await tool(a, 'list_nets', { filter: netName })).nets[0].tracks === 0);
const rcard = a.locator('[data-proposal]').last();
await rcard.getByRole('button', { name: /preview/i }).click(); await a.waitForTimeout(600);
await shot(a, '10b-autoroute-preview');
await rcard.getByRole('button', { name: /accept/i }).click(); await a.waitForTimeout(1000);
const routed = (await tool(a, 'list_nets', { filter: netName })).nets[0];
check('accepted autoroute completes the net', routed.tracks > 0 && routed.unrouted_connections === 0, JSON.stringify(routed));
const drc = await tool(a, 'run_checks', {});
const mine = drc.violations.filter((v) => v.severity === 'error' && (v.message.includes(netName) || /clearance|short/i.test(v.code)));   // R1 was moved off its tracks earlier: those are not the router's
check('autorouted copper passes the DRC', mine.length === 0, JSON.stringify(mine).slice(0, 400));
await shot(a, '10c-autoroute-accepted');

// ---- settings: a person's own key
await a.click('#aiGear');
await a.waitForSelector('#aiSettings');
await a.fill('#aiSettings input[type=password]', 'not-a-key'); await a.click('#aiSettings .ai-btn');
await a.waitForTimeout(400);
check('a malformed key is refused', (await a.locator('#aiSettings .bad').count()) === 1);
await a.fill('#aiSettings input[type=password]', 'sk-ant-api03-mine-0000000000000000wxyz'); await a.click('#aiSettings .ai-btn');
await a.waitForFunction(() => /Remove my key/.test(document.querySelector('#aiSettings')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
check('own key saved and shown by its last characters only', /wxyz/.test(await a.locator('#aiSettings').innerText()) && !/mine-0000/.test(await a.locator('#aiSettings').innerText()));
const stored = (await db.query('SELECT key, hint FROM ai_keys WHERE user_id = $1', [dana])).rows[0];
check('own key is encrypted at rest', !!stored && !Buffer.from(stored.key).toString('latin1').includes('sk-ant-api03-mine'));
await shot(a, '11-settings');
await post(`${AI}/__ctl/reset`); await script([{ content: [{ type: 'text', text: 'Using your key.' }] }]);
await ask(a, 'Hello');
check('own key is used for the call', (await requests()).pop().headers['x-api-key'] === 'sk-ant-api03-mine-0000000000000000wxyz');
const usage = (await db.query('SELECT requests, input_tokens, output_tokens FROM ai_usage WHERE user_id = $1', [dana])).rows[0];
check('usage is recorded', !!usage && usage.requests > 10 && Number(usage.output_tokens) > 0, JSON.stringify(usage));

// ---- access: someone outside the project cannot use it as a proxy
const eve = await user(9303, 'ai-eve');
const denied = await fetch(`${BASE}/api/projects/${projectId}/ai/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mintJwt(eve, 'ai-eve')}` }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
check('non-members are refused', denied.status === 403 || denied.status === 404, String(denied.status));
const anon = await fetch(`${BASE}/api/projects/${projectId}/ai/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
check('signed-out callers are refused', anon.status === 401, String(anon.status));

check('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close(); await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
