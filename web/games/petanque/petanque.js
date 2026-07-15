// petanque.js — pétanque / boules. The GAME (physics, turns, AI) is pure client-side and lives here in 2D
// "plan" coordinates (x:0..W, y:0..H): you THROW with an arc (an aerial phase that lands and then rolls),
// and the surface is ROUGH GRAVEL — high friction plus a little random deflection on landing and while
// rolling, so the terrain never plays quite fair. The RENDERING is real hand-rolled WebGL 3D over in
// petanque-gl.js (a low camera over the piste, lit steel boules, and a loitering Lowry crowd); this file
// just feeds it the plan-coordinate state and turns pointer rays back into plan coordinates for aiming.
// Closest boule to the jack wins the end; first to 13. Play vs a simple computer or pass-and-play.

import { VERSION } from '../../version.js';
import { createPetanqueRenderer } from './petanque-gl.js';

const cv = document.getElementById('piste');
const overlay = document.getElementById('aim');
const el = (id) => document.getElementById(id);
const W = 900, H = 560;   // logical "plan" play-field (independent of the WebGL canvas pixel size)

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

// Throw control: you DRAG out from the throwing circle. The drag DIRECTION is your line, and the drag
// LENGTH is the power (mapped to an aerial landing distance) — NOT the cursor position, so aiming the
// cursor straight at the jack and pulling hard sails long past it. You judge force and line, never click
// an exact spot. And no two throws of the same drag land alike (AIM_SPREAD), because a hand isn't a ruler.
const DRAG_MIN = 16, DRAG_MAX = 205;                  // px of drag → 0..full power
const DIST_MIN = 80, DIST_MAX = 486;                  // aerial landing distance (px) mapped from power
const AIM_SPREAD_ANG = 0.045, AIM_SPREAD_DIST = 0.05; // ± line / ± distance a throw can stray by itself

// Shot shaping: LOFT (0=high lob, 1=flat roll) sets the arc height + how far the boule runs after it lands;
// SPIN (-1..+1) bows the flight path sideways (a banana curve) and makes the boule grab/hook on landing.
const LIFT_BASE = 96;                 // world-unit apex height reference (scaled up for lobs, flattened for rolls)
const CURVE_MAX = 130;                // px of sideways bow in the flight path at full spin
const arcHeight = (loft) => LIFT_BASE * (1.25 - loft);   // lob → tall arc, roll → skimming

// Sample the flight path (plan coords + aerial height) so the aim overlay and the physics agree on the shape.
function flightArc(from, to, loft, spin, n = 26) {
  const dx = to.x - from.x, dy = to.y - from.y, len = Math.hypot(dx, dy) || 1;
  const px = -dy / len, py = dx / len, curve = spin * CURVE_MAX, H = arcHeight(loft);
  const pts = [];
  for (let i = 0; i <= n; i++) { const k = i / n, s = Math.sin(k * Math.PI);
    pts.push({ x: from.x + dx * k + px * curve * s, y: from.y + dy * k + py * curve * s, lift: s * H }); }
  return pts;
}

const TEAM = [
  { name: 'you', fill: ['#dcecff', '#5a86dd', '#31509a'] },
  { name: 'opp', fill: ['#ffd9cb', '#d86a4f', '#9a3b2a'] },
];

const renderer = createPetanqueRenderer(cv, overlay, { W, H, P, THROW, R, JACK_R, TEAM });

// --- state ------------------------------------------------------------------------------------------
let jack, bodies, boulesLeft, scores, current, mode, phase, aim, aiTimer, settleTimer;
// The spin ball's contact point (like snooker english): side −1..+1 = hook L/R; vert −1..+1 = lob..roll.
let strike = { side: 0, vert: 0 };
const loftFromVert = (v) => clamp(0.5 + v * 0.42, 0.08, 0.95); // draw(down)=lob, follow(up)=roll
const shotName = (v) => (v > 0.34 ? 'Roll' : v < -0.34 ? 'Lob' : 'Pitch');
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
// loft: 0 (high lob) .. 1 (flat roll); spin: -1..+1 (banana curve + landing hook).
function throwTo(landing, loft, spin, team) {
  if (boulesLeft[team] <= 0) return;
  // A hand is not a ruler: jitter the intended landing (line + distance) before the boule even leaves.
  // Applies to YOU and the computer alike, so aiming is judgement, not pixel-picking.
  const a0 = Math.atan2(landing.y - THROW.y, landing.x - THROW.x), d0 = dist(THROW, landing);
  const a = a0 + (Math.random() - 0.5) * 2 * AIM_SPREAD_ANG;
  const d = d0 * (1 + (Math.random() - 0.5) * 2 * AIM_SPREAD_DIST);
  landing = reachable({ x: THROW.x + Math.cos(a) * d, y: THROW.y + Math.sin(a) * d });
  boulesLeft[team] -= 1;
  const b = { x: THROW.x, y: THROW.y, vx: 0, vy: 0, r: R, team, dead: false, state: 'air',
    from: { x: THROW.x, y: THROW.y }, to: { x: landing.x, y: landing.y }, t: 0, airLift: 0,
    // a lob hangs in the air longer, a roll is flung low and fast
    flight: Math.max(FLIGHT_MIN, dist(THROW, landing) * FLIGHT_PER_PX) * (1.5 - 0.6 * loft),
    style: loft, spin, curve: spin * CURVE_MAX, arc: arcHeight(loft) };
  bodies.push(b);
  phase = 'sim';
  aim = null;
  renderer.react(); // heads in the crowd turn to watch the throw
  syncHud();
}

// When a boule finishes its flight, it lands and (unless a pure lob) runs forward — plus a gravel kick
// and any spin "hook", so it never lands exactly where aimed. `justLanded` cues the renderer's dust puff.
function land(b) {
  b.state = 'ground';
  b.x = b.to.x; b.y = b.to.y;
  b.airLift = 0; b.justLanded = true;
  const ang = Math.atan2(b.to.y - b.from.y, b.to.x - b.from.x);
  const runSpeed = b.style * ROLL_MAX;
  // spin bites the gravel: the run hooks to the side, and a strong spin/lob checks (shortens) the roll
  const spinBias = (b.spin || 0) * 0.5;
  const grab = 1 - 0.28 * Math.abs(b.spin || 0);
  // terrain kick: random angle jitter + speed variance, scaled by roughness (bigger for flatter throws)
  const kickAng = ang + spinBias + (Math.random() - 0.5) * 0.5 * ROUGH * (1.2 - b.style);
  const kickSpd = runSpeed * grab * (1 + (Math.random() - 0.5) * 0.4 * ROUGH) + (Math.random() * 22 * ROUGH);
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
      // travel the parabola across the piste, bowing sideways with spin, so the flight is actually SEEN
      const k = Math.min(1, b.t / b.flight), s = Math.sin(k * Math.PI);
      const dx = b.to.x - b.from.x, dy = b.to.y - b.from.y, len = Math.hypot(dx, dy) || 1;
      const px = -dy / len, py = dx / len;
      b.x = b.from.x + dx * k + px * b.curve * s;
      b.y = b.from.y + dy * k + py * b.curve * s;
      b.airLift = s * b.arc;
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
    let target, loft, spin;
    if (yours && holdingTeam() === 0 && dist(yours, jack) < 34 && Math.random() < 0.5) {
      target = { x: yours.x, y: yours.y }; loft = 0.85; spin = 0;             // shoot: flat and hard
    } else {
      const s = 30; target = { x: jack.x + (Math.random() - 0.5) * s, y: jack.y + (Math.random() - 0.5) * s };
      loft = 0.3 + Math.random() * 0.25; spin = (Math.random() - 0.5) * 0.5;  // point: gentle arc, a little hook
    }
    throwTo(reachable(target), loft, spin, 1);
  }, 900);
}

// --- input (human aim) ----------------------------------------------------------------------------
// Clamp a desired landing spot to something actually throwable from the circle.
function reachable(pt) {
  let x = clamp(pt.x, P.x0 + R, P.x1 - R);
  let y = clamp(pt.y, P.y0 + R, THROW.y - 34);
  const dx = x - THROW.x, dy = y - THROW.y, d = Math.hypot(dx, dy);
  const md = clamp(d, 70, 480); const a = Math.atan2(dy, dx);
  return { x: THROW.x + Math.cos(a) * md, y: THROW.y + Math.sin(a) * md };
}
const humanTurn = () => phase === 'aim' && (mode === 'hotseat' || current === 0) && boulesLeft[current] > 0;

// Turn a pointer position into a throw: DIRECTION from the circle = line; DRAG LENGTH = power → distance.
function aimFrom(pos) {
  const dx = pos.x - THROW.x, dy = pos.y - THROW.y;
  const heading = Math.atan2(dy, dx);
  const power = clamp((Math.hypot(dx, dy) - DRAG_MIN) / (DRAG_MAX - DRAG_MIN), 0, 1);
  const d = DIST_MIN + power * (DIST_MAX - DIST_MIN);
  const landing = reachable({ x: THROW.x + Math.cos(heading) * d, y: THROW.y + Math.sin(heading) * d });
  const loft = loftFromVert(strike.vert), spin = strike.side;
  // arc = the 3D trajectory the overlay draws so you can see the shot before you let go
  return { heading, power, dist: d, landing, loft, spin, shot: shotName(strike.vert), arc: flightArc(THROW, landing, loft, spin) };
}

let aiming = false;
cv.addEventListener('pointerdown', (ev) => {
  if (!humanTurn()) return;
  aiming = true; aim = aimFrom(renderer.screenToGround(ev.clientX, ev.clientY));
  try { cv.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
});
cv.addEventListener('pointermove', (ev) => { if (aiming && humanTurn()) aim = aimFrom(renderer.screenToGround(ev.clientX, ev.clientY)); });
function releaseThrow() {
  if (!aiming) return;
  aiming = false;
  const a = aim; aim = null;
  if (a && humanTurn() && a.power > 0.02) throwTo(a.landing, a.loft, a.spin, current); // too soft = cancel
}
cv.addEventListener('pointerup', releaseThrow);
cv.addEventListener('pointercancel', () => { aiming = false; aim = null; });

// --- loop -----------------------------------------------------------------------------------------
// Physics still runs in 2D plan coords; the WebGL renderer draws that state in 3D each frame.
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
  // b.airLift is set by the physics step during flight; the renderer reads it for the 3D arc.
  renderer.frame({ jack, bodies, aim, aiming, humanTurn, phase }, d);
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
// --- spin ball (snooker-style english) ------------------------------------------------------------
// One steel ball you set the contact point on: up = roll on (follow), down = lob / drop dead (draw),
// out to the side = hook the flight. It feeds `strike`, which aimFrom turns into loft + spin.
const sb = el('spinball'), sbx = sb.getContext('2d');
const SBW = sb.width, SBC = SBW / 2, SBR = SBW / 2 - 12;
function drawSpinBall() {
  sbx.clearRect(0, 0, SBW, SBW);
  const g = sbx.createRadialGradient(SBC - SBR * 0.36, SBC - SBR * 0.42, SBR * 0.12, SBC, SBC, SBR);
  g.addColorStop(0, '#f2f5f8'); g.addColorStop(0.5, '#9fb0bf'); g.addColorStop(1, '#3f4d5a');
  sbx.fillStyle = g; sbx.beginPath(); sbx.arc(SBC, SBC, SBR, 0, 7); sbx.fill();
  sbx.strokeStyle = 'rgba(0,0,0,.45)'; sbx.lineWidth = 1.5; sbx.stroke();
  // reference marks: crosshair + a half-radius ring, so you can gauge how far off-centre the dot sits
  sbx.strokeStyle = 'rgba(18,28,38,.22)'; sbx.lineWidth = 1;
  sbx.beginPath(); sbx.moveTo(SBC - SBR, SBC); sbx.lineTo(SBC + SBR, SBC); sbx.moveTo(SBC, SBC - SBR); sbx.lineTo(SBC, SBC + SBR); sbx.stroke();
  sbx.beginPath(); sbx.arc(SBC, SBC, SBR * 0.5, 0, 7); sbx.stroke();
  sbx.fillStyle = 'rgba(15,25,35,.5)'; sbx.font = '700 10px system-ui, sans-serif'; sbx.textAlign = 'center';
  sbx.fillText('ROLL', SBC, SBC - SBR + 12); sbx.fillText('LOB', SBC, SBC + SBR - 4);
  const dx = SBC + strike.side * SBR, dy = SBC - strike.vert * SBR; // contact dot
  sbx.fillStyle = '#e8663f'; sbx.beginPath(); sbx.arc(dx, dy, 7, 0, 7); sbx.fill();
  sbx.strokeStyle = 'rgba(255,255,255,.9)'; sbx.lineWidth = 2; sbx.stroke();
}
function syncShot() {
  el('shot-name').textContent = shotName(strike.vert);
  el('shot-sub').textContent = Math.abs(strike.side) < 0.08 ? 'straight' : `hook ${strike.side > 0 ? 'R' : 'L'} ${Math.abs(strike.side).toFixed(2)}`;
}
function setStrike(side, vert) {
  const m = Math.hypot(side, vert); if (m > 1) { side /= m; vert /= m; } // clamp the contact point to the ball's edge
  strike = { side, vert };
  drawSpinBall(); syncShot();
}
function sbFrom(ev) {
  const r = sb.getBoundingClientRect();
  setStrike(((ev.clientX - r.left) * (SBW / r.width) - SBC) / SBR, -((ev.clientY - r.top) * (SBW / r.height) - SBC) / SBR);
}
sb.addEventListener('pointerdown', (ev) => { sb.focus(); try { sb.setPointerCapture(ev.pointerId); } catch { /* ignore */ } sbFrom(ev); });
sb.addEventListener('pointermove', (ev) => { if (ev.buttons) sbFrom(ev); });
sb.addEventListener('dblclick', () => setStrike(0, 0));
// arrow keys nudge the contact point for fine adjustment; hold Shift for extra-fine, 0/Home to centre
sb.addEventListener('keydown', (ev) => {
  const s = ev.shiftKey ? 0.01 : 0.05;
  if (ev.key === 'ArrowUp') setStrike(strike.side, strike.vert + s);
  else if (ev.key === 'ArrowDown') setStrike(strike.side, strike.vert - s);
  else if (ev.key === 'ArrowRight') setStrike(strike.side + s, strike.vert);
  else if (ev.key === 'ArrowLeft') setStrike(strike.side - s, strike.vert);
  else if (ev.key === '0' || ev.key === 'Home') setStrike(0, 0);
  else return;
  ev.preventDefault();
});
drawSpinBall(); syncShot();

el('measure').addEventListener('click', () => { if (phase === 'aim') measure(); });
el('newgame').addEventListener('click', () => newMatch());

el('build').textContent = `Pétanque · v${VERSION}`;
mode = 'ai';
newMatch();
requestAnimationFrame(frame);
