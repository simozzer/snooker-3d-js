// tune.mjs — Milestone D feel-tuning harness (headless, deterministic).
//
//   node tools/tune.mjs
//
// Runs a fixed set of CANONICAL reference shots through the real engine and reports the physical
// outcomes (pot / rattle / clear, post-shot positions, hop apex, cushion speed-retention + rebound
// angle, follow/draw displacement). It reads the isolated constants from snooker.js so the printed
// header always reflects the values being judged. No RNG — every number is reproducible.
//
// This is a SANITY instrument, not an autotuner: it puts each behaviour into a physical range you
// can eyeball. The final "feel" dial is the owner's (they can watch it render).

import * as v3 from '../src/vec3.js';
import * as C from '../src/snooker.js';
import { Ball, twoPhasePlan, velAt } from '../src/motion.js';
import { runEngine } from '../src/engine.js';
import { bounds, pockets, HX, HY } from '../src/table.js';

const R = C.BALL.radius;
const M = C.BALL.mass;
const mk = (id, pos, vel = v3.vec(0, 0, 0), spin = v3.vec(0, 0, 0)) =>
  new Ball({ id, kind: 'cue', radius: R, mass: M, pos, vel, spin });
const layout = (balls) => ({ balls, bounds: bounds(), pockets: pockets() });
const deg = (r) => (r * 180) / Math.PI;
const fmt = (x, n = 3) => (x >= 0 ? ' ' : '') + x.toFixed(n);

// Hop apex above the bed. Snapshots are only at events (the apex is mid-flight), so we take the
// max of the snapshot heights AND the analytic apex from each event's upward vz (½vz²/g), which
// captures the true peak of a rail hop that never coincides with a snapshot.
function maxHop(res, id) {
  let hop = 0;
  for (const s of res.timeline) {
    const b = s.balls.find((x) => x.id === id);
    if (!b) continue;
    hop = Math.max(hop, b.pos.z - R);
    if (b.vel.z > 0) hop = Math.max(hop, (b.vel.z * b.vel.z) / (2 * C.GRAVITY) + (b.pos.z - R));
  }
  return hop;
}
function outcome(res, id) {
  if (res.cleared.includes(id)) return 'CLEAR';
  if (res.pocketed.includes(id)) return 'POT';
  return 'stay';
}
// speed + heading of a ball at the first event of a given kind (for rebound measurement)
function atEvent(res, id, kind) {
  const s = res.timeline.find((sn) => sn.kind === kind);
  if (!s) return null;
  const b = s.balls.find((x) => x.id === id);
  return { speed: Math.hypot(b.vel.x, b.vel.y, b.vel.z), heading: deg(Math.atan2(b.vel.y, b.vel.x)), vz: b.vel.z };
}

const rows = [];
const report = (name, cols) => rows.push([name, cols]);

// 1. STRAIGHT POT — cue dead-on at the top-middle pocket from mid-table. Should POT cleanly.
{
  const cue = mk('cue', v3.vec(0, 0.2, R));
  const res = runEngine(layout([cue]), { ballId: 'cue', angle: Math.PI / 2, speed: 3.0 }, {});
  report('straight pot (middle)', `${outcome(res, 'cue').padEnd(5)} events=${res.events}`);
}

// 2. CUT — cue strikes an object ball at a half-ball angle; object should be thrown toward a pocket.
{
  const cue = mk('cue', v3.vec(-0.4, 0, R));
  const obj = mk('obj', v3.vec(0, R, R)); // offset by R in y → ~30° cut
  const res = runEngine(layout([cue, obj]), { ballId: 'cue', angle: 0, speed: 3.0 }, { contactBall: 'cue' });
  const objEnd = res.balls.find((b) => b.id === 'obj');
  const cueDir = res.timeline.find((s) => s.kind === 'pair');
  const objAt = cueDir && cueDir.balls.find((b) => b.id === 'obj');
  const objHeading = objAt ? deg(Math.atan2(objAt.vel.y, objAt.vel.x)) : NaN;
  report('cut (half-ball)', `obj thrown ${fmt(objHeading, 1)}°  obj end=(${fmt(objEnd.pos.x)},${fmt(objEnd.pos.y)})`);
}

// 3. CUSHION-JAW RATTLE — off-line at the middle pocket: clips a jaw and stays out (rattle).
{
  const cue = mk('cue', v3.vec(0.045, 0.2, R));
  const res = runEngine(layout([cue]), { ballId: 'cue', angle: Math.PI / 2, speed: 2.5 }, { contactBall: 'cue' });
  const jaws = res.timeline.filter((s) => s.kind === 'jaw').length;
  report('jaw rattle (off-line)', `${outcome(res, 'cue').padEnd(5)} jawHits=${jaws}  (want: stay, >=1 jaw)`);
}

// 4. FOLLOW-THROUGH — cue with topspin hits an object dead-centre; cue should roll FORWARD after.
{
  const cue = mk('cue', v3.vec(-0.4, 0, R));
  const obj = mk('obj', v3.vec(0, 0, R));
  const res = runEngine(layout([cue, obj]), { ballId: 'cue', angle: 0, speed: 2.4, spin: { vert: 1 } }, {});
  const cueEnd = res.balls.find((b) => b.id === 'cue');
  report('follow-through (topspin)', `cue ends x=${fmt(cueEnd.pos.x)}  (want > 0: rolled forward past contact)`);
}

// 5. DRAW-BACK (screw) — cue with backspin hits dead-centre; cue should screw BACKWARD.
{
  const cue = mk('cue', v3.vec(-0.4, 0, R));
  const obj = mk('obj', v3.vec(0, 0, R));
  const res = runEngine(layout([cue, obj]), { ballId: 'cue', angle: 0, speed: 2.4, spin: { vert: -1 } }, {});
  const cueEnd = res.balls.find((b) => b.id === 'cue');
  report('draw-back (backspin)', `cue ends x=${fmt(cueEnd.pos.x)}  (want < -0.4: screwed back behind start)`);
}

// 6. BANK / DOUBLE — cue into a cushion at 45°; rebound heading should mirror (angle in ≈ angle
//    out) and retain a healthy fraction of speed. Start the ball a short slide from the cushion and
//    measure the CUSHION-only retention: incoming speed at the rail time (from the pre-bounce plan)
//    vs the post-bounce speed — so the pre-cushion cloth slide isn't blamed on the cushion.
{
  const speed = 3.0;
  const start = v3.vec(0.4, HY - R - 0.06, R);
  const vel = v3.vec(speed * Math.cos(Math.PI / 4), speed * Math.sin(Math.PI / 4), 0);
  const cue = mk('cue', start, vel);
  const res = runEngine(layout([cue]), null, { maxEvents: 1 });
  const railSnap = res.timeline.find((s) => s.kind === 'rail');
  const railT = railSnap ? railSnap.t : NaN;
  const plan = twoPhasePlan(start, vel, v3.vec(0, 0, 0), R); // pre-bounce plan
  const vin = velAt(plan, railT);
  const inSpeed = Math.hypot(vin.x, vin.y, vin.z);
  const inHeading = deg(Math.atan2(vin.y, vin.x));
  const reb = atEvent(res, 'cue', 'rail');
  report('bank/double (45° cushion)', `in=${fmt(inHeading, 1)}°  out=${fmt(reb ? reb.heading : NaN, 1)}°  cushion speed kept=${fmt((reb ? reb.speed : 0) / inSpeed * 100, 0)}%  hop=${fmt(reb ? reb.vz : NaN)} m/s`);
}

// 7. FIRM CUSHION SHOT — hard square into a cushion; must HOP only a few mm, not centimetres.
{
  const speed = 6.0;
  const cue = mk('cue', v3.vec(0.5, 0.2, R), v3.vec(0, speed, 0)); // square into the top rail
  const res = runEngine(layout([cue]), null, {});
  const hopMM = maxHop(res, 'cue') * 1000;
  const reb = atEvent(res, 'cue', 'rail');
  report('firm cushion (6 m/s square)', `hop apex=${fmt(hopMM, 1)} mm  speed kept=${fmt((reb ? reb.speed : 0) / speed * 100, 0)}%  (want hop: single-digit mm)`);
}

// 8. HIGH JUMP — 45° elevation hard: should CLEAR the table (leave play), a few tens of cm apex.
{
  const cue = mk('cue', v3.vec(0.4, 0, R));
  const res = runEngine(layout([cue]), { ballId: 'cue', angle: 0, speed: 6.0, spin: {}, elevation: Math.PI / 4 }, {});
  report('high jump (45° elev)', `${outcome(res, 'cue').padEnd(5)} apex=${fmt(maxHop(res, 'cue') * 100, 1)} cm  (want CLEAR)`);
}

// 9. POT GENEROSITY — sweep the offset at which a straight middle-pocket shot flips pot→rattle.
{
  let lastPot = -1;
  let firstRattle = -1;
  for (let off = 0; off <= 0.06; off += 0.0025) {
    const cue = mk('cue', v3.vec(off, 0.25, R));
    const res = runEngine(layout([cue]), { ballId: 'cue', angle: Math.PI / 2, speed: 2.8 }, {});
    if (res.pocketed.includes('cue')) lastPot = off;
    else if (firstRattle < 0) firstRattle = off;
  }
  report('pot generosity (middle)', `pots up to offset ${fmt(lastPot * 1000, 1)} mm, first miss at ${fmt(firstRattle * 1000, 1)} mm`);
}

// ---- print ----
console.log('=== FEEL-TUNING HARNESS ===  (units: metres, m/s, degrees)  R =', R.toFixed(5), 'm');
console.log('constants:',
  `ball_e=${C.BALL_RESTITUTION} ball_muT=${C.BALL_FRICTION_T}`,
  `| cush_e=${C.CUSHION_RESTITUTION} cush_muT=${C.CUSHION_FRICTION_T} noseDrop=${C.CUSHION_NOSE_DROP}R rise=${C.CUSHION_RISE}R`,
  `| jaw_e=${C.JAW_RESTITUTION} ring=${C.JAW_RING}R tube=${C.JAW_TUBE}R lip=${C.POCKET_LIP_RISE}R`,
  `| bed_e=${C.BED_RESTITUTION} bed_muT=${C.BED_FRICTION_T}`);
console.log('-'.repeat(96));
for (const [name, cols] of rows) console.log('  ' + name.padEnd(28) + cols);
console.log('-'.repeat(96));
