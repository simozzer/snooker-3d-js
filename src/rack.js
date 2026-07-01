// rack.js — the opening layout: cue ball in the D, a triangle of reds behind the pink, the 6
// colours on their spots. Returns plain piece descriptors {id, color, kind, pos}; game.js turns
// them into physics balls.
//
// Two racks share one builder: standard snooker (15 reds, rows 1..5) and "double snooker" (30 reds,
// rows 1..7 full plus a ragged back row of 2). Both apex just behind the pink and widen toward the
// black; the double pack still clears the black spot (back row ≈ x1.27, black ≈ x1.46).

import { BALL } from './snooker.js';
import { spots, dCentre } from './table.js';

const GAP = 0.0004; // tiny spacing so no two balls start in exact contact (a chaotic break)

// Cue (in the D) + the six colours on their spots — common to every snooker-family rack.
function cueAndColours() {
  const s = spots();
  const d = dCentre();
  const pieces = [{ id: 'cue', color: 'cue', kind: 'cue', pos: { x: d.x, y: 0.15 } }];
  for (const color of ['yellow', 'green', 'brown', 'blue', 'pink', 'black']) {
    pieces.push({ id: color, color, kind: 'colour', pos: { x: s[color].x, y: s[color].y } });
  }
  return pieces;
}

// Append a triangular pack of reds. `rowCounts[k]` balls sit in row k, centred on the spine (y=0),
// the apex just behind the pink and widening toward the black (+x). A full triangle row k holds
// k+1; a SHORTER count (the double pack's ragged back row) is centred within the same spacing.
function addReds(pieces, rowCounts) {
  const r = BALL.radius;
  const s = spots();
  const apexX = s.pink.x + 2 * r + GAP;
  const rowDx = r * Math.sqrt(3) + GAP; // close-packed row spacing
  let id = 0;
  for (let row = 0; row < rowCounts.length; row++) {
    const x = apexX + row * rowDx;
    const count = rowCounts[row];
    for (let i = 0; i < count; i++) {
      const y = (i - (count - 1) / 2) * (2 * r + GAP);
      pieces.push({ id: `r${id}`, color: 'red', kind: 'red', pos: { x, y } });
      id += 1;
    }
  }
  return pieces;
}

// Standard snooker: 15 reds in a 5-row triangle. (rowCounts [1,2,3,4,5] reproduces the original
// row-major positions and ids exactly.)
export function openingPieces() {
  return addReds(cueAndColours(), [1, 2, 3, 4, 5]);
}

// Double snooker: 30 reds — seven full rows (28) plus a ragged back row of 2, widening toward the
// black. The deeper pack still stops ~0.19 m short of the black spot, so no spot needs moving.
export function doubleOpeningPieces() {
  return addReds(cueAndColours(), [1, 2, 3, 4, 5, 6, 7, 2]);
}
