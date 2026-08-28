// Protocol smoke test against a running server (unauthenticated paths only).
// Usage: node server/scripts/smoke.mjs [base-url]
const BASE = process.argv[2]?.replace(/\/$/, '')
  || process.env.KICAD_COLLAB_SERVER?.replace(/\/$/, '')
  || 'https://kicad-collab-production.up.railway.app';
const WS = BASE.replace('https://', 'wss://') + '/ws';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

// --- HTTP surface ---
const health = await fetch(`${BASE}/healthz`);
check('healthz 200', health.status === 200, `got ${health.status}`);

const idx = await fetch(`${BASE}/`);
check('index renders', idx.status === 200 && (await idx.text()).includes('KiCad Collaborative'));

const badLink = await fetch(`${BASE}/j/definitely-not-a-real-token`);
const badLinkBody = await badLink.text();
check('invalid share link shows an error page, not a crash',
  badLink.status === 200 && badLinkBody.includes('Link invalid or expired'));

const meNoAuth = await fetch(`${BASE}/api/me`);
check('GET /api/me without a token is 401', meNoAuth.status === 401, `got ${meNoAuth.status}`);

const projNoAuth = await fetch(`${BASE}/api/projects/00000000-0000-0000-0000-000000000000`);
check('project read without a token is 401', projNoAuth.status === 401, `got ${projNoAuth.status}`);

const authRedir = await fetch(`${BASE}/auth/github/login`, { redirect: 'manual' });
const loc = authRedir.headers.get('location') || '';
check('github login redirects to github with client_id',
  authRedir.status === 303 && loc.startsWith('https://github.com/login/oauth/authorize') && loc.includes('client_id='));
check('github login sets the state-binding cookie (login-CSRF fix)',
  (authRedir.headers.getSetCookie?.() || []).some(c => c.startsWith('kc_oauth_state=') && c.includes('HttpOnly')));

const badCallback = await fetch(`${BASE}/auth/github/callback?code=x&state=y`, { redirect: 'manual' });
check('callback without the state cookie is rejected', badCallback.status === 400, `got ${badCallback.status}`);

// --- WebSocket protocol ---
const wsSay = (msg, expectType) => new Promise((resolve) => {
  const ws = new WebSocket(WS);
  const t = setTimeout(() => { try { ws.close(); } catch {} resolve({ timeout: true }); }, 15000);
  ws.onopen = () => ws.send(JSON.stringify(msg));
  ws.onmessage = (e) => {
    clearTimeout(t);
    let parsed; try { parsed = JSON.parse(e.data); } catch { parsed = { raw: e.data }; }
    try { ws.close(); } catch {}
    resolve(parsed);
  };
  ws.onerror = () => { clearTimeout(t); resolve({ error: true }); };
  ws.onclose = () => { clearTimeout(t); resolve({ closed: true }); };
});

const badProto = await wsSay({ type: 'hello', proto: 999, token: 'x' });
check('ws rejects an unsupported protocol version',
  badProto.type === 'error' && badProto.code === 'unsupported_protocol',
  JSON.stringify(badProto));

const badToken = await wsSay({ type: 'hello', proto: 1, token: 'not-a-real-jwt' });
check('ws rejects a bad token', badToken.type === 'error' && badToken.code === 'auth_failed',
  JSON.stringify(badToken));

const notHello = await wsSay({ type: 'join_doc', docId: '00000000-0000-0000-0000-000000000000' });
check('ws requires hello first', notHello.type === 'error' && notHello.code === 'bad_message',
  JSON.stringify(notHello));

const garbage = await wsSay({ nonsense: true });
check('ws rejects unparseable frames', garbage.type === 'error', JSON.stringify(garbage));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
