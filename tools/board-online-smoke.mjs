// board-online-smoke.mjs — opt-in end-to-end browser test for ONLINE draughts. Headless Chrome runs
// the real board.html/board.js/draughts-view.js as the HOST; a Node RelayClient plays the GUEST. This
// exercises the DOM wiring the Node-only smokes can't reach: mode switch → lobby → create room, canvas
// clicks committing a move that reaches the peer, and a peer move applied back into the live board.
//   npm run test:board
// Skips cleanly (exit 0) if no Chrome/Edge binary is present.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { RelayClient } from '../web/net.js';
import { createDraughts } from '../src/board/draughts.js';

const HTTP_PORT = 47000 + (process.pid % 700);
const CDP_PORT = 49000 + (process.pid % 700);
const RELAY_PORT = 46000 + (process.pid % 700);
const UDD = mkdtempSync(join(tmpdir(), 'board-online-'));
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;
const BASE = `http://127.0.0.1:${HTTP_PORT}/web/board.html?game=draughts&relay=${encodeURIComponent(RELAY_URL)}`;

const chromePath = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean).find((p) => { try { return existsSync(p); } catch { return false; } });

let server, relay, chrome, ws;
let available = false, skipReason = '', msgId = 0;
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
async function waitFor(expr, { timeout = 15000, step = 200 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    try { if (await evaluate(expr)) return true; } catch { /* transient */ }
    if (Date.now() > end) return false;
    await sleep(step);
  }
}
const setSelect = (id, val) => evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(id)}); e.value=${JSON.stringify(val)}; e.dispatchEvent(new Event('change')); return e.value;})()`);
const waitListening = async (url, tries = 30) => { for (let i = 0; i < tries; i++) { try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch { /* down */ } await sleep(200); } return false; };

// Dispatch a real mousedown at the centre of a draughts square (the view listens on 'mousedown').
const clickSquare = (row, col) => evaluate(`(()=>{
  const cv=document.getElementById('board'); const r=cv.getBoundingClientRect(); const cell=r.width/8;
  cv.dispatchEvent(new MouseEvent('mousedown',{clientX:r.left+(${col}+0.5)*cell, clientY:r.top+(${row}+0.5)*cell, bubbles:true, cancelable:true}));
  return true;
})()`);

before(async () => {
  if (!chromePath) { skipReason = 'no Chrome/Edge binary found (set CHROME_PATH)'; return; }
  relay = spawn(process.execPath, ['server/relay.js', String(RELAY_PORT)], { stdio: 'ignore' });
  server = spawn(process.execPath, ['serve.js', String(HTTP_PORT)], { stdio: 'ignore' });
  if (!await waitListening(`http://127.0.0.1:${HTTP_PORT}/web/board.html`)) { skipReason = 'dev server did not start'; return; }
  chrome = spawn(chromePath, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${UDD}`, BASE,
  ], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 40; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json(); target = list.find((t) => t.type === 'page' && t.url.includes('board.html')); if (target?.webSocketDebuggerUrl) break; } catch { /* down */ }
    await sleep(300);
  }
  if (!target) { skipReason = 'Chrome DevTools endpoint not reachable'; return; }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result ?? m.error); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') jsErrors.push(m.params.exceptionDetails?.exception?.description || 'exception');
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws error'))); });
  await cdp('Runtime.enable');
  if (!await waitFor(`!!document.getElementById('board') && !!window.boardController`, { timeout: 15000 })) { skipReason = 'board did not load'; return; }
  available = true;
});

after(async () => {
  try { ws?.close(); } catch { /* noop */ }
  try { chrome?.kill('SIGKILL'); } catch { /* noop */ }
  try { server?.kill('SIGKILL'); } catch { /* noop */ }
  try { relay?.kill('SIGKILL'); } catch { /* noop */ }
  if (process.platform === 'win32') {
    try { spawn('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${UDD.replace(/\\/g, '\\\\')}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' }); } catch { /* best effort */ }
  }
});

const guard = (t) => { if (!available) { t.skip(`browser env unavailable — ${skipReason}`); return true; } return false; };

test('host creates a room, guest joins, and moves sync both ways through the real UI', async (t) => {
  if (guard(t)) return;

  // The reachability light is ALWAYS visible (connects on load) and should be green before we even
  // touch the mode selector, since the relay is up.
  assert.ok(await waitFor(`document.getElementById('netstat').classList.contains('show') && document.getElementById('netstat').classList.contains('online')`, { timeout: 6000 }), 'reachability light not green on load');

  // Host: switch to online mode and create a room; read the room code from the lobby.
  await setSelect('mode', 'online');
  assert.equal(await evaluate(`document.getElementById('lobby').style.display !== 'none'`), true, 'lobby not shown');
  assert.equal(await evaluate(`document.getElementById('netstat').classList.contains('online')`), true, 'light should still be green in online mode');
  await evaluate(`document.getElementById('net-create').click()`);
  assert.ok(await waitFor(`document.querySelector('#net-status b')`, { timeout: 8000 }), 'no room code appeared');
  const code = await evaluate(`document.querySelector('#net-status b').textContent`);
  assert.match(code, /^[A-Z2-9]{4}$/);

  // Guest: a Node RelayClient joins that room; the host must then show it's our (Red's) move.
  const guest = new RelayClient({ url: RELAY_URL, autoReconnect: false });
  const B = createDraughts(); // mirror engine for the guest
  guest.on('move', (m) => { if (m.seat !== guest.seat) B.move({ from: m.payload.from, path: m.payload.path }); });
  await guest.connect();
  await guest.join(code);
  assert.ok(await waitFor(`/your move/i.test(document.getElementById('turn').textContent)`, { timeout: 6000 }), 'host never became ready to move');

  // Host plays Red's opening move on the CANVAS: select (5,0) then land on (4,1).
  const gotHostMove = new Promise((res) => { const off = guest.on('move', (m) => { if (m.seat === 0) { off(); res(m); } }); });
  await clickSquare(5, 0);
  await sleep(120);
  await clickSquare(4, 1);
  const hostMove = await Promise.race([gotHostMove, sleep(4000).then(() => null)]);
  assert.ok(hostMove, 'host move never reached the guest');
  assert.deepEqual(hostMove.payload.path, [{ row: 4, col: 1 }]);
  await sleep(300); // let the host's slide animation settle

  // Guest replies with White's first legal move; the host page must apply it into its live board.
  const reply = B.allLegalMoves()[0];
  B.move(reply);
  guest.sendMove({ from: reply.from, path: reply.path }, reply.from ? (B.turn() === 'r' ? 0 : 1) : 1);
  assert.ok(await waitFor(`window.boardController.getShareToken() === ${JSON.stringify(B.serialize())}`, { timeout: 6000 }),
    'host board did not match after applying the guest reply');

  // The local-only lifecycle controls are hidden during an online game.
  assert.equal(await evaluate(`document.getElementById('newgame').style.display`), 'none');
  assert.deepEqual(jsErrors, [], `unexpected JS errors: ${jsErrors.join(' | ')}`);

  guest.close();
});

test('the light reflects the relay going DOWN and recovers when it comes back', async (t) => {
  if (guard(t)) return;

  // Start from green.
  assert.ok(await waitFor(`document.getElementById('netstat').classList.contains('online')`, { timeout: 6000 }), 'not green to begin with');

  // Kill the relay — the page's socket drops and the light must leave the green/online state.
  relay.kill('SIGKILL'); relay = null;
  assert.ok(await waitFor(`!document.getElementById('netstat').classList.contains('online')`, { timeout: 8000 }), 'light stayed green after the server died');
  const downLabel = await evaluate(`document.getElementById('netstat-label').textContent`);
  assert.match(downLabel, /reconnect|unreach/i, `expected a down/reconnecting label, got "${downLabel}"`);

  // Bring the relay back on the same port; the auto-reconnecting client must return to green on its own.
  await sleep(600); // let the port free after SIGKILL
  relay = spawn(process.execPath, ['server/relay.js', String(RELAY_PORT)], { stdio: 'ignore' });
  assert.ok(await waitFor(`document.getElementById('netstat').classList.contains('online')`, { timeout: 20000 }), 'light did not recover to green after the server returned');
});
