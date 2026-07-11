// net.js — the browser-side client for the multiplayer relay (server/relay.js). Game-agnostic and
// dependency-free: it speaks the same tiny JSON protocol the relay does and exposes a small, typed
// surface the game views build on. It uses the global `WebSocket`, so it runs unchanged in the
// browser and (Node ≥21 has a global WebSocket) in the Node integration tests.
//
// Responsibilities, and NOTHING more:
//   • connect / create / join / resume  — request-response, returned as promises
//   • sendMove(payload, next) / requestRandom()  — fire-and-forget; results arrive as events
//   • on(event, cb)  — subscribe to server-pushed messages (move, random, peer-*, resumed, …)
//   • auto-reconnect + resume  — a dropped socket silently re-opens and replays the move-log
// It knows nothing about draughts, dice, or turns beyond relaying them — the deterministic engines
// on each client do the actual gameplay from the ordered move-log.

const DEFAULT_URL = () => {
  // Override with ?relay=ws://host:port or new RelayClient({ url }).
  if (typeof location === 'undefined') return 'ws://127.0.0.1:8090';
  const q = new URLSearchParams(location.search).get('relay');
  if (q) return q;
  // Behind an HTTPS reverse proxy (e.g. Tailscale Funnel) the relay is same-origin on /relay over
  // 443. On plain HTTP (LAN / local dev) it's a separate service on its own port.
  if (location.protocol === 'https:') return `wss://${location.host}/relay`;
  return `ws://${location.hostname || '127.0.0.1'}:8090`;
};

export class RelayClient {
  constructor({ url = DEFAULT_URL(), autoReconnect = true } = {}) {
    this.url = url;
    this.autoReconnect = autoReconnect;
    this.ws = null;
    this.pid = null;        // our stable identity — preserved across reconnects so we resume our seat
    this.code = null;       // current room code (set on create/join)
    this.seat = -1;         // our seat in the room, or -1
    this.token = null;      // optional OIDC token; re-sent on every (re)connect so identity survives drops
    this.games = 0;         // this player's running totals (from the relay, once authenticated)
    this.wins = 0;
    this._handlers = new Map();
    this._pending = null;   // an in-flight request-response { okTypes, resolve, reject }
    this._closedByUs = false;
    this._backoff = 500;    // reconnect backoff, capped below
  }

  // --- events --------------------------------------------------------------------------------
  on(event, cb) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(cb);
    return () => this._handlers.get(event)?.delete(cb);
  }
  _emit(event, data) { this._handlers.get(event)?.forEach((cb) => { try { cb(data); } catch (e) { console.error(e); } }); }

  // --- connection ----------------------------------------------------------------------------
  // Open the socket and resolve once the relay has handed us a pid ('welcome'). Safe to call once;
  // reconnects are handled internally.
  connect() {
    this._closedByUs = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener('open', () => { this._backoff = 500; });
      ws.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'welcome') {
          // First connect: adopt the server's pid. Reconnect: keep OUR pid and resume the room.
          if (!this.pid) this.pid = m.pid;
          this._emit('welcome', m);
          if (this.token) this._raw({ type: 'auth', token: this.token }); // re-auth on every (re)connect
          if (this.code) this._raw({ type: 'resume', pid: this.pid, code: this.code });
          if (!settled) { settled = true; resolve(m); }
          return;
        }
        this._dispatch(m);
      });
      ws.addEventListener('error', (e) => { if (!settled) { settled = true; reject(e); } this._emit('neterror', e); });
      ws.addEventListener('close', () => {
        this._emit('close');
        if (this._pending) { this._pending.reject(new Error('socket-closed')); this._pending = null; }
        if (this.autoReconnect && !this._closedByUs) this._scheduleReconnect();
      });
    });
  }

  _scheduleReconnect() {
    const delay = this._backoff;
    this._backoff = Math.min(this._backoff * 2, 8000);
    this._emit('reconnecting', { delay });
    setTimeout(() => { if (!this._closedByUs) this.connect().catch(() => {}); }, delay);
  }

  _raw(msg) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }

  // Route a server message: settle a matching in-flight request, then always emit it as an event.
  _dispatch(m) {
    if (this._pending) {
      const p = this._pending;
      if (p.okTypes.includes(m.type)) { this._pending = null; p.resolve(m); }
      else if (m.type === 'error') { this._pending = null; p.reject(new Error(m.error)); }
    }
    // Track our own room identity from the authoritative replies.
    if (m.type === 'created' || m.type === 'joined' || m.type === 'resumed') {
      this.code = m.code; this.seat = m.seat;
    }
    // Track our running totals (relay greets us with them on auth, updates them after each game).
    if (m.type === 'authed' || m.type === 'stats') {
      if (typeof m.games === 'number') this.games = m.games;
      if (typeof m.wins === 'number') this.wins = m.wins;
    }
    this._emit(m.type, m);
  }

  _request(msg, okTypes) {
    return new Promise((resolve, reject) => {
      if (this._pending) { reject(new Error('request-in-flight')); return; }
      this._pending = { okTypes, resolve, reject };
      this._raw(msg);
    });
  }

  // --- identity ------------------------------------------------------------------------------
  // Present an OIDC token; resolves with the verified { name, sub } the relay derived from it. The
  // token is remembered and re-sent automatically after any reconnect.
  authenticate(token) { this.token = token; return this._request({ type: 'auth', token }, ['authed']); }

  // --- room lifecycle ------------------------------------------------------------------------
  create({ game, seats = 2, name = null } = {}) { return this._request({ type: 'create', game, seats, name }, ['created']); }
  join(code, { name = null } = {}) { return this._request({ type: 'join', code, name }, ['joined']); }

  // --- gameplay ------------------------------------------------------------------------------
  // `payload` is opaque game data (a draughts {from,path}, a shot token, …). `next` is the seat the
  // turn passes to; omit to hand off round-robin (fine for 2-player alternating games).
  sendMove(payload, next) { this._raw({ type: 'move', code: this.code, payload, next }); }
  requestRandom() { this._raw({ type: 'random', code: this.code }); }
  // Ask for the top-players leaderboard; the reply arrives as a 'leaderboard' event (fire-and-forget so
  // it never contends with the single in-flight request slot used by create/join/auth).
  requestLeaderboard() { this._raw({ type: 'leaderboard' }); }
  // Community page: the full score board (overall + per-game) and the who's-online list. Both are
  // fire-and-forget; replies arrive as 'scores' and 'online' events. Safe to poll.
  requestScores() { this._raw({ type: 'scores' }); }
  requestOnline() { this._raw({ type: 'online' }); }
  // Report a finished game so the relay tallies stats. `winner` is the winning seat, or null for a draw.
  sendGameOver(winner) { this._raw({ type: 'game-over', code: this.code, winner }); }
  // Ask the relay to start a fresh game in the same room; it broadcasts a 'rematch' with the new seed.
  rematch() { this._raw({ type: 'rematch', code: this.code }); }
  // Ring a signed-in friend BY NAME to join our current room. They receive an 'invited' event; we get
  // an 'invite-sent' with how many of their sockets it reached (0 = they're not online).
  invite(to) { this._raw({ type: 'invite', to, code: this.code }); }
  leave() { this._raw({ type: 'leave', code: this.code }); this.code = null; this.seat = -1; }

  close() { this._closedByUs = true; try { this.ws?.close(); } catch { /* already gone */ } }
}
