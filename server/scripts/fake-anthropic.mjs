// A stand-in for the Anthropic Messages API, for testing the assistant without a key or a
// network: POST /v1/messages streams the next scripted turn as server-sent events in the
// real wire format (message_start, content_block_start/delta/stop, message_delta,
// message_stop), split into small chunks so the client's parser sees event boundaries in
// awkward places.  Nothing here knows about KiCad; the test decides what "the model" says.
//
//   PORT=8097 node fake-anthropic.mjs
//
//   POST /__ctl/script    {turns: [{content: [...blocks], stop_reason?, status?, error?, delayMs?}]}
//   GET  /__ctl/requests  every request body received so far, with its headers
//   POST /__ctl/reset
//
import http from 'node:http';

const PORT = +(process.env.PORT || 8097);
let turns = [], requests = [], n = 0;

const readBody = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pieces = (s, size) => { const out = []; for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size)); return out.length ? out : ['']; };

/** The events of one assistant turn. */
function events(turn, model) {
  const ev = [];
  const id = `msg_fake_${++n}`;
  ev.push(['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null,
    usage: { input_tokens: 1200, cache_read_input_tokens: 800, cache_creation_input_tokens: 0, output_tokens: 1 } } }]);
  (turn.content || []).forEach((b, index) => {
    const start = (content_block) => ev.push(['content_block_start', { type: 'content_block_start', index, content_block }]);
    const delta = (d) => ev.push(['content_block_delta', { type: 'content_block_delta', index, delta: d }]);
    if (b.type === 'text') { start({ type: 'text', text: '' }); for (const p of pieces(b.text, 23)) delta({ type: 'text_delta', text: p }); }
    else if (b.type === 'thinking') {
      start({ type: 'thinking', thinking: '', signature: '' });
      for (const p of pieces(b.thinking, 31)) delta({ type: 'thinking_delta', thinking: p });
      delta({ type: 'signature_delta', signature: b.signature || 'sig-fake' });
    } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
      start({ type: b.type, id: b.id, name: b.name, input: {} });
      for (const p of pieces(JSON.stringify(b.input || {}), 17)) delta({ type: 'input_json_delta', partial_json: p });
    } else start(b);   // result blocks of server tools arrive whole
    ev.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  ev.push(['message_delta', { type: 'message_delta', delta: { stop_reason: turn.stop_reason || ((turn.content || []).some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'), stop_sequence: null },
    usage: { output_tokens: 345 } }]);
  ev.push(['message_stop', { type: 'message_stop' }]);
  return ev;
}

http.createServer(async (req, res) => {
  const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url === '/__ctl/script' && req.method === 'POST') { turns.push(...(JSON.parse(await readBody(req)).turns || [])); return json(200, { queued: turns.length }); }
  if (req.url === '/__ctl/requests') return json(200, requests);
  if (req.url === '/__ctl/reset') { turns = []; requests = []; return json(200, {}); }
  if (req.url === '/v1/messages' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    requests.push({ headers: req.headers, body });
    const turn = turns.shift() || { content: [{ type: 'text', text: 'Nothing scripted.' }] };
    if (turn.status) return json(turn.status, { type: 'error', error: turn.error || { type: 'api_error', message: 'scripted failure' } });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const wire = events(turn, body.model).map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
    for (const chunk of pieces(wire, 97)) { res.write(chunk); await sleep(turn.delayMs ?? 2); }   // 97 bytes: never aligned with an event
    return res.end();
  }
  json(404, { type: 'error', error: { type: 'not_found_error', message: req.url } });
}).listen(PORT, '127.0.0.1', () => console.log(`fake anthropic on :${PORT}`));
