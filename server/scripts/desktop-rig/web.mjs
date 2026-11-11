import { createRequire } from 'module'; import fs from 'fs'; import crypto from 'crypto';
const require = createRequire('/opt/node-tools/node_modules/'); const { chromium } = require('playwright');
const rig = JSON.parse(fs.readFileSync('/tmp/claude-0/rig/rig.json')); const BASE = 'http://127.0.0.1:8099';
const doc = rig.project.docs.find((d) => d.docType === 'kicad_pcb');
const browser = await chromium.launch(); const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 })).newPage();
const toasts = []; page.on('console', (m) => { if (/refill|desktop/i.test(m.text())) toasts.push(m.text()); });
await page.goto(`${BASE}/auth/dev?jwt=${rig.bob}&next=${encodeURIComponent(`/p/${rig.project.projectId}/edit?doc=${doc.docId}`)}`);
await page.waitForFunction(() => window.CollabEditor && window.CollabEditor.kdoc && window.CollabEditor.kdoc.items.size > 5 && window.CollabEditor.ws && window.CollabEditor.ws.readyState === 1, null, { timeout: 60000 });
await page.waitForTimeout(1500);
const sig = () => page.evaluate(() => { const K = window.KiCadCanvas; const out = {}; for (const it of window.CollabEditor.kdoc.items.values()) if (it.kind === 'zone') { const s = JSON.stringify(K.kids(it.node, 'filled_polygon')); let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; out[it.id.slice(0, 8)] = [s.length, h]; } return out; });
const before = await sig(); console.log('browser zones before', JSON.stringify(before));
await page.screenshot({ path: '/mnt/project-files/sync-two-client/browser-before-refill.png' });
fs.writeFileSync('/tmp/claude-0/rig/web-ready', '1');
// wait for the driver to add a track on the desktop, then ask for the refill from the browser
await page.waitForFunction(() => fetch('/static/x').then(() => true), null).catch(() => {});
while (!fs.existsSync('/tmp/claude-0/rig/web-go')) await page.waitForTimeout(300);
await page.mouse.move(700, 500); await page.keyboard.press('b');
await page.waitForTimeout(600); await page.screenshot({ path: '/mnt/project-files/sync-two-client/browser-asked.png' });
let after = before; const t0 = Date.now();
while (Date.now() - t0 < 60000 && JSON.stringify(after) === JSON.stringify(before)) { await page.waitForTimeout(500); after = await sig(); }
console.log('browser zones after ', JSON.stringify(after), 'changed', JSON.stringify(after) !== JSON.stringify(before), 'in', Date.now() - t0, 'ms');
await page.waitForTimeout(1000); await page.screenshot({ path: '/mnt/project-files/sync-two-client/browser-after-refill.png' });
fs.writeFileSync('/tmp/claude-0/rig/web-result.json', JSON.stringify({ before, after }));
await browser.close();
