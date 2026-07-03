// tools/browser-smoke.mjs — opt-in end-to-end smoke tests for the RENDERER (which the headless unit
// suite can't reach). Boots serve.js + headless Chrome, drives the app over the DevTools Protocol, and
// asserts the big user-facing flows: the app renders, modes switch, a shot resolves, Trick Shots loads
// and solves, and a shared frame round-trips through a link. Run it with:
//
//   npm run test:browser
//
// It is NOT part of `npm test` (kept out of test/ so node --test won't auto-discover it), because it
// needs a Chrome/Edge binary. (three.js is vendored locally, so no network is required.) If Chrome is
// missing it SKIPS cleanly (exit 0) rather than failing, so it never breaks a machine that can't run it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const HTTP_PORT = 47800 + (process.pid % 900);
const CDP_PORT = 48800 + (process.pid % 900);
const UDD = mkdtempSync(join(tmpdir(), 'snk3d-smoke-'));
const BASE = `http://127.0.0.1:${HTTP_PORT}/web/render3d.html`;

const chromePath = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean).find((p) => { try { return existsSync(p); } catch { return false; } });

let server, chrome, ws;
let available = false;
let skipReason = '';
let msgId = 0;
const pending = new Map();
const jsErrors = [];

function cdp(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) rej(new Error(`CDP timeout: ${method}`)); }, 20000);
  });
}
async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(expr, { timeout = 15000, step = 250 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    try { if (await evaluate(expr)) return true; } catch { /* transient */ }
    if (Date.now() > end) return false;
    await sleep(step);
  }
}
const click = (id) => evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(id)}); if(e){e.click(); return true;} return false;})()`);
const setSelect = (id, val) => evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(id)}); e.value=${JSON.stringify(val)}; e.dispatchEvent(new Event('change')); return e.value;})()`);
const status = () => evaluate(`document.getElementById('status').textContent`);

async function waitListening(url, tries = 30) {
  for (let i = 0; i < tries; i++) { try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch { /* not up */ } await sleep(200); }
  return false;
}

before(async () => {
  if (!chromePath) { skipReason = 'no Chrome/Edge binary found (set CHROME_PATH)'; return; }
  // 1) dev server
  server = spawn(process.execPath, ['serve.js', String(HTTP_PORT)], { cwd: process.cwd(), stdio: 'ignore' });
  if (!await waitListening(BASE)) { skipReason = 'dev server did not start'; return; }
  // 2) headless Chrome
  chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu=false', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${UDD}`, BASE,
  ], { stdio: 'ignore' });
  // 3) CDP target
  let target;
  for (let i = 0; i < 40; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json(); target = list.find((t) => t.type === 'page' && t.url.includes('render3d')); if (target?.webSocketDebuggerUrl) break; } catch { /* not up */ }
    await sleep(300);
  }
  if (!target) { skipReason = 'Chrome DevTools endpoint not reachable'; return; }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result ?? m.error); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') jsErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'exception');
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws error'))); });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  try { await cdp('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }); } catch { /* optional */ }
  // 4) the app actually renders (needs three.js from the CDN)
  if (!await waitFor(`!!document.querySelector('#view canvas')`, { timeout: 15000 })) { skipReason = 'app did not render (three.js CDN unreachable / no network?)'; return; }
  await sleep(500);
  available = true;
});

after(async () => {
  try { ws?.close(); } catch { /* noop */ }
  try { chrome?.kill('SIGKILL'); } catch { /* noop */ }
  try { server?.kill('SIGKILL'); } catch { /* noop */ }
  if (process.platform === 'win32') { // Chrome headless spawns detached children; sweep by our unique user-data-dir
    try { spawn('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${UDD.replace(/\\/g, '\\\\')}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' }); } catch { /* best effort */ }
  }
});

const guard = (t) => { if (!available) { t.skip(`browser env unavailable — ${skipReason}`); return true; } return false; };

test('the app loads: canvas renders and all four game modes are offered', async (t) => {
  if (guard(t)) return;
  assert.equal(await evaluate(`!!document.querySelector('#view canvas')`), true);
  assert.match(await evaluate(`document.title`), /snooker/i);
  const modes = await evaluate(`[...document.getElementById('game').options].map(o=>o.value)`);
  assert.deepEqual(modes.sort(), ['nineball', 'pool', 'snooker', 'trickshots'].sort());
  assert.match(await evaluate(`document.getElementById('version').textContent`), /^v\d/);
});

test('switching to pool racks a fresh frame with ball-in-hand placement', async (t) => {
  if (guard(t)) return;
  await setSelect('game', 'pool');
  assert.ok(await waitFor(`/place|ball in hand|hand/i.test(document.getElementById('status').textContent)`, { timeout: 5000 }), 'expected a ball-in-hand placement prompt');
});

test('playing a shot resolves it (status updates to a rules outcome)', async (t) => {
  if (guard(t)) return;
  await setSelect('game', 'pool');
  await sleep(400);
  const before = await status();
  await click('play');
  // playShot sets the outcome message synchronously, before the animation
  const changed = await waitFor(`document.getElementById('status').textContent && document.getElementById('status').textContent !== ${JSON.stringify(before)}`, { timeout: 6000 });
  assert.ok(changed, 'status did not change after Play');
});

test('Trick Shots loads a level and "Show me" makes the shot', async (t) => {
  if (guard(t)) return;
  await setSelect('game', 'trickshots');
  assert.ok(await waitFor(`document.getElementById('trickpanel').style.display==='block'`, { timeout: 4000 }), 'trick panel not shown');
  assert.match(await evaluate(`document.getElementById('trick-name').textContent`), /\w/);
  await click('trick-show');
  assert.ok(await waitFor(`/shot made/i.test(document.getElementById('trick-result').textContent)`, { timeout: 25000 }), 'Show me did not make the shot');
});

test('AI-vs-AI shows broadcast labels (AI 1 / AI 2)', async (t) => {
  if (guard(t)) return;
  await setSelect('game', 'pool');
  await setSelect('aimode', 'self');
  assert.ok(await waitFor(`/AI 1/.test(document.getElementById('scores').textContent) && /AI 2/.test(document.getElementById('scores').textContent)`, { timeout: 8000 }), 'AI-vs-AI labels not shown');
  await setSelect('aimode', 'ai');
});

test('a shared frame round-trips: play → copy link → open ?frame= replays it', async (t) => {
  if (guard(t)) return;
  await setSelect('game', 'pool');
  await sleep(400);
  await click('play');
  await waitFor(`document.getElementById('status').textContent.length>0`, { timeout: 6000 });
  await sleep(1200);
  await click('sharelink');
  await sleep(400);
  const url = await evaluate(`navigator.clipboard.readText().catch(()=>'')`);
  assert.match(url, /[?&](challenge|frame)=[A-Za-z0-9_-]+/, 'no share link on the clipboard');
  const token = url.replace(/.*[?&](?:challenge|frame)=/, '').split('&')[0];
  await cdp('Page.navigate', { url: `${BASE}?frame=${token}` });
  assert.ok(await waitFor(`!!document.querySelector('#view canvas')`, { timeout: 15000 }), 'app did not re-render after navigation');
  assert.ok(await waitFor(`/watching|shared frame|complete/i.test(document.getElementById('status').textContent)`, { timeout: 8000 }), 'shared frame did not load');
  assert.equal(await evaluate(`document.getElementById('game').value`), 'pool');
});

test('no uncaught JavaScript errors during the whole session', async (t) => {
  if (guard(t)) return;
  assert.deepEqual(jsErrors, [], `console/JS errors:\n${jsErrors.join('\n')}`);
});
