// dice-online-browser.mjs — opt-in end-to-end BROWSER test for online DICE. Headless Chrome runs the
// real board.html/board.js/dice-view.js as the GUEST (seat 1); a Node RelayClient running the real
// dice engine (src/board/dice.js) is the HOST (seat 0). The host plays a whole turn (roll → keep the
// scorers → bank) and relays its authoritative state each step; the browser must animate the tumble,
// SNAP to the host's faces, keep the scoreboard in lockstep, gate its Roll button off-turn, and then
// take its OWN turn — whose roll must reach the host. Verifies the whole loop with zero JS errors.
//   npm run test:dice-online-browser
// Skips cleanly (exit 0) if no Chrome/Edge binary is present.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { RelayClient } from '../web/net.js';
import { createDice } from '../src/board/dice.js';

const HTTP_PORT = 47500 + (process.pid % 400);
const CDP_PORT = 48500 + (process.pid % 400); // stay below Windows' 49702+ excluded range
const RELAY_PORT = 46500 + (process.pid % 400);
const UDD = mkdtempSync(join(tmpdir(), 'dice-online-'));
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;
const BASE = `http://127.0.0.1:${HTTP_PORT}/web/board.html?game=dice&relay=${encodeURIComponent(RELAY_URL)}`;

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
async function waitFor(expr, { timeout = 15000, step = 150 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    try { if (await evaluate(expr)) return true; } catch { /* transient */ }
    if (Date.now() > end) return false;
    await sleep(step);
  }
}
const peek = async () => JSON.parse(await evaluate('JSON.stringify(window.boardController.peek())'));
const poses = async () => JSON.parse(await evaluate('JSON.stringify(window.boardController.dicePoses())'));
const setSelect = (id, val) => evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(id)}); e.value=${JSON.stringify(val)}; e.dispatchEvent(new Event('change')); return e.value;})()`);
const rollBtnDisabled = `document.querySelector('#gamecontrols button').disabled`;
const clickRoll = () => evaluate(`document.querySelector('#gamecontrols button').click()`);
const waitListening = async (url, tries = 30) => { for (let i = 0; i < tries; i++) { try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch { /* down */ } await sleep(200); } return false; };
const fromSeat = (client, event, seat, ms = 15000) => new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error(`timeout ${event} seat ${seat}`)), ms);
  const off = client.on(event, (m) => { if (m.seat === seat) { clearTimeout(to); off(); resolve(m); } });
});

before(async () => {
  if (!chromePath) { skipReason = 'no Chrome/Edge binary found (set CHROME_PATH)'; return; }
  relay = spawn(process.execPath, ['server/relay.js', String(RELAY_PORT)], { stdio: 'ignore' });
  server = spawn(process.execPath, ['serve.js', String(HTTP_PORT)], { stdio: 'ignore' });
  if (!await waitListening(`http://127.0.0.1:${HTTP_PORT}/web/board.html`)) { skipReason = 'dev server did not start'; return; }
  await sleep(300);
  chrome = spawn(chromePath, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--use-gl=swiftshader',
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

test('the browser guest animates+snaps the host roll, stays in lockstep, and takes its own turn', async (t) => {
  if (guard(t)) return;

  // Node HOST (seat 0) runs the real engine; the browser JOINS as the guest (seat 1).
  const host = new RelayClient({ url: RELAY_URL, autoReconnect: false });
  const A = createDice(); A.newGame(['Host', 'Guest']);
  await host.connect();
  const created = await host.create({ game: 'dice', seats: 2 });

  await setSelect('mode', 'online');
  await evaluate(`(()=>{const c=document.getElementById('net-code'); c.value=${JSON.stringify(created.code)}; document.getElementById('net-join').click();})()`);
  await fromSeat(host, 'peer-joined', 1).catch(() => {});
  assert.ok(await waitFor(`window.boardController.peek().online === true && window.boardController.peek().onlineSeat === 1`, { timeout: 8000 }), 'guest never entered online play as seat 1');

  // It's the host's turn (seat 0) → the guest's Roll button must be locked (turn gating).
  assert.ok(await waitFor(`${rollBtnDisabled} === true`, { timeout: 6000 }), 'guest Roll should be disabled off-turn');

  // HOST turn: roll three 1s + a 5, keep all four scorers, bank 1050. Relay each step.
  A.roll([1, 1, 1, 5, 2, 3]);
  host.sendMove({ roll: { seed: 0xC0FFEE, thrown: [0, 1, 2, 3, 4, 5] }, state: A.state() }, host.seat);
  assert.ok(await waitFor(`window.boardController.peek().phase === 'pick' && window.boardController.peek().busy === false`, { timeout: 20000 }), 'guest never settled the host roll');

  // The guest snapped to the host's authoritative faces (values match the engine, not the tumble).
  const gp = await peek();
  assert.deepEqual(gp.dice.map((d) => d.value), [1, 1, 1, 5, 2, 3], 'guest engine holds the host roll');
  for (const p of await poses()) assert.equal(p.value, gp.dice[p.index].value, `die ${p.index} did not snap to its authoritative face`);

  for (const i of [0, 1, 2, 3]) { A.toggleSelect(i); host.sendMove({ state: A.state() }, host.seat); }
  assert.ok(await waitFor(`window.boardController.peek().dice.filter(d=>d.picked).length === 4`, { timeout: 6000 }), 'guest did not mirror the host selection');

  A.bank();
  host.sendMove({ state: A.state() }, 1); // banking hands the turn to the guest
  assert.ok(await waitFor(`window.boardController.peek().current === 1 && window.boardController.peek().players[0].score === 1050`, { timeout: 6000 }), 'guest did not see the host bank / turn hand-off');

  // GUEST turn: its Roll button enables; it rolls, and the roll must reach the host.
  assert.ok(await waitFor(`${rollBtnDisabled} === false`, { timeout: 6000 }), 'guest Roll did not enable on its turn');
  const guestRoll = fromSeat(host, 'move', 1);
  await clickRoll();
  const gm = await guestRoll;
  assert.ok(gm.payload.roll && gm.payload.state, 'guest relayed a well-formed roll payload');
  A.load(gm.payload.state); // host applies the guest roll
  assert.ok(await waitFor(`window.boardController.peek().phase === 'pick' && window.boardController.peek().busy === false`, { timeout: 20000 }), 'guest did not settle its own roll');
  const gp2 = await peek();
  assert.deepEqual(A.state().dice.map((d) => d.value), gp2.dice.map((d) => d.value), 'host and guest disagree on the guest roll');

  assert.deepEqual(jsErrors, [], `unexpected JS errors: ${jsErrors.join(' | ')}`);
  host.close();
});
