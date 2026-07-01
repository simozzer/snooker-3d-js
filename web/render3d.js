// render3d.js — PRESENTATION-ONLY 3D replay of the analytic engine (Milestone D part 2).
//
// The deterministic engine resolves a shot into a typed timeline of event snapshots; this file only
// DRAWS it. Between two events each ball follows its closed-form plan, so we interpolate by
// rebuilding the plan from the snapshot at the start of the interval and evaluating posAt/spinAt —
// exactly the engine's own trajectory, so the drawn positions match the reported ones at every
// event (see replayState / the render-parity test). No physics lives here.
//
// Coordinate map: physics is z-up (x,y on the bed, z = height). three.js is y-up, so we map
//   physics (x, y, z)  →  three (x, z, y)   [physics height z → three's vertical Y].

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MAX_SPEED, CUSHION_RISE } from '../src/snooker.js';
import { railCylinders, pocketJaws } from '../src/table.js';
import { newGame, takeShot, buildBalls } from '../src/game.js';
import { simulate } from '../src/simulate.js';
import { snooker } from '../src/variants/snooker.js';
import { pool } from '../src/variants/pool.js';
import { nineball } from '../src/variants/nineball.js';
import { aiTurn, chooseShotFinish, difficultyConfig, executeShot } from '../src/ai.js';
import { buildPlanCache, replayState } from './replay.js';

// Variant-driven, like the 2D renderer: all geometry, dimensions, ball appearance, rules, and AI come
// from the selected variant. This file only draws — the physics/rules/AI are the headless engine the
// tests drive. railCylinders/pocketJaws are geometry builders that take (R, bounds, pockets), so the
// same code renders a snooker table or a (smaller) pool table just from the variant's own dimensions.
const VARIANTS = { snooker, pool, nineball };
let variant = snooker;
const S = 10; // scene scale (physics metres → scene units)
let R;
let B;
let topZ;
let HX;
let HY;
function applyVariantGeom() {
  R = variant.ball.radius;
  B = variant.bounds();
  HX = B.maxX;
  HY = B.maxY;
  topZ = R + CUSHION_RISE * R;
}
applyVariantGeom();

// physics (x,y,z) → three.Vector3 (x, z, y), scaled.
const P3 = (x, y, z) => new THREE.Vector3(x * S, z * S, y * S);

// --- scene -----------------------------------------------------------------------------------
const view = document.getElementById('view');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1116);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.shadowMap.enabled = true;
view.appendChild(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 0.9);
key.castShadow = true;
scene.add(key);

// Frame the camera + key light to the current table size (recalled when the variant changes, so a
// smaller pool table is zoomed in appropriately).
function frameCamera() {
  camera.position.set(0, HY * S * 2.4, HY * S * 3.0);
  key.position.set(HX * S, HY * S * 2, HY * S);
  controls.target.set(0, 0, 0);
  controls.update();
}
frameCamera();

function resize() {
  const w = view.clientWidth;
  const h = view.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h || 1;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// --- static table geometry (built once) ------------------------------------------------------
const cloth = new THREE.MeshStandardMaterial({ color: 0x1f7a4d, roughness: 0.9 });
const railMat = new THREE.MeshStandardMaterial({ color: 0x5a3d22, roughness: 0.7 });
const jawMat = new THREE.MeshStandardMaterial({ color: 0x3a2817, roughness: 0.6 });
const pocketMat = new THREE.MeshStandardMaterial({ color: 0x05070a, roughness: 1 });

function buildTable() {
  const g = new THREE.Group();
  // bed (a thin slab; its top surface is z=0 in physics, ball centre rides at z=R above it)
  const bed = new THREE.Mesh(new THREE.BoxGeometry(TABLE_W() * S, 0.02 * S, TABLE_H() * S), cloth);
  bed.position.set(0, -0.01 * S, 0);
  bed.receiveShadow = true;
  g.add(bed);

  // finite-height straight cushions: a box per rail cylinder, spanning its along-axis extent, sat
  // on the bed and rising to the cushion top (topZ). Its inner face marks where balls rebound.
  for (const rail of railCylinders(R, B, variant.pockets())) {
    const [lo, hi] = rail.span;
    const len = (hi - lo) * S;
    const thick = 0.06 * S;
    const height = topZ * S;
    const box = new THREE.Mesh(new THREE.BoxGeometry(rail.axis === 'x' ? len : thick, height, rail.axis === 'x' ? thick : len), railMat);
    const alongMid = (lo + hi) / 2;
    // sit the cushion just OUTSIDE the rebound line (perp), so its inner face is at the table edge
    const perpOut = rail.perp + Math.sign(rail.perp) * thick / (2 * S);
    const cx = rail.axis === 'x' ? alongMid : perpOut;
    const cy = rail.axis === 'x' ? perpOut : alongMid;
    box.position.copy(P3(cx, cy, topZ / 2));
    box.castShadow = true;
    g.add(box);
  }

  // rounded pocket jaws: a torus per jaw (matching the physics torus: ring radius + tube), lying in
  // the horizontal plane at nose height, so the curled nose reads around each mouth.
  for (const jaw of pocketJaws(R, B, variant.pockets())) {
    const t = new THREE.Mesh(new THREE.TorusGeometry(jaw.Rring * S, jaw.tube * S, 10, 24), jawMat);
    t.rotation.x = Math.PI / 2; // torus default is in xy-plane (three) → lay it flat (horizontal)
    t.position.copy(P3(jaw.cx, jaw.cy, jaw.z));
    g.add(t);
  }

  // pocket mouths: dark discs sunk at each pocket, radius = mouth (the visible opening).
  for (const p of variant.pockets()) {
    const disc = new THREE.Mesh(new THREE.CircleGeometry((p.mouth ?? p.radius) * S, 24), pocketMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.copy(P3(p.center.x, p.center.y, 0.001));
    g.add(disc);
  }
  return g;
}
const TABLE_W = () => B.maxX - B.minX;
const TABLE_H = () => B.maxY - B.minY;
let tableGroup = null;
function rebuildTable() {
  if (tableGroup) { scene.remove(tableGroup); tableGroup.traverse((o) => o.geometry?.dispose?.()); }
  tableGroup = buildTable();
  scene.add(tableGroup);
}
rebuildTable();

// --- balls -----------------------------------------------------------------------------------
// Appearance is variant-driven: `colorOf` gives each ball's colour, `isStripe` marks a stripe (drawn
// white with a coloured equatorial band), and `label` gives its number (drawn as a camera-facing
// decal). Snooker balls are plain coloured spheres with a spin spot; pool/9-ball balls are numbered.
// Each ball is an OUTER group (positioned) holding a number decal + an INNER "spinner" group (the
// sphere/band/spot) that rotates to show spin — so the number stays put while the ball rolls.
const CUE_FALLBACK = '#f5f3ea';

function ballColor(piece) {
  const isCue = piece.group === 'cue' || piece.id === 'cue';
  if (isCue) return new THREE.Color(variant.cueColor && variant.cueColor.startsWith('#') ? variant.cueColor : CUE_FALLBACK);
  return new THREE.Color(variant.colorOf ? variant.colorOf(piece) : '#cccccc');
}
// A camera-facing number decal (like a real pool ball's number circle), readable from any angle.
function numberSprite(text) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const c = cv.getContext('2d');
  c.fillStyle = '#f7f5ee';
  c.beginPath();
  c.arc(32, 32, 27, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = '#141414';
  c.font = `bold ${text.length > 1 ? 30 : 38}px system-ui, sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, 32, 35);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv) }));
  const s = R * S * 0.95;
  spr.scale.set(s, s, s);
  spr.position.set(0, R * S * 0.5, 0);
  return spr;
}
let ballMeshes = new Map(); // id → { grp, spinner }
function makeBallMesh(piece) {
  const grp = new THREE.Group(); // outer: positioned only
  const spinner = new THREE.Group(); // inner: rotates to show spin
  grp.add(spinner);
  const col = ballColor(piece);
  const stripe = variant.isStripe ? variant.isStripe(piece) : false;
  const base = stripe ? new THREE.Color(CUE_FALLBACK) : col; // a stripe = white ball + a coloured band
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(R * S, 28, 20), new THREE.MeshStandardMaterial({ color: base, roughness: 0.18 }));
  sphere.castShadow = true;
  spinner.add(sphere);
  if (stripe) {
    const band = new THREE.Mesh(new THREE.SphereGeometry(R * S * 1.003, 28, 12, 0, Math.PI * 2, Math.PI * 0.36, Math.PI * 0.28), new THREE.MeshStandardMaterial({ color: col, roughness: 0.18 }));
    spinner.add(band);
  }
  const label = variant.label ? variant.label(piece) : '';
  if (label) {
    grp.add(numberSprite(label)); // numbered ball: a camera-facing decal (doesn't spin with the ball)
  } else {
    const spot = new THREE.Mesh(new THREE.SphereGeometry(R * S * 0.28, 10, 8), new THREE.MeshStandardMaterial({ color: 0xffffff }));
    spot.position.set(0, R * S * 0.92, 0);
    spinner.add(spot); // spin spot rolls with the ball
  }
  return { grp, spinner };
}
function syncBallMeshes(pieces) {
  const ids = new Set(pieces.map((p) => p.id));
  for (const [id, m] of ballMeshes) if (!ids.has(id)) { scene.remove(m.grp); ballMeshes.delete(id); }
  for (const p of pieces) {
    if (!ballMeshes.has(p.id)) {
      const m = makeBallMesh(p);
      scene.add(m.grp);
      ballMeshes.set(p.id, m);
    }
    ballMeshes.get(p.id).grp.position.copy(P3(p.pos.x, p.pos.y, R));
    ballMeshes.get(p.id).grp.visible = true;
  }
}

// --- game state ------------------------------------------------------------------------------
// A seeded PRNG makes the AI reproducible; a fresh seed per frame keeps openings varied.
function mulberry32(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
let game = null;
let aiRng = mulberry32(1);
let timeline = [];
let planCache = null;
let endT = 0;

// (the interpolation core lives in replay.js — pure, no three.js, headlessly tested for parity.)

// accumulate a rolling orientation per ball from spin so the surface spot visibly turns
const orient = new Map();
function applyState(state, dt) {
  for (const [id, s] of state) {
    const m = ballMeshes.get(id);
    if (!m) continue;
    if (s.pocketed) {
      if (s.cleared) { m.grp.visible = true; m.grp.position.copy(P3(s.pos.x, s.pos.y, s.pos.z)); } // frozen where it left
      else { m.grp.visible = true; m.grp.position.copy(P3(s.pos.x, s.pos.y, -0.05)); } // dropped into the pocket
      continue;
    }
    m.grp.visible = true;
    m.grp.position.copy(P3(s.pos.x, s.pos.y, s.pos.z));
    // integrate the spin (rad/s) into a visible rotation of the ball's spinner (the number stays put)
    if (dt > 0) {
      const q = orient.get(id) ?? new THREE.Quaternion();
      const w = new THREE.Vector3(s.spin.x, s.spin.z, s.spin.y); // physics ω (x,y,z)→three (x,z,y)
      const ang = w.length() * dt;
      if (ang > 1e-9) { const dq = new THREE.Quaternion().setFromAxisAngle(w.normalize(), ang); q.premultiply(dq); }
      orient.set(id, q);
      m.spinner.quaternion.copy(q);
    }
  }
}

// --- UI + turn loop --------------------------------------------------------------------------
const el = (id) => document.getElementById(id);
const status = el('status');
const scoreEl = el('scores');
const sliders = { angle: el('angle'), power: el('power') };

// --- cue-ball spin pad -----------------------------------------------------------------------
// One widget replacing the side / follow-draw / elevation sliders. The inner disc is the cue ball
// seen tip-on: the dot is the contact point — x = side (english), y = follow (up) / draw (down). The
// outer ring is cue elevation (a jump shot): the marker's height off the bottom is the lift, 0° at
// the bottom rising symmetrically to MAX at the top.
let spin = { side: 0, vert: 0 };
let elevAngle = Math.PI / 2; // canvas angle of the ring marker; bottom (π/2) = 0° lift
const MAX_ELEV_DEG = 60;
function elevationDeg() {
  const d = Math.atan2(Math.sin(elevAngle - Math.PI / 2), Math.cos(elevAngle - Math.PI / 2));
  return (Math.abs(d) / Math.PI) * MAX_ELEV_DEG; // 0 at bottom → MAX at top, symmetric on both sides
}

// Aim is held at full precision here (the slider only shows 0.1° steps); the fine-tune keys/buttons
// integrate onto this so sub-slider nudges accumulate instead of rounding away.
let aimDeg = +sliders.angle.value;

function refreshLabels() {
  el('v-angle').textContent = `${aimDeg.toFixed(1)}°`;
  el('v-power').textContent = `${(+sliders.power.value).toFixed(1)} m/s`;
  el('v-spin').textContent = `${spin.side >= 0 ? 'R' : 'L'}${Math.abs(spin.side).toFixed(2)} · ${spin.vert >= 0 ? 'follow' : 'draw'} ${Math.abs(spin.vert).toFixed(2)} · lift ${Math.round(elevationDeg())}°`;
}
sliders.power.addEventListener('input', () => { refreshLabels(); refreshHumanPreview(); });
sliders.angle.addEventListener('input', () => { aimDeg = +sliders.angle.value; refreshLabels(); refreshHumanPreview(); });

const pad = el('spinpad');
const pctx = pad.getContext('2d');
const PAD = pad.width;
const PC = PAD / 2;
const R_IN = 42;   // inner ball radius (spin)
const R_RING = 55; // ring centreline radius
const RING_W = 12;
function drawPad() {
  pctx.clearRect(0, 0, PAD, PAD);
  pctx.lineWidth = RING_W;
  pctx.strokeStyle = '#2b3846'; // ring track
  pctx.beginPath(); pctx.arc(PC, PC, R_RING, 0, Math.PI * 2); pctx.stroke();
  const d = Math.atan2(Math.sin(elevAngle - Math.PI / 2), Math.cos(elevAngle - Math.PI / 2));
  pctx.strokeStyle = '#c9762f'; // lift fill: bottom → marker, the short way
  pctx.beginPath(); pctx.arc(PC, PC, R_RING, Math.PI / 2, elevAngle, d < 0); pctx.stroke();
  pctx.fillStyle = '#f0b072'; // ring marker
  pctx.beginPath(); pctx.arc(PC + Math.cos(elevAngle) * R_RING, PC + Math.sin(elevAngle) * R_RING, 5.5, 0, Math.PI * 2); pctx.fill();
  pctx.fillStyle = '#f5f3ea'; // cue ball
  pctx.beginPath(); pctx.arc(PC, PC, R_IN, 0, Math.PI * 2); pctx.fill();
  pctx.lineWidth = 1; pctx.strokeStyle = '#b8b3a3'; pctx.stroke();
  pctx.strokeStyle = 'rgba(0,0,0,0.16)'; // crosshair
  pctx.beginPath(); pctx.moveTo(PC - R_IN, PC); pctx.lineTo(PC + R_IN, PC); pctx.moveTo(PC, PC - R_IN); pctx.lineTo(PC, PC + R_IN); pctx.stroke();
  pctx.fillStyle = '#c0241f'; // contact-point dot: x = side, y = follow(up)/draw(down)
  pctx.beginPath(); pctx.arc(PC + spin.side * R_IN, PC - spin.vert * R_IN, 6, 0, Math.PI * 2); pctx.fill();
}

let padMode = null; // 'spin' | 'elev' — locked on pointerdown so a drag stays in its zone
function padFromPointer(ev) {
  const r = pad.getBoundingClientRect();
  const x = (ev.clientX - r.left) * (PAD / r.width) - PC;
  const y = (ev.clientY - r.top) * (PAD / r.height) - PC;
  const dist = Math.hypot(x, y);
  if (padMode === null) padMode = dist <= (R_IN + R_RING - RING_W / 2) / 2 ? 'spin' : 'elev';
  if (padMode === 'spin') {
    let sx = x / R_IN;
    let sy = -y / R_IN;
    const m = Math.hypot(sx, sy);
    if (m > 1) { sx /= m; sy /= m; } // clamp the contact point to the ball's edge
    spin = { side: sx, vert: sy };
  } else {
    elevAngle = Math.atan2(y, x); // marker follows the pointer round the ring
  }
  drawPad(); refreshLabels(); refreshHumanPreview();
}
pad.addEventListener('pointerdown', (ev) => { padMode = null; try { pad.setPointerCapture(ev.pointerId); } catch { /* non-capturable pointer */ } padFromPointer(ev); });
pad.addEventListener('pointermove', (ev) => { if (ev.buttons) padFromPointer(ev); });
pad.addEventListener('pointerup', () => { padMode = null; });
pad.addEventListener('dblclick', () => { spin = { side: 0, vert: 0 }; elevAngle = Math.PI / 2; drawPad(); refreshLabels(); refreshHumanPreview(); });

drawPad();
refreshLabels();

// --- trajectory preview ----------------------------------------------------------------------
// Mirror the 2D renderer's aim preview: a NON-committing simulate() capped at `maxEvents = depth`
// predicts where the balls would go, and we draw those paths. Depth is the menu selection:
//   none = off · immediate = ~to first contact (2 events) · full = the whole chain (30).
// The cue's own line is drawn solid/bright, every other ball dashed/faint — same as 2D. This shares
// the exact engine + interpolation the real shot uses, so the drawn line matches what will happen.
// full = Infinity → the engine runs the shot to REST (its own MAX_EVENTS safety cap applies), so the
// whole predicted path is drawn, not a truncated slice.
const TRAJECTORY = { none: 0, immediate: 2, full: Infinity };
const trajectoryDepth = () => TRAJECTORY[el('trajectory')?.value] ?? TRAJECTORY.full;

const previewGroup = new THREE.Group();
scene.add(previewGroup);
const cueLineMat = new THREE.LineBasicMaterial({ color: 0xf5f3ea, transparent: true, opacity: 0.9 });
const objLineMat = new THREE.LineDashedMaterial({ color: 0xbcd3e6, transparent: true, opacity: 0.5, dashSize: 0.6, gapSize: 0.4 });

function clearPreview() {
  for (const c of previewGroup.children) c.geometry.dispose();
  previewGroup.clear();
}

// Sample every ball's predicted path from a capped sim into scene-space polylines. We subdivide each
// inter-event interval so curved segments (spin swerve, flight arcs) read smoothly while the exact
// event points stay as crisp corners; pocketed/off samples are dropped so a line stops at its pot.
function samplePreview(res) {
  const tl = res.timeline;
  const paths = new Map();
  if (tl.length < 2) return paths;
  const cache = buildPlanCache(tl, R);
  const push = (id, v) => { (paths.get(id) ?? paths.set(id, []).get(id)).push(v); };
  const SUB = 8;
  const addAt = (t) => { for (const [id, s] of replayState(tl, cache, t)) if (!s.pocketed) push(id, P3(s.pos.x, s.pos.y, s.pos.z)); };
  for (let e = 0; e < tl.length - 1; e++) {
    const t0 = tl[e].t;
    const t1 = tl[e + 1].t;
    for (let s = 0; s < SUB; s++) addAt(t0 + (t1 - t0) * (s / SUB));
  }
  addAt(tl[tl.length - 1].t);
  return paths;
}

// Build the balls the way takeShot would (cue placed if the frame owes ball-in-hand), run a capped
// non-committing sim of `shot`, and return the sampled paths. Pure prediction — never mutates game.
function computePreviewPaths(shot, depth) {
  const pieces = game.pieces.map((p) => ({ ...p, pos: { ...p.pos } }));
  if (shot.cuePlacement) {
    const cue = pieces.find((p) => p.id === 'cue');
    if (cue) cue.pos = { ...shot.cuePlacement };
    else pieces.push({ id: 'cue', color: 'white', group: 'cue', kind: 'cue', pos: { ...shot.cuePlacement } });
  }
  const balls = buildBalls(pieces, variant.ball);
  const res = simulate(
    { balls, bounds: variant.bounds(), pockets: variant.pockets() },
    { ballId: 'cue', angle: shot.angle, speed: shot.speed, spin: shot.spin, elevation: shot.elevation || 0 },
    depth === Infinity ? {} : { maxEvents: depth }, // Infinity ⇒ engine default (run to rest)
  );
  return samplePreview(res);
}

function drawPreviewPaths(paths) {
  clearPreview();
  for (const [id, pts] of paths) {
    if (pts.length < 2) continue;
    const isCue = id === 'cue';
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), isCue ? cueLineMat : objLineMat);
    if (!isCue) line.computeLineDistances(); // required for the dashed material
    previewGroup.add(line);
  }
}

// The shot the human's sliders currently describe (also what humanShot fires).
function sliderShot() {
  return {
    angle: (aimDeg * Math.PI) / 180,
    speed: Math.min(+sliders.power.value, MAX_SPEED),
    spin: { side: spin.side, vert: spin.vert },
    elevation: (elevationDeg() * Math.PI) / 180,
    cuePlacement: game.frame.ballInHand ? variant.defaultPlacement(game) : null,
  };
}

// Redraw the human's aim preview — only when it's actually the human's turn to line up a shot.
function refreshHumanPreview() {
  const depth = trajectoryDepth();
  if (!game || playing || game.frame.frameOver || isAiTurn() || depth <= 0) { clearPreview(); return; }
  drawPreviewPaths(computePreviewPaths(sliderShot(), depth));
}

// Put a shot's control choices onto the widgets so a watcher can read what the AI picked (aim slider,
// power slider, spin pad). The AI never elevates, so lift stays at 0.
function showShotOnControls(shot) {
  aimDeg = ((((shot.angle * 180) / Math.PI) % 360) + 360) % 360;
  sliders.angle.value = aimDeg.toFixed(1);
  sliders.power.value = Math.min(shot.speed, MAX_SPEED).toFixed(1);
  spin = { side: shot.spin?.side ?? 0, vert: shot.spin?.vert ?? 0 };
  elevAngle = Math.PI / 2;
  refreshLabels();
  drawPad();
}

// A reasonable first try at the start of the human's turn: gentle pace, no spin, no lift.
function resetHumanControls() {
  sliders.power.value = '1.0';
  spin = { side: 0, vert: 0 };
  elevAngle = Math.PI / 2;
  refreshLabels();
  drawPad();
}

// The AI "lines up" before firing: animate its control widgets AND trajectory from a naive first try
// (its aim, 1.0 pace, no spin) to its FINAL chosen shot (its pace + spin), so a watcher sees the
// choice form, then play it. The frame loop drives the animation (see aiLineup handling).
let aiLineup = null;
function playAiShot(shot) {
  if (playing || game.frame.frameOver) { playShot(shot); return; }
  aiLineup = {
    first: { angle: shot.angle, speed: 1.0, spin: { side: 0, vert: 0 }, elevation: 0, cuePlacement: shot.cuePlacement },
    final: shot,
    start: performance.now(),
    dur: 1200,
  };
  status.textContent = 'AI lining up…';
}

el('trajectory').addEventListener('change', refreshHumanPreview);

const aiEnabled = () => el('aimode').value !== 'human'; // 'off' human-vs-human, else vs AI / self-play
const selfPlay = () => el('aimode').value === 'self';
const difficulty = () => el('difficulty').value; // easy | medium | hard
// Player 0 = you (unless self-play). Player 1 = AI (when AI is on).
const isAiTurn = () => !game.frame.frameOver && (selfPlay() || (aiEnabled() && game.frame.turn === 1));

let playing = false;
let simT = 0;
let lastFrame = 0;
let seedCounter = 1;

function updateScore() {
  // variant HUD: sideValue = each player's score/label, centerText = the current ball-on / state
  const a = variant.sideValue ? variant.sideValue(game.frame, 0) : game.frame.scores[0];
  const b = variant.sideValue ? variant.sideValue(game.frame, 1) : game.frame.scores[1];
  const on = variant.centerText ? variant.centerText(game.frame) : '';
  const who = game.frame.frameOver ? '' : `— ${isAiTurn() ? 'AI' : 'You'} to play`;
  scoreEl.textContent = `You ${a} · AI ${b}${on ? `   ·   ${on}` : ''}   ${who}`;
}

function newFrameGame() {
  playing = false;
  endReplay();
  aiLineup = null;
  aiRng = mulberry32(seedCounter++); // fresh seed each frame → varied openings, still reproducible
  game = newGame(variant, { rng: aiRng });
  syncBallMeshes(game.pieces);
  orient.clear();
  timeline = [];
  status.textContent = game.frame.message;
  updateScore();
  maybeAiTurn();
  if (!isAiTurn()) resetHumanControls();
  refreshHumanPreview();
}

// Resolve a shot through the real game/rules, replay it, then chain turns.
function playShot(shot) {
  if (playing) return;
  clearPreview(); // the aim line is spent the moment the shot is struck
  const res = takeShot(game, shot); // mutates game (rules + settled positions); returns the timeline
  timeline = res.timeline;
  planCache = buildPlanCache(timeline, R);
  endT = timeline.length ? timeline[timeline.length - 1].t : 0;
  status.textContent = res.outcome.message;
  updateScore();
  lastAngle = shot.angle;
  lastPots = pottedObjectBalls(timeline); // object balls dropped this shot → worth a replay
  simT = 0;
  soundIdx = 0;
  playing = true;
  lastFrame = performance.now();
}

// --- pot replays -----------------------------------------------------------------------------
// After a successful pot, re-play the SAME shot timeline once with a scripted, randomly-chosen camera
// (top-down / follow cue / chase the potted ball into its pocket / track the action), smoothly damped.
// Any key skips it. Physics untouched — this just re-runs the interpolation with the camera driven.
let replaying = false;
let replayInfo = null;
let lastPots = [];
let lastAngle = 0;
const replaysOn = () => el('replays').checked;

function pottedObjectBalls(tl) {
  const last = tl[tl.length - 1];
  if (!last) return [];
  return last.balls.filter((b) => b.pocketed && !b.cleared && b.id !== 'cue').map((b) => b.id);
}

// When does the ball(s) drop? Used both to slow-mo the key moment and to CUT the replay just after it
// (no dead time watching balls trickle to rest — TV cuts away once the shot's told its story).
function potMoments() {
  const drops = [];
  for (const ev of timeline) if (ev.kind === 'pocket' && ev.hit && lastPots.includes(ev.hit.id)) drops.push(ev.t);
  const first = drops.length ? drops[0] : endT;
  const last = drops.length ? drops[drops.length - 1] : endT;
  return { first, last };
}

function startReplay() {
  replaying = true;
  const treatments = ['top', 'cue', 'motion', 'object'];
  const treatment = treatments[Math.floor(Math.random() * treatments.length)];
  const followId = treatment === 'object' ? lastPots[Math.floor(Math.random() * lastPots.length)] : 'cue';
  const { first, last } = potMoments();
  replayInfo = {
    treatment,
    followId,
    potT: first, // slow-mo hardest around the (first) drop
    end: Math.min(endT, last + 0.9), // cut ~0.9 s after the last pot
    camPos: new THREE.Vector3(),
    camTgt: new THREE.Vector3(),
    init: false,
    prev: new Map(),
    savedPos: camera.position.clone(),
    savedTgt: controls.target.clone(),
  };
  controls.enabled = false;
  el('replayband').classList.add('on');
  status.textContent = '⟲ Replay';
  simT = 0;
  soundIdx = 0;
  orient.clear();
  applyState(replayState(timeline, planCache, 0), 0); // reset the balls to the shot start
  lastFrame = performance.now();
  playing = true;
}

// TV-director pacing: fast-forward the dead rolling, slow to a crawl around every collision, and go
// slowest of all right at the pot. Rate is a smooth function of the time to the nearest event.
function replayRate(t) {
  const rm = replayInfo;
  let nearest = Infinity;
  for (const ev of timeline) {
    if (ev.kind === 'start' || ev.kind === 'end') continue;
    const d = Math.abs(ev.t - t);
    if (d < nearest) nearest = d;
  }
  const FAST = 2.8; // boring gaps zip by
  const SLOW = 0.4; // collisions crawl
  const W = 0.3; // seconds either side of an event that count as "near"
  let r = FAST + (SLOW - FAST) * Math.max(0, 1 - nearest / W);
  const potNear = Math.abs(t - rm.potT);
  if (potNear < 0.4) r = Math.min(r, 0.22 + 0.6 * (potNear / 0.4)); // extra-slow bullet-time on the drop
  return r;
}

function endReplay() {
  if (replayInfo) {
    camera.position.copy(replayInfo.savedPos); // restore the pre-replay view
    controls.target.copy(replayInfo.savedTgt);
    controls.enabled = true;
    controls.update();
    replayInfo = null;
  }
  el('replayband').classList.remove('on');
  replaying = false;
}

function skipReplay() {
  if (!replaying) return;
  playing = false;
  endReplay();
  onReplayEnd();
}

// Centroid of the balls moving THIS frame (fallback: the cue), so the "motion" camera tracks the action.
function motionCentroid(state, rm) {
  let sx = 0;
  let sz = 0;
  let n = 0;
  for (const [id, s] of state) {
    if (s.pocketed) continue;
    const p = P3(s.pos.x, s.pos.y, s.pos.z);
    const prev = rm.prev.get(id);
    if (prev && p.distanceToSquared(prev) > (0.003 * S) ** 2) { sx += p.x; sz += p.z; n += 1; }
    rm.prev.set(id, p.clone());
  }
  if (n === 0) { const c = state.get('cue'); return c ? P3(c.pos.x, c.pos.y, c.pos.z) : new THREE.Vector3(0, 0, 0); }
  return new THREE.Vector3(sx / n, 0, sz / n);
}

// Compute the desired camera pose for the treatment from the current replay state, then damp toward it
// (exponential smoothing → smooth motion; sudden direction changes at collisions are eased, not snapped).
function driveReplayCamera(state) {
  const rm = replayInfo;
  const u = HY * S; // table-scaled distance unit
  const dPos = new THREE.Vector3();
  const dTgt = new THREE.Vector3();
  if (rm.treatment === 'top') {
    dTgt.set(0, 0, 0);
    dPos.set(0.001, u * 3.4, u * 0.55); // high overhead, a slight tilt so it reads as 3D
  } else if (rm.treatment === 'cue' || rm.treatment === 'object') {
    const b = state.get(rm.followId);
    const bp = b && !b.pocketed ? P3(b.pos.x, b.pos.y, b.pos.z) : rm.camTgt.clone(); // freeze on the ball as it drops
    const dir = new THREE.Vector3();
    const prev = rm.prev.get(rm.followId);
    if (prev) dir.copy(bp).sub(prev).setY(0);
    if (dir.lengthSq() < 1e-8) dir.set(Math.cos(lastAngle), 0, Math.sin(lastAngle)); // physics (x,y)→scene (x,z)
    dir.normalize();
    dTgt.copy(bp).addScaledVector(dir, u * 0.25); // look a little ahead of the ball
    dPos.copy(bp).addScaledVector(dir, -u * 0.9); // behind it…
    dPos.y = u * 0.7; // …and above
    rm.prev.set(rm.followId, bp.clone());
  } else {
    const c = motionCentroid(state, rm);
    dTgt.copy(c);
    dPos.set(c.x * 0.4, u * 2.0, c.z * 0.4 + u * 1.35); // elevated 3/4 over the action
  }
  if (!rm.init) { rm.camPos.copy(dPos); rm.camTgt.copy(dTgt); rm.init = true; }
  else { rm.camPos.lerp(dPos, 0.05); rm.camTgt.lerp(dTgt, 0.09); }
  camera.position.copy(rm.camPos);
  camera.lookAt(rm.camTgt);
}

// The human's shot from the sliders (aim/power/spin/elevation). Ball-in-hand uses the default D spot.
function humanShot() {
  if (playing || isAiTurn() || game.frame.frameOver) return;
  playShot(sliderShot());
}

// --- AI search: OFF the main thread across a Web Worker pool -------------------------------------
// Mirrors the 2D renderer: the candidate grid is sliced across the pool (each worker scores its
// slice via chooseShotGrid and returns the scored variants); the main thread merges them and runs
// chooseShotFinish, so the top-K refinements still see the GLOBAL best — identical to the sync
// aiTurn, just off the render loop so the table keeps drawing while the AI "thinks". The opening
// break (random style) and the no-worker fallback run synchronously via aiTurn. Determinism is
// preserved: chooseShotGrid is rng-free, so the only rng draw is executeShot's applyError — one per
// decision on both paths, same as aiTurn.
const AI_POOL_SIZE = Math.max(2, Math.min((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4, 8));
const AI_TIMEOUT_MS = 8000;
let aiPool = null; // null = unbuilt, false = unavailable, else Worker[]
let aiReqId = 0;
let aiPending = null; // in-flight fan-out
function ensureAiPool() {
  if (aiPool !== null || typeof Worker === 'undefined') return aiPool;
  try {
    aiPool = [];
    for (let i = 0; i < AI_POOL_SIZE; i++) {
      const w = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => aiResolve(w, e.data.reqId, e.data.scored, false);
      w.onerror = () => aiResolve(w, w._aiReq, null, true);
      aiPool.push(w);
    }
  } catch { aiPool = false; }
  return aiPool;
}
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
  const { scored, d, config, replies } = aiPending;
  aiPending = null;
  // No worker even answered → pool unusable; tear it down so later turns go straight to sync.
  if (replies === 0 && Array.isArray(aiPool)) { for (const w of aiPool) w.terminate(); aiPool = false; }
  if (!isAiTurn() || playing || game.frame.frameOver) return; // the turn moved on while it thought
  // merge every slice → finish on the main thread (top-K refinements see the global best); an empty
  // merge with live workers is a genuine no-candidate position → full sync aiTurn covers the fallback.
  if (!scored.length) { playAiShot(aiTurn(game, { difficulty: difficulty(), rng: aiRng })); return; }
  playAiShot(executeShot(game, d, chooseShotFinish(game, config, scored), aiRng));
}

// The AI decides (headless engine, off-thread when possible) and its shot animates through the SAME
// replay path. AI only DECIDES; playShot (engine + rules + renderer) plays it.
function aiShot() {
  if (playing || game.frame.frameOver || aiPending) return;
  status.textContent = 'AI thinking…';
  updateScore();
  // let the "thinking…" paint before dispatch
  setTimeout(() => {
    if (playing || game.frame.frameOver || aiPending) return;
    const { d, config } = difficultyConfig(difficulty(), aiRng);
    const pool = ensureAiPool();
    // The opening break (full rack + ball-in-hand) stays on the main thread — its random style must
    // not fan out to a pool where each worker would pick differently. So do everything else.
    const isBreak = game.frame.ballInHand && (variant.redCount === undefined || game.frame.reds === variant.redCount);
    if (pool && pool.length && !isBreak) {
      const reqId = (aiReqId += 1);
      aiPending = { reqId, d, config, pending: new Set(pool), scored: [], replies: 0, timer: setTimeout(() => aiTimeout(reqId), AI_TIMEOUT_MS) };
      // rng is a function → not structure-cloneable; strip it (the grid is rng-free anyway) before
      // posting. The main thread keeps `config` (with rng) for chooseShotFinish/executeShot.
      const { rng: _rng, ...wireConfig } = config;
      for (let i = 0; i < pool.length; i++) {
        pool[i]._aiReq = reqId;
        pool[i].postMessage({ variantName: el('game').value, frame: game.frame, pieces: game.pieces, config: { ...wireConfig, slice: { workers: pool.length, index: i } }, reqId });
      }
    } else {
      playAiShot(aiTurn(game, { difficulty: difficulty(), rng: aiRng })); // synchronous: break, or no workers
    }
  }, 30);
}

function maybeAiTurn() {
  if (isAiTurn() && !playing && !game.frame.frameOver && !aiPending) aiShot();
}

// Called once a shot's replay finishes: settle the meshes to the resolved layout, then hand off.
function onReplayEnd() {
  syncBallMeshes(game.pieces); // authoritative resting positions from the rules reconciliation
  updateScore();
  if (game.frame.frameOver) { status.textContent = game.frame.message; return; }
  maybeAiTurn();
  if (!isAiTurn()) resetHumanControls(); // your shot → start from a reasonable first try (1.0, no spin)
  refreshHumanPreview(); // if it's now your shot, show the aim line
}

// Switch game (snooker / 8-ball / 9-ball): swap the variant, rebuild the table + camera for its
// dimensions, drop the old balls, and rack a fresh frame. Physics/rules/AI follow the variant.
function setVariant(v) {
  aiLineup = null;
  playing = false;
  endReplay();
  variant = v;
  applyVariantGeom();
  rebuildTable();
  frameCamera();
  for (const [, m] of ballMeshes) scene.remove(m.grp);
  ballMeshes.clear();
  orient.clear();
  const h1 = document.querySelector('#panel h1');
  if (h1) h1.textContent = `${variant.name ?? 'SNOOKER'} · 3D`;
  newFrameGame();
}

el('play').addEventListener('click', humanShot);
el('newframe').addEventListener('click', newFrameGame);
el('aimode').addEventListener('change', () => { updateScore(); maybeAiTurn(); refreshHumanPreview(); });
el('game').addEventListener('change', () => setVariant(VARIANTS[el('game').value] ?? snooker));

// --- aiming: click the table, or fine-tune with buttons / arrow keys --------------------------
// A click on the bed raycasts to the table plane and aims the cue ball at that point; a drag is left
// for OrbitControls (orbit), so we only treat a near-stationary press as an aim click. ◀ ▶ and the
// arrow keys nudge the angle for fine adjustment. The angle slider stays as a coarse control/readout.
const raycaster = new THREE.Raycaster();
const tablePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -R * S); // horizontal plane at ball-centre height
// Fine-tune is HELD, not tapped: each frame it nudges the angle by a very fine base amount that ramps
// up the longer you hold (like the 2D version) — a tap barely moves, a hold accelerates smoothly.
const AIM_BASE_DEG = (0.00006 * 180) / Math.PI; // ≈0.0034°/frame — the 2D base, in degrees
const AIM_ACCEL_MAX = 12; // hold long enough → up to 12× the base rate
const AIM_RAMP = 70; // frames to reach max acceleration (~1.2s at 60fps)
let aimHeldDir = 0; // -1 (left) | 0 | +1 (right)
let aimHoldFrames = 0;

function cueBallPos() {
  const c = game.pieces.find((p) => p.id === 'cue');
  if (c) return c.pos;
  return game.frame.ballInHand ? variant.defaultPlacement(game) : { x: 0, y: 0 };
}
function setAim(deg) {
  aimDeg = ((deg % 360) + 360) % 360;
  sliders.angle.value = aimDeg.toFixed(1);
  refreshLabels();
  refreshHumanPreview();
}
function pointerToTable(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  tablePlane.constant = -R * S; // track the current variant's ball-centre height
  raycaster.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(tablePlane, hit)) return null;
  return { x: hit.x / S, y: hit.z / S }; // three (x,z,y) → physics (x,y)
}

let aimDown = null;
renderer.domElement.addEventListener('pointerdown', (ev) => { aimDown = { x: ev.clientX, y: ev.clientY }; });
renderer.domElement.addEventListener('pointerup', (ev) => {
  const start = aimDown;
  aimDown = null;
  if (!start || Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 6) return; // a drag → orbit, not aim
  if (!game || playing || isAiTurn() || game.frame.frameOver) return;
  const t = pointerToTable(ev);
  if (!t) return;
  const c = cueBallPos();
  if (t.x === c.x && t.y === c.y) return;
  setAim((Math.atan2(t.y - c.y, t.x - c.x) * 180) / Math.PI);
});

function holdAimButton(button, dir) {
  const down = (ev) => { aimHeldDir = dir; try { button.setPointerCapture(ev.pointerId); } catch { /* non-capturable */ } };
  const up = () => { if (aimHeldDir === dir) { aimHeldDir = 0; aimHoldFrames = 0; } };
  button.addEventListener('pointerdown', down);
  button.addEventListener('pointerup', up);
  button.addEventListener('pointerleave', up);
  button.addEventListener('pointercancel', up);
}
holdAimButton(el('angleL'), -1);
holdAimButton(el('angleR'), 1);
window.addEventListener('keydown', (ev) => {
  if (replaying) { skipReplay(); ev.preventDefault(); return; } // any key skips a pot replay
  if (document.activeElement === sliders.angle) return; // let the focused slider handle its own arrows
  if (ev.key === 'ArrowLeft') { aimHeldDir = -1; ev.preventDefault(); }
  else if (ev.key === 'ArrowRight') { aimHeldDir = 1; ev.preventDefault(); }
});
window.addEventListener('keyup', (ev) => {
  if ((ev.key === 'ArrowLeft' && aimHeldDir === -1) || (ev.key === 'ArrowRight' && aimHeldDir === 1)) { aimHeldDir = 0; aimHoldFrames = 0; }
});

// --- sound: synthesised collision knocks (ported from the 2D renderer) --------------------------
// A short noise burst → bandpass → fast decay, volume/brightness scaled by impact speed. Ball-ball
// (pair) is a bright click; cushions (rail/jaw/frame) a duller knock; a bed landing a low thud.
const soundOn = () => el('sound').checked;
let audioCtx = null;
let master = null; // compressor → destination, so overlapping knocks stay clean
let soundIdx = 0; // last timeline event whose sound has played, during replay
function unlockAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    if (!audioCtx) {
      audioCtx = new AC();
      const comp = audioCtx.createDynamicsCompressor();
      const out = audioCtx.createGain();
      out.gain.value = 1.6;
      comp.connect(out).connect(audioCtx.destination);
      master = comp;
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* audio unavailable */ }
}
function knock(kind, intensity) {
  if (!soundOn() || !audioCtx || audioCtx.state !== 'running') return;
  try {
    const t = audioCtx.currentTime;
    const cushion = kind === 'rail' || kind === 'jaw' || kind === 'frame';
    const bed = kind === 'bed';
    const hard = Math.max(0, Math.min(1, intensity / 3.5));
    const len = Math.ceil(audioCtx.sampleRate * 0.05);
    const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const bp = audioCtx.createBiquadFilter();
    bp.type = 'bandpass';
    const baseHz = bed ? 320 : cushion ? 900 : 2000;
    const spread = bed ? 200 : cushion ? 400 : 1000;
    bp.frequency.value = baseHz * (0.9 + Math.random() * 0.2) + hard * spread;
    bp.Q.value = bed ? 3 : cushion ? 4 : 8;
    const g = audioCtx.createGain();
    const peak = (bed ? 0.8 : cushion ? 1.1 : 1.4) * Math.max(bed ? 0.18 : 0.28, hard);
    g.gain.setValueAtTime(Math.max(0.0003, peak), t);
    g.gain.exponentialRampToValueAtTime(0.0003, t + (cushion ? 0.06 : bed ? 0.07 : 0.04));
    src.connect(bp).connect(g).connect(master || audioCtx.destination);
    src.start(t);
    src.stop(t + 0.08);
  } catch { /* ignore a dropped knock */ }
}
// browsers require a user gesture to start audio — resume on the first one, then stop listening
const unlockOnce = () => { unlockAudio(); window.removeEventListener('pointerdown', unlockOnce, true); window.removeEventListener('keydown', unlockOnce, true); };
window.addEventListener('pointerdown', unlockOnce, true);
window.addEventListener('keydown', unlockOnce, true);
el('sound').addEventListener('change', unlockAudio);

function frame(now) {
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;
  // held fine-tune: integrate the aim each frame, accelerating the longer it's held
  if (aimHeldDir !== 0 && game && !playing && !isAiTurn() && !game.frame.frameOver) {
    aimHoldFrames += 1;
    const accel = Math.min(AIM_ACCEL_MAX, 1 + (aimHoldFrames / AIM_RAMP) * (AIM_ACCEL_MAX - 1));
    setAim(aimDeg + aimHeldDir * AIM_BASE_DEG * accel);
  } else if (aimHoldFrames !== 0) {
    aimHoldFrames = 0;
  }
  // AI lining up: morph its controls + trajectory from the naive first try to its final choice, then fire
  if (aiLineup && !playing) {
    const p = Math.min(1, (now - aiLineup.start) / aiLineup.dur);
    const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; // easeInOut
    const a = aiLineup.first;
    const b = aiLineup.final;
    const disp = {
      angle: b.angle,
      speed: a.speed + (b.speed - a.speed) * e,
      spin: { side: (b.spin?.side ?? 0) * e, vert: (b.spin?.vert ?? 0) * e },
      elevation: 0,
      cuePlacement: b.cuePlacement,
    };
    showShotOnControls(disp);
    if (trajectoryDepth() > 0) drawPreviewPaths(computePreviewPaths(disp, trajectoryDepth()));
    if (p >= 1) { const shot = aiLineup.final; aiLineup = null; playShot(shot); }
  }
  if (playing && timeline.length) {
    // a replay warps time (slow-mo the pot, fast-forward the dead rolling); the live pass is 1×
    const simDt = dt * (replaying ? replayRate(simT) : 1);
    simT += simDt;
    const activeEnd = replaying ? replayInfo.end : endT; // a replay cuts just after the pot
    let ended = false;
    if (simT >= activeEnd) { simT = activeEnd; ended = true; }
    // fire a knock for each collision event the playback time has now passed
    while (soundIdx + 1 < timeline.length && timeline[soundIdx + 1].t <= simT) {
      soundIdx += 1;
      const s = timeline[soundIdx];
      if (s.kind === 'pair' || s.kind === 'rail' || s.kind === 'jaw' || s.kind === 'frame' || s.kind === 'bed') knock(s.kind, s.intensity || 0);
    }
    const state = replayState(timeline, planCache, simT);
    applyState(state, simDt);
    if (replaying) driveReplayCamera(state);
    if (ended) {
      playing = false;
      if (replaying) { endReplay(); onReplayEnd(); } // the cinematic pass finished → hand off
      else if (replaysOn() && lastPots.length) startReplay(); // a pot → replay the shot cinematically
      else onReplayEnd();
    }
  }
  if (!replaying) controls.update(); // don't fight the scripted replay camera
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

resize();
newFrameGame();
requestAnimationFrame(frame);
