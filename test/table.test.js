import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from '../src/vec2.js';
import { Ball } from '../src/motion.js';
import { simulate } from '../src/simulate.js';
import { bounds, pockets, spots, inD, HX, HY, baulkX } from '../src/table.js';
import { BALL } from '../src/snooker.js';

const R = BALL.radius;
const ball = (id, pos, vel = v.vec(0, 0)) => new Ball({ id, kind: 'red', pos, vel, radius: R, mass: BALL.mass });
const layout = (balls) => ({ balls, bounds: bounds(), pockets: pockets() });

// A ball rolled into a corner is potted.
test('a ball into a corner pocket is potted', () => {
  const b = ball('b', v.vec(0, 0));
  const angle = Math.atan2(-HY - 0, HX - 0); // toward bottom-right corner
  const r = simulate(layout([b]), { ballId: 'b', angle, speed: 4.5 });
  assert.ok(r.pocketed.includes('b'), `not potted; rest ${b.pos.x},${b.pos.y}`);
});

// A ball rolled along the long rail into a middle pocket is potted.
test('a ball into a middle pocket is potted', () => {
  // approach INTO the mouth (line converges on the centre) — not a shallow rail-skim, which now rattles
  const b = ball('b', v.vec(-0.3, HY - 0.3));
  const r = simulate(layout([b]), { ballId: 'b', angle: Math.PI / 4, speed: 3.0 }); // 45° toward (0, +HY)
  assert.ok(r.pocketed.includes('b'), `not potted; rest ${b.pos.x},${b.pos.y}`);
});

// A ball hitting a rail mid-cushion (far from any pocket) bounces, not pots.
test('a ball into the middle of a rail bounces and stays on the table', () => {
  const b = ball('b', v.vec(HX / 2, 0));
  const r = simulate(layout([b]), { ballId: 'b', angle: Math.PI / 2, speed: 1.2 }); // straight at +y rail, x≈0.89 (far from x=0 middle pocket)
  assert.ok(!r.pocketed.includes('b'), 'should not be potted mid-rail');
  assert.ok(b.pos.y <= HY - R + 1e-6 && b.pos.y >= -HY + R - 1e-6, `escaped: y=${b.pos.y}`);
});

// Spots sit inside the table and the black/pink are on the centre line toward +x.
test('standard spots are sane', () => {
  const s = spots();
  for (const [name, p] of Object.entries(s)) {
    assert.ok(Math.abs(p.x) <= HX - R && Math.abs(p.y) <= HY - R, `${name} off table`);
  }
  assert.ok(s.black.x > s.pink.x && s.pink.x > s.blue.x, 'black > pink > blue along +x');
  assert.ok(s.yellow.y < 0 && s.green.y > 0, 'yellow right, green left');
  assert.ok(Math.abs(s.brown.x - baulkX()) < 1e-9, 'brown on the baulk line');
});

// The "D" contains the baulk spots and excludes points past the baulk line.
test('the D contains the baulk-line spots and rejects forward points', () => {
  const s = spots();
  assert.ok(inD(s.brown.x, s.brown.y), 'brown in D');
  assert.ok(inD(s.yellow.x, s.yellow.y), 'yellow in D');
  assert.ok(inD(s.green.x, s.green.y), 'green in D');
  assert.ok(!inD(s.blue.x, s.blue.y), 'centre spot not in D');
  assert.ok(!inD(baulkX() + 0.1, 0), 'point past the baulk line not in D');
});
