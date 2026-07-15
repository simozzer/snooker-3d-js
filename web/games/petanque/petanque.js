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

// Up to four players. Each has BOTH a colour and a distinct pattern stamped on the boule (circle,
// double-circle, square, triangle) so colour-blind players can tell boules apart by shape alone. GLYPH
// mirrors the pattern in the HUD/status text.
const TEAM = [
  { name: 'Blue',  pattern: 'circle',   glyph: '●', fill: ['#dcecff', '#5a86dd', '#31509a'] },
  { name: 'Red',   pattern: 'double',   glyph: '◎', fill: ['#ffd9cb', '#d86a4f', '#9a3b2a'] },
  { name: 'Green', pattern: 'square',   glyph: '■', fill: ['#cdead0', '#57ab5e', '#2f6a35'] },
  { name: 'Amber', pattern: 'triangle', glyph: '▲', fill: ['#ffe9c2', '#e0a93a', '#946a16'] },
];

const renderer = createPetanqueRenderer(cv, overlay, { W, H, P, THROW, R, JACK_R, TEAM });

// --- procedural sound (WebAudio, zero assets) -----------------------------------------------------
// A soft gravel thud on landing, a metallic clink on a collision (pitched by how hard the click was),
// and a little chime when you take an end. The context is created/resumed on your first gesture.
const sfx = (() => {
  let ctx = null, muted = false, lastClink = 0;
  const ensure = () => {
    try { if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === 'suspended') ctx.resume(); } catch { /* no audio */ }
    return ctx;
  };
  function thud() {
    const c = ensure(); if (!c || muted) return;
    const t = c.currentTime, len = Math.floor(0.16 * c.sampleRate);
    const buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2); // gravel crunch
    const src = c.createBufferSource(); src.buffer = buf;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 430;
    const g = c.createGain(); g.gain.value = 0.16;
    src.connect(lp).connect(g).connect(c.destination); src.start(t);
  }
  function clink(s) {
    const c = ensure(); if (!c || muted) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : 0);
    if (now - lastClink < 45) return; lastClink = now; // don't machine-gun on a cluster
    const t = c.currentTime, freq = 880 + s * 1500, vol = 0.04 + s * 0.16;
    for (const mul of [1, 1.48]) {
      const o = c.createOscillator(); o.type = 'triangle'; o.frequency.value = freq * mul;
      const g = c.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0008, t + 0.18);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.2);
    }
  }
  function chime() {
    const c = ensure(); if (!c || muted) return;
    const t0 = c.currentTime;
    [523, 659, 784, 1047].forEach((f, i) => {
      const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const g = c.createGain(), t = t0 + i * 0.1;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.15, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0008, t + 0.4);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.42);
    });
  }
  return { thud, clink, chime, resume: ensure, toggle() { muted = !muted; return muted; }, get muted() { return muted; } };
})();

// --- the French referee (pure comedy) -------------------------------------------------------------
// Announces every landing with a French word or phrase — from proper boules calls, through random nouns
// (banana, bicycle, cheese…), to full nonsense ("where is my bicycle?", "why do you smell?"), and now and
// then the obligatory "hon hon hon". A caption always shows; it's SPOKEN aloud (fr-FR) unless sound's muted.
const referee = (() => {
  const PHRASES = [
    'Boule !', 'Pétanque !', 'Le cochonnet !', 'Tirez !', 'Pointez !', 'Carreau !', 'Le bouchon !',
    'Fanny !', 'Un point !', 'Le but !',
    'La banane.', 'La bicyclette.', 'Le fromage.', 'Le croissant.', 'La baguette.', "L'escargot.",
    'Le béret.', 'La moustache.', 'Le pamplemousse.', 'La grenouille.', 'Le camembert.', 'La saucisse.',
    'Le parapluie.', 'La chaussette.', 'Le canard.',
    'Zut alors !', 'Sacré bleu !', 'Oh là là !', 'Magnifique !', 'Catastrophe !', 'Formidable !',
    'Incroyable !', 'Quelle horreur !', "C'est la vie.", 'Bof.', 'Mon Dieu !',
    'Où est ma bicyclette ?', 'Pourquoi tu sens mauvais ?', 'Je suis une pomme de terre.',
    'Le chat porte un chapeau.', 'As-tu vu mon fromage ?', 'Il pleut des grenouilles.',
    'Ma grand-mère fait du vélo.', 'Le poisson est fatigué.', 'Où sont mes chaussettes ?',
    'Tu danses comme un canard.', 'Mon pantalon est trop petit.', 'Le président mange une baguette.',
    "Je n'aime pas le lundi.", 'Ton chapeau est ridicule.',
  ];
  const node = el('ref');
  let last = -1, hideT = 0, voice = null;
  const loadVoice = () => { try { voice = speechSynthesis.getVoices().find((v) => /^fr/i.test(v.lang)) || null; } catch { /* none */ } };
  try { loadVoice(); if (speechSynthesis.onvoiceschanged !== undefined) speechSynthesis.onvoiceschanged = loadVoice; } catch { /* no TTS */ }
  function speak(text) {
    if (sfx.muted) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'fr-FR'; if (voice) u.voice = voice; u.rate = 0.95; u.pitch = 1.12;
      speechSynthesis.cancel(); speechSynthesis.speak(u);
    } catch { /* no TTS */ }
  }
  function announce() {
    let i; do { i = Math.floor(Math.random() * PHRASES.length); } while (i === last && PHRASES.length > 1);
    last = i;
    const phrase = (Math.random() < 0.18 ? 'Hon hon hon… ' : '') + PHRASES[i];
    node.innerHTML = `<span class="flag">🇫🇷</span>${phrase}`;
    node.classList.add('show');
    clearTimeout(hideT); hideT = setTimeout(() => node.classList.remove('show'), 2600);
    speak(phrase);
  }
  return { announce };
})();

// --- players + modes --------------------------------------------------------------------------------
// Free-for-all: 2–4 players, each human or AI (closest boule to the jack takes the end; a player scores
// one point per boule of theirs closer than the best of EVERYONE else). AI self-play = all-AI, sit back.
const MODES = {
  ai:      ['human', 'ai'],
  hotseat: ['human', 'human'],
  four:    ['human', 'ai', 'ai', 'ai'],
  watch:   ['ai', 'ai', 'ai', 'ai'],
};

// --- state ------------------------------------------------------------------------------------------
let jack, bodies, boulesLeft, scores, current, mode, phase, aim, aiTimer, settleTimer;
let players = [], perPlayer = 3;
const humanCount = () => players.filter((p) => p.kind === 'human').length;
const playerName = (i) => (players[i].kind === 'human' && humanCount() === 1 && i === 0 ? 'You' : TEAM[i].name);
const turnStatus = () => { const nm = playerName(current); return nm === 'You' ? 'Your throw' : `${nm}'s throw`; };
let impacts = [];  // collision events (contact point + strength) drained each frame for shock-rings + shake
let measureInfo = null;  // during the end's measure: the winner + the boules being counted, for the string overlay
// The spin ball's contact point (like snooker english): side −1..+1 = hook L/R; vert −1..+1 = lob..roll.
let strike = { side: 0, vert: 0 };
const loftFromVert = (v) => clamp(0.5 + v * 0.42, 0.08, 0.95); // draw(down)=lob, follow(up)=roll
const vertFromLoft = (loft) => clamp((loft - 0.5) / 0.42, -1, 1); // inverse — to show the computer's pick on the ball
const shotName = (v) => (v > 0.34 ? 'Roll' : v < -0.34 ? 'Lob' : 'Pitch');
// phase: 'aim' (human to throw) | 'sim' (physics running) | 'measure' | 'over'

function newMatch() {
  mode = mode || 'ai';
  players = (MODES[mode] || MODES.ai).map((kind) => ({ kind }));
  perPlayer = players.length <= 2 ? 3 : 2; // singles gets 3 boules; a crowded 3–4 player end gets 2 each
  scores = players.map(() => 0);
  el('status').classList.remove('win');
  startEnd(0); // the first player throws the jack
}

function startEnd(starter) {
  bodies = [];
  boulesLeft = players.map(() => perPlayer);
  current = starter;
  // Place the jack: forward of the throw circle, within the piste, roughly where a real toss lands.
  jack = { x: W / 2 + (Math.random() - 0.5) * 260, y: H * 0.30 + (Math.random() - 0.5) * 120,
    vx: 0, vy: 0, r: JACK_R, team: -1, dead: false, state: 'rest' };
  clampInto(jack);
  phase = 'aim';
  aim = null;
  setStrike(0, 0); // fresh end: spin ball back to centre (this also clears any stale aim preview)
  status(`${turnStatus()} — ${boulesLeft[current]} boules left`);
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
  sfx.thud();
  referee.announce(); // le référé français
}

// --- physics --------------------------------------------------------------------------------------
function step(dt) {
  let moving = false;

  // Include the jack (team −1): a knocked jack must roll and settle under friction like any boule —
  // otherwise the velocity the collision gives it is never damped, so it drifts/spins forever.
  for (const b of [jack, ...bodies]) {
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
        const s = Math.min(1, Math.abs(vn) / 300); // how hard the click was → ring size + camera kick
        if (s > 0.1) impacts.push({ x: a.x + nx * a.r, y: a.y + ny * a.r, s });
        if (s > 0.16) sfx.clink(s);
      }
      if (jack.team === -1) clampInto(jack);
    }
  }
  return moving;
}

// --- turn flow ------------------------------------------------------------------------------------
// Distance of a player's CLOSEST boule to the jack (Infinity if they have none down yet).
function nearestDistOf(pi) {
  let best = Infinity;
  for (const b of live()) if (b.team === pi) best = Math.min(best, dist(b, jack));
  return best;
}
// Pétanque's core rule, generalised to N players: whoever does NOT hold the point throws next; among the
// non-holders with boules left, the one lying farthest from the jack (most to gain) goes. −1 → measure.
function nextThrower() {
  const withBoules = players.map((_, i) => i).filter((i) => boulesLeft[i] > 0);
  if (!withBoules.length) return -1;
  const holder = holdingTeam();
  if (holder === -1) return withBoules.includes(current) ? current : withBoules[0];
  const challengers = withBoules.filter((i) => i !== holder);
  const pool = challengers.length ? challengers : withBoules; // only the holder has boules → they play on
  pool.sort((a, b) => nearestDistOf(b) - nearestDistOf(a));
  return pool[0];
}

function afterSettle() {
  const next = nextThrower();
  if (next === -1) { measure(); return; }
  current = next;
  phase = 'aim';
  aim = null;
  setStrike(0, 0); // each turn starts from a centred spin ball; an AI sets its own before it throws
  status(`${turnStatus()} — ${boulesLeft[current]} left`);
  syncHud();
  maybeAI();
}

function measure() {
  phase = 'measure';
  measureInfo = null;
  const pts = live().map((b) => ({ b, team: b.team, d: dist(b, jack) })).sort((a, b) => a.d - b.d);
  if (!pts.length) { status('No boules counted — dead end.'); setTimeout(() => startEnd(current), 1400); return; }
  const winner = pts[0].team;
  const rivalNearest = pts.find((p) => p.team !== winner)?.d ?? Infinity; // best of everyone else
  const counting = pts.filter((p) => p.team === winner && p.d < rivalNearest);
  const points = counting.length;
  const nm = playerName(winner), youWon = players[winner].kind === 'human';
  // run the string out from the jack to the counting boules FIRST; award once the measure has been seen
  measureInfo = { winner, boules: counting.map((p) => p.b) };
  status(`Measuring…  ${nm === 'You' ? 'you' : nm} for ${points}`);
  setTimeout(() => {
    measureInfo = null;
    scores[winner] += points;
    syncHud();
    if (youWon) sfx.chime(); // a little fanfare when a human takes the end
    if (scores[winner] >= 13) {
      phase = 'over';
      status(`${nm === 'You' ? 'You win' : `${nm} wins`} the match 🎉`);
      el('status').classList.toggle('win', youWon);
      syncHud();
      return;
    }
    const verb = nm === 'You' ? 'You win' : `${nm} wins`;
    status(`${verb} the end +${points}. New end…`);
    setTimeout(() => startEnd(winner), 1700);
  }, 1800);
}

// --- simple AI ------------------------------------------------------------------------------------
const isAI = (i) => players[i] && players[i].kind === 'ai';
function maybeAI() {
  clearTimeout(aiTimer);
  if (phase !== 'aim' || !isAI(current)) return;
  const me = current;
  aiTimer = setTimeout(() => {
    if (phase !== 'aim' || current !== me || !isAI(me)) return;
    // If someone else holds the point with a boule hugging the jack, sometimes shoot it; else point at the jack.
    const rival = live().filter((b) => b.team !== me).sort((a, b) => dist(a, jack) - dist(b, jack))[0];
    let target, loft, spin;
    if (rival && holdingTeam() !== me && dist(rival, jack) < 34 && Math.random() < 0.45) {
      target = { x: rival.x, y: rival.y }; loft = 0.85; spin = 0;             // shoot: flat and hard
    } else {
      const s = 30; target = { x: jack.x + (Math.random() - 0.5) * s, y: jack.y + (Math.random() - 0.5) * s };
      loft = 0.3 + Math.random() * 0.25; spin = (Math.random() - 0.5) * 0.5;  // point: gentle arc, a little hook
    }
    // show the AI setting its shot on the spin ball, then throw a beat later so you can see it
    setStrike(spin, vertFromLoft(loft));
    aiTimer = setTimeout(() => { if (phase === 'aim' && current === me && isAI(me)) throwTo(reachable(target), loft, spin, me); }, 520);
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
const humanTurn = () => phase === 'aim' && players[current] && players[current].kind === 'human' && boulesLeft[current] > 0;

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

// Setting up a shot is deliberate: DRAG the piste to set your line + power (the trajectory persists as a
// preview after you let go), fine-tune spin/lob/roll on the ball, then press LAUNCH to actually throw.
let aiming = false;
cv.addEventListener('pointerdown', (ev) => {
  sfx.resume(); // unlock WebAudio on the first user gesture
  if (!humanTurn()) return;
  aiming = true; aim = aimFrom(renderer.screenToGround(ev.clientX, ev.clientY)); updateLaunch();
  try { cv.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
});
cv.addEventListener('pointermove', (ev) => { if (aiming && humanTurn()) { aim = aimFrom(renderer.screenToGround(ev.clientX, ev.clientY)); updateLaunch(); } });
function endAim() {
  if (!aiming) return;
  aiming = false;
  if (aim && aim.power <= 0.02) aim = null; // a tap, not a drag → no trajectory set
  updateLaunch();
}
cv.addEventListener('pointerup', endAim);
cv.addEventListener('pointercancel', () => { aiming = false; updateLaunch(); });

// Keep the persisted aim's shape (loft/spin/arc) in step with the spin ball as you adjust it.
function recomputeAimShape() {
  if (!aim) return;
  aim.loft = loftFromVert(strike.vert); aim.spin = strike.side; aim.shot = shotName(strike.vert);
  aim.arc = flightArc(THROW, aim.landing, aim.loft, aim.spin);
}
const launchReady = () => humanTurn() && !!aim && aim.power > 0.02;
function updateLaunch() { el('launch').classList.toggle('ready', launchReady()); }
function launch() {
  if (!launchReady()) return;
  sfx.resume();
  const a = aim; aim = null; updateLaunch();
  throwTo(a.landing, a.loft, a.spin, current);
}
el('launch').addEventListener('click', launch);

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
      [jack, ...bodies].forEach((b) => { if (b.state !== 'air') { b.state = 'rest'; b.vx = b.vy = 0; } });
      simTime = 0; acc = 0;
      clearTimeout(settleTimer); settleTimer = setTimeout(afterSettle, 250);
      phase = 'settling';
    }
  }
  // b.airLift is set by the physics step during flight; the renderer reads it for the 3D arc.
  updateLaunch(); // keep the Launch button in step with turn/aim state
  renderer.frame({ jack, bodies, aim, aiming, humanTurn, phase, impacts, measure: measureInfo }, d);
  requestAnimationFrame(frame);
}

// --- HUD / controls -------------------------------------------------------------------------------
const dotGrad = (i) => `radial-gradient(circle at 35% 30%, ${TEAM[i].fill[0]}, ${TEAM[i].fill[1]} 70%)`;
function syncHud() {
  el('scores').innerHTML = players.map((p, i) => {
    const spent = perPlayer - boulesLeft[i];
    const dots = Array.from({ length: perPlayer }, (_, k) =>
      `<span class="bd" style="background:${dotGrad(i)}${k < spent ? ';opacity:.2' : ''}"></span>`).join('');
    const tag = p.kind === 'ai' ? '<span class="ai">AI</span>' : '';
    return `<div class="stat${i === current && phase !== 'over' && phase !== 'measure' ? ' turn' : ''}">`
      + `<span class="pat" style="color:${TEAM[i].fill[1]}">${TEAM[i].glyph}</span>`
      + `<b>${scores[i]}</b><span class="nm">${playerName(i)}</span>${tag}`
      + `<span class="dotrow">${dots}</span></div>`;
  }).join('');
}
const status = (t) => { el('status').classList.remove('win'); el('status').textContent = t; };

el('mode').addEventListener('change', () => { mode = el('mode').value; newMatch(); });
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
  const v = strike.vert, s = strike.side;
  // always two decimals + a fixed-width column, so the readout (and the panel) never resize as you adjust
  el('shot-name').textContent = `${shotName(v)} ${Math.abs(v).toFixed(2)}`;
  el('shot-sub').textContent = `hook ${Math.abs(s) < 0.005 ? '' : (s > 0 ? 'R' : 'L')}${Math.abs(s).toFixed(2)}`;
}
function setStrike(side, vert) {
  const m = Math.hypot(side, vert); if (m > 1) { side /= m; vert /= m; } // clamp the contact point to the ball's edge
  strike = { side, vert };
  drawSpinBall(); syncShot(); recomputeAimShape();
}
function sbFrom(ev) {
  if (!humanTurn()) return; // can't set spin on the computer's turn — the ball shows ITS pick then
  const r = sb.getBoundingClientRect();
  setStrike(((ev.clientX - r.left) * (SBW / r.width) - SBC) / SBR, -((ev.clientY - r.top) * (SBW / r.height) - SBC) / SBR);
}
sb.addEventListener('pointerdown', (ev) => { sb.focus(); try { sb.setPointerCapture(ev.pointerId); } catch { /* ignore */ } sbFrom(ev); });
sb.addEventListener('pointermove', (ev) => { if (ev.buttons) sbFrom(ev); });
sb.addEventListener('dblclick', () => { if (humanTurn()) setStrike(0, 0); });
// arrow keys nudge the contact point for fine adjustment; hold Shift for extra-fine, 0/Home to centre
sb.addEventListener('keydown', (ev) => {
  if (!humanTurn()) return;
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

// mute toggle (remembered across sessions)
let startMuted = false; try { startMuted = localStorage.getItem('petanque-muted') === '1'; } catch { /* no storage */ }
if (startMuted) sfx.toggle();
el('mute').textContent = sfx.muted ? '🔇' : '🔊';
el('mute').addEventListener('click', () => {
  const m = sfx.toggle(); sfx.resume();
  el('mute').textContent = m ? '🔇' : '🔊';
  try { localStorage.setItem('petanque-muted', m ? '1' : '0'); } catch { /* no storage */ }
});

el('build').textContent = `Pétanque · v${VERSION}`;
mode = 'ai';
el('mode').value = mode;
newMatch();
requestAnimationFrame(frame);
