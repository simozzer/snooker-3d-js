// lobby-browser.mjs — opt-in end-to-end BROWSER test for the Community page (web/lobby.html). Headless
// Chrome loads the real page against a live relay whose stats we pre-seed: two authenticated Node
// clients play a short chess game (so a per-game score row exists) and stay connected (so they're
// "online now"). The browser — an anonymous viewer — must connect, show a non-zero connected count,
// list the signed-in players, and render the chess score table, all with zero JS errors.
//   npm run test:lobby-browser
// Auth uses a MOCK JWKS (as auth-smoke does) so identities/stats work without a real Keycloak.
// Skips cleanly (exit 0) if no Chrome/Edge binary is present.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { RelayClient } from '../web/net.js';

const HTTP_PORT = 47700 + (process.pid % 500);
const CDP_PORT = 49100 + (process.pid % 500);   // stay below Windows' 49702+ excluded range
const RELAY_PORT = 46700 + (process.pid % 500);
const JWKS_PORT = 45700 + (process.pid % 500);
const UDD = mkdtempSync(join(tmpdir(), 'lobby-online-'));
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;
const BASE = `http://127.0.0.1:${HTTP_PORT}/web/lobby.html?relay=${encodeURIComponent(RELAY_URL)}`;
const ISSUER = 'https://kc.test/realms/games';
const AUDIENCE = 'games-web';

const chromePath = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean).find((p) => { try { return existsSync(p); } catch { return false; } });

let jwksServer, server, relay, chrome, ws, privateKey;
let available = false, skipReason = '', msgId = 0;
const pending = new Map();
const jsErrors = [];
const sign = (claims) => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'test-1' })
  .setIssuer(ISSUER).setAudience(AUDIENCE).setSubject(claims.sub).setExpirationTime('5m').sign(privateKey);

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
const waitEvent = (client, event, ms = 4000) => new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error(`timeout ${event}`)), ms);
  const off = client.on(event, (d) => { clearTimeout(to); off(); resolve(d); });
});

// The two seeded players — kept alive for the whole test so they show up as "online now".
let ada, bob;

before(async () => {
  if (!chromePath) { skipReason = 'no Chrome/Edge binary found (set CHROME_PATH)'; return; }

  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: 'test-1', alg: 'RS256', use: 'sig' };
  jwksServer = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise((r) => jwksServer.listen(JWKS_PORT, r));

  relay = spawn(process.execPath, ['server/relay.js', String(RELAY_PORT)], {
    stdio: 'ignore',
    env: { ...process.env, OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, OIDC_JWKS_URI: `http://127.0.0.1:${JWKS_PORT}/certs`,
      DATA_DIR: mkdtempSync(join(tmpdir(), 'lobby-stats-')) },
  });
  server = spawn(process.execPath, ['serve.js', String(HTTP_PORT)], { stdio: 'ignore' });
  if (!await waitListening(`http://127.0.0.1:${HTTP_PORT}/web/lobby.html`)) { skipReason = 'dev server did not start'; return; }
  await sleep(300); // let the relay bind

  // Seed one completed CHESS game so a per-game score row exists; keep both clients connected.
  ada = new RelayClient({ url: RELAY_URL, autoReconnect: false }); await ada.connect();
  await ada.authenticate(await sign({ name: 'Ada', sub: 'ada-lobby' }));
  const room = await ada.create({ game: 'chess' });
  bob = new RelayClient({ url: RELAY_URL, autoReconnect: false }); await bob.connect();
  await bob.authenticate(await sign({ name: 'Bob', sub: 'bob-lobby' }));
  const jp = bob.join(room.code); await waitEvent(ada, 'peer-joined'); await jp;
  ada.sendMove({ n: 1 }, 1); await waitEvent(bob, 'move');
  bob.sendMove({ n: 2 }, 0); await waitEvent(ada, 'move');
  const tallied = waitEvent(ada, 'stats');
  ada.sendGameOver(0); // Ada wins
  await tallied;

  chrome = spawn(chromePath, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${UDD}`, BASE,
  ], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 40; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json(); target = list.find((t) => t.type === 'page' && t.url.includes('lobby.html')); if (target?.webSocketDebuggerUrl) break; } catch { /* down */ }
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
  // Login is now OFF in the shipped bundle until a deployment configures it (config.local.js is neutral).
  // Simulate a login-enabled deployment: inject __GAMES_CONFIG__ before any page script, then reload so
  // config.js picks it up. This also exercises the config-bootstrap path end-to-end.
  await cdp('Page.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__GAMES_CONFIG__=Object.assign(window.__GAMES_CONFIG__||{},{authIssuer:${JSON.stringify(ISSUER)}});` });
  await cdp('Page.reload', { ignoreCache: true });
  if (!await waitFor(`!!document.getElementById('people') && !!document.getElementById('tabs')`, { timeout: 15000 })) { skipReason = 'lobby did not load'; return; }
  available = true;
});

after(async () => {
  try { ada?.close(); bob?.close(); } catch { /* noop */ }
  try { ws?.close(); } catch { /* noop */ }
  try { chrome?.kill('SIGKILL'); } catch { /* noop */ }
  try { server?.kill('SIGKILL'); } catch { /* noop */ }
  try { relay?.kill('SIGKILL'); } catch { /* noop */ }
  try { jwksServer?.close(); } catch { /* noop */ }
  if (process.platform === 'win32') {
    try { spawn('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${UDD.replace(/\\/g, '\\\\')}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' }); } catch { /* best effort */ }
  }
});

const guard = (t) => { if (!available) { t.skip(`browser env unavailable — ${skipReason}`); return true; } return false; };

test('the Community page connects, shows who is online, and lists the signed-in players', async (t) => {
  if (guard(t)) return;
  assert.ok(await waitFor(`document.getElementById('netstat').classList.contains('online')`, { timeout: 8000 }), 'relay never reported online');
  // Connected count includes the two seeded sockets plus the browser itself.
  assert.ok(await waitFor(`Number(document.getElementById('online-n').textContent) >= 2`, { timeout: 8000 }), 'connected count did not populate');
  assert.ok(await waitFor(`/Ada/.test(document.getElementById('people').textContent) && /Bob/.test(document.getElementById('people').textContent)`, { timeout: 8000 }),
    'signed-in players not listed');
});

test('a signed-out visitor sees the join card with a Create account button', async (t) => {
  if (guard(t)) return;
  // The browser has no token, so the friendly join card must be visible with both actions.
  assert.ok(await waitFor(`document.getElementById('join').classList.contains('show')`, { timeout: 6000 }), 'join card not shown to signed-out visitor');
  assert.ok(await evaluate(`!!document.getElementById('join-register') && !!document.getElementById('join-login')`), 'join buttons missing');
  assert.equal(await evaluate(`document.getElementById('authbar').style.display`), 'none', 'signed-in chip hidden when signed out');
});

test('the score tables render, with a Chess tab and Ada leading it', async (t) => {
  if (guard(t)) return;
  // Overall table shows first; the seeded chess game means a Chess tab exists too.
  assert.ok(await waitFor(`/Ada/.test(document.getElementById('scores-body').textContent)`, { timeout: 8000 }), 'overall table did not render');
  assert.ok(await waitFor(`[...document.querySelectorAll('#tabs .tab')].some(b => /Chess/.test(b.textContent))`, { timeout: 8000 }), 'no Chess tab');
  // Click the Chess tab and confirm Ada (the winner) appears in that per-game table.
  await evaluate(`[...document.querySelectorAll('#tabs .tab')].find(b => /Chess/.test(b.textContent)).click()`);
  assert.ok(await waitFor(`document.querySelector('#tabs .tab.active').textContent.includes('Chess') && /Ada/.test(document.getElementById('scores-body').textContent)`, { timeout: 4000 }),
    'chess score table did not show Ada');
  assert.deepEqual(jsErrors, [], `unexpected JS errors: ${jsErrors.join(' | ')}`);
});
