// ai-worker.js — runs the AI's grid scoring off the main thread so a deadly move doesn't freeze
// the UI. The candidate list is sliced across a pool of these workers; each scores its share and
// returns the scored variants. The MAIN thread merges every slice and runs chooseShotFinish
// (sort + robustness + 2-ply + fallback) so the top-K refinements still see the GLOBAL best — i.e.
// the result is identical to the single-threaded path, just computed in parallel.
//
// The opening break is handled on the main thread (its random style must not fan out to a pool,
// where each worker would pick differently), so workers never see it. chooseShotGrid reads only
// frame + pieces, both structure-cloneable.
import { chooseShotGrid } from '../src/ai.js';
import { snooker } from '../src/variants/snooker.js';
import { doubleSnooker } from '../src/variants/doublesnooker.js';
import { pool } from '../src/variants/pool.js';
import { nineball } from '../src/variants/nineball.js';
import { billiards } from '../src/variants/billiards.js';

const VARIANTS = { snooker, doublesnooker: doubleSnooker, pool, nineball, billiards };

self.onmessage = (e) => {
  const { variantName, frame, pieces, config, reqId } = e.data;
  const variant = VARIANTS[variantName] ?? snooker;
  const scored = chooseShotGrid({ variant, frame, pieces }, config);
  self.postMessage({ scored, reqId });
};
