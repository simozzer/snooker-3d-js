// tools/verify.mjs — server-side frame verification. `node tools/verify.mjs <token>` decodes,
// re-simulates the frame deterministically, and prints the verified summary (winner, scores, highest
// break) — exactly what a leaderboard backend runs to confirm a claimed score WITHOUT trusting the
// sender. A cheated token can't survive re-simulation: the physics it implies won't reproduce.
//
//   node tools/verify.mjs <frame-token>
//   node tools/verify.mjs "$(pbpaste)"            # verify a link you copied

import { verifyFrame } from '../src/share.js';

let token = process.argv[2] || '';
const m = token.match(/[?&]frame=([^&]+)/); // accept a full ?frame= URL too
if (m) token = m[1];

if (!token) {
  console.error('usage: node tools/verify.mjs <frame-token | ?frame=URL>');
  process.exit(2);
}

try {
  const r = verifyFrame(token);
  console.log(JSON.stringify(r, null, 2));
  console.log(`\n✓ verified: ${r.variant} · ${r.shots} shot(s) · highest break ${r.highBreak} ${r.unit}` +
    (r.winner != null ? ` · winner P${r.winner + 1}` : ' · frame unfinished'));
} catch (e) {
  console.error('✗ INVALID token —', e.message);
  process.exit(1);
}
