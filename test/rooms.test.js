import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rooms } from '../server/rooms.js';

// A deterministic Rooms: fixed room code + a counter-based "random" so every assertion is exact.
// This is the whole point of keeping rooms.js pure — no sockets, no real clock, no real RNG.
function makeRooms() {
  let n = 100;
  let t = 0;
  return new Rooms({
    randomU32: () => ++n,          // 101, 102, 103, … in call order
    genCode: () => 'TEST',
    now: () => (t += 1000),        // advance 1s per touch so TTL logic is testable
    roomTtlMs: 5000,
  });
}

test('create seats the host at 0, first turn is theirs, seed is fixed', () => {
  const r = makeRooms();
  const res = r.create({ pid: 'host', game: 'draughts' });
  assert.equal(res.self.type, 'created');
  assert.equal(res.self.code, 'TEST');
  assert.equal(res.self.seat, 0);
  assert.equal(res.self.turn, 0);
  assert.equal(typeof res.self.seed, 'number');
  assert.deepEqual(r.membersOf('TEST'), ['host']);
});

test('join takes seat 1, gets the full log, and notifies the host', () => {
  const r = makeRooms();
  r.create({ pid: 'host', game: 'draughts' });
  const res = r.join({ pid: 'guest', code: 'TEST', name: 'Bob' });
  assert.equal(res.self.type, 'joined');
  assert.equal(res.self.seat, 1);
  assert.deepEqual(res.self.log, []);
  assert.equal(res.peers.type, 'peer-joined');
  assert.equal(res.peers.seat, 1);
  assert.equal(res.self.players.length, 2);
});

test('join rejects unknown room and a full room', () => {
  const r = makeRooms();
  assert.equal(r.join({ pid: 'x', code: 'NOPE' }).error, 'no-room');
  r.create({ pid: 'host', game: 'draughts', seats: 2 });
  r.join({ pid: 'guest', code: 'TEST' });
  assert.equal(r.join({ pid: 'third', code: 'TEST' }).error, 'full');
});

test('a move by the turn-holder appends to the log and hands off the turn', () => {
  const r = makeRooms();
  r.create({ pid: 'host', game: 'draughts' });
  r.join({ pid: 'guest', code: 'TEST' });

  const res = r.move({ pid: 'host', code: 'TEST', payload: { from: 'a1', to: 'b2' } });
  assert.equal(res.all.type, 'move');
  assert.equal(res.all.seq, 1);
  assert.equal(res.all.seat, 0);
  assert.equal(res.all.turn, 1);                 // handed to seat 1 by default
  assert.deepEqual(res.all.payload, { from: 'a1', to: 'b2' });
  assert.equal(r.get('TEST').log.length, 1);
});

test('a move out of turn is rejected and does not touch the log', () => {
  const r = makeRooms();
  r.create({ pid: 'host', game: 'draughts' });
  r.join({ pid: 'guest', code: 'TEST' });

  const res = r.move({ pid: 'guest', code: 'TEST', payload: {} }); // seat 1, but turn is 0
  assert.equal(res.error, 'not-your-turn');
  assert.equal(r.get('TEST').log.length, 0);
});

test('a mover can keep the turn (multi-jump) via next=self', () => {
  const r = makeRooms();
  r.create({ pid: 'host', game: 'draughts' });
  r.join({ pid: 'guest', code: 'TEST' });

  const res = r.move({ pid: 'host', code: 'TEST', payload: { jump: 1 }, next: 0 });
  assert.equal(res.all.turn, 0);                 // still seat 0
  // ...and the host may move again immediately.
  const res2 = r.move({ pid: 'host', code: 'TEST', payload: { jump: 2 }, next: 1 });
  assert.equal(res2.all.turn, 1);
  assert.equal(r.get('TEST').log.length, 2);
});

test('random is server-authoritative, logged, and broadcast; turn is unchanged', () => {
  const r = makeRooms();
  r.create({ pid: 'host', game: 'backgammon' }); // seed = 101
  r.join({ pid: 'guest', code: 'TEST' });

  const res = r.random({ pid: 'host', code: 'TEST' });
  assert.equal(res.all.type, 'random');
  assert.equal(res.all.seat, 0);
  assert.equal(typeof res.all.value, 'number');
  assert.equal(r.get('TEST').turn, 0);           // rolling does not end the turn
  assert.equal(r.get('TEST').log.at(-1).kind, 'random');
});

test('only the turn-holder may request a random value', () => {
  const r = makeRooms();
  r.create({ pid: 'host', game: 'backgammon' });
  r.join({ pid: 'guest', code: 'TEST' });
  assert.equal(r.random({ pid: 'guest', code: 'TEST' }).error, 'not-your-turn');
});

test('rejoining with the same pid resumes the seat and replays the whole log', () => {
  const r = makeRooms();
  r.create({ pid: 'host', game: 'draughts' });
  r.join({ pid: 'guest', code: 'TEST' });
  r.move({ pid: 'host', code: 'TEST', payload: { n: 1 } });

  r.disconnect('guest');
  assert.equal(r.get('TEST').players.get('guest').connected, false);

  const res = r.resume({ pid: 'guest', code: 'TEST' });
  assert.equal(res.self.type, 'resumed');
  assert.equal(res.self.seat, 1);
  assert.equal(res.self.log.length, 1);          // the move made while away is replayed
  assert.equal(r.get('TEST').players.get('guest').connected, true);
});

test('leave frees the seat; the last player leaving closes the room', () => {
  const r = makeRooms();
  r.create({ pid: 'host', game: 'draughts' });
  r.join({ pid: 'guest', code: 'TEST' });

  const res = r.leave({ pid: 'guest', code: 'TEST' });
  assert.equal(res.peers.type, 'peer-left');
  // The vacated seat 1 can be reclaimed by a newcomer.
  assert.equal(r.join({ pid: 'newcomer', code: 'TEST' }).self.seat, 1);

  r.leave({ pid: 'newcomer', code: 'TEST' });
  const closed = r.leave({ pid: 'host', code: 'TEST' });
  assert.equal(closed.closed, true);
  assert.equal(r.get('TEST'), null);
});

test('sweep reaps rooms idle past the TTL', () => {
  const r = makeRooms();               // ttl 5000ms, clock +1000 per touch
  r.create({ pid: 'host', game: 'draughts' }); // touches move the clock forward
  // Burn clock with no activity on the room by sweeping repeatedly until past TTL.
  let removed = [];
  for (let i = 0; i < 10 && removed.length === 0; i++) removed = r.sweep();
  assert.deepEqual(removed, ['TEST']);
  assert.equal(r.get('TEST'), null);
});
