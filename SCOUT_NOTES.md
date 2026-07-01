# SCOUT_NOTES.md — architecture of snooker-js (as found)

Repo cloned: **simozzer/snooker-js** (`snooker-sim` v0.10c). Pure ES6/ESM, no deps.
Test runner: `node --test` (`npm test`). 76 tests pass on a clean checkout.

## Module system
ESM throughout (`"type": "module"`, `import`/`export`). Vectors are plain
immutable `{x, y}` objects manipulated by pure functions in `src/vec2.js`
(`add/sub/scale/dot/len2/len/normalize/fromAngle/perp`). No classes for vectors.

## Units
SI — metres, kg, seconds. Table 3.569 × 1.778 m, ball radius R = 0.02625 m,
mass 0.142 kg, GRAVITY = 9.81 (already exported from `snooker.js`, used only as
`μ·g` cloth deceleration today — no airborne phase existed). So z-gravity
`g = (0,0,-9.81)` is already unit-consistent.

## Trajectory representation (`src/motion.js`) — THE KEY INTERFACE
A ball's motion is a closed-form **two-phase plan** built by `twoPhasePlan(pos, vel, spin, R)`:
- **SLIDE** `[0, tRoll]`: centre follows a parabola `p0 + v0·t + ½·aSlide·t²`
  (constant friction accel opposite the slip). Curve = follow/draw/swerve.
- **ROLL** `[tRoll, tStop]`: straight decelerating line under rolling resistance.

The plan is sampled by `posAt/velAt/spinAt(plan, t)` and — critically — flattened
to **polynomial segments** by `segments(plan, t0)`: a list of
`{ lo, hi, P, V, C }` in ABSOLUTE time where `position(t) = P + V·t + C·t²`
(C = HALF the acceleration). Every event detector consumes ONLY these segments.
`segmentsToHorizon` pads with a trailing rest segment for pair search.

`Ball` (class) carries `pos {x,y}`, `vel {x,y}`, `spin {x,y,z}` (spin is ALREADY a
3-vector: x,y = horizontal-axis roll spin, z = vertical "side"/English), `plan`,
and `t0` (absolute time the plan was built). `replan()` rebuilds the plan.

## Event detection (`src/events.js`) — per-segment closed-form
Each detector loops the segments and solves a polynomial per segment window; every
detector finds the first DOWNWARD crossing of its gap (approaching only, so a resting/
separating contact isn't re-detected):
- **wall**: per-axis quadratic gap → `firstApproachQuad` (local helper).
- **pair (ball-ball)**: `|Δp(t)|² − R²` ⇒ quartic → `firstApproachInWindow`.
- **pocket**: quartic vs a fixed circle → `contactInWindow → firstQuarticRoot`.
All times ABSOLUTE; `tNow` is the lower bound.

## Roots (`src/roots.js`)
`cubicRoots` (Cardano), `firstQuarticRoot` (critical-point-bracketed bisection),
`smallestPositiveQuadratic` (exact smaller positive root — used by the NEW bed
detector; already exported, roots.js UNCHANGED), and the earmarked
`firstRoot` "generic sampled fallback for a future NON-polynomial trajectory model"
(unused; reserved for Milestone C jaw/corner tori).

## Impulse resolution (`src/collisions.js`)
- `resolvePair(a, b, e, muT)`: normal impulse along contact normal with restitution;
  tangential Coulomb-clamped friction exchanging ω_z ↔ tangential velocity. Uses
  scalar sphere inertia `I = INERTIA_FACTOR·m·R²` (2/5). **Only ω_z participates**
  (contact plane is the table); ω_x/ω_y (follow/draw) pass through untouched.
- `resolveWall(ball, axis, e, restThreshold, muT)`: axis-aligned reflection + grip.

Spin is a scalar-per-axis 3-vector but the CONTACT math is effectively 2D today
(normal always in the table plane, only ω_z matters).

## Engine (`src/engine.js`)
Event-driven loop: build all events, pop earliest, `advance` every ball by
evaluating its plan at `t−t0`, resolve the event, `replan` + reset `t0` on the 1–2
affected balls, `recompute` their events. `strike()` maps (angle, speed, spin{side,vert})
→ launch vel + spin. Emits a timeline of snapshots.

## Where 3D plugs in (Milestone A)
- Position/velocity are 2D `{x,y}`; I add a `z` track. On-table phases pin z=R, vz=0
  (existing 2D detectors read only `.x/.y`, so an extra `.z` on the objects is inert).
- The plan gains a **FLIGHT** phase (`p=P+V·t+½g·t²`, spin frozen) and a phase enum.
- `segments()` gains z coefficients so the **bed (z=R) quadratic** detector can run
  off the same segment list.
- A **generic 3D contact resolver** (isotropic sphere, n=(0,0,1) for the floor)
  handles the bounce; the floor friction impulse converts spin↔velocity (backspin
  checks) out of the same code path.
