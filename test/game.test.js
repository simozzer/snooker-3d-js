import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, takeShot } from '../src/game.js';
import { snooker } from '../src/variants/snooker.js';
import { pool } from '../src/variants/pool.js';
import { nineball } from '../src/variants/nineball.js';
import { billiards } from '../src/variants/billiards.js';
import { twoPhasePlan, posAt } from '../src/motion.js';
import { HX, HY } from '../src/table.js';

// A ball must never tunnel through a cushion — not even mid-shot. Spun, high-power shots are the
// danger case: a curved slide can carry a ball back into a cushion it just left. Sample the full
// replayed trajectory of every ball and assert it stays inside the table.
for (const variant of [snooker, pool, nineball, billiards]) {
  test(`${variant.id}: no ball tunnels out of bounds, even mid-shot`, () => {
    const r = variant.ball.radius;
    const b = variant.bounds();
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 0; i < 12; i++) {
      const g = newGame(variant);
      const res = takeShot(g, {
        angle: rnd() * Math.PI * 2,
        speed: 4 + rnd() * 4,
        spin: { side: (rnd() * 2 - 1) * 0.9, vert: (rnd() * 2 - 1) * 0.9 },
        cuePlacement: variant.defaultPlacement(g),
      });
      for (let s = 0; s < res.timeline.length - 1; s++) {
        const seg = res.timeline[s];
        const span = res.timeline[s + 1].t - seg.t;
        for (const e of seg.balls) {
          if (e.pocketed) continue;
          const plan = twoPhasePlan(e.pos, e.vel, e.spin, r);
          for (let k = 0; k <= 8; k++) {
            const p = posAt(plan, (span * k) / 8);
            assert.ok(Math.abs(p.x) <= b.maxX - r + 2e-3 && Math.abs(p.y) <= b.maxY - r + 2e-3, `${variant.id} trial ${i}: ${e.id} escaped to ${p.x.toFixed(3)},${p.y.toFixed(3)}`);
          }
        }
      }
    }
  });
}

// No two balls may ever come to rest overlapping (and none off the table) — exercised by hard
// breaks into a full rack, the worst case for the analytic cluster resolution.
for (const variant of [snooker, pool, nineball, billiards]) {
  test(`${variant.id}: balls never settle overlapping after a break`, () => {
    const r = variant.ball.radius;
    const b = variant.bounds();
    for (let i = 0; i < 25; i++) {
      const g = newGame(variant);
      const y = -0.2 + i * 0.012;
      takeShot(g, { angle: Math.atan2(0.015, 1), speed: 6.8, cuePlacement: { x: variant.id === 'pool' ? -0.56 : -1.0, y } });
      const ps = g.pieces;
      for (let a = 0; a < ps.length; a++) {
        for (let c = a + 1; c < ps.length; c++) {
          const d = Math.hypot(ps[a].pos.x - ps[c].pos.x, ps[a].pos.y - ps[c].pos.y);
          assert.ok(d >= 2 * r - 1e-4, `${variant.id} trial ${i}: ${ps[a].id}/${ps[c].id} overlap (gap ${(d - 2 * r).toFixed(5)})`);
        }
        assert.ok(Math.abs(ps[a].pos.x) <= b.maxX - r + 1e-4 && Math.abs(ps[a].pos.y) <= b.maxY - r + 1e-4, `${variant.id}: ${ps[a].id} off table`);
      }
    }
  });
}

test('a new game racks 22 balls (cue + 15 reds + 6 colours)', () => {
  const g = newGame();
  assert.equal(g.pieces.length, 22);
  assert.equal(g.pieces.filter((p) => p.color === 'red').length, 15);
  assert.equal(g.pieces.filter((p) => p.kind === 'colour').length, 6);
  assert.ok(g.frame.ballInHand, 'cue is in hand to break');
});

test('a break runs to rest and produces an outcome', () => {
  const g = newGame();
  const { outcome, timeline } = takeShot(g, { angle: Math.atan2(0.02, 1), speed: 6.0, cuePlacement: { x: -1.0, y: 0.15 } });
  assert.ok(timeline.length > 1, 'shot produced a timeline');
  assert.ok(typeof outcome.message === 'string' && outcome.message.length > 0);
});

test('a gentle pot of the ball-on red scores, continues, and the cue stays up', () => {
  const g = newGame();
  const R2 = 0.0525;
  const pocket = { x: HX, y: -HY }; // bottom-right corner
  // red sitting in the jaws; cue just behind it on the line to the pocket; a soft tap
  const red = { x: HX - 0.05, y: -HY + 0.05 };
  const dir = { x: pocket.x - red.x, y: pocket.y - red.y };
  const dl = Math.hypot(dir.x, dir.y);
  const cue = { x: red.x - (dir.x / dl) * R2, y: red.y - (dir.y / dl) * R2 };
  const angle = Math.atan2(dir.y, dir.x);

  g.pieces = [
    { id: 'cue', color: 'cue', kind: 'cue', pos: cue },
    { id: 'r0', color: 'red', kind: 'red', pos: red },
  ];
  g.frame.reds = 1;
  g.frame.ballInHand = false;
  const { outcome } = takeShot(g, { angle, speed: 0.8, spin: { vert: 0 } });
  assert.ok(!outcome.foul, `unexpected foul: ${outcome.message}`);
  assert.equal(g.frame.scores[0], 1, `score ${g.frame.scores[0]} — ${outcome.message}`);
  assert.equal(g.frame.reds, 0);
  assert.ok(outcome.continues, 'should stay at the table after a pot');
  assert.ok(!g.pieces.some((p) => p.id === 'r0'), 'red removed from the table');
  assert.ok(g.pieces.some((p) => p.id === 'cue'), 'cue ball still on the table (no in-off)');
});
