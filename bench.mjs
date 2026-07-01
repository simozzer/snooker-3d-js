import { performance } from 'node:perf_hooks';
import { newGame, takeShot, buildBalls } from './src/game.js';
import { simulate } from './src/simulate.js';
import { snooker } from './src/variants/snooker.js';
import { aiTurn } from './src/ai.js';

function rng(seed){return()=>{seed|=0;seed=(seed+0x6d2b79f5)|0;let t=Math.imul(seed^(seed>>>15),1|seed);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
const time = (label, fn, n) => {
  for(let i=0;i<3;i++) fn();
  const t0 = performance.now();
  for (let i=0;i<n;i++) fn();
  const ms = (performance.now()-t0)/n;
  console.log(`${label.padEnd(40)} ${ms.toFixed(3)} ms/call  (${n}x)`);
  return ms;
};

{
  const g = newGame(snooker, { jitter: 0, rng: rng(1) });
  time('simulate: full break to rest', () => {
    simulate({ balls: buildBalls(g.pieces, snooker.ball), bounds: snooker.bounds(), pockets: snooker.pockets() },
             { ballId:'cue', angle: 1.0, speed: 8, spin:{side:0,vert:0} }, { contactBall:'cue' });
  }, 200);
}
{
  const g = { variant: snooker, frame: snooker.newFrame(), pieces: [
    { id:'cue', color:'white', group:'cue', kind:'cue', pos:{x:0,y:-0.8} },
    { id:'r0', color:'red', group:'red', kind:'red', pos:{x:0,y:0.9} } ] };
  g.frame.reds=1; g.frame.ballInHand=false;
  time('simulate: single-red pot', () => {
    simulate({ balls: buildBalls(g.pieces, snooker.ball), bounds: snooker.bounds(), pockets: snooker.pockets() },
             { ballId:'cue', angle: Math.PI/2, speed: 3, spin:{side:0,vert:0} }, { contactBall:'cue' });
  }, 500);
}
for (const diff of ['easy','medium','hard']) {
  const g = newGame(snooker, { jitter: 0, rng: rng(2) });
  g.frame.ballInHand = false;
  time(`aiTurn decision (${diff})`, () => { aiTurn(g, { difficulty: diff, rng: rng(3) }); }, 30);
}
