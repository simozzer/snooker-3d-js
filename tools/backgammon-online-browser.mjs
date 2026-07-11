// backgammon-online-browser.mjs — opt-in end-to-end BROWSER test for online backgammon, focused on
// the dice/random path and multi-move turns. Headless Chrome runs the real board.html/board.js/
// backgammon-view.js as the GUEST (Black); a Node RelayClient is the HOST (White). White plays a whole
// turn — a roll plus its several checker moves relayed back-to-back — and the browser must apply every
// one and land on the identical board. This guards a real regression: applying a peer move inside an
// animation callback drops checkers when moves arrive faster than the slide (backgammon is the only
// game that relays multiple moves per turn). Then the browser rolls on its own turn.
//   npm run test:bg-browser
// Skips cleanly (exit 0) if no Chrome/Edge binary is present.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { RelayClient } from '../web/net.js';
import { createBackgammon } from '../src/board/backgammon.js';
import { diceFromU32 } from '../web/games/backgammon-view.js';

const HTTP_PORT = 47100 + (process.pid % 600);
const CDP_PORT = 49000 + (process.pid % 600);  // stay below Windows' 49702+ excluded range
const RELAY_PORT = 46100 + (process.pid % 600);
const UDD = mkdtempSync(join(tmpdir(), 'bg-online-'));
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;
const BASE = `http://127.0.0.1:${HTTP_PORT}/web/board.html?game=backgammon&relay=${encodeURIComponent(RELAY_URL)}`;

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
const fromSeat = (client, event, seat, ms = 4000) => new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error(`timeout ${event} seat ${seat}`)), ms);
  const off = client.on(event, (m) => { if (m.seat === seat) { clearTimeout(to); off(); resolve(m); } });
});

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

test('a whole relayed turn (roll + multiple moves) applies in the real UI and the board matches', async (t) => {
  if (guard(t)) return;

  // Node is the HOST (White, seat 0); the browser JOINS as Black (seat 1). Mirror engine for White.
  const host = new RelayClient({ url: RELAY_URL, autoReconnect: false });
  const A = createBackgammon();
  host.on('random', (m) => { if (m.seat !== host.seat) { const [d1, d2] = diceFromU32(m.value); A.roll(d1, d2); } });
  host.on('move', (m) => { if (m.seat !== host.seat) { const p = m.payload; if (p.pass) A.endTurn(); else { A.move({ from: p.from, to: p.to }); if (A.state().movesLeft.length === 0 || !A.canMove()) A.endTurn(); } } });
  await host.connect();
  const created = await host.create({ game: 'backgammon' });

  await setSelect('mode', 'online');
  await evaluate(`(()=>{const c=document.getElementById('net-code'); c.value=${JSON.stringify(created.code)}; document.getElementById('net-join').click();})()`);
  await fromSeat(host, 'peer-joined', 1).catch(() => {});
  assert.ok(await waitFor(`/playing/i.test(document.getElementById('net-status').innerHTML)`, { timeout: 6000 }), 'guest never became ready');

  // White plays its whole first turn: one roll, then every checker move relayed back-to-back.
  const myRoll = fromSeat(host, 'random', 0);
  host.requestRandom();
  const rm = await myRoll;
  const [d1, d2] = diceFromU32(rm.value);
  A.roll(d1, d2);
  for (;;) {
    const mv = A.allLegalMoves()[0];
    A.move(mv);
    const complete = A.state().movesLeft.length === 0 || !A.canMove();
    const delivered = fromSeat(host, 'move', 0);
    host.sendMove({ from: mv.from, to: mv.to }, complete ? 1 : 0);
    await delivered;
    if (complete) { A.endTurn(); break; }
  }

  // The browser must have applied EVERY relayed move (no drops) and reached the identical board.
  assert.ok(await waitFor(`window.boardController.getShareToken() === ${JSON.stringify(A.serialize())}`, { timeout: 6000 }),
    'browser board did not match after White\'s full turn — a relayed move was dropped');
  assert.ok(await waitFor(`/your roll/i.test(document.getElementById('turn').textContent)`, { timeout: 4000 }), 'browser did not pass the turn to Black');

  // Browser rolls on its own turn; the roll must reach the host through the relay.
  const guestRoll = fromSeat(host, 'random', 1);
  await evaluate(`document.querySelector('#gamecontrols button').click()`);
  await guestRoll;
  assert.ok(await waitFor(`/your move|no legal/i.test(document.getElementById('turn').textContent + document.getElementById('status').textContent)`, { timeout: 4000 }), 'browser did not reflect its own roll');

  assert.deepEqual(jsErrors, [], `unexpected JS errors: ${jsErrors.join(' | ')}`);
  host.close();
});
