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

test('per-game breakdown: recordGame(game) feeds topByGame without disturbing overall totals', () => {
  const s = new Stats();
  s.recordGame('u1', 'Ada', true, 'chess');    // chess 1g 1w
  s.recordGame('u1', 'Ada', false, 'othello'); // othello 1g 0w
  s.recordGame('u2', 'Bob', true, 'chess');    // chess 1g 1w
  s.recordGame('u2', 'Bob', true, 'chess');    // chess 2g 2w

  // Overall totals still aggregate across every game type.
  assert.equal(s.get('u1').games, 2);
  assert.equal(s.get('u2').wins, 2);

  const chess = s.topByGame('chess', 10);
  assert.deepEqual(chess.map((r) => r.name), ['Bob', 'Ada']); // Bob 2w outranks Ada 1w
  assert.deepEqual(chess.find((r) => r.name === 'Ada'), { name: 'Ada', games: 1, wins: 1 });

  const othello = s.topByGame('othello', 10);
  assert.deepEqual(othello, [{ name: 'Ada', games: 1, wins: 0 }]); // Bob never played othello
  assert.deepEqual(s.topByGame('backgammon', 10), []); // unseen game → empty
});

test('board() returns overall + per-game map + registered player count', () => {
  const s = new Stats();
  s.recordGame('u1', 'Ada', true, 'chess');
  s.recordGame('u2', 'Bob', false, 'othello');
  const b = s.board(10);
  assert.equal(b.players, 2);
  assert.deepEqual(Object.keys(b.byGame).sort(), ['chess', 'othello']);
  assert.equal(b.overall.length, 2);
  assert.equal(b.byGame.chess[0].name, 'Ada');
});

test('game param is optional — a null game records overall only, byGame absent', () => {
  const s = new Stats();
  s.recordGame('u1', 'Ada', true);       // no game
  assert.equal(s.get('u1').games, 1);
  assert.deepEqual(s.board(10).byGame, {}); // nothing per-game
});

test('legacy snapshots without byGame upgrade lazily on next recordGame', () => {
  const legacy = { u1: { games: 3, wins: 2, name: 'Ada' } }; // pre-byGame record
  const s = new Stats({ initial: legacy });
  assert.equal(s.topByGame('chess', 10).length, 0); // no per-game history yet
  s.recordGame('u1', 'Ada', true, 'chess');
  assert.deepEqual(s.topByGame('chess', 10), [{ name: 'Ada', games: 1, wins: 1 }]);
  assert.equal(s.get('u1').games, 4); // overall still accumulates on top of the legacy total
});
