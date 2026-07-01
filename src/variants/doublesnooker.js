// variants/doublesnooker.js — "Double Snooker": ordinary snooker with TWICE the reds (30). It is
// snooker in every other respect (table, colours, rules, scoring, AI), so it spreads the snooker
// variant and overrides only what the bigger rack changes:
//   • rack       → the 30-red pack (rack.doubleOpeningPieces)
//   • newFrame   → a frame that starts with 30 reds
//   • redCount   → 30, which snooker.aiBreakShots reads via `this` to gate the opening break
//
// Spreading snooker keeps every deadly-AI feature (play-for-value, single-red break-building,
// safety, 2-ply look-ahead) — they are correct for a longer frame too; the maximum break just rises
// (30·8 + 27 = a "267"). The snooker-only feature flags ride along, which is intended: this IS
// snooker. (The "snooker-only" gating test checks pool/9-ball/billiards, not the snooker family.)

import { snooker } from './snooker.js';
import { newFrame } from '../rules.js';
import { doubleOpeningPieces } from '../rack.js';

export const doubleSnooker = {
  ...snooker,
  id: 'doublesnooker',
  name: 'Double Snooker',
  redCount: 30,
  rack: doubleOpeningPieces,
  newFrame: () => newFrame(30),
  rulesText: [
    'Double Snooker: the same as snooker but with 30 reds racked behind the pink.',
    ...snooker.rulesText,
  ],
};
