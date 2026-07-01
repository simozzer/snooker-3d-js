// t_jaws.test.js — MILESTONE C2: pocket jaws (rounded rail-end tori, sampled non-polynomial
// contact via roots.firstRoot) + finite cushion height + 3D-honest pocket capture. Deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v3 from '../src/vec3.js';
import { BALL, CUSHION_RISE, POCKET_LIP_RISE } from '../src/snooker.js';
import { Ball } from '../src/motion.js';
import { detectJaw, detectPocket } from '../src/events.js';
import { runEngine } from '../src/engine.js';
import { bounds, pockets, pocketJaws, HX, HY } from '../src/table.js';

const R = BALL.radius;
const M = BALL.mass;
const mk = (id, pos, vel = v3.vec(0, 0, 0), spin = v3.vec(0, 0, 0)) => new Ball({ id, kind: 'cue', radius: R, mass: M, pos, vel, spin });
const layout = (b) => ({ balls: b, bounds: bounds(), pockets: pockets() });
const topZ = R + CUSHION_RISE * R;
const lipZ = R + POCKET_LIP_RISE * R;

// A ball rolled DEAD-ON at a pocket passes between the jaws and drops.
test('a ball rolled dead-centre at the middle pocket drops (passes between the jaws)', () => {
  const b = mk('b', v3.vec(0, 0.3, R), v3.vec(0, 2.5, 0)); // straight at (0, +HY)
  const res = runEngine(layout([b]), null, { contactBall: 'b' });
  assert.ok(res.pocketed.includes('b'), 'a dead-centre pot must drop');
  assert.equal(res.timeline.filter((s) => s.kind === 'jaw').length, 0, 'a clean pot should not clip a jaw');
});

// A ball rolled OFF-LINE at the same pocket clips a jaw and RATTLES OUT — it does not drop, and it
// comes back down the table instead of being swallowed at the mouth.
test('an off-line ball clips a jaw and rattles OUT of the pocket (does not drop)', () => {
  const b = mk('b', v3.vec(0.045, 0.3, R), v3.vec(0, 2.5, 0)); // aimed just off the middle pocket
  const res = runEngine(layout([b]), null, { contactBall: 'b' });
  assert.ok(!res.pocketed.includes('b'), 'an off-line ball must rattle, not drop');
  assert.ok(res.timeline.some((s) => s.kind === 'jaw'), 'it must actually clip a jaw');
  assert.ok(res.balls[0].pos.y < 0, `the rattled ball should be deflected back down-table, y=${res.balls[0].pos.y}`);
  assert.ok(res.settled && !res.hitCap, 'the rattle must settle');
});

// detectJaw finds a real clip for a skimming ball, but NOT for one threading the mouth cleanly.
test('detectJaw: clips a skimming ball, ignores a dead-centre one', () => {
  const jaws = pocketJaws(R, bounds(), pockets());
  const clean = mk('c', v3.vec(0, 0.3, R), v3.vec(0, 2.5, 0));
  const skim = mk('s', v3.vec(0.05, 0.3, R), v3.vec(0, 2.5, 0));
  assert.equal(detectJaw(clean, jaws, 0, topZ), null, 'a dead-centre ball should thread the mouth without a jaw contact');
  assert.ok(detectJaw(skim, jaws, 0, topZ), 'a skimming ball should register a jaw contact');
});

// FINITE CUSHION HEIGHT: a hard jump-shot flies over the cushion and LEAVES PLAY (cleared),
// distinct from a pot — it never tunnels and never settles inside the table.
test('a high jump-shot clears the cushion and leaves play (cleared, not potted, not tunnelled)', () => {
  const cue = mk('cue', v3.vec(0.5, 0, R));
  const res = runEngine(layout([cue]), { ballId: 'cue', angle: 0, speed: 6, spin: {}, elevation: Math.PI / 3 }, {});
  assert.ok(res.cleared.includes('cue'), 'a high leap should clear the table');
  assert.ok(!res.pocketed.includes('cue'), 'clearing the table is NOT a pot');
  assert.ok(res.settled && !res.hitCap, 'the run must terminate');
});

// The previously-ESCAPING Milestone-T shot (36°, 5.5 m/s) now resolves under the finite-height
// rule: it is cleared (or potted), never tunnels past the cushion line.
test('the 36°/5.5 m/s jump shot resolves (cleared) instead of tunnelling out', () => {
  const cue = mk('cue', v3.vec(0, 0, R));
  const res = runEngine(layout([cue]), { ballId: 'cue', angle: 0, speed: 5.5, spin: {}, elevation: Math.PI / 5 }, {});
  // it must end EITHER cleared or potted — but its centre must never cross past the rail line
  const maxAbsX = Math.max(...res.timeline.map((s) => Math.abs(s.balls[0].pos.x)));
  const maxAbsY = Math.max(...res.timeline.map((s) => Math.abs(s.balls[0].pos.y)));
  assert.ok(maxAbsX <= HX - R + 1e-6 && maxAbsY <= HY - R + 1e-6, `tunnelled past the cushion: maxX=${maxAbsX}, maxY=${maxAbsY}`);
  assert.ok(res.cleared.includes('cue') || res.pocketed.includes('cue'), 'must resolve as cleared or potted');
  assert.ok(res.settled && !res.hitCap, 'must terminate');
});

// A ball GRAZING a jaw continues in play (rattle keeps it on the table, doesn't stall or escape).
test('a ball grazing a jaw continues in play (no stall, no escape)', () => {
  const b = mk('b', v3.vec(0.045, 0.3, R), v3.vec(0, 3.0, 0));
  const res = runEngine(layout([b]), null, { contactBall: 'b' });
  assert.ok(res.timeline.some((s) => s.kind === 'jaw'), 'should graze a jaw');
  assert.ok(res.settled && !res.hitCap, 'must settle, not stall');
  const end = res.balls[0];
  if (!end.pocketed) {
    assert.ok(Math.abs(end.pos.x) <= HX - R + 3e-3 && Math.abs(end.pos.y) <= HY - R + 3e-3, `escaped after grazing: (${end.pos.x},${end.pos.y})`);
  }
});

// 3D-HONEST CAPTURE: a ball sailing high over a pocket mouth is NOT captured (it must be below the
// lip to drop) — contrast with a bed-height ball at the same horizontal spot, which IS captured.
test('pocket capture requires the ball to be at/below the lip (a high fly-over is not captured)', () => {
  const p = pockets();
  const highOverMouth = mk('h', v3.vec(0, HY, lipZ + 0.02)); // horizontal centre in the mouth, but high
  const atMouth = mk('l', v3.vec(0, HY, R)); // same spot, on the bed
  assert.equal(detectPocket(highOverMouth, p, 0, lipZ), null, 'a ball above the lip must not be captured');
  assert.ok(detectPocket(atMouth, p, 0, lipZ), 'a bed-height ball in the mouth must be captured');
});

// A full potting shot still works end-to-end through the jawed geometry (corner + middle).
test('a dead-on corner pot and an angled middle pot still drop through the jawed geometry', () => {
  const corner = mk('c', v3.vec(0, 0, R));
  const rc = runEngine(layout([corner]), { ballId: 'c', angle: Math.atan2(-HY, HX), speed: 4.5 }, {});
  assert.ok(rc.pocketed.includes('c'), 'a dead-on corner pot must drop');

  // a middle pot approaching INTO the mouth (its line converges on the centre), not skimming the rail
  const mid = mk('m', v3.vec(-0.3, HY - 0.3, R));
  const rm = runEngine(layout([mid]), { ballId: 'm', angle: Math.PI / 4, speed: 3.0 }, {});
  assert.ok(rm.pocketed.includes('m'), 'an angled middle pot must drop');
});

// A fast ball running ALONG the rail past a middle pocket must NOT be sucked in — it rattles/passes,
// not potted (the capture is speed/line-honest, so only a ball genuinely entering the mouth drops).
test('a fast rail-skimmer past a middle pocket does not drop (it is not sucked in)', () => {
  const runner = mk('m', v3.vec(-0.4, HY - R - 0.001, R)); // hugs the top rail, shallow line past the mouth
  const r = runEngine(layout([runner]), { ballId: 'm', angle: Math.atan2(R + 0.001, 0.4), speed: 3.0 }, {});
  assert.ok(!r.pocketed.includes('m'), 'a fast rail-skimmer must not be swallowed by the middle pocket');
});

// No-escape at the CORNER: a ball that rails/jaws near a corner and ends up running parallel just
// inside a rail into the corner pocket-gap must be caught (rail / jaw / frame backstop), never
// tunnel out. This is the exact corner-runner the adversarial review flagged. Sweep the 4 corners.
test('a corner-gap runner never tunnels out (frame backstop catches what rail/jaw miss)', () => {
  let escapes = 0;
  for (const p of pockets()) {
    const nx = p.center.x, ny = p.center.y;
    const nrm = Math.hypot(nx, ny) || 1;
    const ux = nx / nrm, uy = ny / nrm, px = -uy, py = ux;
    for (let off = -0.06; off <= 0.06 + 1e-9; off += 0.006) {
      for (const spd of [3, 5]) {
        const st = { x: nx - ux * 0.35 + px * off, y: ny - uy * 0.35 + py * off };
        if (Math.abs(st.x) > HX - R || Math.abs(st.y) > HY - R) continue;
        const b = mk('b', v3.vec(st.x, st.y, R), v3.vec(ux * spd, uy * spd, 0));
        const res = runEngine(layout([b]), null, {});
        assert.ok(res.settled && !res.hitCap, `not settled from (${st.x.toFixed(3)},${st.y.toFixed(3)}) spd ${spd}`);
        const e = res.balls[0];
        if (!e.pocketed && (Math.abs(e.pos.x) > HX + 0.005 || Math.abs(e.pos.y) > HY + 0.005)) escapes++;
      }
    }
  }
  assert.equal(escapes, 0, `${escapes} balls tunnelled out near a pocket`);
});

// The sampled jaw solver is deterministic — identical inputs give an identical rattle outcome.
test('jaw rattle is deterministic (sampled solver stable across repeats)', () => {
  const fp = () => {
    const b = mk('b', v3.vec(0.045, 0.3, R), v3.vec(0, 2.5, 0));
    const res = runEngine(layout([b]), null, {});
    return res.timeline.map((s) => `${s.t.toFixed(9)}:${s.kind}`).join('|') + '#' + `${res.balls[0].pos.x.toFixed(12)},${res.balls[0].pos.y.toFixed(12)}`;
  };
  const ref = fp();
  for (let i = 0; i < 8; i++) assert.equal(fp(), ref, `jaw rattle nondeterministic at repeat ${i}`);
});
