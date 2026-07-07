// carrom.test.js — Carrom rules: colour claim, own/opponent pots, fouls, the Queen cover, and the win.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carrom } from '../src/variants/carrom.js';

const W = { color: 'white' }, B = { color: 'black' }, Q = { color: 'queen' };
const openFrame = () => { const f = carrom.newFrame(); f.ballInHand = false; return f; };
const assigned = () => { const f = openFrame(); f.open = false; f.assigned = ['white', 'black']; return f; };

test('open board: potting a white man claims white for the striker and continues', () => {
  const f = openFrame();
  const r = carrom.applyOutcome(f, { firstContact: W, potted: [W] });
  assert.equal(f.open, false);
  assert.deepEqual(f.assigned, ['white', 'black']);
  assert.equal(r.continues, true);
  assert.equal(f.turn, 0);
  assert.equal(f.remaining.white, 8);
  assert.equal(f.scores[0], 1);
});

test('own man continues; the opponent’s man passes the turn and credits them', () => {
  const f = assigned();
  let r = carrom.applyOutcome(f, { firstContact: W, potted: [W] });
  assert.equal(r.continues, true);
  assert.equal(f.turn, 0);
  r = carrom.applyOutcome(f, { firstContact: B, potted: [B] });
  assert.equal(r.continues, false, 'potting only the opponent’s man ends the turn');
  assert.equal(f.turn, 1);
  assert.equal(f.scores[1], 1, 'their man counts for them');
});

test('foul: striker pocketed → turn passes and the potted man returns', () => {
  const f = assigned();
  const r = carrom.applyOutcome(f, { firstContact: W, potted: [W], cuePotted: true });
  assert.equal(r.foul, true);
  assert.equal(f.turn, 1);
  assert.deepEqual(r.respot, ['white']);
  assert.equal(f.remaining.white, 9, 'the returned man is not deducted');
});

test('foul: striking no piece passes the turn', () => {
  const f = assigned();
  const r = carrom.applyOutcome(f, { firstContact: null, potted: [] });
  assert.equal(r.foul, true);
  assert.equal(f.turn, 1);
});

test('Queen potted and covered in the same stroke scores +3', () => {
  const f = assigned();
  const r = carrom.applyOutcome(f, { firstContact: W, potted: [Q, W] });
  assert.equal(f.queenAwarded, 0);
  assert.equal(f.scores[0], 1 + 3);
  assert.equal(r.continues, true);
});

test('Queen potted alone is pending, then covered on a later stroke', () => {
  const f = assigned();
  let r = carrom.applyOutcome(f, { firstContact: Q, potted: [Q] });
  assert.equal(f.queenPending, true);
  assert.equal(f.queenOwner, 0);
  assert.equal(r.continues, true, 'you keep striking to try to cover');
  r = carrom.applyOutcome(f, { firstContact: W, potted: [W] });
  assert.equal(f.queenPending, false);
  assert.equal(f.queenAwarded, 0);
  assert.equal(f.scores[0], 1 + 3);
});

test('Queen not covered by the end of the break goes back to the centre', () => {
  const f = assigned();
  carrom.applyOutcome(f, { firstContact: Q, potted: [Q] }); // pending
  const r = carrom.applyOutcome(f, { firstContact: W, potted: [] }); // struck a man but potted nothing
  assert.equal(r.continues, false);
  assert.equal(f.turn, 1);
  assert.equal(f.queenPending, false);
  assert.deepEqual(r.respot, ['queen']);
});

test('the Queen cannot be claimed while the board is open — it returns', () => {
  const f = openFrame();
  const r = carrom.applyOutcome(f, { firstContact: Q, potted: [Q] });
  assert.ok(r.respot.includes('queen'));
  assert.equal(f.open, true);
});

test('clearing all your men wins the frame', () => {
  const f = assigned();
  f.remaining.white = 1;
  const r = carrom.applyOutcome(f, { firstContact: W, potted: [W] });
  assert.equal(f.remaining.white, 0);
  assert.equal(f.frameOver, true);
  assert.equal(f.winner, 0);
  assert.ok(/wins/.test(r.message));
});
