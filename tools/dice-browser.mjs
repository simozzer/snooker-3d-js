// dice-browser.mjs — opt-in BROWSER smoke for the 3D Dice (Farkle) view. Headless Chrome runs the real
// board.html/board.js/dice-view.js; it rolls the dice several times and asserts the settled dice (a)
// lie FLAT on the tray (a face pointing essentially straight up) and (b) rest at VARIED headings rather
// than all lined up parallel to the walls — the regression this change fixes. Any cocked throw is
// auto-re-rolled by the view, so by the time a roll finishes every die must be flat. Also fails on any
// JS console error.
//   node --test tools/dice-browser.mjs
// Skips cleanly (exit 0) if no Chrome/Edge binary is present.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const HTTP_PORT = 47700 + (process.pid % 600);
const CDP_PORT = 49100 + (process.pid % 400); // stay below Windows' 49702+ excluded range
const UDD = mkdtempSync(join(tmpdir(), 'dice-browser-'));
const BASE = `http://127.0.0.1:${HTTP_PORT}/web/board.html?game=dice`;

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
  if (!await waitListening(`http://127.0.0.1:${HTTP_PORT}/web/board.html`)) { skipReason = 'dev server did not start'; return; }
  chrome = spawn(chromePath, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--use-gl=swiftshader',
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
  if (!await waitFor('!!(window.boardController && window.boardController.dicePoses)')) { skipReason = 'dice view did not mount'; return; }
  available = true;
});

after(async () => {
  try { ws?.close(); } catch { /* ignore */ }
  try { chrome?.kill(); } catch { /* ignore */ }
  try { server?.kill(); } catch { /* ignore */ }
});

// Click Roll and wait until the throw (plus any automatic cocked re-rolls) has fully settled.
async function rollAndSettle() {
  await evaluate(`(()=>{ for (const b of document.querySelectorAll('button')) if (b.textContent.includes('Roll')) { b.click(); break; } })()`);
  const ok = await waitFor('window.boardController.peek().busy === false', { timeout: 12000 });
  assert.ok(ok, 'roll did not settle in time');
}

test('dice land flat and at varied headings, with no JS errors', async (t) => {
  if (!available) { t.skip(skipReason || 'browser unavailable'); return; }

  const yaws = [];
  for (let r = 0; r < 6; r++) {
    await rollAndSettle();
    const poses = await evaluate('JSON.stringify(window.boardController.dicePoses())').then(JSON.parse);
    assert.ok(poses.length >= 1, `roll ${r}: expected dice in the tray`);
    for (const p of poses) {
      // Every settled die must be flat — a face pointing essentially straight up (within ~1°).
      assert.ok(p.upFaceY > 0.999, `roll ${r}: a die did not lie flat (upFaceY=${p.upFaceY.toFixed(4)})`);
      yaws.push(((p.yaw % 90) + 90) % 90); // fold into a face's 90° symmetry
    }
    // Reset to a fresh six for the next throw (a whole new set exercises the full lay-flat path).
    await evaluate('window.boardController.newGame()');
    await waitFor('window.boardController.peek().phase === "await-roll"');
  }

  // If the dice were snapping parallel to the walls, folded yaws would cluster hard at ~0; a natural
  // lay-flat spreads them across 0..90. Demand a healthy mid-range fraction.
  const mid = yaws.filter((y) => y > 15 && y < 75).length / yaws.length;
  assert.ok(mid > 0.35, `headings look grid-aligned, not natural (mid-range fraction ${mid.toFixed(2)} of ${yaws.length})`);
  assert.deepEqual(jsErrors, [], `console errors:\n${jsErrors.join('\n')}`);
});
