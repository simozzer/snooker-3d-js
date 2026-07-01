# snooker-js

A 2D snooker game built on the **event-driven analytic engine** from
[carrom-js](https://github.com/simozzer/carrom-js) — no frame-stepping: it solves in closed
form for the exact time of the next event (cushion hit, ball–ball touch, pocket capture),
jumps the world to it, resolves it, and repeats. Pure ES6, zero dependencies.

The new physics here is **faithful cue spin**: balls *roll*, and the cue ball follows,
screws back, and swerves.

## The physics — two-phase rolling motion

Carrom men slide in a straight line under one friction coefficient. Snooker balls don't —
so each ball's free flight is modelled in two phases ([src/motion.js](src/motion.js)):

- **Slide** `[0, tRoll]` — just after a strike or collision the contact patch slips. The
  slip velocity decays linearly in a *fixed direction*, so the cloth friction force is a
  **constant vector** and the ball's centre traces a **parabola** `p₀ + v₀t + ½at²`. This is
  where follow / draw (screw) / swerve come from. Slip dies at `tRoll = (2/7)|u₀|/(μ_slide·g)`,
  leaving the centre at 5/7 of its launch speed for a plain (no-spin) shot.
- **Roll** `[tRoll, tStop]` — rolling without slipping under small rolling resistance, a
  **straight** decelerating line (exactly carrom's single-phase model).

Both phases are degree ≤ 2 per axis, so the engine keeps the **same analytic solvers**: a
ball vs a cushion is a quadratic; a ball vs a ball (`|Δp|² = R²`) or a ball vs a pocket is a
quartic. The only structural change is that detection runs **per trajectory segment** — a
direct generalization of carrom's two-window pair solve.

Follow/draw need no special-casing at impact: the horizontal-axis spin is carried *through*
the collision untouched, so when the engine rebuilds the struck ball's plan from its new
velocity + retained spin, the next slide phase produces the screw/follow on its own.

### Reused from carrom (verbatim)
- [src/vec2.js](src/vec2.js) — vector ops
- [src/roots.js](src/roots.js) — quadratic / quartic root finders

### New / adapted for snooker
- [src/motion.js](src/motion.js) — two-phase trajectory + the `Ball` (full 3-vector spin)
- [src/events.js](src/events.js) — segment-windowed wall / pair / pocket detection
- [src/collisions.js](src/collisions.js) — sphere-inertia impulses, side-spin throw, cushion grip
- [src/engine.js](src/engine.js) — the event loop (per-ball motion plans + `t0`)
- [src/snooker.js](src/snooker.js) — physical constants
- [src/table.js](src/table.js) — table geometry, 6 pockets, spots & the "D"
- [src/rack.js](src/rack.js) — opening layout
- [src/rules.js](src/rules.js) — pure frame-scoring rules (unit-tested without physics)
- [src/game.js](src/game.js) — glue: run a shot → classify → apply rules → re-spot
- [src/ai.js](src/ai.js) — ghost-ball aiming + simulation-scored shot selection
- [web/](web/) — canvas renderer: 360° aiming, power, 2-axis cue-tip spin, replay, sound, AI

## Run it

```sh
npm test          # node --test — physics, geometry, rules, game, AI
npm run serve     # static server; then open http://localhost:8080/web/
```

In the browser: **drag on the table** to aim, set **power**, drag the **spin dot** (up =
follow, down = draw, sideways = side), and **Fire**. Player 2 is the computer by default;
tick *Self-play* to watch it play itself.

## Honest scope boundaries (TODO)

- **Pocket jaws.** Cushions are modelled as full rails and pockets as capture *circles*
  (carrom's approach), with capture radii enlarged so corner pots aren't blocked by the rail.
  Real angled jaws that **rattle** a ball need finite cushion segments + diagonal reflection;
  until then near-misses pot instead of rattling. See [src/table.js](src/table.js).
- **Spin model.** The two-phase (slide/roll) model is the standard billiard approximation; it
  omits ball hop and cushion-nose-height effects. `roots.firstRoot` is the numerical fallback
  if a richer model ever makes a trajectory segment non-polynomial.
- **AI.** A strong potter with basic foul avoidance — no safety/snooker tactics or bank shots yet.
- **Rules.** Free ball, the miss rule, and a respotted-black decider are not modelled.

Built on carrom-js by Simon Moscrop.
