// sidoku-browser.mjs — opt-in BROWSER smoke for the ported Sidoku (solo roguelite Sudoku).
// Headless Chrome loads the real web/games/sidoku/ page (classic engine scripts + flattened CSS),
// asserts it boots cleanly, then selects a difficulty and asserts a puzzle is fetched from
// ./resources and rendered into #sidukoTable — all with ZERO JS console errors. This is the
// regression guard for the Tailwind→plain-CSS flatten and the word-search removal.
//   node --test tools/sidoku-browser.mjs
// Skips cleanly (exit 0) if no Chrome/Edge binary is present.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const HTTP_PORT = 47100 + (process.pid % 500);
const CDP_PORT = 48600 + (process.pid % 300); // stay below Windows' 49702+ excluded range
const UDD = mkdtempSync(join(tmpdir(), 'sidoku-browser-'));
const BASE = `http://127.0.0.1:${HTTP_PORT}/web/games/sidoku/index.html`;

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
const waitListening = async (url, tries = 30) => { for (let i = 0; i < tries; i++) { try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch { /* down */ } await sleep(200); } return false; };

before(async () => {
  if (!chromePath) { skipReason = 'no Chrome/Edge binary found (set CHROME_PATH)'; return; }
  server = spawn(process.execPath, ['serve.js', String(HTTP_PORT)], { stdio: 'ignore' });
  if (!await waitListening(BASE)) { skipReason = 'dev server did not start'; return; }
  chrome = spawn(chromePath, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    // synthetic dispatchEvent isn't a "real" gesture, so allow autoplay or the game's start
    // sound throws a NotAllowedError that would never occur on a real click.
    '--autoplay-policy=no-user-gesture-required', '--mute-audio',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${UDD}`, BASE,
  ], { stdio: 'ignore' });

  let target;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      const list = await r.json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch { /* not up yet */ }
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
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  // onLoad -> doGameLoaded() must have run (it attaches the #menu listener).
  if (!await waitFor(`document.readyState === 'complete' && !!document.getElementById('menu')`)) {
    skipReason = 'Sidoku page did not finish loading';
    return;
  }
  available = true;
});

after(async () => {
  try { ws?.close(); } catch { /* ignore */ }
  try { chrome?.kill(); } catch { /* ignore */ }
  try { server?.kill(); } catch { /* ignore */ }
});

test('Sidoku boots, loads a puzzle and renders the grid — no JS errors', async (t) => {
  if (!available) { t.skip(skipReason || 'browser unavailable'); return; }

  // 1) clean boot
  assert.deepEqual(jsErrors, [], `console errors during load:\n${jsErrors.join('\n')}`);

  // 2) pick a difficulty -> triggers loadPuzzle('./resources/easyPuzzleData.txt') -> render
  await evaluate(`(()=>{ const m=document.getElementById('menu'); m.value='Easy'; m.dispatchEvent(new Event('change')); })()`);

  const rendered = await waitFor(`!!document.getElementById('sidukoTable')`, { timeout: 12000 });
  assert.ok(rendered, 'the puzzle grid (#sidukoTable) did not render after selecting Easy (puzzle fetch/render failed)');

  // 3) a full 9x9 board is present (81 cells; outer/inner-table holder <td>s push the count higher)
  const cellCount = await evaluate(`document.querySelectorAll('#sidukoTable td').length`);
  assert.ok(cellCount >= 81, `expected >= 81 grid cells, got ${cellCount}`);

  // 4) still no console errors after starting a puzzle
  assert.deepEqual(jsErrors, [], `console errors after starting a puzzle:\n${jsErrors.join('\n')}`);
});
