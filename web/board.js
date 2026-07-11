import { VERSION } from './version.js';
import { RelayClient } from './net.js';
import { createAuth } from './auth.js';
import { AUTH } from './auth-config.js';
// board.js — the harness that turns board.html into a switchable board-game shell. It reads the
// ?game= query string, lazily imports the matching view module, and drives it through one small
// contract shared by chess / draughts / backgammon. All the outer chrome (opponent + difficulty
// selects, New game / Undo, the turn + result banners, the rules panel) lives here so every game
// looks and behaves the same; each view only owns its canvas, its input, its engine and its AI.
//
// ---- VIEW CONTRACT ---------------------------------------------------------------------------
// Each web/games/<id>-view.js default-exports a `mount(ctx)` that returns a controller.
//   ctx = {
//     canvas,                       // the #board canvas to render into (view sizes it via fitCanvas)
//     box,                          // the #view element (measure this for available space)
//     gameControls,                 // empty <div> to append game-specific buttons into (e.g. Roll dice)
//     ui: {
//       status(text),               // transient one-liner (whose move failed, hint, etc.)
//       turn(text|null),            // prompt banner ("White to move"); null hides it
//       result(text|null),          // game-over banner; null clears it (also re-enables New game)
//       setUndo(enabled),           // toggle the Undo button
//     },
//     getMode(): 'ai' | 'human',
//     getDifficulty(): 'easy' | 'medium' | 'hard',
//   }
//   controller = {
//     newGame(),                    // start fresh using current mode + difficulty
//     setMode(mode), setDifficulty(level),
//     undo(),                       // undo to the human's previous decision (no-op allowed)
//     resize(),                     // #view resized
//     destroy(),                    // remove listeners / stop animation
//     rulesHtml: string,            // innerHTML for the rules panel
//     getShareToken(): string|null, // OPTIONAL: URL-safe encoding of the current position to share/resume
//     loadShare(token): boolean,    // OPTIONAL: restore from a token; true on success
//     // OPTIONAL online-play contract (see web/net.js + server/). A game that implements onlineStart
//     // gets a "Play online" mode; the harness owns the lobby + relay and calls these:
//     onlineStart({ seat, seed, players, log }), // enter online play at `seat`; reset + replay `log`
//     setOnlineReady(ready: boolean),            // both seats present? gate input + banners
//     applyRemoteMove(payload),                  // a peer's move arrived — apply it (animated)
//     onlineResync(log),                         // reconnect / mid-game join — reset + replay the log
//     applyRemoteRandom(value, seat),            // OPTIONAL: an authoritative random value (dice)
//   }
// The view sends its OWN moves via ctx.net.send(payload, nextSeat); the harness relays them.
//
// Sharing: because the board engines are deterministic snapshots (no physics timeline), a whole game
// state fits in a short ?state= token. The harness owns the button + the URL round-trip; each game
// owns its own compact codec (FEN for chess, packed squares for draughts, points+bar+off for backgammon).
// ---------------------------------------------------------------------------------------------

const el = (id) => document.getElementById(id);
el('version').textContent = `v${VERSION}`; // top-left build stamp (shared across every screen)

// Registry: id → { title, module loader }. Adding a game = one entry + its view module.
const GAMES = {
  chess:      { title: 'Chess',      load: () => import('./games/chess-view.js') },
  draughts:   { title: 'Draughts',   load: () => import('./games/draughts-view.js') },
  backgammon: { title: 'Backgammon', load: () => import('./games/backgammon-view.js') },
  dice:       { title: 'Dice',       load: () => import('./games/dice-view.js') },
};

const params = new URLSearchParams(location.search);
const gameId = (params.get('game') || 'chess').toLowerCase();
const entry = GAMES[gameId];

const canvas = el('board');
const box = el('view');

function showError(msg) {
  canvas.style.display = 'none';
  const e = el('err');
  e.style.display = 'block';
  e.innerHTML = msg;
}

if (!entry) {
  document.title = 'Unknown game';
  el('gametitle').textContent = 'Unknown game';
  showError(`No game called “${gameId}”. <br><br><a href="../index.html">← Back to all games</a>`);
} else {
  document.title = `${entry.title} — games`;
  el('gametitle').textContent = entry.title;

  const ui = {
    status: (t) => { el('status').textContent = t || ''; },
    turn: (t) => { const n = el('turn'); n.textContent = t || ''; n.classList.toggle('show', !!t); },
    result: (t) => {
      const n = el('result');
      n.textContent = t || '';
      n.classList.toggle('show', !!t);
      el('newgame').disabled = false;
    },
    setUndo: (on) => { el('undo').disabled = !on; },
  };

  // Shared online state; `net` is a stable handle the view captures at mount and uses to relay its
  // own moves. The harness fills in the live relay below (create/join), so the view never touches
  // the socket directly.
  const netState = { relay: null, active: false, ready: false, players: null };
  const ctx = {
    canvas, box,
    gameControls: el('gamecontrols'),
    ui,
    getMode: () => el('mode').value,
    getDifficulty: () => el('difficulty').value,
    net: {
      isOnline: () => netState.active,
      isReady: () => netState.ready,
      seat: () => netState.relay?.seat ?? -1,
      send: (payload, next) => netState.relay?.sendMove(payload, next),
      requestRandom: () => netState.relay?.requestRandom(),
    },
  };

  entry.load()
    .then((mod) => {
      const controller = (mod.default || mod.mount)(ctx);
      window.boardController = controller; // exposed for debugging / smoke tests

      el('rules-body').innerHTML = controller.rulesHtml || '';
      el('row-difficulty').style.display = el('mode').value === 'ai' ? '' : 'none';

      el('newgame').addEventListener('click', () => controller.newGame());
      el('undo').addEventListener('click', () => controller.undo());

      // Share the current position as ?game=<id>&state=<token>. Hidden if the game has no codec.
      const shareBtn = el('sharelink');
      if (typeof controller.getShareToken !== 'function') {
        shareBtn.style.display = 'none';
      } else {
        shareBtn.addEventListener('click', async () => {
          const token = controller.getShareToken();
          if (!token) { ui.status('Nothing to share yet.'); return; }
          const url = `${location.origin}${location.pathname}?game=${gameId}&state=${encodeURIComponent(token)}`;
          try {
            await navigator.clipboard.writeText(url);
            ui.status('Share link copied to clipboard.');
          } catch {
            // clipboard blocked (no gesture / permissions) — fall back to a prompt so it's still shareable
            ui.status('Copy this link: ' + url);
            try { window.prompt('Share link', url); } catch { /* headless */ }
          }
        });
      }

      // Resume a shared position if one is in the URL; otherwise start a fresh game.
      const stateToken = params.get('state');
      let resumed = false;
      if (stateToken && typeof controller.loadShare === 'function') {
        try { resumed = controller.loadShare(stateToken); } catch { resumed = false; }
        if (!resumed) ui.status('That share link couldn’t be read — starting a new game.');
      }
      el('difficulty').addEventListener('change', () => controller.setDifficulty(el('difficulty').value));

      // --- online play (lobby + relay orchestration) -----------------------------------------
      // The relay + move-log are game-agnostic; this block owns the lobby UI and routes relay events
      // to the view's optional online contract. Only games that implement onlineStart offer it.
      const onlineOk = typeof controller.onlineStart === 'function';
      const netStatus = (html) => { el('net-status').innerHTML = html; };

      // --- identity (optional OIDC login via Keycloak; see web/auth-config.js) ----------------
      const auth = createAuth(AUTH);
      function updateAuthUI() {
        if (!auth.enabled) { el('authbar').style.display = 'none'; return; }
        el('authbar').style.display = '';
        const user = auth.getUser();
        el('userchip').textContent = user ? `Signed in as ${user.name}` : 'Not signed in';
        el('login').style.display = user ? 'none' : '';
        el('logout').style.display = user ? '' : 'none';
      }
      const loggedIn = () => auth.enabled && !!auth.getUser();
      el('login').addEventListener('click', () => auth.login());   // → Keycloak (choose Google/MS/FB)
      el('logout').addEventListener('click', () => auth.logout());

      // Bottom-left relay reachability light. 'idle' hides it (offline play needs no relay).
      const netStatEl = el('netstat');
      function setNetStat(state, label) {
        if (state === 'idle') { netStatEl.classList.remove('show', 'online', 'connecting', 'offline'); return; }
        netStatEl.classList.remove('online', 'connecting', 'offline');
        netStatEl.classList.add('show', state);
        el('netstat-label').textContent = label;
      }
      const roomLine = () => (netState.relay?.code ? `Room <b>${netState.relay.code}</b>` : 'Room');

      // Names come from the relay's verified identity for logged-in players; anonymous seats fall back
      // to "Player N". A ★ marks you.
      function playerRoster() {
        const mySeat = netState.relay?.seat;
        return (netState.players || []).slice().sort((a, b) => a.seat - b.seat)
          .map((p) => `${p.seat === mySeat ? '★ ' : ''}${p.name || `Player ${p.seat + 1}`}${p.connected ? '' : ' (away)'}`)
          .join(' &nbsp;vs&nbsp; ');
      }
      function setReady(players) {
        if (players) netState.players = players;
        const list = netState.players || [];
        const count = list.length ? list.filter((p) => p.connected).length : 2;
        netState.ready = count >= 2;
        controller.setOnlineReady?.(netState.ready);
        if (!netState.active) return;
        const who = playerRoster();
        netStatus(netState.ready ? `${roomLine()} — playing<br>${who}` : `${roomLine()} — waiting for opponent…${who ? '<br>' + who : ''}`);
      }

      // Online lifecycle is shared, so hide the local-only controls. (Hiding, not disabling: the
      // view's game-over banner re-enables New game via ui.result, which would fight a disabled flag.)
      const shareDefaultDisplay = el('sharelink').style.display;
      function gateOnlineButtons() {
        const on = netState.active;
        el('newgame').style.display = on ? 'none' : '';
        el('sharelink').style.display = on ? 'none' : shareDefaultDisplay;
      }

      function wireRelay(relay) {
        // Reachability light: 'welcome' fires on every (re)connect; close/error/reconnect flip it amber/red.
        relay.on('welcome', () => setNetStat('online', 'Server online'));
        relay.on('reconnecting', () => setNetStat('connecting', 'Reconnecting…'));
        relay.on('neterror', () => setNetStat('offline', 'Server unreachable'));
        relay.on('move', (m) => { if (m.seat !== relay.seat) controller.applyRemoteMove?.(m.payload); }); // ignore own echo
        relay.on('random', (m) => controller.applyRemoteRandom?.(m.value, m.seat));
        relay.on('peer-joined', (m) => setReady(m.players));
        relay.on('peer-reconnected', (m) => setReady(m.players));
        relay.on('peer-left', (m) => { if (m.players) netState.players = m.players; netState.ready = false; controller.setOnlineReady?.(false); netStatus(`${roomLine()} — opponent disconnected, waiting…<br>${playerRoster()}`); });
        relay.on('resumed', (m) => { controller.onlineResync?.(m.log); setReady(m.players); });
        relay.on('room-closed', () => { netStatus('Room closed.'); leaveOnline(); });
        relay.on('reconnecting', () => netStatus(`${roomLine()} — reconnecting…`));
        relay.on('error', (m) => netStatus(`Error: ${m.error || 'unknown'}`));
      }

      async function ensureConnected() {
        if (netState.relay && netState.relay.ws?.readyState === 1) return netState.relay;
        const relay = new RelayClient({});
        netState.relay = relay;
        wireRelay(relay);
        await relay.connect();
        // If logged in, establish VERIFIED identity before any create/join so the relay labels our
        // seat with the real name (and it's re-sent automatically on reconnect).
        if (loggedIn()) { const tok = await auth.getAccessToken(); if (tok) { try { await relay.authenticate(tok); } catch { /* stay anonymous */ } } }
        return relay;
      }
      // Block online actions when the server requires a login the player hasn't done.
      const needsLogin = () => { if (auth.enabled && AUTH.requireLogin && !loggedIn()) { netStatus('Please log in to play online.'); return true; } return false; };

      // Keep a live connection purely for the reachability light — opened on page load and kept open
      // (auto-reconnecting) so the bottom-left dot always reflects whether the relay is reachable,
      // even before/without playing online. Reused as-is when a game is actually created/joined.
      async function probeRelay() {
        if (netState.relay?.ws?.readyState === 1) { setNetStat('online', 'Server online'); return; }
        setNetStat('connecting', 'Connecting…');
        try { await ensureConnected(); setNetStat('online', 'Server online'); }
        catch { setNetStat('offline', 'Server unreachable'); } // client keeps retrying; 'welcome' flips it green
      }

      // Leave the current ROOM but keep the reachability socket (and its light) alive.
      function leaveOnline() {
        if (netState.relay && netState.active) { try { netState.relay.leave(); } catch { /* gone */ } }
        netState.active = false; netState.ready = false; netState.players = null;
        gateOnlineButtons(); // restore the local-only controls
      }

      el('net-create').addEventListener('click', async () => {
        if (needsLogin()) return;
        try {
          netStatus('Connecting…');
          const relay = await ensureConnected();
          const created = await relay.create({ game: gameId, seats: 2 });
          netState.active = true; gateOnlineButtons();
          netState.players = [{ seat: created.seat, name: auth.getUser()?.name ?? null, connected: true }];
          controller.onlineStart({ seat: created.seat, seed: created.seed, players: netState.players, log: [] });
          setReady(netState.players);
        } catch (e) { netStatus(`Couldn’t create room: ${e.message || e}`); }
      });

      el('net-join').addEventListener('click', async () => {
        if (needsLogin()) return;
        const code = el('net-code').value.trim().toUpperCase();
        if (code.length < 4) { netStatus('Enter the 4-letter room code.'); return; }
        try {
          netStatus('Joining…');
          const relay = await ensureConnected();
          const joined = await relay.join(code);
          netState.active = true; gateOnlineButtons();
          controller.onlineStart({ seat: joined.seat, seed: joined.seed, players: joined.players, log: joined.log });
          setReady(joined.players);
        } catch (e) { netStatus(`Couldn’t join: ${e.message || e}`); }
      });

      function applyMode(mode) {
        el('row-difficulty').style.display = mode === 'ai' ? '' : 'none';
        el('lobby').style.display = mode === 'online' ? '' : 'none';
        if (mode === 'online') {
          netStatus(onlineOk ? 'Create a room, or join with a code.' : 'Online isn’t available for this game yet.');
        } else {
          leaveOnline();
          controller.setMode(mode);
        }
      }
      el('mode').addEventListener('change', () => applyMode(el('mode').value));

      let rt;
      window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => controller.resize(), 120); });

      if (!resumed) controller.newGame();

      // Finish any OIDC redirect (turns ?code into tokens), reflect login state, then connect the
      // reachability socket — so it authenticates on the very first connection if we're logged in.
      (async () => {
        updateAuthUI();
        if (auth.enabled) {
          try { await auth.handleRedirect(); } catch { ui.status('Login didn’t complete — please try again.'); }
          updateAuthUI();
        }
        probeRelay(); // always show the reachability light — connect on load, regardless of game/mode
      })();
    })
    .catch((err) => {
      console.error(err);
      showError(`Couldn’t load ${entry.title}. <br><br><a href="../index.html">← Back to all games</a>`);
    });
}
