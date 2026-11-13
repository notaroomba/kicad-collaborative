// Shared pieces of the demo video recorder: sign-in tokens, project upload, the MCP call, and a
// screen recorder that stores what the browser really painted as numbered JPEG frames with times.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
export const SECRET = process.env.E2E_JWT_SECRET || 'testsecret';
export const PG_URL = process.env.E2E_PG_URL || 'postgres://postgres:test@127.0.0.1:5432/collabtest';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export function mintJwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 7200 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}

// ---- a zip with stored (uncompressed) entries, enough for the project upload
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function makeZip(files) {
  const parts = [], central = []; let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'), nameBuf = Buffer.from(name, 'utf8'), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf); offset += 30 + nameBuf.length + data.length;
  }
  const cenBuf = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cenBuf, end]);
}

export async function upload(jwt, name, files) {
  const form = new FormData(); form.append('archive', new Blob([makeZip(files)], { type: 'application/zip' }), 'project.zip'); form.append('name', name);
  const r = await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: form });
  if (r.status !== 200) throw new Error(`upload ${name}: ${r.status} ${await r.text()}`);
  return r.json();
}
export async function share(ownerJwt, projectId, peerJwt) {
  const link = await (await fetch(`${BASE}/api/projects/${projectId}/links`, { method: 'POST', headers: { Authorization: `Bearer ${ownerJwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'editor' }) })).json();
  await fetch(`${BASE}/api/join/${link.token}`, { method: 'POST', headers: { Authorization: `Bearer ${peerJwt}` } });
}

let rpcId = 0;
export async function mcp(jwt, name, args) {
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${jwt}`, 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
  const raw = await r.text(); let j;
  if (raw.trimStart().startsWith('{')) j = JSON.parse(raw);
  else j = raw.split(/\n\n/).map((f) => f.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')).filter(Boolean).map((d) => JSON.parse(d)).find((e) => e.id !== undefined);
  if (!j || !j.result) return { isError: true, text: JSON.stringify(j && j.error) };
  const text = (j.result.content.find((c) => c.type === 'text') || {}).text || ''; let data = null; try { data = JSON.parse(text); } catch { /* prose */ }
  return { isError: !!j.result.isError, text, data };
}

// ---- recorder: photographs of the page as the browser painted it, numbered, each with its time.
// Headless Chromium draws no mouse pointer, so the page gets one that follows the real mouse events.
export const POINTER = `(() => {
  const mk = () => {
    if (document.getElementById('__demo_ptr')) return;
    const p = document.createElement('div'); p.id = '__demo_ptr';
    p.style.cssText = 'position:fixed;left:0;top:0;width:20px;height:20px;pointer-events:none;z-index:2147483647;transform:translate(-100px,-100px)';
    p.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20"><path d="M3 2l12 7.2-5.3 1.2 3 5.6-2.2 1.1-3-5.7L3 15z" fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(p);
    addEventListener('mousemove', (e) => { p.style.transform = 'translate(' + (e.clientX - 3) + 'px,' + (e.clientY - 2) + 'px)'; }, true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', mk); else mk();
})();`;

// One or more pages are photographed together, so two people's windows stay in step.  A gesture is
// photographed once per mouse step and each step counts as 1/30 s, the pace of a person's hand: a
// headless browser on a build machine paints slower than a desktop does, and that is not what the
// video is about.  Waiting (wait()) is kept in real time; the composition says where it speeds it up.
export const FPS = 30;
export async function record(pages, dirs) {
  pages = [].concat(pages); dirs = [].concat(dirs);
  for (const d of dirs) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
  const frames = []; let t = 0, n = 0; const marks = {};
  const tick = async (dt) => {
    const file = String(++n).padStart(5, '0') + '.jpg';
    // a page that is busy for a long stretch (a big redraw) keeps its previous photograph for this step
    const shot = async (p, i) => { const to = path.join(dirs[i], file);
      const s0 = Date.now();
      try { await p.screenshot({ path: to, type: 'jpeg', quality: 92, timeout: n === 1 ? 90000 : 25000 }); if (process.env.SHOT_LOG && Date.now() - s0 > 2000) console.log(`  slow photo: page ${i}, frame ${n}, ${Date.now() - s0} ms`); }
      catch (e) { const prev = n > 1 && path.join(dirs[i], String(n - 1).padStart(5, '0') + '.jpg'); if (!prev || !fs.existsSync(prev)) throw e; fs.copyFileSync(prev, to); } };
    await Promise.all(pages.map(shot));
    frames.push({ t: +t.toFixed(3), file }); t += dt;
  };
  const rec = {
    tick: () => tick(1 / FPS),
    wait: async (ms) => { const end = Date.now() + ms; let last = Date.now(); do { await tick(0); await sleep(60); const now = Date.now(); t += (now - last) / 1000; last = now; } while (Date.now() < end); },
    until: async (promise) => { let done = false, value, error; promise.then((v) => { done = true; value = v; }, (e) => { done = true; error = e; }); let last = Date.now(); while (!done) { await tick(0); await sleep(150); const now = Date.now(); t += (now - last) / 1000; last = now; } if (error) throw error; return value; },
    mark: (name) => { marks[name] = +t.toFixed(3); },
    // A mouse path a person could have made: eased, one photograph per step.
    glide: async (page, from, to, ms = 600) => {
      const steps = Math.max(6, Math.round((ms / 1000) * FPS));
      for (let i = 1; i <= steps; i++) { const k = i / steps, e = k * k * (3 - 2 * k); await page.mouse.move(from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e); await tick(1 / FPS); }
    },
    hold: async (ms) => { for (let i = 0; i < Math.round((ms / 1000) * FPS / 3); i++) { await sleep(30); await tick(3 / FPS); } },
    stop: async () => {
      await tick(0);
      const vp = pages[0].viewportSize(); const meta = { width: vp.width, height: vp.height, length: +t.toFixed(3), marks, frames };
      for (const d of dirs) fs.writeFileSync(path.join(d, 'frames.json'), JSON.stringify(meta));
      return { length: meta.length, frames: frames.length, marks };
    },
  };
  return rec;
}
