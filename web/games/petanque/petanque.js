// petanque.js — a top-down pétanque / boules prototype. Pure client-side, no backend. It demonstrates
// the two things that make boules different from cue sports: you THROW with an arc (an aerial phase that
// lands and then rolls), and the surface is ROUGH GRAVEL — high friction plus a little random deflection
// on landing and while rolling, so the terrain never plays quite fair. Closest boule to the jack wins the
// end; first to 13 wins. Play vs a simple computer or pass-and-play. (Distances in canvas pixels.)

import { VERSION } from '../../version.js';

const cv = document.getElementById('piste');
const ctx = cv.getContext('2d');
const W = cv.width, H = cv.height;
const el = (id) => document.getElementById(id);

// --- geometry + tuning ------------------------------------------------------------------------------
const R = 13, JACK_R = 7;                 // boule / jack radii
const THROW = { x: W / 2, y: H - 52 };    // the throwing circle (bottom centre)
const P = { x0: 30, y0: 28, x1: W - 30, y1: H - 20 };   // playable piste rectangle
const FRICTION = 680;                     // px/s^2 rolling deceleration — high, for gravel (short roll)
const ROLL_MAX = 560;                     // residual speed for a full "roll" throw
const REST = 9;                           // speed below which a body is at rest
const ROUGH = 0.9;                        // gravel character 0..1 (landing kick + rolling wobble)
const FLIGHT_MIN = 380, FLIGHT_PER_PX = 0.9; // aerial time in ms
const PER_TEAM = 3;

const TEAM = [
  { name: 'you', fill: ['#dcecff', '#5a86dd', '#31509a'] },
  { name: 'opp', fill: ['#ffd9cb', '#d86a4f', '#9a3b2a'] },
];

// --- state ------------------------------------------------------------------------------------------
let jack, bodies, boulesLeft, scores, current, mode, phase, aim, aiTimer, settleTimer;
// phase: 'aim' (human to throw) | 'sim' (physics running) | 'measure' | 'over'

function newMatch() {
  scores = [0, 0];
  mode = mode || 'ai';
  startEnd(0); // you throw the first jack
}

function startEnd(starter) {
  bodies = [];
  boulesLeft = [PER_TEAM, PER_TEAM];
  current = starter;
  // Place the jack: forward of the throw circle, within the piste, roughly where a real toss lands.
  jack = { x: W / 2 + (Math.random() - 0.5) * 260, y: H * 0.30 + (Math.random() - 0.5) * 120,
    vx: 0, vy: 0, r: JACK_R, team: -1, dead: false, state: 'rest' };
  clampInto(jack);
  phase = 'aim';
  aim = null;
  status(`${current === 0 ? 'Your' : "Computer's"} throw — ${boulesLeft[current]} boules left`);
  syncHud();
  maybeAI();
}

// --- helpers ----------------------------------------------------------------------------------------
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function clampInto(b) { b.x = clamp(b.x, P.x0 + b.r, P.x1 - b.r); b.y = clamp(b.y, P.y0 + b.r, P.y1 - b.r); }
const inBounds = (b) => b.x >= P.x0 && b.x <= P.x1 && b.y >= P.y0 && b.y <= P.y1;
const live = () => bodies.filter((b) => !b.dead);

// Which team owns the boule nearest the jack (or -1 if none on the piste yet).
function holdingTeam() {
  let best = Infinity, team = -1;
  for (const b of live()) { const d = dist(b, jack); if (d < best) { best = d; team = b.team; } }
  return team;
}

// --- throwing -------------------------------------------------------------------------------------
function throwTo(landing, style, team) {
  if (boulesLeft[team] <= 0) return;
  boulesLeft[team] -= 1;
  const b = { x: THROW.x, y: THROW.y, vx: 0, vy: 0, r: R, team, dead: false, state: 'air',
    from: { x: THROW.x, y: THROW.y }, to: { x: landing.x, y: landing.y }, t: 0,
    flight: Math.max(FLIGHT_MIN, dist(THROW, landing) * FLIGHT_PER_PX), style };
  bodies.push(b);
  phase = 'sim';
  aim = null;
  syncHud();
}

// When a boule finishes its flight, it lands and (unless a pure lob) runs forward — plus a gravel kick,
// so it never lands exactly where aimed.
function land(b) {
  b.state = 'ground';
  b.x = b.to.x; b.y = b.to.y;
  const ang = Math.atan2(b.to.y - b.from.y, b.to.x - b.from.x);
  const runSpeed = b.style * ROLL_MAX;
  // terrain kick: random angle jitter + speed variance, scaled by roughness (bigger for flatter throws)
  const kickAng = ang + (Math.random() - 0.5) * 0.5 * ROUGH * (1.2 - b.style);
  const kickSpd = runSpeed * (1 + (Math.random() - 0.5) * 0.4 * ROUGH) + (Math.random() * 22 * ROUGH);
  b.vx = Math.cos(kickAng) * kickSpd;
  b.vy = Math.sin(kickAng) * kickSpd;
}

// --- physics --------------------------------------------------------------------------------------
function step(dt) {
  let moving = false;

  for (const b of bodies) {
    if (b.state === 'air') {
      moving = true;
      b.t += dt * 1000;
      if (b.t >= b.flight) land(b);
      continue;
    }
    if (b.dead || b.state === 'rest') continue;
    const sp = Math.hypot(b.vx, b.vy);
    if (sp < REST) { b.vx = b.vy = 0; b.state = 'rest'; continue; }
    moving = true;
    // gravel wobble: small random perturbation while rolling
    if (ROUGH) { const w = 26 * ROUGH * dt; b.vx += (Math.random() - 0.5) * w * sp * 0.02; b.vy += (Math.random() - 0.5) * w * sp * 0.02; }
    // rolling friction (constant deceleration)
    const dec = FRICTION * dt, ns = Math.max(0, sp - dec), k = ns / sp;
    b.vx *= k; b.vy *= k;
    b.x += b.vx * dt; b.y += b.vy * dt;
    if (!inBounds(b) && b.team !== -1) { b.dead = true; b.state = 'rest'; b.vx = b.vy = 0; clampInto(b); }
    if (b.team === -1) clampInto(b); // the jack can be knocked but never leaves
  }

  // collisions (equal-mass elastic) among all non-dead, non-air bodies incl. the jack
  const all = [jack, ...bodies].filter((b) => !b.dead && b.state !== 'air');
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i], c = all[j];
    const dx = c.x - a.x, dy = c.y - a.y, d = Math.hypot(dx, dy) || 0.001, min = a.r + c.r;
    if (d < min) {
      const nx = dx / d, ny = dy / d, overlap = (min - d) / 2;
      a.x -= nx * overlap; a.y -= ny * overlap; c.x += nx * overlap; c.y += ny * overlap;
      const rvx = c.vx - a.vx, rvy = c.vy - a.vy, vn = rvx * nx + rvy * ny;
      if (vn < 0) {
        a.vx += vn * nx; a.vy += vn * ny; c.vx -= vn * nx; c.vy -= vn * ny;
        if (a.state === 'rest') a.state = 'ground'; if (c.state === 'rest') c.state = 'ground';
      }
      if (jack.team === -1) clampInto(jack);
    }
  }
  return moving;
}

// --- turn flow ------------------------------------------------------------------------------------
function afterSettle() {
  const hp = holdingTeam();
  const other = (t) => (t === 0 ? 1 : 0);
  // The team NOT holding the point throws next (pétanque's core rule).
  let next = hp === -1 ? current : other(hp);
  if (boulesLeft[next] <= 0) next = other(next);
  if (boulesLeft[0] <= 0 && boulesLeft[1] <= 0) { measure(); return; }
  current = next;
  phase = 'aim';
  status(`${current === 0 ? 'Your' : "Computer's"} throw — ${boulesLeft[current]} left`);
  syncHud();
  maybeAI();
}

function measure() {
  phase = 'measure';
  const pts = live().map((b) => ({ team: b.team, d: dist(b, jack) })).sort((a, b) => a.d - b.d);
  if (!pts.length) { status('No boules counted — dead end.'); setTimeout(() => startEnd(current), 1400); return; }
  const winner = pts[0].team;
  const oppNearest = pts.find((p) => p.team !== winner)?.d ?? Infinity;
  const points = pts.filter((p) => p.team === winner && p.d < oppNearest).length;
  scores[winner] += points;
  syncHud();
  if (scores[winner] >= 13) {
    phase = 'over';
    status(`${winner === 0 ? 'You win the match' : 'Computer wins the match'} ${scores[0]}–${scores[1]} 🎉`);
    el('status').classList.toggle('win', winner === 0);
    return;
  }
  status(`${winner === 0 ? 'You' : 'Computer'} win${winner === 0 ? '' : 's'} the end +${points}  (${scores[0]}–${scores[1]}). New end…`);
  setTimeout(() => startEnd(winner), 1800);
}

// --- simple AI ------------------------------------------------------------------------------------
function maybeAI() {
  clearTimeout(aiTimer);
  if (phase !== 'aim' || current !== 1 || mode !== 'ai') return;
  aiTimer = setTimeout(() => {
    if (phase !== 'aim' || current !== 1) return;
    // If YOU hold the point with a boule hugging the jack, sometimes shoot it; otherwise point at the jack.
    const yours = live().filter((b) => b.team === 0).sort((a, b) => dist(a, jack) - dist(b, jack))[0];
    let target, style;
    if (yours && holdingTeam() === 0 && dist(yours, jack) < 34 && Math.random() < 0.5) {
      target = { x: yours.x, y: yours.y }; style = 0.9;               // shoot
    } else {
      const s = 30; target = { x: jack.x + (Math.random() - 0.5) * s, y: jack.y + (Math.random() - 0.5) * s }; style = 0.3 + Math.random() * 0.2; // point
    }
    throwTo(reachable(target), style, 1);
  }, 900);
}

// --- input (human aim) ----------------------------------------------------------------------------
function canvasPos(ev) {
  const r = cv.getBoundingClientRect();
  return { x: (ev.clientX - r.left) * (W / r.width), y: (ev.clientY - r.top) * (H / r.height) };
}
// Clamp a desired landing spot to something actually throwable from the circle.
function reachable(pt) {
  let x = clamp(pt.x, P.x0 + R, P.x1 - R);
  let y = clamp(pt.y, P.y0 + R, THROW.y - 34);
  const dx = x - THROW.x, dy = y - THROW.y, d = Math.hypot(dx, dy);
  const md = clamp(d, 70, 480); const a = Math.atan2(dy, dx);
  return { x: THROW.x + Math.cos(a) * md, y: THROW.y + Math.sin(a) * md };
}
const humanTurn = () => phase === 'aim' && (mode === 'hotseat' || current === 0) && boulesLeft[current] > 0;
cv.addEventListener('mousemove', (ev) => { if (humanTurn()) aim = reachable(canvasPos(ev)); });
cv.addEventListener('mouseleave', () => { aim = null; });
cv.addEventListener('click', (ev) => { if (humanTurn()) throwTo(reachable(canvasPos(ev)), el('style').value / 100, current); });

// --- rendering ------------------------------------------------------------------------------------
const gravel = document.createElement('canvas'); gravel.width = W; gravel.height = H;
(function paintGravel() {
  const g = gravel.getContext('2d');
  g.fillStyle = '#b79a6e'; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 5200; i++) {
    const x = Math.random() * W, y = Math.random() * H, s = Math.random() * 2.1 + 0.4;
    const t = Math.random(); g.fillStyle = t < 0.5 ? 'rgba(90,72,45,.35)' : (t < 0.8 ? 'rgba(150,128,92,.5)' : 'rgba(233,220,190,.5)');
    g.beginPath(); g.arc(x, y, s, 0, 7); g.fill();
  }
})();

function boule(b, lift = 0) {
  if (lift > 0) { ctx.save(); ctx.globalAlpha = 0.28; ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.ellipse(b.x, b.y, b.r * 0.95, b.r * 0.55, 0, 0, 7); ctx.fill(); ctx.restore(); }
  const y = b.y - lift;
  const c = b.team === -1 ? ['#fff', '#e7cf8f', '#b89a55'] : TEAM[b.team].fill;
  const g = ctx.createRadialGradient(b.x - b.r * 0.35, y - b.r * 0.4, b.r * 0.2, b.x, y, b.r);
  g.addColorStop(0, c[0]); g.addColorStop(0.55, c[1]); g.addColorStop(1, c[2]);
  ctx.save(); if (b.dead) ctx.globalAlpha = 0.25;
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(b.x, y, b.r, 0, 7); ctx.fill();
  ctx.restore();
}

function draw() {
  ctx.drawImage(gravel, 0, 0);
  // piste border + throw circle
  ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 2;
  ctx.strokeRect(P.x0, P.y0, P.x1 - P.x0, P.y1 - P.y0);
  ctx.beginPath(); ctx.arc(THROW.x, THROW.y, 22, 0, 7); ctx.stroke();

  // aim guide
  if (aim && humanTurn()) {
    ctx.strokeStyle = 'rgba(84,201,138,.8)'; ctx.setLineDash([5, 6]); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(THROW.x, THROW.y); ctx.lineTo(aim.x, aim.y); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(aim.x, aim.y, 11, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.arc(aim.x, aim.y, 2.5, 0, 7); ctx.fillStyle = '#54c98a'; ctx.fill();
  }

  boule(jack);
  for (const b of bodies) boule(b, b.state === 'air' ? Math.sin((b.t / b.flight) * Math.PI) * 46 * (0.5 + b.style) : 0);
}

// --- loop -----------------------------------------------------------------------------------------
let last = 0, acc = 0, simTime = 0;
function frame(ts) {
  const now = ts / 1000; if (!last) last = now; let d = now - last; last = now;
  if (d > 0.05) d = 0.05;
  if (phase === 'sim') {
    acc += d; simTime += d; let moving = false;
    while (acc >= 1 / 120) { moving = step(1 / 120) || moving; acc -= 1 / 120; }
    if (!moving || simTime > 7) { // settled (or safety timeout)
      bodies.forEach((b) => { if (b.state !== 'air') { b.state = 'rest'; b.vx = b.vy = 0; } });
      simTime = 0; acc = 0;
      clearTimeout(settleTimer); settleTimer = setTimeout(afterSettle, 250);
      phase = 'settling';
    }
  }
  draw();
  requestAnimationFrame(frame);
}

// --- HUD / controls -------------------------------------------------------------------------------
function dots(id, team) {
  const spent = PER_TEAM - boulesLeft[team];
  el(id).innerHTML = Array.from({ length: PER_TEAM }, (_, i) => `<span class="bd ${team === 0 ? 'you' : 'opp'}${i < spent ? ' spent' : ''}"></span>`).join('');
}
function syncHud() {
  el('score-you').textContent = scores[0]; el('score-opp').textContent = scores[1];
  dots('dots-you', 0); dots('dots-opp', 1);
}
const status = (t) => { el('status').classList.remove('win'); el('status').textContent = t; };

el('mode').addEventListener('click', () => {
  mode = mode === 'ai' ? 'hotseat' : 'ai';
  el('mode').textContent = mode === 'ai' ? 'vs Computer' : 'Pass & play';
  el('mode').classList.toggle('active', mode === 'hotseat');
  el('score-opp').parentElement.childNodes[el('score-opp').parentElement.childNodes.length - 1].textContent = mode === 'ai' ? ' Comp' : ' Red';
  newMatch();
});
el('measure').addEventListener('click', () => { if (phase === 'aim') measure(); });
el('newgame').addEventListener('click', () => newMatch());

el('build').textContent = `Pétanque · v${VERSION}`;
mode = 'ai';
newMatch();
requestAnimationFrame(frame);
