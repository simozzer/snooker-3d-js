// doublesnooker.test.js — the "Double Snooker" variant: 30 reds, otherwise ordinary snooker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, takeShot } from '../src/game.js';
import { doubleSnooker } from '../src/variants/doublesnooker.js';
import { snooker } from '../src/variants/snooker.js';
import { openingPieces, doubleOpeningPieces } from '../src/rack.js';
import { BALL } from '../src/snooker.js';
import { bounds, spots } from '../src/table.js';

const R = BALL.radius;

test('the double rack is cue + 6 colours + 30 reds, none overlapping', () => {
  const g = newGame(doubleSnooker, { jitter: 0 }); // deterministic raw layout
  const reds = g.pieces.filter((p) => p.color === 'red');
  const colours = g.pieces.filter((p) => p.kind === 'colour');
  assert.equal(g.pieces.length, 37, 'cue + 6 colours + 30 reds');
  assert.equal(reds.length, 30);
  assert.equal(colours.length, 6);
  assert.equal(g.pieces.filter((p) => p.kind === 'cue').length, 1);

  // no two balls interpenetrate (the close-packed rack sits at 2R + GAP apart)
  for (let i = 0; i < g.pieces.length; i++) {
    for (let j = i + 1; j < g.pieces.length; j++) {
      const a = g.pieces[i].pos;
      const b = g.pieces[j].pos;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      assert.ok(d >= 2 * R - 1e-6, `pieces ${g.pieces[i].id}/${g.pieces[j].id} overlap (d=${d})`);
    }
  }
});

test('every double-rack red sits on the table and clear of the black spot', () => {
  const b = bounds();
  const black = spots().black;
  for (const red of doubleOpeningPieces().filter((p) => p.color === 'red')) {
    assert.ok(red.pos.x >= b.minX + R && red.pos.x <= b.maxX - R, `red x out of bounds: ${red.pos.x}`);
    assert.ok(red.pos.y >= b.minY + R && red.pos.y <= b.maxY - R, `red y out of bounds: ${red.pos.y}`);
    const dBlack = Math.hypot(red.pos.x - black.x, red.pos.y - black.y);
    assert.ok(dBlack >= 2 * R, `a red overlaps the black spot (d=${dBlack})`);
  }
});

test('Double Snooker starts a frame with 30 reds; standard snooker is unchanged at 15', () => {
  assert.equal(doubleSnooker.newFrame().reds, 30);
  assert.equal(snooker.newFrame().reds, 15);
  assert.equal(openingPieces().filter((p) => p.color === 'red').length, 15, 'snooker rack still 15 reds');
});

test('aiBreakShots fires for the 30-red break and the redCount guard is per-variant', () => {
  const dbl = newGame(doubleSnooker, { jitter: 0 }); // reds === 30, ball-in-hand
  const std = newGame(snooker, { jitter: 0 }); // reds === 15, ball-in-hand

  assert.ok(doubleSnooker.aiBreakShots(dbl, 'safe').length > 0, 'double break should yield candidates');
  // a snooker (redCount 15) AI must NOT treat a 30-red rack as its opening break
  assert.equal(snooker.aiBreakShots(dbl, 'safe').length, 0, 'snooker guard rejects 30 reds');
  // and the double variant must NOT treat a 15-red rack as ITS opening break
  assert.equal(doubleSnooker.aiBreakShots(std, 'safe').length, 0, 'double guard rejects 15 reds');
});

test('Double Snooker inherits the snooker-family deadly AI features', () => {
  for (const flag of ['playForValue', 'aiPottedAdjust', 'safetyPlay', 'lookahead2', 'aiBreakShots']) {
    assert.ok(doubleSnooker[flag], `${flag} should be present (it IS snooker)`);
  }
});

test('a Double Snooker break plays to rest with no ball escaping the table', () => {
  const g = newGame(doubleSnooker, { jitter: 0 });
  const place = doubleSnooker.defaultPlacement(g);
  const { outcome } = takeShot(g, { angle: 0.05, speed: 5.0, spin: { side: 0, vert: 0 }, cuePlacement: place });
  assert.ok(outcome && outcome.events.length, 'the break should resolve to an outcome');
  const b = bounds();
  for (const p of g.pieces) {
    assert.ok(p.pos.x >= b.minX - 1e-3 && p.pos.x <= b.maxX + 1e-3, `${p.id} escaped in x: ${p.pos.x}`);
    assert.ok(p.pos.y >= b.minY - 1e-3 && p.pos.y <= b.maxY + 1e-3, `${p.id} escaped in y: ${p.pos.y}`);
  }
});
