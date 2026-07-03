// variants_meta.test.js — one net across EVERY game variant: each must expose the interface the engine,
// AI, and renderer consume, and each rack must be physically sane (in bounds, non-overlapping, has a
// cue). Catches a whole class of "added/edited a variant and broke the contract" regressions at once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snooker } from '../src/variants/snooker.js';
import { pool } from '../src/variants/pool.js';
import { nineball } from '../src/variants/nineball.js';
import { billiards } from '../src/variants/billiards.js';
import { doubleSnooker } from '../src/variants/doublesnooker.js';

const VARIANTS = [snooker, pool, nineball, billiards, doubleSnooker];

for (const v of VARIANTS) {
  test(`${v.name}: exposes the full variant interface`, () => {
    for (const key of ['id', 'name']) assert.equal(typeof v[key], 'string', `${v.name} missing ${key}`);
    assert.equal(typeof v.ball?.radius, 'number');
    assert.equal(typeof v.ball?.mass, 'number');
    for (const fn of ['bounds', 'pockets', 'rack', 'newFrame', 'applyOutcome', 'defaultPlacement', 'placementLegal', 'aiTargets', 'colorOf', 'label', 'isStripe']) {
      assert.equal(typeof v[fn], 'function', `${v.name}.${fn} should be a function`);
    }
    const b = v.bounds();
    assert.ok(b.minX < b.maxX && b.minY < b.maxY, `${v.name} bounds invalid`);
    assert.ok(v.pockets().length > 0, `${v.name} has no pockets`);
  });

  test(`${v.name}: rack is in bounds, non-overlapping, and includes the cue`, () => {
    const r = v.rack();
    const R = v.ball.radius;
    const b = v.bounds();
    assert.ok(r.length > 0);
    assert.equal(r.filter((p) => p.id === 'cue').length, 1, `${v.name} rack should hold exactly one cue`);
    const ids = new Set(r.map((p) => p.id));
    assert.equal(ids.size, r.length, `${v.name} rack has duplicate ids`);
    for (const p of r) {
      assert.ok(p.pos.x >= b.minX - R && p.pos.x <= b.maxX + R, `${v.name} ${p.id} x out of bounds`);
      assert.ok(p.pos.y >= b.minY - R && p.pos.y <= b.maxY + R, `${v.name} ${p.id} y out of bounds`);
    }
    for (let i = 0; i < r.length; i++) {
      for (let j = i + 1; j < r.length; j++) {
        const d = Math.hypot(r[i].pos.x - r[j].pos.x, r[i].pos.y - r[j].pos.y);
        assert.ok(d >= 2 * R * 0.98, `${v.name}: ${r[i].id} & ${r[j].id} overlap (gap ${d.toFixed(4)} < ${(2 * R).toFixed(4)})`);
      }
    }
  });

  test(`${v.name}: newFrame + defaultPlacement are sane`, () => {
    const frame = v.newFrame();
    assert.equal(frame.turn, 0);
    assert.equal(frame.frameOver, false);
    const state = { variant: v, pieces: v.rack(), frame };
    const dp = v.defaultPlacement(state);
    assert.equal(typeof dp.x, 'number');
    assert.equal(typeof dp.y, 'number');
    assert.equal(v.placementLegal(state, dp.x, dp.y), true, `${v.name} default placement should be legal`);
  });

  test(`${v.name}: appearance helpers run on a rack piece`, () => {
    const piece = v.rack().find((p) => p.id !== 'cue');
    assert.doesNotThrow(() => { v.colorOf(piece); v.label(piece); v.isStripe(piece); });
  });
}

test('every variant has a distinct id', () => {
  const ids = VARIANTS.map((v) => v.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate variant ids: ${ids}`);
});
