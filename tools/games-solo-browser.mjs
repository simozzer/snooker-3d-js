// games-solo-browser.mjs — opt-in BROWSER smoke for the two solo games (Peg Solitaire + Klondike).
// Headless Chrome loads each real page, asserts a clean boot, then makes ONE legal move and checks the
// state actually changed — all with zero JS console errors. Regression guard for the hand-written ES6
// engines and their click wiring.
//   node --test tools/games-solo-browser.mjs
// Skips cleanly (exit 0) if no Chrome/Edge binary is present.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const HTTP_PORT = 47500 + (process.pid % 200);
const CDP_PORT = 48200 + (process.pid % 200);
const UDD = mkdtempSync(join(tmpdir(), 'solo-browser-'));
const url = (p) => `http://127.0.0.1:${HTTP_PORT}/${p}`;

const chromePath = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean).find((p) => { try { return existsSync(p); } catch { return false; } });

let server, chrome, ws;
let available = false, skipReason = '', msgId = 0;
const pending = new Map();
let jsErrors = [];

function cdp(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++msgId; pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) rej(new Error(`CDP timeout: ${method}`)); }, 20000);
  });
}
async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(expr, { timeout = 12000, step = 150 } = {}) {
  const end = Date.now() + timeout;
  for (;;) { try { if (await evaluate(expr)) return true; } catch { /* transient */ } if (Date.now() > end) return false; await sleep(step); }
}
async function open(page, bootExpr) {
  jsErrors = [];
  await cdp('Page.navigate', { url: url(page) });
  const ok = await waitFor(bootExpr);
  await sleep(300);
  return ok;
}
const waitListening = async (u, tries = 30) => { for (let i = 0; i < tries; i++) { try { const r = await fetch(u); if (r.ok || r.status === 404) return true; } catch { /* down */ } await sleep(200); } return false; };

before(async () => {
  if (!chromePath) { skipReason = 'no Chrome/Edge binary found (set CHROME_PATH)'; return; }
  server = spawn(process.execPath, ['serve.js', String(HTTP_PORT)], { stdio: 'ignore' });
  if (!await waitListening(url('index.html'))) { skipReason = 'dev server did not start'; return; }
  chrome = spawn(chromePath, ['--headless=new', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${UDD}`, 'about:blank'], { stdio: 'ignore' });

  let target;
  for (let i = 0; i < 40; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json(); target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (target) break; } catch { /* not up */ }
    await sleep(200);
  }
  if (!target) { skipReason = 'Chrome DevTools target not found'; return; }
  const { WebSocket } = await import('ws');
  ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  ws.on('message', (buf) => {
    const m = JSON.parse(buf.toString());
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') jsErrors.push(m.params.args.map((a) => a.value || a.description).join(' '));
    else if (m.method === 'Runtime.exceptionThrown') jsErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  available = true;
});

after(async () => {
  try { ws?.close(); } catch { /* ignore */ }
  try { chrome?.kill(); } catch { /* ignore */ }
  try { server?.kill(); } catch { /* ignore */ }
});

test('Peg Solitaire boots (33 holes, 32 pegs) and a jump into the centre removes a peg', async (t) => {
  if (!available) { t.skip(skipReason || 'browser unavailable'); return; }
  assert.ok(await open('web/games/pegsolitaire/index.html', `document.querySelectorAll('#board .cell').length === 49`), 'board did not render');
  assert.deepEqual(jsErrors, [], `console errors on load:\n${jsErrors.join('\n')}`);
  assert.equal(await evaluate(`document.querySelectorAll('#board .peg').length`), 32, 'should start with 32 pegs');
  assert.equal(await evaluate(`document.getElementById('pegs').textContent`), '32');

  // Opening move: the peg at (3,1) jumps over (3,2) into the empty centre (3,3). Cells are row-major,
  // so index = r*7 + c. Click the peg, then the target hole.
  await evaluate(`document.querySelectorAll('#board .cell')[3*7+1].click()`); // select peg (3,1)
  await sleep(80);
  await evaluate(`document.querySelectorAll('#board .cell')[3*7+3].click()`); // land on centre (3,3)
  assert.ok(await waitFor(`document.getElementById('pegs').textContent === '31'`), 'peg count did not drop to 31 after a jump');
  assert.equal(await evaluate(`document.getElementById('moves').textContent`), '1');
  assert.deepEqual(jsErrors, [], `console errors after move:\n${jsErrors.join('\n')}`);
});

test('Klondike deals 28 tableau cards and dealing the stock puts a card on the waste', async (t) => {
  if (!available) { t.skip(skipReason || 'browser unavailable'); return; }
  assert.ok(await open('web/games/klondike/index.html', `document.querySelectorAll('#tableau .pile').length === 7`), 'tableau did not render');
  assert.deepEqual(jsErrors, [], `console errors on load:\n${jsErrors.join('\n')}`);
  assert.equal(await evaluate(`document.querySelectorAll('#tableau .card').length`), 28, '7 piles should hold 1+2+…+7 = 28 cards');
  assert.equal(await evaluate(`document.querySelectorAll('#waste .card').length`), 0, 'waste starts empty');

  await evaluate(`document.getElementById('stock').click()`); // deal from stock
  assert.ok(await waitFor(`document.querySelectorAll('#waste .card').length >= 1`), 'no card reached the waste after dealing the stock');
  assert.equal(await evaluate(`document.getElementById('moves').textContent`), '1');

  // Undo reverts the deal exactly (state is snapshotted as JSON and restored).
  await evaluate(`document.getElementById('undo').click()`);
  assert.ok(await waitFor(`document.querySelectorAll('#waste .card').length === 0 && document.getElementById('moves').textContent === '0'`), 'undo did not revert the deal');

  // Collect (auto-send to foundations) must never throw, even when it can move nothing.
  await evaluate(`document.getElementById('collect').click()`);
  assert.deepEqual(jsErrors, [], `console errors after deal/undo/collect:\n${jsErrors.join('\n')}`);
});
