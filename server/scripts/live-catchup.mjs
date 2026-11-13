// Browser test of how an open document catches up with edits (web/editor/doc.ts openDoc, net.ts): the edits since the
// stored snapshot are on the first picture, an edit made before the live session is joined survives, a guest and a
// resync end up with the same document, and nothing is parsed twice.  Needs a local server with KC_DEV_LOGIN=1.
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… [E2E_BASE=http://127.0.0.1:8099] node live-catchup.mjs
//
import crypto from 'node:crypto'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import { execSync } from 'node:child_process'; import { createRequire } from 'node:module'; import pg from 'pg';
const { chromium } = createRequire(import.meta.url)('playwright');
const BASE=(process.env.E2E_BASE||'http://127.0.0.1:8099').replace(/\/$/,''), SECRET=process.env.E2E_JWT_SECRET, PG_URL=process.env.E2E_PG_URL;
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
const b64=(o)=>Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt=(sub,login)=>{const now=Math.floor(Date.now()/1000);const h=b64({alg:'HS256',typ:'JWT'}),b=b64({sub,login,iat:now,exp:now+36000});return `${h}.${b}.${crypto.createHmac('sha256',SECRET).update(`${h}.${b}`).digest('base64url')}`;};
pg.types.setTypeParser(20,(v)=>parseInt(v,10));
const db=new pg.Client({connectionString:PG_URL, ssl:false}); await db.connect();
await db.query('DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE github_id = -9305)'); await db.query('DELETE FROM users WHERE github_id = -9305');
const uid=(await db.query("INSERT INTO users (github_id, login, name, email) VALUES (-9305,'live','live','live@example.com') RETURNING id")).rows[0].id; const token=jwt(uid,'live');
const ZIP=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'catchup-')),'p.zip');
execSync(`cd "${path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../demos/stickhub')}" && zip -qr "${ZIP}" . -i '*.kicad_pro' '*.kicad_sch' '*.kicad_pcb'`);
const form=new FormData(); form.append('name','live'); form.append('archive',new Blob([fs.readFileSync(ZIP)]),'p.zip');
const pid=(await (await fetch(BASE+'/api/projects',{method:'POST',headers:{authorization:`Bearer ${token}`},body:form})).json()).projectId;
await fetch(`${BASE}/api/projects/${pid}`,{method:'PATCH',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({public:true})});
const browser=await chromium.launch(); const ctx=await browser.newContext({viewport:{width:1440,height:900}});
const p0=await ctx.newPage(); await p0.goto(`${BASE}/auth/dev?jwt=${token}&next=/api/me`); await p0.close();
const errs=[]; let pass=0, fail=0; const check=(n,ok,d='')=>{ console.log(`${ok?'PASS':'FAIL'} ${n} ${d}`); ok?pass++:fail++; };
const joined=(p)=>p.waitForFunction(()=>window.CollabEditor&&window.CollabEditor.kdoc&&window.CollabEditor.joinedDocId&&window.CollabEditor.lastSeq!==undefined,null,{timeout:15000});
const open=async(c=ctx)=>{ const p=await c.newPage(); p.on('pageerror',(e)=>errs.push(e.message)); await p.addInitScript(()=>{ window.__parses=0; let K; Object.defineProperty(window,'KiCadCanvas',{configurable:true,get(){return K;},set(v){K=v; const o=v.parseDoc; v.parseDoc=function(){window.__parses++; return o.apply(this,arguments);};}}); }); await p.goto(`${BASE}/p/${pid}/edit`); await joined(p); await p.waitForTimeout(500); return p; };
const st=(p)=>p.evaluate(()=>({doc:window.CollabEditor.kdoc.items.size, list:window.CollabEditor.items.length, seq:window.CollabEditor.lastSeq, pend:window.CollabEditor.pendingOps.size, parses:window.__parses}));
const remove=(p,id)=>p.evaluate((id)=>window.CollabEditor.api.commitChanges([{id, kind:'REMOVED', typeName:'SCH_SYMBOL', properties:[]}], 'delete'), id);
const A=await open(), B=await open(); const s0=await st(A); const ids=await A.evaluate(()=>window.CollabEditor.items.slice(0,20).map(i=>i.id));
for (let i=0;i<4;i++) await remove(A, ids[i]); await A.waitForTimeout(700);
let a=await st(A), b=await st(B); check('A deletes four, B follows', a.doc===s0.doc-4 && b.doc===a.doc && b.list===a.list && a.pend===0, JSON.stringify([a,b]));
// a fresh browser: the four edits are on the first picture (fetched with the text), the join parses nothing again
const C=await ctx.newPage(); C.on('pageerror',(e)=>errs.push(e.message));
await C.addInitScript(()=>{ window.__parses=0; let K; Object.defineProperty(window,'KiCadCanvas',{configurable:true,get(){return K;},set(v){K=v; const o=v.parseDoc; v.parseDoc=function(){window.__parses++; return o.apply(this,arguments);};}}); });
await C.route('**/api/ws-ticket', async (route)=>{ await new Promise(r=>setTimeout(r,1500)); route.continue(); });
await C.goto(`${BASE}/p/${pid}/edit`); await C.waitForFunction(()=>window.CollabEditor&&window.CollabEditor.kdoc&&window.CollabEditor.items.length);
let c=await st(C); check('a fresh open shows the edits before it has joined', c.doc===s0.doc-4 && !(await C.evaluate(()=>!!window.CollabEditor.joinedDocId)), JSON.stringify(c));
// meanwhile B deletes one more and C deletes another before joining
await remove(B, ids[5]); await remove(C, ids[7]); await joined(C); await C.waitForTimeout(900);
a=await st(A); b=await st(B); c=await st(C);
check('an edit before the join and one made meanwhile both land everywhere', a.doc===s0.doc-6 && b.doc===a.doc && c.doc===a.doc && c.list===a.list && c.pend===0, JSON.stringify([a,b,c]));
// untouched fresh open: one parse only, then live edits flow
const D=await open(); let d=await st(D); check('fresh open: all edits, one parse', d.doc===s0.doc-6 && d.parses===1 && d.seq===a.seq, JSON.stringify(d));
await remove(A, ids[9]); await remove(D, ids[11]); await A.waitForTimeout(900);
a=await st(A); b=await st(B); c=await st(C); d=await st(D);
check('everyone agrees after more edits', [b,c,d].every(x=>x.doc===a.doc&&x.list===a.list&&x.seq===a.seq) && a.doc===s0.doc-8, JSON.stringify([a,b,c,d]));
// a guest (signed out, public project) cannot fetch the edits: the join brings them
const g=await browser.newContext(); const G=await g.newPage(); G.on('pageerror',(e)=>errs.push(e.message)); await G.goto(`${BASE}/p/${pid}/edit`); await joined(G); await G.waitForTimeout(900);
const gs=await G.evaluate(()=>({doc:window.CollabEditor.kdoc.items.size, seq:window.CollabEditor.lastSeq})); check('a guest catches up at the join', gs.doc===a.doc && gs.seq===a.seq, JSON.stringify(gs));
// resync puts the same document back
await D.evaluate(()=>window.CollabEditor.ws.send(JSON.stringify({type:'resync', docId:window.CollabEditor.joinedDocId}))); await D.waitForTimeout(900); d=await st(D);
check('a resync gives the same document', d.doc===a.doc && d.seq===a.seq, JSON.stringify(d));
console.log(`${pass} passed, ${fail} failed; errors ${JSON.stringify(errs)}`);
await browser.close(); await db.query('DELETE FROM projects WHERE id=$1',[pid]); await db.end();
process.exit(fail || errs.length ? 1 : 0);
