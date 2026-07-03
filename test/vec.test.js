// vec.test.js — the 2D/3D vector primitives everything else is built on. Small, but a broken normalize
// or cross would corrupt aim, ghost-ball geometry, and collision normals silently, so they earn a net.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v2 from '../src/vec2.js';
import * as v3 from '../src/vec3.js';

const close = (a, b, e = 1e-12) => Math.abs(a - b) < e;

test('vec2: add / sub / scale / dot / len', () => {
  assert.deepEqual(v2.add(v2.vec(1, 2), v2.vec(3, 4)), { x: 4, y: 6 });
  assert.deepEqual(v2.sub(v2.vec(3, 4), v2.vec(1, 1)), { x: 2, y: 3 });
  assert.deepEqual(v2.scale(v2.vec(2, -3), 2), { x: 4, y: -6 });
  assert.equal(v2.dot(v2.vec(1, 2), v2.vec(3, 4)), 11);
  assert.ok(close(v2.len(v2.vec(3, 4)), 5));
  assert.equal(v2.len2(v2.vec(3, 4)), 25);
});

test('vec2: normalize returns a unit vector (and is safe on zero)', () => {
  const n = v2.normalize(v2.vec(3, 4));
  assert.ok(close(v2.len(n), 1));
  assert.ok(close(n.x, 0.6) && close(n.y, 0.8));
  const z = v2.normalize(v2.vec(0, 0));
  assert.ok(Number.isFinite(z.x) && Number.isFinite(z.y), 'normalize(0) must not be NaN');
});

test('vec2: perp is a 90° rotation (orthogonal, same length)', () => {
  const a = v2.vec(2, 1);
  const p = v2.perp(a);
  assert.ok(close(v2.dot(a, p), 0), 'perp must be orthogonal');
  assert.ok(close(v2.len(p), v2.len(a)));
});

test('vec2: fromAngle gives the unit direction for an angle', () => {
  assert.ok(close(v2.len(v2.fromAngle(1.234)), 1));
  const e = v2.fromAngle(0);
  assert.ok(close(e.x, 1) && close(e.y, 0));
  const up = v2.fromAngle(Math.PI / 2);
  assert.ok(close(up.x, 0) && close(up.y, 1));
});

test('vec3: add / sub / scale / dot / len', () => {
  assert.deepEqual(v3.add(v3.vec(1, 2, 3), v3.vec(4, 5, 6)), { x: 5, y: 7, z: 9 });
  assert.deepEqual(v3.sub(v3.vec(4, 5, 6), v3.vec(1, 2, 3)), { x: 3, y: 3, z: 3 });
  assert.equal(v3.dot(v3.vec(1, 0, 0), v3.vec(0, 1, 0)), 0);
  assert.ok(close(v3.len(v3.vec(2, 3, 6)), 7));
});

test('vec3: cross product is orthogonal and right-handed', () => {
  const x = v3.vec(1, 0, 0), y = v3.vec(0, 1, 0);
  assert.deepEqual(v3.cross(x, y), { x: 0, y: 0, z: 1 }); // x × y = z
  const c = v3.cross(v3.vec(1, 2, 3), v3.vec(4, 5, 6));
  assert.ok(close(v3.dot(c, v3.vec(1, 2, 3)), 0) && close(v3.dot(c, v3.vec(4, 5, 6)), 0));
});

test('vec3: normalize returns a unit vector', () => {
  const n = v3.normalize(v3.vec(0, 3, 4));
  assert.ok(close(v3.len(n), 1));
});
