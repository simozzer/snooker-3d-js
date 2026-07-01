// simulate.js — public API.
//
//   simulate(layout, shot, opts) -> { balls, pocketed, timeline, settled, events }
//     layout: { balls: Ball[], bounds, pockets }
//     shot:   { ballId, angle, speed, spin:{side,vert} } | null
//     opts:   { maxEvents, timeline:false }
//
// Static table + one cue strike in, predicted resting positions (and a replay timeline) out.

import { runEngine } from './engine.js';

export function simulate(layout, shot, opts) {
  return runEngine(layout, shot, opts);
}
