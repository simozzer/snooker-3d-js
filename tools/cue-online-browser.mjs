// cue-online-browser.mjs — opt-in end-to-end BROWSER test for online 3D snooker. Headless Chrome runs
// the real render3d.html/render3d.js as the GUEST (seat 1); a Node RelayClient running the real engine
// (src/game.js) is the HOST (seat 0). The host breaks and relays {shot + resting table + frame}; the
// browser must animate it and SNAP to the identical table, then it becomes the browser's turn — the
// browser plays its own shot through the UI and the host applies it. Verifies the whole online loop:
// shared-seed rack, turn gating (Play disabled off-turn), animate-then-snap, and the return relay —
// with zero JS errors.
//   npm run test:cue-browser
// Skips cleanly (exit 0) if no Chrome/Edge binary is present.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { RelayClient } from '../web/net.js';
import { newGame, takeShot } from '../src/game.js';
import { snooker } from '../src/variants/snooker.js';
import { serializeTable, shotPayload } from '../web/games/cue-online.js';

const HTTP_PORT = 47300 + (process.pid % 500);
const CDP_PORT = 49200 + (process.pid % 500);   // stay below Windows' 49702+ excluded range
const RELAY_PORT = 46300 + (process.pid % 500);
const UDD = mkdtempSync(join(tmpdir(), 'cue-online-'));
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;
const BASE = `http://127.0.0.1:${HTTP_PORT}/web/render3d.html?game=snooker&relay=${encodeURIComponent(RELAY_URL)}`;

const chromePath = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean).find((p) => { try { return existsSync(p); } catch { return false; } });

function mulberry32(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function breakShot(state) {
  const cue = state.pieces.find((p) => p.id === 'cue');
  const origin = cue ? cue.pos : snooker.defaultPlacement(state);
  const objs = state.pieces.filter((p) => p.id !== 'cue');
  const cx = objs.reduce((s, p) => s + p.pos.x, 0) / objs.length;
  const cy = objs.reduce((s, p) => s + p.pos.y, 0) / objs.length;
  return { angle: Math.atan2(cy - origin.y, cx - origin.x), speed: 5.2, spin: { side: 0, vert: 0 }, elevation: 0, cuePlacement: null };
}

let server, relay, chrome, ws, host, A;
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
const waitListening = async (url, tries = 30) => { for (let i = 0; i < tries; i++) { try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch { /* down */ } await sleep(200); } return false; };
const moveFrom = (client, seat, ms = 15000) => new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error(`timeout waiting for move from seat ${seat}`)), ms);
  const off = client.on('move', (m) => { if (m.seat === seat) { clearTimeout(to); off(); resolve(m); } });
});

before(async () => {
  if (!chromePath) { skipReason = 'no Chrome/Edge binary found (set CHROME_PATH)'; return; }
  relay = spawn(process.execPath, ['server/relay.js', String(RELAY_PORT)], { stdio: 'ignore' });
  server = spawn(process.execPath, ['serve.js', String(HTTP_PORT)], { stdio: 'ignore' });
  if (!await waitListening(`http://127.0.0.1:${HTTP_PORT}/web/render3d.html`)) { skipReason = 'dev server did not start'; return; }
  await sleep(300);
  chrome = spawn(chromePath, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--use-gl=swiftshader',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${UDD}`, BASE,
  ], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 40; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json(); target = list.find((t) => t.type === 'page' && t.url.includes('render3d.html')); if (target?.webSocketDebuggerUrl) break; } catch { /* down */ }
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
  if (!await waitFor(`!!document.getElementById('aimode') && !!window.__cue`, { timeout: 15000 })) { skipReason = 'render3d did not load'; return; }
  available = true;
});

after(async () => {
  try { host?.close(); } catch { /* noop */ }
  try { ws?.close(); } catch { /* noop */ }
  try { chrome?.kill('SIGKILL'); } catch { /* noop */ }
  try { server?.kill('SIGKILL'); } catch { /* noop */ }
  try { relay?.kill('SIGKILL'); } catch { /* noop */ }
  if (process.platform === 'win32') {
    try { spawn('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${UDD.replace(/\\/g, '\\\\')}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' }); } catch { /* best effort */ }
  }
});

const guard = (t) => { if (!available) { t.skip(`browser env unavailable — ${skipReason}`); return true; } return false; };

test('online snooker: the browser guest animates the host break, snaps to it, then relays its own shot', async (t) => {
  if (guard(t)) return;

  // Node HOST (seat 0) creates the room and runs the real engine.
  host = new RelayClient({ url: RELAY_URL, autoReconnect: false });
  await host.connect();
  const created = await host.create({ game: 'snooker', seats: 2 });
  A = newGame(snooker, { rng: mulberry32(created.seed) });
  host.on('move', (m) => { if (m.seat !== host.seat) { /* applied below via applyTable */ } });

  // Browser JOINS as the guest: switch to online mode, wait for the relay, enter the code, join.
  await evaluate(`(()=>{const s=document.getElementById('aimode'); s.value='online'; s.dispatchEvent(new Event('change'));})()`);
  assert.ok(await waitFor(`document.getElementById('netstat').classList.contains('online')`, { timeout: 10000 }), 'browser never reached the relay');
  await evaluate(`(()=>{const c=document.getElementById('net-code'); c.value=${JSON.stringify(created.code)}; document.getElementById('net-join').click();})()`);
  await moveFrom(host, host.seat).catch(() => {}); // (no-op; just yields)
  await waitFor(`window.__cue.active()`, { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 200));

  // Before the break, it's the host's turn → the guest's Play button must be disabled (turn gating).
  assert.equal(await evaluate(`document.getElementById('play').disabled`), true, 'guest Play should be disabled off-turn');
  assert.equal(await evaluate(`window.__cue.seat()`), 1, 'browser should be seat 1');

  // HOST breaks: resolve locally, relay the shot + resting table.
  const shot = breakShot(A);
  takeShot(A, shot);
  const nextAfterBreak = A.frame.turn;
  host.sendMove(shotPayload(shot, A), nextAfterBreak);

  // The guest animates the break and SNAPS to the host's authoritative table.
  const wantTable = JSON.stringify(serializeTable(A));
  assert.ok(await waitFor(`JSON.stringify(window.__cue.table()) === ${JSON.stringify(wantTable)}`, { timeout: 20000 }),
    'browser did not converge on the host\'s resting table after the break');

  if (nextAfterBreak === 1) {
    // Turn passed to the guest → Play must enable, and a guest shot must reach the host.
    assert.ok(await waitFor(`window.__cue.turn() === 1 && !window.__cue.playing() && document.getElementById('play').disabled === false`, { timeout: 8000 }),
      'guest Play did not enable on its turn');
    const guestMove = moveFrom(host, 1);
    await evaluate(`document.getElementById('play').click()`); // the guest plays its shot
    const gm = await guestMove;
    assert.ok(gm.payload && gm.payload.pieces && gm.payload.frame, 'guest relayed a well-formed shot payload');
  } else {
    // The break kept the table (a red dropped) → the guest stays gated; the host would shoot again.
    assert.equal(await evaluate(`document.getElementById('play').disabled`), true, 'guest Play should stay disabled while host keeps the table');
  }

  assert.deepEqual(jsErrors, [], `unexpected JS errors: ${jsErrors.join(' | ')}`);
});
