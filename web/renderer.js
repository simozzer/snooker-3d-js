// renderer.js — table-game UI (snooker or pool): aiming, replay, and the AI opponent.
// Serve from the project root (npm run serve) and open /web/ — file:// blocks ES imports.

import { snooker } from '../src/variants/snooker.js';
import { doubleSnooker } from '../src/variants/doublesnooker.js';
import { pool } from '../src/variants/pool.js';
import { nineball } from '../src/variants/nineball.js';
import { billiards } from '../src/variants/billiards.js';
import { newGame, takeShot, buildBalls } from '../src/game.js';
import { simulate } from '../src/simulate.js';
import { twoPhasePlan, posAt } from '../src/motion.js';
import { chooseShot, chooseShotFinish, applyError } from '../src/ai.js';

const VERSION = '0.10c'; // shown in the top-line title so players can report which build they run (keep in sync with package.json)
const VARIANTS = { snooker, doublesnooker: doubleSnooker, pool, nineball, billiards };
const canvas = document.getElementById('table');
const ctx = canvas.getContext('2d');

// AI difficulty: execution error ("hand") + search breadth/depth ("brain").
const AI_SEARCH = { spins: [{ side: 0, vert: 0 }, { side: 0, vert: 0.6 }, { side: 0, vert: -0.6 }] };
const DEADLY_SEARCH = {
  maxCandidates: 18, // denser candidate breadth than the other levels
  powerScales: [0.8, 0.95, 1.1, 1.3, 1.6],
  // ±0.012 rad (~±0.7°) aim window — 5 samples is finer than the pot window itself, so dropping
  // the old 7-point grid to 5 costs no measurable strength while cutting ~29% of the search.
  angleOffsets: [-0.012, -0.006, 0, 0.006, 0.012],
  spins: [{ side: 0, vert: 0 }, { side: 0, vert: 0.6 }, { side: 0, vert: -0.6 }, { side: 0.5, vert: 0 }, { side: -0.5, vert: 0 }],
  // 'advanced' gates the deadly-only AI features (play-for-the-black, single-red break-building,
  // safety play, random opening-break styles, and the 2-ply red→black→red look-ahead). Only the
  // deadly profile sets it.
  advanced: true,
};
const DIFFICULTY = {
  deadly: { angleErr: 0, speedPct: 0, search: DEADLY_SEARCH },
  perfect: { angleErr: 0, speedPct: 0, search: AI_SEARCH },
  hard: { angleErr: 0.006, speedPct: 0.03, search: AI_SEARCH },
  medium: { angleErr: 0.015, speedPct: 0.06, search: AI_SEARCH },
  easy: { angleErr: 0.03, speedPct: 0.12, search: AI_SEARCH },
  beginner: { angleErr: 0.06, speedPct: 0.22, search: AI_SEARCH },
};
const TRAJECTORY = { none: 0, immediate: 2, full: 30 };

// Shared controls help (the same for every game); the per-variant rules come from variant.rulesText.
const HOWTO = [
  'Drag on the table to aim — the predicted path appears once you set a direction.',
  'Power: the vertical slider. Spin: drag the dot on the round pad (up = follow, down = draw/screw, left/right = side).',
  'Nudge the angle with the ◀ ▶ buttons or the ← → arrow keys; press Fire (or Enter) to play; Reset clears power & spin.',
  'Ball-in-hand: grab the cue ball and drag it into position (inside the "D" for snooker & billiards; anywhere clear for pool).',
  'Difficulty sets the computer’s strength · Trajectories sets the aim-preview depth · tick Self-play to watch the computer play both sides.',
];

const el = (id) => document.getElementById(id);
// Computer-vs-computer (self-play) always plays at Deadly, regardless of the menu selection.
const difficulty = () => DIFFICULTY[selfPlay() ? 'deadly' : el('difficulty')?.value] ?? DIFFICULTY.medium;
const trajectoryDepth = () => TRAJECTORY[el('trajectory')?.value] ?? TRAJECTORY.full;
const aiEnabled = () => el('ai').checked;
const selfPlay = () => el('selfplay').checked;
// Computer-vs-computer plays out faster than a human watching a single shot: scale the replay
// playback rate and the AI's line-up / think delays by this factor (1× for human play).
const SELF_PLAY_SPEED = 3;
const animSpeed = () => (selfPlay() ? SELF_PLAY_SPEED : 1);
const soundOn = () => el('sound').checked;

// --- game/variant state ---
let game = newGame(snooker);
let variant = game.variant;

// world → screen mapping (recomputed when the variant/table changes; both tables are 2:1)
const MARGIN = 34;
const INNER_W = 940;
let SCALE = 1;
let HX = 1;
let HY = 1;
function rebuildView() {
  variant = game.variant;
  const b = variant.bounds();
  HX = b.maxX;
  HY = b.maxY;
  SCALE = INNER_W / (HX * 2);
  canvas.width = INNER_W + 2 * MARGIN;
  canvas.height = HY * 2 * SCALE + 2 * MARGIN;
  fillHelp();
}

// Populate the collapsible "How to play" (shared) and "Rules" (per-variant) lists.
function fillHelp() {
  const ul = (id, items) => {
    const e = el(id);
    if (!e) return;
    e.innerHTML = '';
    for (const t of items) {
      const li = document.createElement('li');
      li.textContent = t;
      e.appendChild(li);
    }
  };
  ul('howto-list', HOWTO);
  ul('rules-list', variant.rulesText || []);
}
const toPx = (x, y) => ({ px: MARGIN + (x + HX) * SCALE, py: MARGIN + (HY - y) * SCALE });
const sPx = (m) => m * SCALE;
const toWorld = (px, py) => ({ x: (px - MARGIN) / SCALE - HX, y: HY - (py - MARGIN) / SCALE });
const R = () => variant.ball.radius;

let mode = 'idle'; // 'idle' | 'aiming' | 'aiplan' | 'animating' | 'gameover'
let aimAngle = 0;
let aimed = false; // a human hasn't aimed this turn yet → don't draw a trajectory
let dragging = false;
let placing = false;
let pendingCue = null;
let power = 1.0;
let spin = { side: 0, vert: 0 };
let frameShots = 0; // shots played this frame; 0 ⇒ the opening break
const BREAK_POWER = 7.0; // open the frame with real pace (the pack won't scatter on a soft tap)

// Reset the cue controls to their per-turn defaults (no spin; a firm power for the break, else
// a gentle 1.0) and sync the UI.
function resetControls() {
  power = frameShots === 0 ? BREAK_POWER : 1.0;
  spin = { side: 0, vert: 0 };
  el('power').value = String(power);
  el('pwrval').textContent = power.toFixed(1);
}

// fine-tune angle nudging
let leftHeld = false;
let rightHeld = false;
let holdFrames = 0;
let holdDir = 0;
const ADJUST_STEP = 0.00006; // ~10× finer than before — angle nudges much more slowly
const ADJUST_ACCEL_MAX = 12;
const ADJUST_RAMP = 70;

// AI presentation
let aiPlan = null;
let aiPlanFrom = null;

// replay
let timeline = [];
let meta = new Map();
let endT = 0;
let startedAt = 0;
let soundIdx = 0;
let pendingMsg = '';

const isAITurn = () => !game.frame.frameOver && (selfPlay() || (aiEnabled() && game.frame.turn === 1));

// --- sound ---
let audioCtx = null;
let master = null; // compressor → destination, so loud overlapping knocks stay clean
function unlockAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    if (!audioCtx) {
      audioCtx = new AC();
      const comp = audioCtx.createDynamicsCompressor();
      const out = audioCtx.createGain();
      out.gain.value = 1.6; // overall loudness
      comp.connect(out).connect(audioCtx.destination);
      master = comp;
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {}
}
function knock(kind, intensity) {
  if (!soundOn() || !audioCtx || audioCtx.state !== 'running') return;
  try {
    const t = audioCtx.currentTime;
    const wall = kind === 'wall';
    const hard = Math.max(0, Math.min(1, intensity / 3.5));
    const len = Math.ceil(audioCtx.sampleRate * 0.05);
    const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const bp = audioCtx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = (wall ? 900 : 2000) * (0.9 + Math.random() * 0.2) + hard * (wall ? 400 : 1000);
    bp.Q.value = wall ? 4 : 8;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(Math.max(0.0003, (wall ? 1.1 : 1.4) * Math.max(0.28, hard)), t);
    g.gain.exponentialRampToValueAtTime(0.0003, t + (wall ? 0.06 : 0.04));
    src.connect(bp).connect(g).connect(master || audioCtx.destination);
    src.start(t); src.stop(t + 0.05);
  } catch {}
}

function cuePos() {
  if (game.frame.ballInHand) return pendingCue;
  const c = game.pieces.find((p) => p.id === 'cue');
  return c ? c.pos : null;
}

// --- drawing ---
function drawTable() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#5a3d1f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const tl = toPx(-HX, HY);
  ctx.fillStyle = variant.cloth;
  ctx.fillRect(tl.px, tl.py, sPx(HX * 2), sPx(HY * 2));
  variant.drawMarkings(ctx, { toPx, sPx });
  for (const pk of variant.pockets()) {
    const p = toPx(pk.center.x, pk.center.y);
    ctx.beginPath(); ctx.arc(p.px, p.py, sPx(pk.radius), 0, Math.PI * 2);
    ctx.fillStyle = '#06170d'; ctx.fill();
  }
  ctx.strokeStyle = '#2a1c0e';
  ctx.lineWidth = 3;
  ctx.strokeRect(tl.px, tl.py, sPx(HX * 2), sPx(HY * 2));
}

// Draw a ball from render info { fill, stripe, label } (variant-supplied).
// A ring colour that contrasts the cloth, so every ball reads clearly against the felt (dark
// cloth → light ring, light cloth → dark ring). Memoised on the cloth string — it rarely changes.
let _ringFor = { cloth: null, color: '#eee' };
function clothContrastRing() {
  const cloth = variant.cloth || '#000';
  if (cloth !== _ringFor.cloth) {
    const h = cloth.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b; // perceived brightness, 0..255
    _ringFor = { cloth, color: lum < 140 ? 'rgba(240,240,240,0.95)' : 'rgba(18,18,18,0.9)' };
  }
  return _ringFor.color;
}

function drawBall(x, y, radius, info, ghost = false) {
  const p = toPx(x, y);
  const rp = sPx(radius);
  ctx.save();
  ctx.globalAlpha = ghost ? 0.4 : 1;
  ctx.beginPath(); ctx.arc(p.px, p.py, rp, 0, Math.PI * 2);
  ctx.fillStyle = info.fill;
  ctx.fill();
  if (info.stripe) {
    ctx.save();
    ctx.clip();
    ctx.fillStyle = '#f5f3ea';
    ctx.fillRect(p.px - rp, p.py - rp * 0.42, rp * 2, rp * 0.84);
    ctx.restore();
  }
  // Contrasting rim INSIDE the ball edge (band rp-ringW..rp) so each ball reads against the cloth
  // — esp. dark balls and the 8 on dark felt. Clipped to the face so it stays within the piece.
  const ringW = Math.max(1.5, rp * 0.16);
  ctx.save();
  ctx.beginPath(); ctx.arc(p.px, p.py, rp, 0, Math.PI * 2); ctx.clip();
  ctx.lineWidth = ringW;
  ctx.strokeStyle = clothContrastRing();
  ctx.beginPath(); ctx.arc(p.px, p.py, rp - ringW / 2, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  if (info.label) {
    ctx.beginPath(); ctx.arc(p.px, p.py, rp * 0.5, 0, Math.PI * 2);
    ctx.fillStyle = '#f5f3ea'; ctx.fill();
    ctx.fillStyle = '#222';
    ctx.font = `${Math.max(7, rp * 0.8)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(info.label, p.px, p.py + 0.5);
  }
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.beginPath(); ctx.arc(p.px, p.py, rp, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

const renderInfo = (piece) => ({ fill: variant.colorOf(piece), stripe: variant.isStripe(piece), label: variant.label(piece) });

function drawStatic() {
  for (const p of game.pieces) {
    if (p.id === 'cue' && game.frame.ballInHand) continue;
    drawBall(p.pos.x, p.pos.y, R(), renderInfo(p));
  }
}

function samplePaths(tl, mta, dt = 0.02) {
  const paths = new Map();
  const sunk = new Set();
  for (let i = 0; i < tl.length - 1; i++) {
    const seg = tl[i];
    const span = tl[i + 1].t - seg.t;
    for (const e of seg.balls) {
      if (sunk.has(e.id)) continue;
      if (!paths.has(e.id)) paths.set(e.id, []);
      const plan = twoPhasePlan(e.pos, e.vel, e.spin, mta.get(e.id)?.radius ?? R());
      for (let tt = 0; tt <= span + 1e-9; tt += dt) paths.get(e.id).push(posAt(plan, tt));
      if (e.pocketed) sunk.add(e.id);
    }
  }
  return paths;
}

function drawPreview() {
  const cp = cuePos();
  const depth = trajectoryDepth();
  if (!cp || power <= 0 || depth <= 0) return;
  const pieces = game.pieces.map((p) => (p.id === 'cue' ? { ...p, pos: { ...cp } } : p));
  if (!pieces.some((p) => p.id === 'cue')) pieces.push({ id: 'cue', color: variant.cueColor, group: 'cue', kind: 'cue', pos: { ...cp } });
  const balls = buildBalls(pieces, variant.ball);
  const m = new Map(balls.map((b) => [b.id, { radius: b.radius }]));
  const res = simulate({ balls, bounds: variant.bounds(), pockets: variant.pockets() }, { ballId: 'cue', angle: aimAngle, speed: power, spin }, { maxEvents: depth });
  const paths = samplePaths(res.timeline, m);
  ctx.save();
  for (const [id, pts] of paths) {
    if (pts.length < 2) continue;
    const isCue = id === 'cue';
    ctx.strokeStyle = isCue ? 'rgba(245,243,234,0.85)' : 'rgba(255,255,255,0.35)';
    ctx.lineWidth = isCue ? 2 : 1.2;
    ctx.setLineDash(isCue ? [] : [4, 4]);
    ctx.beginPath();
    const a0 = toPx(pts[0].x, pts[0].y);
    ctx.moveTo(a0.px, a0.py);
    for (const q of pts) { const pp = toPx(q.x, q.y); ctx.lineTo(pp.px, pp.py); }
    ctx.stroke();
  }
  ctx.restore();
  ctx.setLineDash([]);
}

function drawSpinPad() {
  const pad = el('spinpad');
  const c = pad.getContext('2d');
  const w = pad.width;
  c.clearRect(0, 0, w, w);
  c.beginPath(); c.arc(w / 2, w / 2, w / 2 - 2, 0, Math.PI * 2);
  c.fillStyle = '#f5f3ea'; c.fill();
  c.strokeStyle = '#888'; c.stroke();
  const dx = w / 2 + spin.side * (w / 2 - 8);
  const dy = w / 2 - spin.vert * (w / 2 - 8);
  c.beginPath(); c.arc(dx, dy, 6, 0, Math.PI * 2);
  c.fillStyle = '#c0241f'; c.fill();
}

function updateHud() {
  el('s0').textContent = variant.sideValue(game.frame, 0);
  el('s1').textContent = variant.sideValue(game.frame, 1);
  el('on').textContent = variant.centerText(game.frame);
  el('pl0').classList.toggle('active', game.frame.turn === 0 && !game.frame.frameOver);
  el('pl1').classList.toggle('active', game.frame.turn === 1 && !game.frame.frameOver);
  el('p1name').textContent = aiEnabled() || selfPlay() ? 'Computer' : 'Player 2';
  el('msg').textContent = game.frame.frameOver
    ? game.frame.message + ' — refresh / switch game for a new frame'
    : mode === 'aiplan'
      ? 'Computer is lining up its shot…'
      : mode === 'aiming' && isAITurn()
        ? 'Computer thinking…'
        : game.frame.message;
  el('hint').textContent = isAITurn() || mode === 'aiplan'
    ? 'Computer is at the table…'
    : game.frame.ballInHand
      ? 'Ball in hand: drag the cue ball to position it, then drag elsewhere to aim. Set power & spin, then Fire.'
      : 'Drag on the table to aim. Set power and cue-tip spin (up = follow, down = draw, sideways = side). Fire.';
  const idle = mode !== 'aiming' || isAITurn();
  el('fire').disabled = idle || !cuePos();
  el('angleL').disabled = idle;
  el('angleR').disabled = idle;
  el('reset').disabled = idle;
}

// --- render scheduling ---
// Only run the rAF loop while something is actually moving: a shot animating, the AI lining up,
// or an angle nudge being held. When the table is static — the player thinking, the AI computing
// in workers, or the frame over — we draw the settled frame once and stop, instead of repainting
// 30 balls 60×/second for nothing. Input handlers and state transitions call kick() to wake it.
let rafScheduled = false;
function kick() {
  if (rafScheduled) return;
  rafScheduled = true;
  requestAnimationFrame(frame);
}
function needsContinuous() {
  if (mode === 'animating' || mode === 'aiplan') return true;
  return mode === 'aiming' && !isAITurn() && (leftHeld || rightHeld);
}

// --- main loop ---
function frame(now) {
  rafScheduled = false;
  drawTable();
  if (mode === 'animating') {
    const rate = 0.7 * animSpeed(); // physics-seconds per wall-second (3× in self-play)
    const simT = Math.min(((now - startedAt) / 1000) * rate, endT);
    while (soundIdx + 1 < timeline.length && timeline[soundIdx + 1].t <= simT) {
      soundIdx += 1;
      const s = timeline[soundIdx];
      if (s.kind === 'pair' || s.kind === 'wall') knock(s.kind, s.intensity);
    }
    let i = 0;
    while (i + 1 < timeline.length && timeline[i + 1].t <= simT) i += 1;
    const seg = timeline[i];
    for (const e of seg.balls) {
      if (e.pocketed) continue;
      const m = meta.get(e.id);
      const plan = twoPhasePlan(e.pos, e.vel, e.spin, m.radius);
      const p = posAt(plan, simT - seg.t);
      drawBall(p.x, p.y, m.radius, m);
    }
    if (((now - startedAt) / 1000) * rate >= endT) endAnimation();
  } else {
    drawStatic();
    if (mode === 'aiplan' && aiPlan) {
      renderAiPlan(now);
    } else if (mode === 'aiming' && !isAITurn()) {
      const dir = (leftHeld ? 1 : 0) - (rightHeld ? 1 : 0);
      if (dir !== 0) {
        if (dir !== holdDir) { holdFrames = 0; holdDir = dir; }
        holdFrames += 1;
        const accel = Math.min(ADJUST_ACCEL_MAX, 1 + (holdFrames / ADJUST_RAMP) * (ADJUST_ACCEL_MAX - 1));
        aimAngle += dir * ADJUST_STEP * accel;
      } else {
        holdFrames = 0;
        holdDir = 0;
      }
      const cp = cuePos();
      if (cp) {
        if (game.frame.ballInHand) drawBall(cp.x, cp.y, R(), { fill: variant.cueColor === 'cue' ? '#f5f3ea' : variant.cueColor, stripe: false, label: '' });
        if (aimed) drawPreview(); // only once the player has clicked/dragged to aim
      }
    }
  }
  drawSpinPad();
  updateHud();
  if (needsContinuous()) kick();
}

function endAnimation() {
  mode = game.frame.frameOver ? 'gameover' : 'aiming';
  soundIdx = 0;
  el('msg').textContent = pendingMsg;
  kick(); // render the settled table (and any game-over state) once, then idle
  if (game.frame.frameOver) return;
  aimed = false; // next player must aim before a trajectory is shown
  pendingCue = game.frame.ballInHand ? variant.defaultPlacement(game) : null;
  resetControls(); // each turn starts at power 1.0, no spin (the AI overrides during its plan)
  if (isAITurn()) setTimeout(aiMove, 500 / animSpeed());
}

function fire() {
  const cp = cuePos();
  if (!cp) return;
  const res = takeShot(game, { angle: aimAngle, speed: power, spin, cuePlacement: cp });
  frameShots += 1;
  timeline = res.timeline;
  meta = res.meta;
  endT = timeline.length ? timeline[timeline.length - 1].t : 0;
  pendingMsg = res.outcome.message;
  startedAt = performance.now();
  soundIdx = 0;
  pendingCue = null;
  leftHeld = rightHeld = false;
  mode = 'animating';
  kick();
}

// Take the AI's chosen shot and start its on-table line-up animation. Shared by the synchronous
// path and the worker-pool finalize, so the only difference between them is WHERE the search ran.
function applyAiShot(shot) {
  if (!isAITurn() || mode === 'animating') return;
  aiPlanFrom = game.frame.ballInHand ? pendingCue || variant.defaultPlacement(game) : cuePos() || variant.defaultPlacement(game);
  power = 0;
  spin = { side: 0, vert: 0 };
  aiPlan = { shot, startedAt: performance.now() };
  mode = 'aiplan';
  kick();
}

// --- AI search: parallelised across a Web Worker pool ---
// The candidate grid is split across CPU cores (each worker scores its slice and returns the scored
// variants); the main thread merges them and runs chooseShotFinish — identical to a single-threaded
// search, but ~cores× faster AND the main thread stays free so the table keeps animating while it
// "thinks". The opening break (random style) and a synchronous fallback both run on the main thread.
const AI_POOL_SIZE = Math.max(2, Math.min((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4, 8));
const AI_TIMEOUT_MS = 8000; // a worker that dies / never loads must not hang the turn
let aiPool = null; // null = unbuilt, false = unavailable, else Worker[]
let aiReqId = 0;
let aiPending = null; // in-flight fan-out: { reqId, diff, config, pending:Set<Worker>, scored, replies, timer }
function ensureAiPool() {
  if (aiPool !== null || typeof Worker === 'undefined') return aiPool;
  try {
    aiPool = [];
    for (let i = 0; i < AI_POOL_SIZE; i++) {
      const w = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => aiResolve(w, e.data.reqId, e.data.scored, false);
      w.onerror = () => aiResolve(w, w._aiReq, null, true); // error carries no reqId → use the dispatch one
      aiPool.push(w);
    }
  } catch {
    aiPool = false;
  }
  return aiPool;
}
// A pool worker answered for `reqId` — its scored slice, or an error. Each worker counts at most
// once, so neither a double-fire (message + error) nor a stale reply mis-balances the tally.
function aiResolve(worker, reqId, scored, isError) {
  if (!aiPending || reqId !== aiPending.reqId || !aiPending.pending.has(worker)) return;
  aiPending.pending.delete(worker);
  if (!isError) { aiPending.replies += 1; if (scored && scored.length) aiPending.scored.push(...scored); }
  if (aiPending.pending.size === 0) finalizeAiSearch();
}
function aiTimeout(reqId) {
  if (!aiPending || aiPending.reqId !== reqId) return;
  aiPending.pending.clear();
  finalizeAiSearch();
}
function finalizeAiSearch() {
  clearTimeout(aiPending.timer);
  const { scored, diff, config, replies } = aiPending;
  aiPending = null;
  // No worker even delivered a message → the pool is unusable (e.g. module workers unsupported).
  // Tear it down so later turns go straight to sync instead of stalling on dead workers each time.
  if (replies === 0 && Array.isArray(aiPool)) { for (const w of aiPool) w.terminate(); aiPool = false; }
  if (!isAITurn() || mode !== 'aiming') return; // the turn moved on while it thought
  // merge every slice → finish on the main thread (so the top-K refinements see the global best);
  // an empty merge with live workers is a real no-candidate position → fall back to a full sync search
  const shot = scored.length ? chooseShotFinish(game, config, scored) : chooseShot(game, config);
  applyAiShot(applyError(shot, diff));
}

function aiMove() {
  if (!isAITurn() || mode === 'gameover' || mode === 'animating' || aiPending) return;
  el('msg').textContent = 'Computer thinking…';
  setTimeout(() => {
    if (!isAITurn() || mode === 'animating' || aiPending) return;
    const diff = difficulty();
    const config = { ...diff.search, robust: { angleErr: diff.angleErr, speedPct: diff.speedPct } };
    const pool = ensureAiPool();
    // The opening break (snooker, full rack + ball-in-hand) stays on the main thread — its random
    // style must not fan out. Everything else fans across the pool when one is available.
    const isBreak = game.frame.ballInHand && game.frame.reds === 15;
    if (pool && pool.length && !isBreak) {
      const reqId = (aiReqId += 1);
      const variantName = el('game')?.value ?? 'snooker';
      aiPending = { reqId, diff, config, pending: new Set(pool), scored: [], replies: 0, timer: setTimeout(() => aiTimeout(reqId), AI_TIMEOUT_MS) };
      for (let i = 0; i < pool.length; i++) {
        pool[i]._aiReq = reqId;
        pool[i].postMessage({ variantName, frame: game.frame, pieces: game.pieces, config: { ...config, slice: { workers: pool.length, index: i } }, reqId });
      }
    } else {
      applyAiShot(applyError(chooseShot(game, config), diff)); // synchronous: break, or no workers
    }
  }, 60 / animSpeed());
}

const easeInOut = (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
function renderAiPlan(now) {
  const { shot } = aiPlan;
  const t = (now - aiPlan.startedAt) * animSpeed(); // line-up animation runs 3× faster in self-play
  const placingNow = game.frame.ballInHand;
  const T_PLACE = placingNow ? 500 : 0;
  const tCharge0 = T_PLACE + 250;
  const tCharge1 = tCharge0 + 550;
  const tFire0 = tCharge1 + 250;
  const tFire1 = tFire0 + 320;
  aimAngle = shot.angle;
  if (placingNow) {
    const k = T_PLACE ? Math.min(1, t / T_PLACE) : 1;
    const e = easeInOut(k);
    pendingCue = { x: aiPlanFrom.x + (shot.cuePos.x - aiPlanFrom.x) * e, y: aiPlanFrom.y + (shot.cuePos.y - aiPlanFrom.y) * e };
  }
  const cr = Math.max(0, Math.min(1, (t - tCharge0) / 550));
  const ce = 1 - (1 - cr) ** 3;
  power = ce * shot.speed;
  spin = { side: ce * shot.spin.side, vert: ce * shot.spin.vert };
  el('power').value = String(power);
  el('pwrval').textContent = power.toFixed(1);
  el('fire').classList.toggle('firing', t >= tFire0 && t < tFire1);
  if (placingNow) {
    const cp = cuePos();
    if (cp) drawBall(cp.x, cp.y, R(), { fill: variant.cueColor === 'cue' ? '#f5f3ea' : variant.cueColor, stripe: false, label: '' });
  }
  if (t >= T_PLACE) drawPreview();
  if (t >= tFire1) {
    el('fire').classList.remove('firing');
    if (placingNow) pendingCue = shot.cuePos;
    aimAngle = shot.angle;
    power = shot.speed;
    spin = shot.spin;
    aiPlan = null;
    fire();
  }
}

// --- input ---
function evWorld(ev) {
  const r = canvas.getBoundingClientRect();
  const px = (ev.clientX - r.left) * (canvas.width / r.width);
  const py = (ev.clientY - r.top) * (canvas.height / r.height);
  return toWorld(px, py);
}
canvas.addEventListener('pointerdown', (ev) => {
  unlockAudio();
  if (mode !== 'aiming' || isAITurn()) return;
  const w = evWorld(ev);
  const cp = cuePos();
  // ball-in-hand: GRAB the cue ball (click near it) to reposition it; any other click aims.
  // (Pool allows placement anywhere, so we must not treat every table click as a placement.)
  if (game.frame.ballInHand && cp && Math.hypot(w.x - cp.x, w.y - cp.y) <= 3 * R()) {
    placing = true;
    kick();
    return;
  }
  dragging = true;
  aimFromPointer(w);
  kick();
});
window.addEventListener('pointermove', (ev) => {
  if (mode !== 'aiming') return;
  const w = evWorld(ev);
  if (placing) {
    if (variant.placementLegal(game, w.x, w.y)) pendingCue = { x: w.x, y: w.y };
    kick();
  } else if (dragging) {
    aimFromPointer(w);
    kick();
  }
});
window.addEventListener('pointerup', () => { dragging = false; placing = false; });
function aimFromPointer(w) {
  const cp = cuePos();
  if (!cp) return;
  aimAngle = Math.atan2(w.y - cp.y, w.x - cp.x);
  aimed = true; // a direction has been chosen → the trajectory may now be drawn
}

el('power').addEventListener('input', (e) => { power = parseFloat(e.target.value); el('pwrval').textContent = power.toFixed(1); kick(); });

const pad = el('spinpad');
let padDrag = false;
function spinFromPad(ev) {
  const r = pad.getBoundingClientRect();
  const x = (ev.clientX - r.left) / r.width * 2 - 1;
  const y = (ev.clientY - r.top) / r.height * 2 - 1;
  const clamp = (vv) => Math.max(-1, Math.min(1, vv));
  let s = clamp(x);
  let vt = clamp(-y);
  const m = Math.hypot(s, vt);
  if (m > 1) { s /= m; vt /= m; }
  spin = { side: s, vert: vt };
}
pad.addEventListener('pointerdown', (e) => { padDrag = true; spinFromPad(e); kick(); });
window.addEventListener('pointermove', (e) => { if (padDrag) { spinFromPad(e); kick(); } });
window.addEventListener('pointerup', () => { padDrag = false; });

function holdButton(id, setter) {
  const b = el(id);
  const down = (e) => { e.preventDefault(); if (mode === 'aiming' && !isAITurn()) { setter(true); kick(); } };
  const up = () => setter(false);
  b.addEventListener('pointerdown', down);
  b.addEventListener('pointerup', up);
  b.addEventListener('pointerleave', up);
  b.addEventListener('pointercancel', up);
}
holdButton('angleL', (v) => { leftHeld = v; });
holdButton('angleR', (v) => { rightHeld = v; });

// Unlock/resume audio on the FIRST user gesture ANYWHERE — a button or a key, not only the table —
// and again whenever the tab regains focus (browsers suspend the AudioContext in the background).
// Without this, pressing Fire/Enter on a preset break leaves the context locked and the game silent.
for (const evt of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(evt, unlockAudio, { passive: true });
document.addEventListener('visibilitychange', () => { if (!document.hidden) unlockAudio(); });

window.addEventListener('keydown', (e) => {
  if (mode !== 'aiming' || isAITurn()) return;
  if (e.key === 'ArrowLeft') { leftHeld = true; e.preventDefault(); }
  else if (e.key === 'ArrowRight') { rightHeld = true; e.preventDefault(); }
  else if (e.key === 'Enter') { e.preventDefault(); if (!el('fire').disabled) fire(); }
  kick();
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowLeft') leftHeld = false;
  else if (e.key === 'ArrowRight') rightHeld = false;
});

el('fire').addEventListener('click', () => { if (mode === 'aiming' && !isAITurn()) fire(); });
el('reset').addEventListener('click', () => { if (mode === 'aiming' && !isAITurn()) { resetControls(); kick(); } });

// Self-play is computer vs computer → force the menu to "Deadly" and lock it; restore on exit.
let savedDifficulty = null;
function syncDifficultyUI() {
  const sel = el('difficulty');
  if (!sel) return;
  if (selfPlay()) {
    if (savedDifficulty === null) savedDifficulty = sel.value;
    sel.value = 'deadly';
    sel.disabled = true;
  } else if (savedDifficulty !== null) {
    sel.value = savedDifficulty;
    savedDifficulty = null;
    sel.disabled = false;
  } else {
    sel.disabled = false;
  }
}
el('selfplay').addEventListener('change', () => {
  syncDifficultyUI();
  if (isAITurn() && mode === 'aiming') aiMove();
  kick();
});

// Toggling these mid-turn changes what's shown (or whose turn it is) while the loop may be idle,
// so wake it — and let the computer take over immediately if Player 2 just became a computer.
el('ai').addEventListener('change', () => { if (isAITurn() && mode === 'aiming') aiMove(); kick(); });
el('trajectory').addEventListener('change', kick);

el('game').addEventListener('change', (e) => {
  game = newGame(VARIANTS[e.target.value] ?? snooker);
  rebuildView();
  el('title').textContent = `${variant.name.toUpperCase()} · v${VERSION} · event-driven two-phase physics`;
  aiPlan = null;
  timeline = [];
  start();
});

// --- boot ---
function start() {
  mode = 'aiming';
  frameShots = 0; // a fresh frame opens with the break
  aimed = false;
  pendingCue = game.frame.ballInHand ? variant.defaultPlacement(game) : null;
  resetControls();
  if (isAITurn()) setTimeout(aiMove, 600);
  kick(); // draw the opening position
}
rebuildView();
syncDifficultyUI();
el('title').textContent = `${variant.name.toUpperCase()} · v${VERSION} · event-driven two-phase physics`;
start(); // start() kicks the first render; the loop then sleeps until something moves
