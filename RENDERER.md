# 3D replay renderer

A presentation-only 3D view of the analytic engine (Milestone D). The deterministic engine resolves
a shot into its typed event timeline; the renderer only **draws** that timeline by interpolating each
ball along its closed-form plan between events. **No physics lives in the renderer** — it cannot
change an outcome, only display it.

## Run it

The ES-module imports reach `../src/*`, so it must be served (not opened as a `file://`), from the
**project root**:

```
npm run serve          # or: node serve.js [port]   (default 8080)
```

then open **http://localhost:8080/web/render3d.html**

Zero build step. `three.js` loads from a CDN via the page's import map (needs internet the first
time; the browser then caches it). If you're offline, download `three.module.js` +
`examples/jsm/controls/OrbitControls.js` and repoint the import map in `render3d.html`.

The existing 2D game UI is untouched at **http://localhost:8080/web/** (`renderer.js`).

## Controls

- **Opponent** — *You vs AI* (default), *Two players (hot-seat)*, or *Watch AI vs AI* (self-play).
- **AI difficulty** — *Easy / Medium / Hard / Deadly* (see below).
- **Aim** — click anywhere on the table to aim the cue ball at that point; **◀ ▶** or the **← →**
  keys fine-tune by 0.5°; the slider is a coarse control/readout. (Left-drag still orbits the camera —
  a click aims, a drag orbits.) **Power** (m/s) stays a slider.
- **Cue ball** — a spin pad (the cue ball seen tip-on). Drag the **inner disc** to place the contact
  point: left/right = side (english), up/down = follow/draw. Drag the **outer ring** to set cue
  elevation for a jump/massé (bottom = 0°, rising to 60° at the top). Double-click to reset. Replaces
  the old side / follow-draw / elevation sliders.
- **Trajectories** — aim-preview depth: *None* / *To first contact* / *Full path* (**default**).
  Predicts the balls' paths (a non-committing sim) and draws them live as you aim — the cue's line
  solid, other balls dashed. *Full path* runs the shot all the way to rest, so you see the complete
  path (cushions, the pack scattering, everything), not a truncated slice. Shown for your shots and
  briefly for the AI's before it fires. Shares the exact engine the real shot uses, so it matches.
- **Sound** — synthesised collision knocks during replay: a bright click for ball-on-ball, a duller
  knock off the cushions/jaws, a low thud when a jumped ball lands. Volume/brightness scale with
  impact speed. On by default; browsers start audio on your first click/keypress.
- **Play shot** — runs the engine on the current layout + settings and replays the result. The
  resting positions become the next starting layout, so you can play a sequence.
- **Reset table** — restores the demo layout (cue + blue/green/yellow on their spots).
- **Drag** to orbit, **scroll** to zoom.

## Playing against the AI (Milestone E)

Pick **You vs AI**, set a **difficulty**, then set your aim/power/spin and **Play your shot** — the AI
replies automatically on its turn (the status line shows *You to play* / *AI to play*). The AI **only
decides**; the same deterministic engine + renderer play its shot, so it can't do anything you
couldn't. Its search runs **off the main thread** in a Web Worker pool, so the table keeps drawing
while it "thinks" (a synchronous fallback runs if workers are unavailable).

- **How it chooses:** it enumerates candidate lines (aim × power × spin), simulates each through the
  3D engine, and scores the outcome — pot the ball-on first, then position for the next ball, then a
  legal safety when nothing pots; fouls are penalised. It always returns a legal, executable shot.
- **Difficulty** = search breadth + a shaky-hand execution-noise model: *Hard* weighs more candidate
  shots **and** executes them more accurately; *Easy* searches narrower and misses by more. All tiers
  aim at the right thing — a weaker AI just executes worse. Skill is monotonic (Hard pots the same
  makeable set at a measurably higher rate than Easy — asserted in `test/t_ai_opponent.test.js`), and
  a given `(state, seed, difficulty)` is fully deterministic.
- **Deadly** is the tournament tier: a **perfect hand** (zero execution noise) searching the widest,
  densest grid, and committing to the theoretically-best line rather than the most forgiving one. It
  thinks longer than Hard (a bigger search), which the Web Worker pool keeps off the render thread.
- The AI never elevates the cue (no jump/massé) — that's a human-only trick shot.

## What to look for (final visual QA is yours)

- **Bed & geometry:** green bed, brown finite-height cushions split by the six pocket mouths, and a
  small torus "jaw" curling at each mouth edge.
- **Rolling spin:** each ball carries a white surface spot — it should visibly turn as the ball
  rolls, and follow/draw/side should read in how it spins.
- **Jumps read in z:** a cue-elevation shot should visibly leave the bed (rise in height), arc, and
  land — multi-bounce on a firm jump.
- **Pot vs rattle:** a well-aligned pot drops into a pocket (the ball sinks below the bed); an
  off-line ball should clip a jaw and rattle back out onto the table.
- **Clear:** a ball jumped hard enough to clear the cushion **leaves play** (freezes where it left
  the table) and the status line says `cleared`. Distinct from a pot.
- **Status line:** reports the event count, settle time, and any potted/cleared balls.

## What is verified vs what needs a human

- **Verified headlessly:** the page loads with no renderer/module console errors (only a benign
  `favicon.ico` 404 + GPU-driver perf notes under software rendering); the scene graph builds; Play
  drives a real engine shot; a jump shot resolves to `cleared`. And the **replay reproduces the
  engine's reported position + spin at every event to 1e-9** (`test/t_render_parity.test.js`) — so
  the drawing cannot drift from the physics.
- **Needs you (the owner):** the actual *look and feel* — colours, camera, lighting, ball-spin
  legibility, how satisfying the pot-drop / jump / rattle animations read. Those are taste calls a
  headless check can't make.
