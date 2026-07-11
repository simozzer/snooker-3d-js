import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Stats } from '../server/stats.js';

test('recordGame increments games, and wins only when won', () => {
  const saved = [];
  const s = new Stats({ persist: (snap) => saved.push(snap) });
  assert.deepEqual(s.get('u1'), { games: 0, wins: 0, name: null });

  assert.deepEqual(s.recordGame('u1', 'Ada', true), { games: 1, wins: 1 });
  assert.deepEqual(s.recordGame('u1', 'Ada', false), { games: 2, wins: 1 });
  assert.equal(s.get('u1').games, 2);
  assert.equal(s.get('u1').wins, 1);
  assert.equal(s.get('u1').name, 'Ada');
  assert.equal(saved.length, 2, 'persist called on each record');
});

test('anonymous players (no sub) are never recorded', () => {
  let persisted = 0;
  const s = new Stats({ persist: () => { persisted++; } });
  assert.deepEqual(s.recordGame(null, 'Anon', true), { games: 0, wins: 0 });
  assert.deepEqual(s.recordGame(undefined, 'Anon', true), { games: 0, wins: 0 });
  assert.equal(persisted, 0);
});

test('snapshot round-trips through initial (persistence)', () => {
  const a = new Stats();
  a.recordGame('u1', 'Ada', true);
  a.recordGame('u2', 'Bob', false);
  const b = new Stats({ initial: a.snapshot() });
  assert.equal(b.get('u1').games, 1);
  assert.equal(b.get('u1').wins, 1);
  assert.equal(b.get('u2').games, 1);
  assert.equal(b.get('u2').wins, 0);
});

test('leaderboard ranks by wins then games, skipping zero-game players', () => {
  const s = new Stats();
  s.recordGame('u1', 'Ada', true); s.recordGame('u1', 'Ada', true);   // 2g 2w
  s.recordGame('u2', 'Bob', true); s.recordGame('u2', 'Bob', false);  // 2g 1w
  s.recordGame('u3', 'Cy', false); s.recordGame('u3', 'Cy', false); s.recordGame('u3', 'Cy', false); // 3g 0w
  const top = s.top(10);
  assert.deepEqual(top.map((r) => r.name), ['Ada', 'Bob', 'Cy']);
  assert.equal(top[0].wins, 2);
});
