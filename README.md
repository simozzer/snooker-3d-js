# Games Compendium

A browser games arcade — **3D cue sports** (snooker, 8-ball, 9-ball, billiards, carrom) and **classic
board games** (chess, draughts, backgammon, Othello, Connect 4, and a push-your-luck dice game) — each
with its own hand-written physics or rules engine, a thinking AI opponent, and **online multiplayer**
over a WebSocket relay. Pure ES6, `three.js` for the 3D tables, **no build step and no framework**.

Everything is self-hosted: the whole thing runs on a home **k3s Raspberry-Pi cluster** and is served to
the public web through a Tailscale Funnel, with OIDC login (Keycloak), a global leaderboard, and
per-game score tables.

> **▶ Play it live:** https://piserver.tail62d127.ts.net/ — free to play offline or against the AI, no
> login required. Online multiplayer and the leaderboard are an optional signed-in tier.

---

## Why it's interesting

- **Real physics, written from scratch — not a library.**
  - The cue-sports games run an **event-driven *analytic* engine**: no fixed-timestep loop — it solves in
    closed form for the exact time of the next event (cushion hit, ball–ball touch, pocket capture),
    jumps the world to it, resolves it, and repeats. Ball motion is a faithful **two-phase slide→roll**
    model, so the cue ball genuinely follows, screws back, and swerves. ([the physics ↓](#the-cue-sports-physics))
  - The dice game runs a **headless 3D rigid-body simulator** (OBB-vs-plane contacts, friction torque,
    seeded and replayable) that tumbles the dice, detects a cocked die, and re-rolls only that one.
- **Online multiplayer, two netting models — chosen deliberately per game.** ([details ↓](#online-multiplayer))
- **Tested like production software**, not a toy: **400+ deterministic unit tests**, plus
  **headless-Chrome browser smokes** and **online lock-step integration smokes** that drive two real
  clients through a real relay. ([details ↓](#testing))
- **Full stack, self-hosted**: `three.js` frontend → WebSocket relay → OIDC auth (Keycloak) → k3s on a
  Raspberry-Pi cluster, public via Tailscale Funnel.

## The games

| Game | Engine | Notes |
|------|--------|-------|
| **Snooker / 8-ball / 9-ball / Billiards** | analytic 2-phase engine + `three.js` 3D table | full-size table, breaks, fouls, referee voice, Trick-Shot puzzles |
| **Carrom** | same analytic engine, carrom geometry | flick the striker, pocket coins & the queen |
| **Dice** (push-your-luck) | headless 3D rigid-body dice sim | keep scorers, bank or bust, "last-licks" final round |
| **Chess** | full legal move gen + minimax AI | |
| **Draughts** (English) | forced captures, kings, multi-jumps | |
| **Backgammon** | dice, hitting blots, bearing off | |
| **Othello / Connect 4** | board engine + minimax AI | |

Every game plays **offline vs a tuned AI** or **hot-seat**, and — where implemented — **online** against
another person.

## Run it locally

Zero build step; the ES-module imports reach straight into `src/`, so it just needs serving.

```sh
npm install
npm run serve       # static server → http://localhost:8123/
npm run relay       # (optional) the multiplayer relay on ws://localhost:8090
```

```sh
npm test            # 400+ unit tests: physics, geometry, rules, engines, AI  (node --test)
npm run test:online # online lock-step smokes for every networked game (spins up real relays)
npm run test:browser        # headless-Chrome smoke of the 3D renderer
npm run test:dice-online-browser  # a real browser guest playing dice online vs a Node host
```

---

## Architecture

The guiding rule across every game is a hard split between a **DOM-free engine** and a **view**:

```
src/…                 pure logic — no DOM, no canvas, no three.js → unit-testable in Node
  game.js, rules.js,  cue-sports: analytic engine, frame rules, AI, shot codec
  engine.js, ai.js…
  board/*.js          one engine per board game (chess.js, dice.js, backgammon.js, …) + dice-physics.js
  share.js            compact URL/token codec for a position (verifiable replay tokens)
web/…                 views — three.js / canvas rendering + input only
  render3d.js         the 3D cue-sports table (imports the engine, never simulates)
  games/*-view.js     one view per board game, all driven through a small shared controller contract
  board.js            the board-game shell: game switcher, lobby, auth, leaderboard
  net.js              the relay client (rooms, moves, authoritative randoms, reconnection)
server/…              Node WebSocket relay: rooms.js (seats/turns/move-log), stats.js (leaderboard),
                      auth.js (verifies Keycloak JWTs so a player's name can't be spoofed)
```

Because the engines are pure, **the same physics that runs in the browser runs in a Node unit test** —
and a whole game position serialises to a short, independently-verifiable token.

### Online multiplayer

The relay is game-agnostic (opaque move-log + shared per-room seed + turn hand-off). The interesting
decision is that **two different games need two different consistency models**, and each uses the right one:

- **Board games → deterministic move-replay.** The engines are pure snapshots, so clients relay *opaque
  moves* against a shared seed and re-run them; a late joiner replays the whole log to the identical
  position. Cheap, and a peer can never inject an illegal state (moves are re-validated).
- **Physics games (cue sports, dice) → authoritative *state transfer*.** Re-running a physics timeline on
  two machines invites floating-point divergence, so instead the **active player is authoritative**: it
  simulates locally and relays the *resulting resting state* (ball positions / dice faces). The opponent
  **animates then snaps** to that state — so cross-client float determinism is never required. A base
  seed rides along purely so the opponent's animation looks like the real throw before it snaps.

Both are covered by lock-step tests that run two real clients through a real relay (see below).

### Deployment

Runs on a k3s Raspberry-Pi cluster: a **systemd** relay (`server/relay.js`) and static server
(`serve.js`), a **Keycloak** realm for OIDC login (public PKCE client), and a **Tailscale Funnel** that
routes `/` → static, `/auth` → Keycloak, `/relay` → the WebSocket relay (WSS). A single `web/version.js`
stamps the build number onto every screen. No CI/CD magic — `scp` the changed files and reload.

### Testing

The test pyramid is the part I'm proudest of, because it's what keeps a project this broad honest:

- **Unit (`node --test`, 400+):** physics (a shot is deterministic and settles in finite events; spin
  produces follow/draw), geometry, each board engine's rules, the AI's expected-value decisions, and the
  share-token round-trips. No DOM — the engines are pure.
- **Online lock-step smokes:** for every networked game, two real `RelayClient`s play through a real
  relay and must stay bit-identical; a mid-game joiner must replay the log to the same position.
- **Headless-Chrome browser smokes:** boot the real pages under headless Chrome over the DevTools
  Protocol and assert the real user flows — a shot resolves, the dice land flat, and (for online) a
  **browser guest** animate-then-snaps a **Node host's** move and then takes its own turn, with **zero
  uncaught JS errors**.

---

## The cue-sports physics

*(the original core of the project — [src/motion.js](src/motion.js), and a fuller writeup in
[RENDERER.md](RENDERER.md))*

Snooker balls don't slide under a single friction coefficient the way carrom men do, so each ball's free
flight is modelled in **two phases**:

- **Slide** `[0, tRoll]` — just after a strike or collision the contact patch slips. The slip velocity
  decays linearly in a *fixed direction*, so cloth friction is a **constant vector** and the ball's centre
  traces a **parabola** `p₀ + v₀t + ½at²`. This is where follow / draw (screw) / swerve come from. Slip
  dies at `tRoll = (2/7)|u₀|/(μ·g)`, leaving the centre at 5/7 of its launch speed for a plain shot.
- **Roll** `[tRoll, tStop]` — rolling without slipping under small rolling resistance: a **straight**
  decelerating line.

Both phases are degree ≤ 2 per axis, so the engine keeps the **same analytic solvers**: ball-vs-cushion
is a quadratic, ball-vs-ball (`|Δp|² = R²`) and ball-vs-pocket are quartics — detection just runs
**per trajectory segment**. Follow/draw need no special-casing at impact: horizontal-axis spin is carried
*through* the collision, so the next slide phase produces the screw on its own.

## Honest scope boundaries

- **Pocket jaws.** Pockets are capture *circles*, not angled jaws — near-misses pot instead of rattling.
- **Cue-sports AI.** A strong potter with basic foul avoidance; no safety/snooker tactics or bank shots.
- **Presentation vs. code.** This README and the live link are the demo front door; the depth is in the
  engines and the test suite.

---

Built by Simon Moscrop. The analytic engine began as a generalisation of
[carrom-js](https://github.com/simozzer/carrom-js); everything above grew from there.
