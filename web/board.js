import { VERSION } from './version.js';
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
//   }
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

  const ctx = {
    canvas, box,
    gameControls: el('gamecontrols'),
    ui,
    getMode: () => el('mode').value,
    getDifficulty: () => el('difficulty').value,
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
      el('mode').addEventListener('change', () => {
        el('row-difficulty').style.display = el('mode').value === 'ai' ? '' : 'none';
        controller.setMode(el('mode').value);
      });
      el('difficulty').addEventListener('change', () => controller.setDifficulty(el('difficulty').value));

      let rt;
      window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => controller.resize(), 120); });

      if (!resumed) controller.newGame();
    })
    .catch((err) => {
      console.error(err);
      showError(`Couldn’t load ${entry.title}. <br><br><a href="../index.html">← Back to all games</a>`);
    });
}
