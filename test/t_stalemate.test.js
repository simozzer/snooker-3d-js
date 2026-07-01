// t_stalemate.test.js — a fully-deterministic AI can livelock: an identical shot from a position that
// keeps returning to itself, forever (reported with Deadly + a yellow frozen on the cushion). The
// stalemate guard must END the frame instead of looping. Here we force the livelock directly: restore
// the same layout each turn and play the same shot, so the reconciled position is identical every time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takeShot } from '../src/game.js';
import { snooker } from '../src/variants/snooker.js';

test('a repeating scoreless position ends the frame as a stalemate, not an infinite loop', () => {
  const layout = () => [
    { id: 'cue', color: 'white', group: 'cue', kind: 'cue', pos: { x: -0.4, y: 0 } },
    { id: 'yellow', color: 'yellow', group: 'colour', kind: 'colour', pos: { x: 0.4, y: 0 } },
  ];
  const state = { variant: snooker, frame: snooker.newFrame(), pieces: layout() };
  state.frame.reds = 0; // colours phase → yellow is the ball-on
  state.frame.ballInHand = false;

  const shot = { angle: 0, speed: 1.2, spin: { side: 0, vert: 0 } }; // cue → yellow along +x; nothing pots
  let turns = 0;
  const CAP = 40;
  while (!state.frame.frameOver && turns < CAP) {
    state.pieces = layout(); // the livelock: the position returns to itself each turn
    takeShot(state, shot);
    turns += 1;
  }

  assert.ok(state.frame.frameOver, `frame must terminate; ran ${turns} turns without ending`);
  assert.ok(turns < CAP, `must end well before the cap (took ${turns})`);
  assert.match(state.frame.message, /stalemate/i);
});

test('genuinely different positions each turn are never flagged as a stalemate', () => {
  const state = { variant: snooker, frame: snooker.newFrame(), pieces: [] };
  state.frame.reds = 0;
  state.frame.ballInHand = false;
  // shift the layout by a fresh amount every turn so no signature ever recurs
  for (let i = 0; i < 12; i++) {
    const dx = i * 0.05;
    state.pieces = [
      { id: 'cue', color: 'white', group: 'cue', kind: 'cue', pos: { x: -0.4 + dx, y: -0.3 } },
      { id: 'yellow', color: 'yellow', group: 'colour', kind: 'colour', pos: { x: 0.2 + dx, y: 0.3 } },
    ];
    takeShot(state, { angle: 0.4, speed: 1.0, spin: { side: 0, vert: 0 } });
    assert.ok(!(state.frame.frameOver && /stalemate/i.test(state.frame.message ?? '')), `false stalemate at turn ${i}`);
  }
});
