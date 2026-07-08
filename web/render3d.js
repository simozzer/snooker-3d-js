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
import { carrom } from '../src/variants/carrom.js';
import { aiTurn, chooseShotFinish, difficultyConfig, executeShot, shouldRecallMiss } from '../src/ai.js';
import { build147 } from '../src/exhibition.js';
import { getLevel, runTrickShot, findSolution, CURATED_COUNT } from '../src/trickshots.js';
import { buildPlanCache, replayState } from './replay.js';
import { makeStudioEnv } from './materials.js';
import { initSound, unlockAudio, knock, applause } from './sound.js';
import { initReferee, announce } from './referee.js';
import { makeBallMesh } from './balls3d.js';
import { buildTable, kickNet, updateNets, NET_DEPTH } from './table3d.js';
import { createPreview } from './preview3d.js';
import { driveReplayCamera } from './replaycam.js';
import { buildCrowd } from './crowd.js';
import { encodeFrame, decodeFrame, verifyFrame, variantId as shareVariantId, variantById as shareVariantById } from '../src/share.js';

// Variant-driven, like the 2D renderer: all geometry, dimensions, ball appearance, rules, and AI come
// from the selected variant. This file only draws — the physics/rules/AI are the headless engine the
// tests drive. railCylinders/pocketJaws are geometry builders that take (R, bounds, pockets), so the
// same code renders a snooker table or a (smaller) pool table just from the variant's own dimensions.
const VARIANTS = { snooker, pool, nineball, carrom };
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
renderer.shadowMap.type = THREE.PCFSoftShadowMap; // soft, penumbra-ish shadows
renderer.toneMapping = THREE.ACESFilmicToneMapping; // filmic response so highlights on brass/balls don't clip
renderer.toneMappingExposure = 1.15;
view.appendChild(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);

// A procedurally-generated soft "snooker hall" environment (no external HDR needed): a bright overhead
// band on a cool room gradient, run through PMREM. It gives brass plates, polished wood and the balls
// believable reflections and a gentle sheen — the single biggest lift to realism — and lights the room.
scene.environment = makeStudioEnv(renderer);
scene.add(new THREE.AmbientLight(0xffffff, 0.35)); // flat base fill so the far corners never fall dark
scene.add(new THREE.HemisphereLight(0xeaf0ff, 0x141a1f, 0.6)); // sky/ground fill lifts the shadow tone
const key = new THREE.DirectionalLight(0xfff4e2, 1.05); // warm overhead key — casts the table shadow
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.00018;
scene.add(key);
const fill = new THREE.DirectionalLight(0xbcd4ff, 0.22); // cool low fill from the opposite side
scene.add(fill);

// Frame the camera + key light to the current table size (recalled when the variant changes, so a
// smaller pool table is zoomed in appropriately).
function frameCamera() {
  camera.position.set(0, HY * S * 2.4, HY * S * 3.0);
  key.position.set(HX * S * 0.6, HY * S * 2.6, HY * S * 1.2);
  fill.position.set(-HX * S, HY * S * 1.4, -HY * S * 1.2);
  // fit the key light's shadow camera to the table so 2048² resolution isn't wasted on empty space
  const sc = key.shadow.camera;
  const r = Math.max(HX, HY) * S * 1.6;
  sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r; sc.near = 1; sc.far = HY * S * 8;
  sc.updateProjectionMatrix();
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

// --- static table geometry (materials.js + table3d.js) ---------------------------------------
// The table mesh + nets are built in table3d.js from a small geometry context; the renderer keeps the
// nets array (pocket-bag layout + swing) and the tableGroup handle.
let pocketNets = []; // [{ cx, cy, grp, jig }] — string baskets that swing when a ball drops in
let tableGroup = null;
function rebuildTable() {
  if (tableGroup) { scene.remove(tableGroup); tableGroup.traverse((o) => o.geometry?.dispose?.()); }
  const built = buildTable({ variant, S, R, B, HX, HY, topZ, P3 }); // geometry context (recomputed per variant)
  tableGroup = built.group;
  pocketNets = built.nets;
  scene.add(tableGroup);
}
rebuildTable();
// A faint Lowry-esque arena + audience ringing the table — pure background atmosphere (built once,
// sized to the opening table; sits well beyond any camera so it never obscures play). Its eyes track
// the ball each frame (crowd.update), so the gaze follows the action.
const crowd = buildCrowd(HX * S, HY * S);
scene.add(crowd.group);

// --- balls -----------------------------------------------------------------------------------
// Ball appearance (variant-driven mesh construction) lives in balls3d.js; the renderer owns the
// registry (ballMeshes) and the per-frame positioning/spin below.
let ballMeshes = new Map(); // id → { grp, spinner }
const gazePrev = new Map(); // id → last scene pos, so the crowd can gaze at where the ACTION is moving

// The cue stick — shown only while a live shot is being cued (behind the cue ball, striking down the
// aim line). Local +Y runs butt→tip so we can aim it by rotating +Y onto the shot direction.
const CUE_LEN = 1.45; // m
const cueStick = new THREE.Group();
{
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.006 * S, 0.014 * S, CUE_LEN * S, 16), new THREE.MeshStandardMaterial({ color: 0xc79a5b, roughness: 0.5 }));
  shaft.castShadow = true;
  const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.006 * S, 0.006 * S, 0.03 * S, 12), new THREE.MeshStandardMaterial({ color: 0x1f5fa8, roughness: 0.6 }));
  tip.position.y = (CUE_LEN * S) / 2;
  cueStick.add(shaft, tip);
}
cueStick.visible = false;
scene.add(cueStick);

function syncBallMeshes(pieces) {
  const ids = new Set(pieces.map((p) => p.id));
  for (const [id, m] of ballMeshes) if (!ids.has(id)) { scene.remove(m.grp); ballMeshes.delete(id); }
  for (const p of pieces) {
    if (!ballMeshes.has(p.id)) {
      const m = makeBallMesh(p, variant, R, S);
      scene.add(m.grp);
      ballMeshes.set(p.id, m);
    }
    const m = ballMeshes.get(p.id);
    m.grp.position.copy(P3(p.pos.x, p.pos.y, R));
    m.grp.visible = true;
    if (m.spot) m.spot.visible = false; // these are authoritative RESTING positions — no spin to show
  }
}

// --- game state ------------------------------------------------------------------------------
// A seeded PRNG makes the AI reproducible; a fresh seed per frame keeps openings varied.
function mulberry32(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
let game = null;
let trick = null; // Trick Shots mode state: { index, level, awaiting, passed } — null when not in the mode
let aiRng = mulberry32(1);
let timeline = [];
let planCache = null;
let endT = 0;

// (the interpolation core lives in replay.js — pure, no three.js, headlessly tested for parity.)

// accumulate a rolling orientation per ball from spin so the surface spot visibly turns
const orient = new Map();
const SPIN_SHOW = 0.35; // rad/s — below this the ball is effectively at rest, so hide its spin spot
window.__spinSpots = () => { let n = 0; for (const [, m] of ballMeshes) if (m.spot && m.spot.visible) n++; return n; }; // headless test hook
const BAG_SLOTS = [[0, 0], [1.05, 0.2], [0.5, 1.0]]; // up to 3 resting spots (in ball-radius units) in a bag
function applyState(state, dt) {
  // lay potted balls to rest clustered in their nearest pocket's bag, so a full net shows up to 3 balls
  const bags = new Map(); // pocketIndex → [ids], deepest-first order of arrival
  for (const [id, s] of state) {
    if (!s.pocketed || s.cleared) continue;
    let bi = -1;
    let bd = Infinity;
    for (let i = 0; i < pocketNets.length; i++) { const d = Math.hypot(pocketNets[i].cx - s.pos.x, pocketNets[i].cy - s.pos.y); if (d < bd) { bd = d; bi = i; } }
    if (bi >= 0) (bags.get(bi) ?? bags.set(bi, []).get(bi)).push(id);
  }
  const bagPos = new Map(); // id → resting {x,y,z}
  for (const [bi, ids] of bags) {
    const n = pocketNets[bi];
    ids.sort();
    ids.forEach((id, k) => {
      const [sx, sy] = BAG_SLOTS[k % 3];
      bagPos.set(id, { x: n.cx + sx * R * 1.1, y: n.cy + sy * R * 1.1, z: -(NET_DEPTH - R * 1.5) - Math.floor(k / 3) * R * 1.8 });
    });
  }
  for (const [id, s] of state) {
    const m = ballMeshes.get(id);
    if (!m) continue;
    if (m.spot) m.spot.visible = false; // hidden by default; shown below only while the ball is spinning
    if (s.pocketed) {
      if (s.cleared) { m.grp.visible = true; m.grp.position.copy(P3(s.pos.x, s.pos.y, s.pos.z)); continue; } // frozen where it left
      const b = bagPos.get(id) ?? { x: s.pos.x, y: s.pos.y, z: -0.05 };
      m.grp.visible = true;
      m.grp.position.copy(P3(b.x, b.y, b.z)); // resting in the bag
      continue;
    }
    m.grp.visible = true;
    m.grp.position.copy(P3(s.pos.x, s.pos.y, s.pos.z));
    // the white spin spot is only meaningful while the ball moves — show it when spinning, hide at rest
    if (m.spot) m.spot.visible = Math.hypot(s.spin.x, s.spin.y, s.spin.z) > SPIN_SHOW;
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
sliders.power.addEventListener('input', () => { cancelTrickAuto(); refreshLabels(); refreshHumanPreview(); });
sliders.angle.addEventListener('input', () => { aimDeg = +sliders.angle.value; refreshLabels(); refreshHumanPreview(); });

const pad = el('spinpad');
const pctx = pad.getContext('2d');
const PAD = pad.width;
const PC = PAD / 2;
const R_IN = 42;   // inner ball radius (spin)
const R_RING = 55; // ring centreline radius
const RING_W = 12;
// The lowest `vert` (follow−draw) the human may set right now: if the current aim forces the cue up
// (ball / cushion behind the white), draw is locked out. −1 when the shot is open.
function currentMinVert() {
  if (!game || isAiTurn() || game.frame.frameOver) return -1;
  const cue = game.pieces.find((p) => p.id === 'cue');
  const pos = game.frame.ballInHand ? variant.defaultPlacement(game) : cue && cue.pos;
  return pos ? forcedMinFollow(pos, (aimDeg * Math.PI) / 180) : -1;
}
function clampSpinToConstraint() {
  const mv = currentMinVert();
  if (mv > -1 && spin.vert < mv) spin.vert = mv;
}
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
  const mv = currentMinVert(); // lock out the draw zone when the cue is forced up (over a ball / off a cushion)
  if (mv > -1) {
    const lineY = PC - mv * R_IN; // below this line = forbidden (draw / insufficient follow)
    pctx.save();
    pctx.beginPath(); pctx.arc(PC, PC, R_IN, 0, Math.PI * 2); pctx.clip();
    pctx.fillStyle = 'rgba(150,40,40,0.34)';
    pctx.fillRect(PC - R_IN, lineY, 2 * R_IN, PC + R_IN - lineY);
    pctx.restore();
    pctx.strokeStyle = 'rgba(226,59,59,0.85)'; pctx.lineWidth = 1.5;
    pctx.beginPath(); pctx.moveTo(PC - R_IN, lineY); pctx.lineTo(PC + R_IN, lineY); pctx.stroke();
  }
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
    const mv = currentMinVert();
    if (mv > -1 && sy < mv) sy = mv; // can't strike low when the cue is forced up
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

// Preview drawing (group + materials + sampling/draw) lives in preview3d.js; thin wrappers keep the call
// sites here unchanged. samplePreview passes the current variant R (which changes per variant).
const preview = createPreview(scene, P3);
const clearPreview = () => preview.clear();
const samplePreview = (res) => preview.sample(res, R);

// Build the balls the way takeShot would (cue placed if the frame owes ball-in-hand), run a capped
// non-committing sim of `shot`, and return the sampled paths. Pure prediction — never mutates game.
function computePreviewPaths(shot, depth) {
  if (trick && trick.level) return samplePreview(runTrickShot(trick.level, shot)); // include the cue-rails + full path
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

const drawPreviewPaths = (paths) => preview.draw(paths);

// The shot the human's sliders currently describe (also what humanShot fires).
function sliderShot() {
  return {
    angle: (aimDeg * Math.PI) / 180,
    speed: Math.min(+sliders.power.value, MAX_SPEED),
    spin: { side: spin.side, vert: spin.vert },
    elevation: (elevationDeg() * Math.PI) / 180,
    cuePlacement: game.frame.ballInHand ? (heldCuePos ?? variant.defaultPlacement(game)) : null,
  };
}

// Redraw the human's aim preview — only when it's actually the human's turn to line up a shot. Also
// re-evaluates the cue-lift spin lock for the new aim (draw may become unavailable / available again).
function refreshHumanPreview() {
  if (game && !playing && !game.frame.frameOver && !isAiTurn()) { clampSpinToConstraint(); drawPad(); refreshLabels(); }
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

// A cheap "general" starting trajectory for the player's turn: aim the cue at the ghost-ball line of the
// nearest LEGAL target toward that ball's nearest pocket. It needn't be a makeable shot — it just gives
// the player a sensible line to fine-tune from instead of a fixed default. Returns radians, or null.
function suggestedAim() {
  const cue = cueBallPos();
  const targets = (variant.aiTargets ? variant.aiTargets(game) : game.pieces).filter((p) => p && p.id !== 'cue');
  const pockets = variant.pockets();
  let bestAim = null, nearest = Infinity;
  for (const t of targets) {
    const dCue = Math.hypot(t.pos.x - cue.x, t.pos.y - cue.y);
    if (dCue >= nearest || dCue < 1e-6) continue;
    let np = null, npd = Infinity;
    for (const pk of pockets) { const d = Math.hypot(pk.center.x - t.pos.x, pk.center.y - t.pos.y); if (d < npd) { npd = d; np = pk; } }
    if (!np) continue;
    const l = Math.hypot(np.center.x - t.pos.x, np.center.y - t.pos.y) || 1;
    const gx = t.pos.x - (2 * R) * (np.center.x - t.pos.x) / l; // ghost-ball point behind the target
    const gy = t.pos.y - (2 * R) * (np.center.y - t.pos.y) / l;
    nearest = dCue;
    bestAim = Math.atan2(gy - cue.y, gx - cue.x);
  }
  return bestAim;
}
// Point the player's aim at the suggested line as their turn opens (skipped if there's no legal target).
function setSuggestedAim() {
  if (!game || game.frame.frameOver || isAiTurn()) return;
  const a = suggestedAim();
  if (a != null) setAim((a * 180) / Math.PI);
}

// The AI "lines up" before firing: animate its control widgets AND trajectory from a naive first try
// (its aim, 1.0 pace, no spin) to its FINAL chosen shot (its pace + spin), so a watcher sees the
// choice form, then play it. The frame loop drives the animation (see aiLineup handling).
let aiLineup = null;

// --- ball-in-hand placement phase ------------------------------------------------------------
// When the frame owes ball-in-hand (the break, or after the cue is pocketed) the white must be PLACED
// before aiming. The human drags it to a legal spot by clicking the bed; the AI slides it to its chosen
// spot in a short animation. heldCuePos is the current placement; `placing` marks the human phase.
let heldCuePos = null; // {x,y} while ball-in-hand, else null
let placing = false;   // human is placing the cue ball
let aiPlace = null;    // AI placement animation: { from, to, start, dur, shot }

// Show/move the cue ball at `pos`, materialising its mesh if the cue isn't on the table yet.
function setCuePiecePos(pos) {
  let cue = game.pieces.find((p) => p.id === 'cue');
  if (!cue) { cue = { id: 'cue', color: variant.cueColor, group: 'cue', kind: 'cue', pos: { ...pos } }; game.pieces.push(cue); syncBallMeshes(game.pieces); }
  cue.pos = { x: pos.x, y: pos.y };
  const m = ballMeshes.get('cue');
  if (m) { m.grp.visible = true; m.grp.position.copy(P3(pos.x, pos.y, R)); }
}

// Enter the placement phase for the current turn: park the white on its default spot. The human then
// repositions it (pointer handler); the AI's own placement animates in when its shot arrives.
function beginBallInHand() {
  const def = variant.defaultPlacement(game);
  heldCuePos = { x: def.x, y: def.y };
  setCuePiecePos(heldCuePos);
  aiPlace = null;
  if (isAiTurn()) { placing = false; }
  else { placing = true; status.textContent = `${variant.ballInHandLabel || 'Ball in hand'} — drag the white to place it, click the table to aim.`; }
}
function endBallInHand() { placing = false; heldCuePos = null; aiPlace = null; }

// Set up the AI's cue-strike line-up (naive first try → final choice), driven by the frame loop.
function startAiLineup(shot) {
  aiLineup = {
    first: { angle: shot.angle, speed: 1.0, spin: { side: 0, vert: 0 }, elevation: 0, cuePlacement: shot.cuePlacement },
    final: shot,
    start: performance.now(),
    dur: 1200,
  };
  status.textContent = 'AI lining up…';
}
function playAiShot(shot) {
  if (playing || game.frame.frameOver) { playShot(shot); return; }
  // ball-in-hand: slide the white to the AI's chosen spot first, THEN line up
  if (game.frame.ballInHand && shot.cuePlacement) {
    aiPlace = { from: { ...(heldCuePos || variant.defaultPlacement(game)) }, to: { ...shot.cuePlacement }, start: performance.now(), dur: 900, shot };
    status.textContent = 'AI placing the cue ball…';
    return;
  }
  startAiLineup(shot);
}

el('trajectory').addEventListener('change', refreshHumanPreview);

const aiEnabled = () => el('aimode').value !== 'human'; // 'off' human-vs-human, else vs AI / self-play
const selfPlay = () => el('aimode').value === 'self';
const difficulty = () => (trick || selfPlay() ? 'deadly' : el('difficulty').value); // Trick Shots + AI-vs-AI always play at Deadly

// Keep the DISPLAYED difficulty honest: AI-vs-AI is forced to Deadly, so show it as Deadly and lock the
// control; restore the player's own pick when they leave self-play.
let pickedDifficulty = el('difficulty').value;
function syncDifficultyUI() {
  const sel = el('difficulty');
  if (selfPlay()) { if (!sel.disabled) pickedDifficulty = sel.value; sel.value = 'deadly'; sel.disabled = true; }
  else if (sel.disabled) { sel.value = pickedDifficulty; sel.disabled = false; }
}
el('difficulty').addEventListener('change', () => { if (!selfPlay()) pickedDifficulty = el('difficulty').value; });
syncDifficultyUI(); // reflect the initial opponent mode on load

// Collapsible "How to play & rules", populated per game type. The variants carry their own rulesText;
// the controls how-to is shared, and Trick Shots gets its own (no fouls/turns, jump shots, cue-rails).
const CONTROLS_HOWTO = [
  'Aim by clicking the table where you want to hit, or fine-tune with ◀ ▶ / the ← → keys.',
  'Power sets the shot speed. On the Cue ball pad, drag the inner disc for side (english) and follow / draw; drag the outer ring to lift the cue for a jump shot.',
  'Press “Play your shot” to strike. Drag to orbit the view, scroll to zoom.',
];
const TRICK_HOWTO = [
  'Each level auto-plays the perfect stroke at deadly precision to demonstrate the shot — the ball follows the drawn prediction exactly.',
  'Want to try it yourself? Just aim (click the table or ◀ ▶) before it fires — that cancels the demo and hands you the shot.',
  'Anything goes: all shots are legal and jump shots count. Some levels lay a cue stick on the table as a rail to bank off.',
  '↺ Retry replays the demo · “Show me” plays it now · “Next ▶” unlocks once the shot is made.',
];
const TRICK_RULES = [
  'No fouls and no turns — just complete the objective to clear the level.',
  'The famous trick shots come first, then endless generated levels of rising difficulty.',
];
const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function updateRulesPanel() {
  const title = trick ? 'Trick Shots' : (variant.name ?? 'Game');
  const howTo = trick ? TRICK_HOWTO : CONTROLS_HOWTO;
  const rules = trick ? TRICK_RULES : (variant.rulesText ?? []);
  el('rules-summary').textContent = `How to play & rules — ${title}`;
  const sec = (h, items) => (items.length ? `<h4>${h}</h4><ul>${items.map((t) => `<li>${escHtml(t)}</li>`).join('')}</ul>` : '');
  el('rules-body').innerHTML = sec('How to play', howTo) + sec('Rules', rules);
}
updateRulesPanel(); // initial (snooker)
// Player 0 = you (unless self-play). Player 1 = AI (when AI is on). Trick Shots is always solo.
const isAiTurn = () => !trick && !game.frame.frameOver && (selfPlay() || (aiEnabled() && game.frame.turn === 1));

let playing = false;
let simT = 0;
let lastFrame = 0;
let seedCounter = 1;
// Shareable frame: the current frame's rack seed + the executed shots, encodable into a link (src/share.js).
let frameSeed = 0;
let frameShots = [];
let sharedReplay = null; // { shots, i } while watching a shared frame back
let sharedFrame = null;  // the decoded frame being watched (persists so "Take over" works after it ends)
let challenge = null;    // { target } while playing a "beat this" challenge (?challenge=)
let shotIsAi = false;    // was the settling shot a game-AI shot? (pot replays are skipped for those)

// --- broadcast HUD: running break, session-high, celebratory banners -------------------------
// A "break" is the run a player builds in one unbroken visit — points in snooker/billiards
// (frame.scores), or balls potted in a row in pool/9-ball. Tracked per shot in playShot, rendered by
// updateScore + a big banner. Makes AI-vs-AI read like a broadcast rather than silent auto-play.
let bcast = { brk: 0, owner: null, high: 0, highBy: null, milestone: 0, pending: null };
const usesPoints = () => Array.isArray(game && game.frame && game.frame.scores);

function playerLabel(i) {
  if (i == null || i < 0) return '';
  if (selfPlay()) return `AI ${i + 1}`; // both sides are the AI
  if (!aiEnabled()) return `Player ${i + 1}`; // hot-seat
  return i === 0 ? 'You' : 'AI';
}

function resetBreaks({ keepHigh = false } = {}) {
  bcast.brk = 0; bcast.owner = null; bcast.milestone = 0; bcast.pending = null;
  if (!keepHigh) { bcast.high = 0; bcast.highBy = null; }
}

// Fold a resolved shot into the running break. `shooter` = who played; `scoresBefore` = their score
// snapshot before takeShot (null for pot-counting variants); `outcome` = variant.applyOutcome result.
function updateBroadcast(shooter, scoresBefore, outcome) {
  const pendingBefore = bcast.pending; // did THIS shot raise a fresh banner? (drives the spoken milestone)
  if (bcast.owner !== shooter) { bcast.brk = 0; bcast.owner = shooter; bcast.milestone = 0; } // fresh visit
  const gain = scoresBefore ? game.frame.scores[shooter] - scoresBefore[shooter] : lastPots.length;
  if (gain > 0) {
    bcast.brk += gain;
    if (bcast.brk > bcast.high) { bcast.high = bcast.brk; bcast.highBy = shooter; }
    if (scoresBefore) { // points milestones (snooker/billiards) → a banner once the shot settles
      const ms = bcast.brk >= 147 ? 147 : bcast.brk >= 100 ? 100 : bcast.brk >= 50 ? 50 : 0;
      if (ms > bcast.milestone) {
        bcast.milestone = ms;
        bcast.pending = ms === 147 ? { text: 'MAXIMUM 147!', tier: 'gold' }
          : ms === 100 ? { text: `CENTURY BREAK · ${bcast.brk}`, tier: 'gold' }
          : { text: `${bcast.brk} BREAK`, tier: 'silver' };
      }
    }
    noteBreakProgress(); // verified personal best + beaten-challenge banner
  }
  if (game.frame.frameOver && typeof game.frame.winner === 'number') {
    bcast.pending = { text: `${playerLabel(game.frame.winner).toUpperCase()} WINS THE FRAME`, tier: 'gold' };
  }
  // crowd reaction, played when the shot settles: a FULL, long cheer for a milestone / frame win, else
  // a cheer whose length + intensity track how HARD the pot was (thin/long/banked/plant → bigger),
  // with a small nudge for a high-value pot; nothing for a miss or foul.
  // NEVER cheer a foul — even one that happens to pot a ball (a pool cue-scratch that still sinks an
  // object ball has gain>0 via lastPots) or one that ends the frame. Legal pots / milestones / a clean
  // frame win still cheer.
  const foul = !!(outcome && outcome.foul);
  const diff = (gain > 0 && !foul) ? estimateShotDifficulty(timeline, lastPots) : 0;
  crowdReaction = foul ? 0
    : bcast.pending ? 1
    : gain > 0 ? Math.max(0.18, Math.min(0.92, 0.15 + 0.78 * diff + 0.015 * (gain - 1)))
    : 0;
  refSay = refereeLine(shooter, scoresBefore, outcome, bcast.pending !== pendingBefore); // spoken on settle
}
let crowdReaction = 0; // 0..1 pending crowd applause level (set by updateBroadcast, played at the pot)
let applauseFired = false; // has this shot's cheer already started? (fires once, at the drop)
let applauseStartMs = 0; // when the cheer started, so the referee can wait for it to die down

// Build the referee's spoken line for a shot (snooker-family only): fouls (+ points), miss, free ball,
// the re-spotted black, break milestones, and the frame result. Spoken when the shot settles.
let refSay = '';
let refTimer = 0; // pending (delayed) referee announcement, so it lands after the crowd quietens
let refRespotSpoken = false; // the re-spotted-black call fires once per frame
function refereeLine(shooter, scoresBefore, outcome, freshBanner) {
  if (!game.frame || !('onColour' in game.frame)) return ''; // snooker & double-snooker only
  const parts = [];
  if (outcome && outcome.foul) {
    const opp = 1 - shooter;
    const pen = scoresBefore ? Math.max(0, game.frame.scores[opp] - scoresBefore[opp]) : 4;
    parts.push(pen ? `Foul, ${pen} away.` : 'Foul.');
    if (outcome.miss) parts.push('Miss.');
  }
  if (outcome && outcome.freeBall) parts.push('Free ball.');
  if (game.frame.respottedBlack && !refRespotSpoken) { parts.push('Re-spotted black.'); refRespotSpoken = true; }
  if (game.frame.frameOver && typeof game.frame.winner === 'number') {
    const [a, b] = game.frame.scores;
    parts.push(`${playerLabel(game.frame.winner)} wins the frame, ${Math.max(a, b)} to ${Math.min(a, b)}.`);
  } else if (freshBanner && bcast.milestone) {
    parts.push(bcast.milestone === 147 ? 'Maximum break! One four seven.' : bcast.milestone === 100 ? 'Century.' : 'Fifty.');
  }
  return parts.filter(Boolean).join(' ');
}

// Estimate how hard the pot(s) just made were, as [0,1] (0 = tap-in, 1 = outrageous). Reuses the same
// geometry the AI's pot proxy uses — cut angle (cos²) × shot-length decay from the pre-shot layout —
// then adds bonuses for a potted ball that banked off cushions (a double) and for potting more than one
// ball (a plant). Drives applause length + intensity so the crowd reacts to skill, not just points.
// The gaps (seconds) between the ball collisions in a shot — the "rhythm" of the break. Fed to
// applause() so the crowd's sample-and-hold pitch wobble steps in time with the collisions.
function collisionIntervals(tl) {
  if (!tl || !tl.length) return null;
  const ts = [];
  for (const ev of tl) if (ev.kind === 'pair' || ev.kind === 'rail' || ev.kind === 'jaw') ts.push(ev.t);
  const iv = [];
  for (let i = 1; i < ts.length; i++) { const d = ts[i] - ts[i - 1]; if (d > 0.01) iv.push(d); }
  return iv.length ? iv : null;
}

const DIFF_EFOLD = 1.5; // metres — shot-length e-folding
function estimateShotDifficulty(tl, potIds) {
  if (!tl || !tl.length || !potIds || !potIds.length) return 0;
  try {
    const start = replayState(tl, planCache, 0);
    const cue = start.get('cue');
    if (!cue) return 0.4;
    let hardest = 0;
    for (const id of potIds) {
      const obj = start.get(id);
      if (!obj) continue;
      let drop = null; // where this ball dropped → snap to the nearest pocket centre
      for (const ev of tl) { if (ev.kind === 'pocket' && ev.hit && ev.hit.id === id) { const b = ev.balls.find((x) => x.id === id); if (b) drop = b.pos; break; } }
      if (!drop) continue;
      let pk = drop, bd = Infinity;
      for (const n of pocketNets) { const d = Math.hypot(n.cx - drop.x, n.cy - drop.y); if (d < bd) { bd = d; pk = { x: n.cx, y: n.cy }; } }
      const cox = obj.pos.x - cue.pos.x, coy = obj.pos.y - cue.pos.y; // cue → object
      const opx = pk.x - obj.pos.x, opy = pk.y - obj.pos.y; // object → pocket
      const lc = Math.hypot(cox, coy), lo = Math.hypot(opx, opy);
      if (lc < 1e-6 || lo < 1e-6) continue;
      const cosCut = Math.max(0, (cox * opx + coy * opy) / (lc * lo));
      const ease = cosCut * cosCut * Math.exp(-(lc + lo) / DIFF_EFOLD); // higher = easier
      if (1 - ease > hardest) hardest = 1 - ease;
    }
    let cushions = 0; // a potted ball that hit a rail/jaw on the way = a bank / double
    for (const ev of tl) if ((ev.kind === 'rail' || ev.kind === 'jaw') && ev.hit && potIds.includes(ev.hit.id)) cushions++;
    const bank = Math.min(0.35, cushions * 0.18);
    const plant = Math.min(0.2, (potIds.length - 1) * 0.12); // more than one ball down
    return Math.max(0, Math.min(1, hardest + bank + plant));
  } catch { return 0.4; }
}

// Commentary for the status line: relabel players for AI-vs-AI and append the running break.
function commentary(outcome) {
  let msg = (outcome && outcome.message) || '';
  if (selfPlay()) msg = msg.replace(/Player 1/g, 'AI 1').replace(/Player 2/g, 'AI 2');
  if (bcast.brk >= 2 && bcast.owner != null) msg += usesPoints() ? ` · break ${bcast.brk}` : ` · ${bcast.brk} in a row`;
  return msg;
}

let bannerTimer = null;
function showBanner(text, tier) {
  const b = el('bcastbanner');
  b.textContent = text;
  b.className = ''; void b.offsetWidth; // restart the CSS animation
  b.classList.add('show', tier);
  if (bannerTimer) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { b.className = ''; }, 2600);
}
function flushBanner() { if (bcast.pending) { showBanner(bcast.pending.text, bcast.pending.tier); bcast.pending = null; } }

function updateScore() {
  // variant HUD: sideValue = each player's score/label, centerText = the current ball-on / state
  const a = variant.sideValue ? variant.sideValue(game.frame, 0) : game.frame.scores[0];
  const b = variant.sideValue ? variant.sideValue(game.frame, 1) : game.frame.scores[1];
  const on = variant.centerText ? variant.centerText(game.frame) : '';
  const who = game.frame.frameOver ? '' : `— ${playerLabel(game.frame.turn)} to play`;
  scoreEl.textContent = `${playerLabel(0)} ${a} · ${playerLabel(1)} ${b}${on ? `   ·   ${on}` : ''}   ${who}`;
  const brkStr = bcast.brk >= 2 && bcast.owner != null ? `${playerLabel(bcast.owner)} break: ${bcast.brk}` : '';
  const highStr = bcast.high >= 2 ? `high: ${bcast.high}${bcast.highBy != null ? ` (${playerLabel(bcast.highBy)})` : ''}` : '';
  const bl = el('breakline'); if (bl) bl.textContent = [brkStr, highStr].filter(Boolean).join('   ·   ');
  syncTurnUI();
  updateTurnPrompt();
}

// A big, unmissable "it's your turn — here's your immediate goal" prompt, shown only when a human is
// idle and on strike (not the AI, not mid-shot, not Trick Shots). Goal text comes from variant.turnGoal.
function updateTurnPrompt() {
  const p = el('turnprompt'); if (!p) return;
  const yours = game && !trick && !playing && !aiLineup && !aiPlace && !sharedReplay && !game.frame.frameOver && !isAiTurn();
  if (!yours) { p.className = ''; p.textContent = ''; return; }
  const who = aiEnabled() ? '▶ YOUR TURN' : `▶ PLAYER ${game.frame.turn + 1} — YOUR TURN`;
  const goal = variant.turnGoal ? variant.turnGoal(game.frame) : (variant.centerText ? variant.centerText(game.frame) : '');
  p.innerHTML = `${who}${goal ? `<span class="goal">Goal: ${escHtml(goal)}</span>` : ''}`;
  p.className = 'show';
}

// Player-only controls (trajectories, new frame, share link) are irrelevant while the AI is on strike —
// hide them then. Trick Shots owns these controls itself, so leave that mode alone.
function syncTurnUI() {
  if (trick) return;
  const aiOnStrike = !!game && (!!aiLineup || !!aiPlace || (playing ? shotIsAi : isAiTurn()));
  for (const id of ['row-trajectory', 'newframe', 'sharelink']) { const e = el(id); if (e) e.style.display = aiOnStrike ? 'none' : ''; }
}

function newFrameGame() {
  playing = false;
  endReplay();
  endShotCam();
  pauseUntil = 0;
  pauseThen = null;
  aiLineup = null;
  recallCount = 0; lastOutcome = null; awaitingMiss = false; el('missprompt').classList.remove('show'); // clear any miss state
  refRespotSpoken = false; refSay = ''; clearTimeout(refTimer); // reset the referee's per-frame call state
  clearShareContext(); // a fresh frame drops any shared/challenge context
  frameSeed = seedCounter++; // record the rack seed so this frame is shareable/reproducible
  frameShots = [];
  aiRng = mulberry32(frameSeed); // fresh seed each frame → varied openings, still reproducible
  game = newGame(variant, { rng: aiRng });
  resetBreaks({ keepHigh: true }); // new frame, but the session-high break carries across frames
  syncBallMeshes(game.pieces);
  orient.clear();
  timeline = [];
  status.textContent = game.frame.message;
  updateScore();
  updatePBLine();
  if (game.frame.ballInHand) beginBallInHand(); else endBallInHand(); // break = ball-in-hand
  maybeAiTurn();
  if (!isAiTurn()) { resetHumanControls(); setSuggestedAim(); }
  refreshHumanPreview();
}

// Resolve a shot through the real game/rules, replay it, then chain turns.
function playShot(shot) {
  if (playing) return;
  shot = applyCueConstraints(shot); // a raised cue (over a ball / off a cushion) can't draw — enforce it
  clearPreview(); // the aim line is spent the moment the shot is struck
  frameShots.push({ angle: shot.angle, speed: shot.speed, spin: { side: shot.spin?.side ?? 0, vert: shot.spin?.vert ?? 0 }, elevation: shot.elevation ?? 0, cuePlacement: shot.cuePlacement ?? null }); // record for sharing (incl. shared-frame replay, so Take over inherits the shots)
  const shooter = game.frame.turn; // who is at the table (before the rules reassign the turn)
  const scoresBefore = Array.isArray(game.frame.scores) ? [...game.frame.scores] : null;
  const res = takeShot(game, shot); // mutates game (rules + settled positions); returns the timeline
  timeline = res.timeline;
  planCache = buildPlanCache(timeline, R);
  endT = timeline.length ? timeline[timeline.length - 1].t : 0;
  lastAngle = shot.angle;
  lastOutcome = res.outcome; lastPreShot = res.preShot; lastShooter = shooter; // for the miss rule (recall)
  applauseFired = false; // arm the crowd cheer for this shot's first scoring drop
  lastPots = pottedObjectBalls(timeline); // object balls dropped this shot → worth a replay
  updateBroadcast(shooter, scoresBefore, res.outcome); // fold into the running break (banner flushes on settle)
  status.textContent = commentary(res.outcome);
  updateScore();
  simT = 0;
  soundIdx = 0;
  playing = true;
  lastFrame = performance.now();
  beginShotCam(shot); // cue it from the player's angle, then pan out to watch
}

// --- pot replays -----------------------------------------------------------------------------
// After a successful pot, re-play the SAME shot timeline once with a scripted, randomly-chosen camera
// (one of four static framings, or — very infrequently — a swivel that chases a ball and orbits it),
// smoothly damped. Any key skips it. Physics untouched — this just re-runs the interpolation with the
// camera driven.
let replaying = false;
let replayInfo = null;
let pauseUntil = 0; // frame-clock time to hold before the next transition (pre-replay beat / post-replay hold)
let pauseThen = null; // 'replay' (start the replay) | 'handoff' (end replay + next turn)
let lastPots = [];
let lastAngle = 0;
let lastOutcome = null, lastPreShot = null, lastShooter = 0; // last shot's rules result + pre-shot snapshot
let recallCount = 0; // consecutive miss-recalls of the same offender (capped to avoid a livelock)
let awaitingMiss = false; // the miss prompt is open, waiting on the human's choice
const MAX_RECALLS = 3;
const replaysOn = () => el('replays').checked;
const pinCue = () => el('pincue').checked; // keep the free-orbit camera centred on the cue ball

function pottedObjectBalls(tl) {
  const last = tl[tl.length - 1];
  if (!last) return [];
  return last.balls.filter((b) => b.pocketed && !b.cleared && b.id !== 'cue').map((b) => b.id);
}

// Everything the replay must KEEP IN FRAME: the cue's starting position (so you see the shot), every
// collision point (ball-ball, cushion, jaw), every potted ball's drop point, and every ball's final
// resting spot. The framing centre/radius are sized to enclose them all, so the camera never crops the
// action. Also returns the drop TIMES to slow-mo the key moment and cut just after it.
function replayFraming() {
  const pts = [];
  const start = replayState(timeline, planCache, 0);
  const cue = start.get('cue');
  if (cue) pts.push(P3(cue.pos.x, cue.pos.y, R));
  const dropTs = [];
  const ballPt = (ev, id) => { const b = ev.balls.find((x) => x.id === id); if (b) pts.push(P3(b.pos.x, b.pos.y, R)); };
  for (const ev of timeline) {
    if (ev.kind === 'pocket' && ev.hit && lastPots.includes(ev.hit.id)) {
      dropTs.push(ev.t);
      ballPt(ev, ev.hit.id); // where a tracked ball dropped
    } else if ((ev.kind === 'pair' || ev.kind === 'rail' || ev.kind === 'jaw') && ev.hit) {
      // keep the point of contact in view (hit = {a,b} for a pair, {id} for a cushion/jaw)
      for (const id of [ev.hit.a, ev.hit.b, ev.hit.id]) if (id) ballPt(ev, id);
    }
  }
  const last = timeline[timeline.length - 1]; // final resting positions of every ball still on the table
  if (last) for (const b of last.balls) if (!b.pocketed) pts.push(P3(b.pos.x, b.pos.y, R));
  const center = new THREE.Vector3();
  for (const p of pts) center.add(p);
  center.multiplyScalar(1 / Math.max(1, pts.length));
  center.y = 0;
  let radius = 0.28 * HY * S; // a floor so a single tight pot isn't jammed against the lens
  for (const p of pts) radius = Math.max(radius, p.distanceTo(center));
  return { center, radius, first: dropTs[0] ?? endT, last: dropTs[dropTs.length - 1] ?? endT };
}

// Camera angles (a unit "sit" direction from the framing centre, elevated). All keep every pot in view;
// only the angle varies for cinematic variety.
const REPLAY_ANGLES = ['overhead', 'threeq', 'low', 'broadcast'];
function replayAngleDir(name) {
  const d =
    name === 'overhead' ? new THREE.Vector3(0.12, 1, 0.16) :
    name === 'threeq' ? new THREE.Vector3(0.8, 1.0, 0.8) :
    name === 'low' ? new THREE.Vector3(0.15, 0.5, 1.25) :
    new THREE.Vector3(0, 0.95, 1.5); // broadcast: from the near end, elevated
  return d.normalize();
}

const SWIVEL_CHANCE = 0.1; // very infrequently, follow the cue ball and swivel around it instead of the static frame
function startReplay() {
  replaying = true;
  const f = replayFraming();
  const angle = REPLAY_ANGLES[Math.floor(Math.random() * REPLAY_ANGLES.length)];
  const swivel = Math.random() < SWIVEL_CHANCE; // rare cinematic: orbit a moving ball
  replayInfo = {
    center: f.center,
    radius: f.radius,
    dir: replayAngleDir(angle),
    orbit: (Math.random() < 0.5 ? 1 : -1) * 0.28, // radians of gentle orbit across the replay, for life
    swivel,
    followId: lastPots[0] ?? 'cue', // chase the first potted ball if any, else the cue ball
    swivelDir: Math.random() < 0.5 ? 1 : -1, // orbit clockwise / anticlockwise
    swivelBase: Math.random() * Math.PI * 2, // random starting azimuth so it's not always the same view
    potT: f.first, // slow-mo hardest around the first drop
    end: Math.min(endT, f.last + 0.9), // cut ~0.9 s after the last pot
    camPos: new THREE.Vector3(),
    camTgt: new THREE.Vector3(),
    init: false,
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
const TRICK_REPLAY_SLOW = 0.55; // Trick Shots pot-replays play back slower, to admire the shot
function replayRate(t) {
  const rm = replayInfo;
  let nearest = Infinity;
  for (const ev of timeline) {
    if (ev.kind === 'start' || ev.kind === 'end') continue;
    const d = Math.abs(ev.t - t);
    if (d < nearest) nearest = d;
  }
  const FAR = 0.6; // dead stretches: a touch quicker, but still slow-mo (mostly ~half speed)
  const NEAR = 0.35; // right at a collision: crawl
  const W = 0.35; // seconds either side of an event that count as "near"
  let r = FAR + (NEAR - FAR) * Math.max(0, 1 - nearest / W);
  const potNear = Math.abs(t - rm.potT);
  if (potNear < 0.4) r = Math.min(r, 0.2 + 0.5 * (potNear / 0.4)); // bullet-time on the drop
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
  if (!replaying && pauseThen !== 'replay') return; // nothing replay-ish pending
  playing = false;
  pauseUntil = 0;
  pauseThen = null;
  endReplay();
  onReplayEnd();
}

// The pot-replay cinematic camera (static push-in/orbit + rare swivel) lives in replaycam.js. The
// renderer builds replayInfo (framing/state) in startReplay and drives it each frame from the loop.

// --- cueing shot presentation (live play only) -----------------------------------------------
// When a shot is struck, hold the balls at the start, show it from behind the cue ball down the aim
// line with a cue-strike animation, then release the balls and rise up + pan out to watch the shot.
// Live human + AI shots only — replays and the 147 exhibition drive their own cameras.
let shotCam = null;
const CUE_DUR = 2.2; // seconds of cueing (backswing + strike) before the balls are released
const WATCH_EASE = 0.6; // damping time constant easing from the player's view out to the watch view

// Elevation (radians) the cue butt must be raised to so the shaft + backswing clears any ball or
// cushion sitting behind the cue ball on the aim line — a bridge over the ball / steep cue off the
// cushion. The cue is never drawn passing through another ball or through a boundary.
function cueLift(cx, cy, aim) {
  const bwd = { x: -Math.cos(aim), y: -Math.sin(aim) }; // backward along the shaft
  const nrm = { x: -bwd.y, y: bwd.x }; // lateral
  const REACH = CUE_LEN + 0.3; // how far behind the ball the shaft + backswing extends (m)
  let tan = 0; // required tan(elevation) = clearHeight / distance, worst case wins
  for (const p of game.pieces) {
    if (p.id === 'cue') continue;
    const dx = p.pos.x - cx;
    const dy = p.pos.y - cy;
    const along = dx * bwd.x + dy * bwd.y;
    if (along <= 0.02 || along > REACH) continue;
    if (Math.abs(dx * nrm.x + dy * nrm.y) > 2 * R) continue; // ball not under the shaft
    tan = Math.max(tan, (2 * R + 0.012) / along); // clear the ball's crown
  }
  // nearest cushion the backward ray crosses
  let dEdge = Infinity;
  if (bwd.x !== 0) { const t = ((bwd.x > 0 ? HX : -HX) - cx) / bwd.x; if (t > 0) dEdge = Math.min(dEdge, t); }
  if (bwd.y !== 0) { const t = ((bwd.y > 0 ? HY : -HY) - cy) / bwd.y; if (t > 0) dEdge = Math.min(dEdge, t); }
  if (dEdge < REACH) tan = Math.max(tan, (topZ + 0.012) / dEdge); // clear the rail top
  return Math.min(Math.atan(tan), (72 * Math.PI) / 180); // cap the lift
}

// A cue forced up to clear a ball or cushion behind the white cannot strike low: draw (backspin)
// becomes impossible and, steeper still, some follow is unavoidable. Returns the minimum legal `vert`
// for a shot from `pos` along `aim` — −1 means draw is fully available (open shot). One rule, shared by
// the shot pipeline (human + AI) and the spin-pad UI, so what you can set is exactly what can be played.
function forcedMinFollow(pos, aim) {
  const lift = cueLift(pos.x, pos.y, aim);
  return lift > 0.15 ? Math.min(0.6, (lift - 0.15) * 1.4) : -1; // ~8.6°+ raised cue → no draw / forced follow
}
function applyCueConstraints(shot) {
  const cue = game.pieces.find((p) => p.id === 'cue');
  const pos = shot.cuePlacement || (cue && cue.pos);
  if (!pos) return shot;
  const mf = forcedMinFollow(pos, shot.angle);
  if (mf > -1) shot.spin = { side: shot.spin?.side ?? 0, vert: Math.max(shot.spin?.vert ?? 0, mf) };
  return shot;
}

function beginShotCam(shot) {
  const start = replayState(timeline, planCache, 0).get('cue');
  if (!start) { shotCam = null; return; }
  const Cw = P3(start.pos.x, start.pos.y, R);
  const aimW = new THREE.Vector3(Math.cos(shot.angle), 0, Math.sin(shot.angle)); // physics (x,y)→world (x,z)
  const up = new THREE.Vector3(0, 1, 0);
  const lift = cueLift(start.pos.x, start.pos.y, shot.angle);
  const cueDir = aimW.clone().multiplyScalar(Math.cos(lift)).addScaledVector(up, -Math.sin(lift)).normalize(); // tip points at the ball, tilted down by the lift
  // sit behind the CUE BUTT (the whole stick, ~1.45 m, then a little more) so the full cue is in frame,
  // over-the-shoulder and looking down the aim line past the ball
  const cuePos = Cw.clone().addScaledVector(aimW, -(CUE_LEN + 0.5) * S).addScaledVector(up, (0.82 + 1.1 * Math.sin(lift)) * S); // rise the lens with the butt
  const cueLook = Cw.clone().addScaledVector(aimW, 1.5 * S); cueLook.y = 0.1 * S; // low, down the aim line
  const watchPos = Cw.clone().addScaledVector(aimW, -1.3 * S).addScaledVector(up, 2.1 * S); // risen up behind
  shotCam = {
    start: performance.now(), aimW, cueDir, tipContact: Cw.clone().addScaledVector(aimW, -R * S),
    cuePos, cueLook, watchPos, watchLook: new THREE.Vector3(0, 0, 0), // table centre → seamless controls handoff
    camPos: cuePos.clone(), camTgt: cueLook.clone(), struck: false,
  };
  controls.enabled = false;
  camera.position.copy(cuePos);
  camera.lookAt(cueLook);
  placeCue(0);
  cueStick.visible = true;
}
// Position the cue with its tip `back` metres behind contact along the (possibly elevated) shaft axis.
function placeCue(back) {
  const dir = shotCam.cueDir; // unit tip-forward (toward the ball, tilted down by any lift)
  const tip = shotCam.tipContact.clone().addScaledVector(dir, -back * S);
  cueStick.position.copy(tip).addScaledVector(dir, -(CUE_LEN / 2) * S);
  cueStick.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
}
// Cueing phase: a few feather strokes, then a full backswing and strike to contact. Returns false
// (and releases the balls) at contact.
function driveShotCamCueing(now) {
  const cp = Math.min(1, (now - shotCam.start) / (CUE_DUR * 1000));
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  let back; // metres the tip is drawn back from contact
  if (cp < 0.6) {
    back = 0.09 * (0.5 - 0.5 * Math.cos((cp / 0.6) * Math.PI * 6)); // ~3 practice feathers
  } else {
    const q = (cp - 0.6) / 0.4;
    back = q < 0.6 ? 0.28 * easeOut(q / 0.6) : 0.28 * (1 - ((q - 0.6) / 0.4) ** 2); // full draw, then strike
  }
  placeCue(Math.max(0, back));
  camera.position.copy(shotCam.cuePos);
  camera.lookAt(shotCam.cueLook);
  if (cp >= 1) { cueStick.visible = false; shotCam.struck = true; return false; }
  return true;
}
// Watch phase: ease the camera from the player's view out to the risen broadcast view as balls run.
function driveShotCamWatch(dt) {
  shotCam.camPos.lerp(shotCam.watchPos, 1 - Math.exp(-dt / WATCH_EASE));
  shotCam.camTgt.lerp(shotCam.watchLook, 1 - Math.exp(-dt / (WATCH_EASE * 0.8)));
  camera.position.copy(shotCam.camPos);
  camera.lookAt(shotCam.camTgt);
}
function endShotCam() {
  shotCam = null;
  cueStick.visible = false;
  controls.enabled = true;
}

// Over-the-shoulder AIM view (the "Cue-ball view" toggle, while a human is lining up): sit behind the
// cue ball looking down the current aim line, so the view rotates with your aim. Uses the SAME geometry
// as the cueing camera (beginShotCam) so striking the shot is a seamless hand-off. Eased, and orbit is
// suspended while it's active (toggle off to free-orbit). Not for AI turns / replays / exhibition.
const aimCam = { pos: new THREE.Vector3(), tgt: new THREE.Vector3(), init: false };
// Over-the-shoulder framing is a DEFAULT you can override: it re-frames behind the cue whenever you
// change your aim, but hands the camera to free orbit/pan/zoom the moment you drag it — so you can look
// around the table at any phase of the shot without toggling the view off. `aimReframe` = "auto-frame
// is in charge"; a manual orbit (controls 'start') clears it, changing your aim re-arms it.
let aimReframe = true;
let lastAimDeg = aimDeg;
function aimView() {
  return pinCue() && game && !playing && !replaying && !exhibition && !shotCam && !game.frame.frameOver && !isAiTurn();
}
function driveAimCam(dt) {
  const c = cueBallPos();
  const Cw = P3(c.x, c.y, R);
  const aim = (aimDeg * Math.PI) / 180;
  const aimW = new THREE.Vector3(Math.cos(aim), 0, Math.sin(aim));
  const up = new THREE.Vector3(0, 1, 0);
  const lift = cueLift(c.x, c.y, aim); // match the cueing camera's rise when the cue is forced up
  const dPos = Cw.clone().addScaledVector(aimW, -(CUE_LEN + 0.5) * S).addScaledVector(up, (0.82 + 1.1 * Math.sin(lift)) * S);
  const dTgt = Cw.clone().addScaledVector(aimW, 1.5 * S); dTgt.y = 0.1 * S; // low, down the aim line
  if (!aimCam.init) { aimCam.pos.copy(camera.position); aimCam.tgt.copy(controls.target); aimCam.init = true; } // ease in from the current view
  aimCam.pos.lerp(dPos, 1 - Math.exp(-dt / 0.22));
  aimCam.tgt.lerp(dTgt, 1 - Math.exp(-dt / 0.18));
  camera.position.copy(aimCam.pos);
  controls.target.copy(aimCam.tgt); // keep the orbit pivot in sync, so releasing to free-orbit is seamless
  controls.update();
}
// Grabbing the camera (orbit/pan/zoom) during setup hands control to you: stop the auto over-the-shoulder
// framing until you next change your aim (or the phase resets).
controls.addEventListener('start', () => { if (aimView()) { aimReframe = false; aimCam.init = false; } });

// The human's shot from the sliders (aim/power/spin/elevation). Ball-in-hand uses the default D spot.
function humanShot() {
  // A pot replay is showing (or in its pre-beat / post-hold, when `playing` is briefly false): Play must
  // NOT fire a phantom shot — it acts as "skip the replay", like tapping the table or pressing a key.
  // Without this, activating Play during that window fired a shot into the just-cleared table, fouling,
  // flipping the turn, and re-arming another replay → the reported replay loop + scrambled turns.
  if (replaying || pauseThen === 'replay' || pauseThen === 'handoff') { skipReplay(); return; }
  if (playing || sharedReplay || awaitingMiss) return; // awaiting the miss choice → Play is inert
  if (trick) { cancelTrickAuto(); if (!trick.awaiting) playTrickShot(sliderShot()); return; }
  if (isAiTurn() || game.frame.frameOver) return;
  shotIsAi = false;
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
  if (trick) { onTrickShotEnd(); return; } // Trick Shots: judge the goal, don't run game rules/AI
  syncBallMeshes(game.pieces); // authoritative resting positions from the rules reconciliation
  updateScore();
  flushBanner(); // century / frame-won banner, held until the shot has settled
  const cheer = crowdReaction;
  // The cheer normally starts at the pot (in the render loop). Fallback here for a scoring shot whose
  // drop was never played (e.g. the replay was skipped before the pocket event).
  if (cheer > 0 && !applauseFired) { applause(cheer, collisionIntervals(timeline)); applauseFired = true; applauseStartMs = performance.now(); }
  if (refSay) { // the referee holds the call until the crowd (which started at the pot) has died down
    const say = refSay; refSay = '';
    const quietAt = applauseStartMs + (0.9 + cheer * 1.8) * 1000; // when the cheer has faded
    clearTimeout(refTimer);
    refTimer = setTimeout(() => announce(say), cheer > 0 ? Math.max(250, quietAt - performance.now()) : 250);
  }
  crowdReaction = 0;
  if (sharedReplay) { // watching a shared frame back → chain the next recorded shot
    sharedReplay.i += 1;
    if (!game.frame.frameOver && sharedReplay.i < sharedReplay.shots.length) {
      setTimeout(() => { if (sharedReplay) { shotIsAi = false; playShot(sharedReplay.shots[sharedReplay.i]); } }, 600);
    } else { sharedReplay = null; status.textContent = 'Shared frame complete — New frame to play your own.'; }
    return;
  }
  if (game.frame.frameOver) {
    status.textContent = game.frame.message;
    // Watch AI vs AI → rack a fresh frame automatically after a beat so it plays on indefinitely
    if (selfPlay() && !exhibition) setTimeout(() => { if (game.frame.frameOver && selfPlay() && !exhibition) newFrameGame(); }, 3000);
    return;
  }
  // MISS RULE: a foul where the offender COULD have hit the ball-on but didn't. The incoming player may
  // recall it (make them play again from the original position). Capped so a deterministic AI can't
  // livelock, and skipped in AI-vs-AI (nothing to choose, keeps the exhibition flowing).
  if (lastOutcome && lastOutcome.miss && lastPreShot && recallCount < MAX_RECALLS && !selfPlay()) {
    if (isAiTurn()) { if (shouldRecallMiss(game)) { recallMiss(); return; } } // AI incoming decides
    else { offerMissChoice(); return; } // human incoming → pause and offer the choice
  }
  recallCount = 0; // a shot that isn't recalled ends the streak
  finishHandoff();
}

// The normal end-of-shot hand-off (also reached after the miss choice resolves).
function finishHandoff() {
  if (game.frame.ballInHand) beginBallInHand(); else endBallInHand(); // cue potted → place it before playing on
  maybeAiTurn();
  if (!isAiTurn()) { resetHumanControls(); setSuggestedAim(); } // your shot → sensible controls + a suggested aim line
  refreshHumanPreview(); // if it's now your shot, show the aim line
}

// Recall a miss: restore the table + frame to before the missed shot (but the opponent KEEPS the foul
// points) and hand it back to the offender to play again.
function recallMiss() {
  recallCount += 1;
  const keepScores = [...game.frame.scores]; // opponent keeps the penalty; only the position is replayed
  game.pieces = structuredClone(lastPreShot.pieces);
  game.frame = structuredClone(lastPreShot.frame);
  game.frame.scores = keepScores;
  syncBallMeshes(game.pieces);
  orient.clear();
  updateScore();
  status.textContent = `Miss called — ${playerLabel(game.frame.turn)} must play again`;
  finishHandoff();
}

// Human incoming player: pause the hand-off and offer to play on or recall the miss.
function offerMissChoice() {
  awaitingMiss = true;
  el('mp-sub').textContent = `${playerLabel(lastShooter)} could have hit the ball on. Play the position, or make them play again?`;
  el('missprompt').classList.add('show');
}
el('miss-play').addEventListener('click', () => { el('missprompt').classList.remove('show'); awaitingMiss = false; recallCount = 0; finishHandoff(); });
el('miss-again').addEventListener('click', () => { el('missprompt').classList.remove('show'); awaitingMiss = false; recallMiss(); });

// Switch game (snooker / 8-ball / 9-ball): swap the variant, rebuild the table + camera for its
// dimensions, drop the old balls, and rack a fresh frame. Physics/rules/AI follow the variant.
function setVariant(v) {
  aiLineup = null;
  playing = false;
  endReplay();
  pauseUntil = 0;
  pauseThen = null;
  variant = v;
  applyVariantGeom();
  rebuildTable();
  frameCamera();
  for (const [, m] of ballMeshes) scene.remove(m.grp);
  ballMeshes.clear();
  orient.clear();
  const h1 = document.querySelector('#panel h1');
  if (h1) h1.textContent = `${variant.name ?? 'SNOOKER'} · 3D`;
  resetBreaks(); // different game → the break unit/high changes; start the session fresh
  updateRulesPanel();
  newFrameGame();
}

el('play').addEventListener('click', humanShot);
el('newframe').addEventListener('click', newFrameGame);
el('aimode').addEventListener('change', () => { syncDifficultyUI(); updateScore(); maybeAiTurn(); refreshHumanPreview(); });
el('game').addEventListener('change', () => {
  const v = el('game').value;
  if (v === 'trickshots') startTrickShots();
  else { exitTrickShots(); setVariant(VARIANTS[v] ?? snooker); }
});
el('trick-retry').addEventListener('click', () => loadTrickLevel(trick ? trick.index : 0));
el('trick-next').addEventListener('click', () => { if (trick) loadTrickLevel(trick.index + 1); });
el('trick-show').addEventListener('click', showTrickSolution);

// --- shareable frames: watch, take over (correspondence), challenge, verified personal best ----
// Because the engine is deterministic, the current frame = (variant, rack seed, executed shots). Encode
// that into a ?frame= link (src/share.js); opening it re-simulates and plays the exact frame back. From
// there you can Take over & reply (append your shots) — turn-based async play — or a ?challenge= link
// racks the SAME layout and dares you to beat the sharer's break. Personal bests are stored as tokens,
// so they're independently verifiable (tools/verify.mjs).
function shareUrl() {
  return `${location.origin}${location.pathname}?frame=${encodeFrame({ variantId: shareVariantId(variant), seed: frameSeed, shots: frameShots })}`;
}
function copyToClipboard(url, msg) {
  const done = () => { status.textContent = msg; };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done).catch(() => window.prompt('Link:', url));
  else window.prompt('Link:', url);
}
let replying = false; // after Take over, the share button emits a ?frame= reply (watch my continuation)
el('sharelink').addEventListener('click', () => {
  if (trick) { status.textContent = 'Sharing is for game frames, not Trick Shots.'; return; }
  if (!frameShots.length) { status.textContent = 'Play a shot first, then share the frame.'; return; }
  const url = shareUrl().replace('?frame=', replying ? '?frame=' : '?challenge=');
  copyToClipboard(url, replying ? 'Reply link copied — send it back.' : `Challenge link copied — dare a friend to beat this (${frameShots.length} shot${frameShots.length === 1 ? '' : 's'}).`);
});

// Reset the shared/challenge context (called when starting a fresh frame, variant, or trick mode).
function clearShareContext() { sharedReplay = null; sharedFrame = null; challenge = null; replying = false; el('takeover').style.display = 'none'; el('sharelink').textContent = '🔗 Copy share link'; }

// Load a shared frame: rack with its seed, then play its recorded shots back in order (watched, not
// re-decided by rules/AI). Reuses the shot-cam + broadcast HUD so it looks like a live frame.
function startSharedReplay(decoded) {
  loadFrameRack(decoded);
  sharedFrame = decoded;
  sharedReplay = { shots: decoded.shots, i: 0 };
  el('takeover').style.display = '';
  status.textContent = `Shared frame — ${decoded.shots.length} shot${decoded.shots.length === 1 ? '' : 's'} · watching`;
  if (decoded.shots.length) { shotIsAi = false; playShot(decoded.shots[0]); }
  else { sharedReplay = null; status.textContent = 'Shared position — Take over to play on.'; }
}

// Common setup for a shared/challenge frame: swap to its variant and rack its seed.
function loadFrameRack(decoded) {
  const v = shareVariantById(decoded.variantId);
  exitTrickShots();
  clearShareContext();
  el('game').value = v.id;
  variant = v; applyVariantGeom(); rebuildTable(); frameCamera();
  for (const [, m] of ballMeshes) scene.remove(m.grp);
  ballMeshes.clear();
  const h1 = document.querySelector('#panel h1');
  if (h1) h1.textContent = `${variant.name ?? 'SNOOKER'} · 3D`;
  updateRulesPanel();
  playing = false; endReplay(); endShotCam(); aiLineup = null; aiPlace = null;
  frameSeed = decoded.seed;
  frameShots = [];
  aiRng = mulberry32(decoded.seed);
  game = newGame(variant, { rng: aiRng });
  resetBreaks();
  syncBallMeshes(game.pieces);
  orient.clear();
  endBallInHand();
  updatePBLine();
  updateScore();
}

// Take over a watched frame from the current position and play on — your continued shots append to the
// recorded ones, so "Copy reply link" is a fresh token you send back. Turn-based correspondence play.
el('takeover').addEventListener('click', () => {
  if (!sharedFrame) return;
  if (sharedReplay && playing) { status.textContent = 'Wait for the shot to finish, then take over.'; return; }
  sharedReplay = null; sharedFrame = null; replying = true;
  el('takeover').style.display = 'none';
  el('sharelink').textContent = '↩ Copy reply link';
  status.textContent = 'Your turn — play on, then “Copy reply link” to send it back.';
  if (game.frame.ballInHand) beginBallInHand(); else endBallInHand();
  maybeAiTurn();
  if (!isAiTurn()) { resetHumanControls(); setSuggestedAim(); }
  refreshHumanPreview();
});

// Beat-this challenge: rack the SAME layout as the sharer and play it yourself; their result is the bar.
function startChallenge(token) {
  const target = verifyFrame(token); // re-simulate the challenger's frame → their highest break etc.
  const decoded = decodeFrame(token);
  loadFrameRack(decoded);
  challenge = { target, beaten: false };
  const bar = target.highBreak > 0 ? `beat a break of ${target.highBreak} ${target.unit}` : 'pot more than they did';
  status.textContent = `Challenge — ${bar}. Your turn.`;
  updatePBLine();
  maybeAiTurn();
  if (!isAiTurn()) { resetHumanControls(); setSuggestedAim(); }
  refreshHumanPreview();
}

// --- verified personal best (per variant, stored as a shareable token) ------------------------
const PB_KEY = 'snooker3d.pb.v1';
let personalBest = (() => { try { return JSON.parse(localStorage.getItem(PB_KEY) || '{}'); } catch { return {}; } })();
function savePB() { try { localStorage.setItem(PB_KEY, JSON.stringify(personalBest)); } catch { /* storage off */ } }
function updatePBLine() {
  const el2 = el('pbline'); if (!el2) return;
  if (trick) { el2.textContent = ''; return; }
  const pb = personalBest[variant.id];
  const chal = challenge ? `   ·   target: ${challenge.target.highBreak}` : '';
  el2.textContent = pb ? `★ your best ${variant.name ?? variant.id} break: ${pb.break}${chal}` : (chal ? chal.trim() : '');
}
// Called from updateBroadcast whenever the running break grows: bank a new personal best (as a verifiable
// token) and flag a beaten challenge. Only for your own live play — not shared-frame watching or trick.
function noteBreakProgress() {
  if (sharedReplay || trick) return;
  if (challenge && !challenge.beaten && bcast.high > challenge.target.highBreak && bcast.high > 0) {
    challenge.beaten = true;
    bcast.pending = { text: `CHALLENGE BEATEN · ${bcast.high}`, tier: 'gold' };
  }
  const pb = personalBest[variant.id];
  if (bcast.high > 1 && (!pb || bcast.high > pb.break)) {
    personalBest[variant.id] = { break: bcast.high, token: encodeFrame({ variantId: shareVariantId(variant), seed: frameSeed, shots: frameShots }) };
    savePB();
    updatePBLine();
    if (!pb || bcast.high >= (pb.break + 1)) bcast.pending = bcast.pending || { text: `NEW BEST · ${bcast.high}`, tier: 'silver' };
  }
}

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
  if (game.frame.ballInHand && heldCuePos) return heldCuePos; // the placement you're setting this turn
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

// Ball-in-hand uses the natural pool interaction: GRAB the white and drag it to a legal spot, while a
// plain click of the bed AIMS (as always). No mode toggle — grabbing the ball vs clicking empty cloth
// disambiguates, so placing and aiming feel like one fluid step instead of two awkward phases.
let aimDown = null;
let grabCue = false; // dragging the cue ball to place it (ball-in-hand)
const CUE_GRAB_PX = 30; // screen-space grab radius around the white
function cueScreenXY() {
  const c = cueBallPos();
  const v = P3(c.x, c.y, R).clone().project(camera);
  const r = renderer.domElement.getBoundingClientRect();
  return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height, behind: v.z > 1 };
}
function nearCue(ev) {
  if (!placing || !game.frame.ballInHand) return false;
  const s = cueScreenXY();
  return !s.behind && Math.hypot(ev.clientX - s.x, ev.clientY - s.y) < CUE_GRAB_PX;
}
function dragCueTo(ev) {
  const t = pointerToTable(ev);
  if (t && variant.placementLegal(game, t.x, t.y)) { heldCuePos = { x: t.x, y: t.y }; setCuePiecePos(heldCuePos); refreshHumanPreview(); }
}
renderer.domElement.addEventListener('pointerdown', (ev) => {
  if (replaying || pauseThen === 'replay') { skipReplay(); return; } // tap the table to skip a pot replay (like any key)
  aimDown = { x: ev.clientX, y: ev.clientY };
  grabCue = !playing && !sharedReplay && !isAiTurn() && nearCue(ev);
  if (grabCue) { controls.enabled = false; try { renderer.domElement.setPointerCapture(ev.pointerId); } catch { /* non-capturable */ } dragCueTo(ev); }
});
renderer.domElement.addEventListener('pointermove', (ev) => { if (grabCue) dragCueTo(ev); });
renderer.domElement.addEventListener('pointerup', (ev) => {
  const start = aimDown;
  aimDown = null;
  if (grabCue) { grabCue = false; controls.enabled = true; return; } // finished dragging the white into place
  if (!start || Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 6) return; // a drag → orbit, not aim
  if (!game || playing || sharedReplay || isAiTurn() || game.frame.frameOver) return;
  const t = pointerToTable(ev);
  if (!t) return;
  const c = cueBallPos();
  if (t.x === c.x && t.y === c.y) return;
  cancelTrickAuto(); // you're aiming yourself → cancel the auto-demo
  setAim((Math.atan2(t.y - c.y, t.x - c.x) * 180) / Math.PI);
});

function holdAimButton(button, dir) {
  const down = (ev) => { cancelTrickAuto(); aimHeldDir = dir; try { button.setPointerCapture(ev.pointerId); } catch { /* non-capturable */ } };
  const up = () => { if (aimHeldDir === dir) { aimHeldDir = 0; aimHoldFrames = 0; } };
  button.addEventListener('pointerdown', down);
  button.addEventListener('pointerup', up);
  button.addEventListener('pointerleave', up);
  button.addEventListener('pointercancel', up);
}
holdAimButton(el('angleL'), -1);
holdAimButton(el('angleR'), 1);
window.addEventListener('keydown', (ev) => {
  if (replaying || pauseThen === 'replay') { skipReplay(); ev.preventDefault(); return; } // any key skips a pot replay
  if (document.activeElement === sliders.angle) return; // let the focused slider handle its own arrows
  if (ev.key === 'ArrowLeft') { cancelTrickAuto(); aimHeldDir = -1; ev.preventDefault(); }
  else if (ev.key === 'ArrowRight') { cancelTrickAuto(); aimHeldDir = 1; ev.preventDefault(); }
});
window.addEventListener('keyup', (ev) => {
  if ((ev.key === 'ArrowLeft' && aimHeldDir === -1) || (ev.key === 'ArrowRight' && aimHeldDir === 1)) { aimHeldDir = 0; aimHoldFrames = 0; }
});

// --- sound: synthesised collision knocks live in sound.js (leaf WebAudio module) -----------------
// The loop owns soundIdx (which timeline events have already sounded); the synth owns the audio graph.
let soundIdx = 0; // last timeline event whose sound has played, during replay
initSound(() => el('sound').checked); // knock()/applause() honour the Sound toggle
initReferee(() => el('referee').checked); // spoken referee (local TTS) honours the Referee toggle
// Browser autoplay policy blocks audio until a user gesture, and resuming an AudioContext in the same
// gesture that created it is unreliable — so Sound starts OFF and toggling it (an explicit click) is the
// gesture that unlocks audio. The label pulses until the user enables it, then reflects on/off state.
const soundEl = el('sound'), soundLbl = el('soundlbl'), soundTxt = el('soundtxt');
soundEl.addEventListener('change', () => {
  unlockAudio();
  soundLbl.classList.remove('attention'); // engaged once — stop nagging
  soundTxt.textContent = soundEl.checked ? '🔊 Sound on' : '🔇 Sound off';
});

// --- 147 exhibition + video recording --------------------------------------------------------
// Plays a scripted, validated 147 clearance (src/exhibition.build147) as a continuous montage under a
// slowly-orbiting broadcast camera, optionally recording the canvas to a downloadable webm.
let exhibition = null; // { steps, i, orbit } while a 147 is playing
let mediaRec = null;
let recChunks = [];

// Prefer H.264/MP4 — it's what Facebook and (critically) WhatsApp actually play; WhatsApp treats a
// .webm as a document. Fall back to VP9/WebM only where the browser can't record MP4.
const REC_MIMES = [
  'video/mp4;codecs=avc1.640028', // H.264 High
  'video/mp4;codecs=avc1.42E01E', // H.264 Baseline
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];
function startRecording() {
  try {
    const stream = renderer.domElement.captureStream(30);
    const mime = REC_MIMES.find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm';
    recChunks = [];
    mediaRec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6 });
    mediaRec.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    mediaRec.start(1000);
  } catch { mediaRec = null; }
}
function stopRecording() {
  if (!mediaRec) return;
  const rec = mediaRec;
  mediaRec = null;
  rec.onstop = () => {
    const blob = new Blob(recChunks, { type: rec.mimeType });
    window.__last147 = blob; // headless extraction hook
    const ext = (rec.mimeType || '').startsWith('video/mp4') ? 'mp4' : 'webm';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `snooker-147.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  };
  rec.stop();
}

function frameExhibitionCamera() {
  camera.position.set(0, HX * S * 1.35, HX * S * 2.05); // elevated broadcast angle framing the whole table
  camera.lookAt(0, 0, 0);
}
function driveExhibitionCamera(dt) {
  exhibition.orbit += dt * 0.05; // gentle slow orbit, whole table always in view
  const a = exhibition.orbit;
  camera.position.set(Math.sin(a) * HX * S * 2.05, HX * S * 1.35, Math.cos(a) * HX * S * 2.05);
  camera.lookAt(0, 0, 0);
}

function playExhibitionStep() {
  const step = exhibition.steps[exhibition.i];
  syncBallMeshes(step.pieces);
  orient.clear();
  timeline = step.timeline;
  planCache = buildPlanCache(timeline, R);
  endT = timeline.length ? timeline[timeline.length - 1].t : 0;
  simT = 0;
  soundIdx = 0;
  playing = true;
  lastFrame = performance.now();
  // draw the predicted trajectory for this shot — the whole point of the engine is that it solves the
  // full path ahead of time; the balls then trace those very lines as the shot plays out.
  drawPreviewPaths(samplePreview({ timeline }));
  status.textContent = exhibition.i === 0 ? '147 · the break' : `147 · pot ${exhibition.i} / 36`;
}
function nextExhibitionStep() {
  exhibition.i += 1;
  if (exhibition.i >= exhibition.steps.length) { finishExhibition(); return; }
  playExhibitionStep();
}
function finishExhibition() {
  playing = false;
  exhibition = null;
  clearPreview();
  controls.enabled = true;
  frameCamera();
  status.textContent = 'Break of 147! — recording downloaded';
  stopRecording();
}
async function startExhibition(record) {
  if (variant !== snooker) { el('game').value = 'snooker'; setVariant(snooker); }
  aiLineup = null;
  pauseThen = null;
  pauseUntil = 0;
  endReplay();
  endShotCam();
  controls.enabled = false;
  frameExhibitionCamera();
  status.textContent = 'Building the 147…';
  const steps = await build147((n, total) => { status.textContent = `Building the 147… (${n + 1}/${total})`; });
  if (steps.length < 37) { status.textContent = 'exhibition build failed'; controls.enabled = true; frameCamera(); return; }
  exhibition = { steps, i: 0, orbit: -0.55 };
  if (record) startRecording();
  playExhibitionStep();
}

// --- Trick Shots mode ------------------------------------------------------------------------
// A solo, level-based challenge (src/trickshots.js): each level is a fixed layout + a machine-checkable
// goal, with NO game rules — every shot is legal, jump shots included. Curated famous shots come first
// (one uses a laid cue stick as a rail), then endless generated levels of rising difficulty. We reuse
// the human aim/power/spin/jump UI and the shot-cam + pot-replay; only the resolve path differs (the
// rules-free runTrickShot), and the goal is judged when the shot settles.
let trickSeed = 20260701; // varies generated layouts run to run (fixed here for reproducibility)
const trickRailGroup = new THREE.Group();
scene.add(trickRailGroup);

// "Deadly demonstration": on loading a level we auto-play the winning stroke perfectly (zero error) to
// show off the engine's accuracy. It's armed after a short beat so you can see the layout + predicted
// line first; any manual aim/power input cancels it so you can attempt the shot yourself.
let trickAutoTimer = null;
const TRICK_AUTO_DELAY = 1700; // ms to admire the layout + predicted path before the demo fires
function cancelTrickAuto() { if (trickAutoTimer) { clearTimeout(trickAutoTimer); trickAutoTimer = null; } }
function armTrickAuto(index) {
  cancelTrickAuto();
  trickAutoTimer = setTimeout(() => {
    trickAutoTimer = null;
    if (trick && trick.index === index && trick.solution && !playing && !trick.awaiting) {
      status.textContent = '⭐ Deadly demonstration — the perfect stroke';
      playTrickShot(trick.solution);
    }
  }, TRICK_AUTO_DELAY);
}

function setTrickUI(on) {
  el('trickpanel').style.display = on ? 'block' : 'none';
  for (const id of ['newframe', 'sharelink', 'scores', 'breakline', 'pbline']) { const e = el(id); if (e) e.style.display = on ? 'none' : ''; }
  const rt = el('row-trajectory'); if (rt) rt.style.display = ''; // trajectories stay available while aiming a trick
  // Trick Shots runs as a hands-off "Watch AI vs AI" demonstration → show but LOCK the opponent to it
  // (difficulty is locked to Deadly by syncDifficultyUI when self-play is active).
  el('aimode').disabled = on;
}

// Draw the level's cue-stick rails as thin cylinders lying on the bed (a real cue used as a rail).
function syncTrickRails(level) {
  for (const c of [...trickRailGroup.children]) { trickRailGroup.remove(c); c.geometry?.dispose?.(); }
  for (const r of level.rails ?? []) {
    const [lo, hi] = r.span;
    const len = (hi - lo) * S;
    const mid = ((lo + hi) / 2) * S;
    // The physics models the cue as a thin CONTACT LINE at r.perp — a ball banks when its EDGE reaches
    // that line (its centre stays R away). So the stick must be drawn THIN and LOW: a fat stick centred
    // on the line gets sunk half-into by every bank (reads as passing through), and a ball can only
    // approach from either face, so we can't safely offset it. A slim cue resting on the cloth keeps the
    // overlap sub-visible while the bank still lands right at the cue.
    const shaftR = 0.006; // slim shaft — the ball's edge reaches ≈ its surface, so no visible clip-through
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(shaftR * 0.8 * S, shaftR * S, len, 12),
      new THREE.MeshStandardMaterial({ color: 0xcaa062, roughness: 0.5 }),
    );
    shaft.castShadow = true;
    const y = shaftR * S; // rest on the cloth
    if (r.axis === 'x') { shaft.rotation.z = Math.PI / 2; shaft.position.set(mid, y, r.perp * S); }
    else { shaft.rotation.x = Math.PI / 2; shaft.position.set(r.perp * S, y, mid); }
    trickRailGroup.add(shaft);
  }
}

let priorAiMode = 'ai'; // opponent mode to restore when leaving Trick Shots
function startTrickShots(startIndex = 0) {
  playing = false;
  endReplay();
  endShotCam();
  pauseThen = null; pauseUntil = 0;
  aiLineup = null;
  exhibition = null;
  trick = { index: startIndex, level: null, awaiting: false, passed: false };
  endBallInHand();
  clearShareContext();
  priorAiMode = el('aimode').value;
  el('aimode').value = 'self'; // start as a Watch AI-vs-AI demonstration (Deadly)
  setTrickUI(true);
  syncDifficultyUI(); // self-play → difficulty shows + locks to Deadly
  updateRulesPanel();
  loadTrickLevel(startIndex);
}
// Index of a curated level by id, for deep-links (e.g. ?tricky=true → the Leapfrog).
const TRICK_LEVELS = { sledgehammer: 0, leapfrog: 1, guardrail: 2, alley: 3, double: 4 };

function exitTrickShots() {
  if (!trick) return;
  cancelTrickAuto();
  trick = null;
  el('aimode').value = priorAiMode; // restore the opponent mode you had before
  setTrickUI(false);
  syncDifficultyUI();
  for (const c of [...trickRailGroup.children]) { trickRailGroup.remove(c); c.geometry?.dispose?.(); }
}

// Load (and, past the curated set, GENERATE) level `index`. Generation runs a short engine search, so
// yield a frame to paint "Generating…" first. Rebuilds the table if the level uses a different one.
async function loadTrickLevel(index) {
  if (!trick) return;
  playing = false;
  endReplay();
  endShotCam();
  pauseThen = null; pauseUntil = 0;
  trick.awaiting = false;
  trick.passed = false;
  el('trick-result').textContent = '';
  el('trick-result').style.color = '#a8b6c4';
  el('trick-next').disabled = true;
  clearPreview();
  if (index >= CURATED_COUNT) { status.textContent = 'Generating trick shot…'; el('trick-objective').textContent = 'Generating…'; await new Promise((r) => setTimeout(r, 0)); }
  const level = getLevel(index, trickSeed);
  if (!level) { status.textContent = 'Could not generate a level — try Retry.'; return; }
  trick.index = index;
  trick.level = level;

  // per-level table geometry (currently always pool; the level.table hook keeps others open)
  const v = VARIANTS[level.table] ?? pool;
  if (v !== variant) { variant = v; applyVariantGeom(); rebuildTable(); }
  frameCamera();
  // lightweight game object so the existing aim / preview / spin-pad / cue-lift code all just work
  game = { variant: v, pieces: level.pieces.map((p) => ({ ...p, pos: { ...p.pos } })), frame: { ballInHand: false, frameOver: false, turn: 0, message: '' } };
  for (const [, m] of ballMeshes) scene.remove(m.grp);
  ballMeshes.clear();
  orient.clear();
  syncBallMeshes(game.pieces);
  syncTrickRails(level);
  timeline = [];
  const h1 = document.querySelector('#panel h1');
  if (h1) h1.textContent = 'TRICK SHOTS · 3D';
  el('trick-name').textContent = level.name ?? `Level ${index + 1}`;
  el('trick-level').textContent = index < CURATED_COUNT ? `Famous · ${index + 1}/${CURATED_COUNT}` : `Level ${index + 1}`;
  el('trick-objective').textContent = level.objective ?? '';
  resetHumanControls();
  // Line the controls + predicted path up on the winning stroke, then auto-play it perfectly after a
  // beat (the "deadly demonstration"). Aiming yourself cancels it — see cancelTrickAuto() call sites.
  const sol = level.solution || findSolution(level);
  trick.solution = sol;
  if (sol) {
    setAim((sol.angle * 180) / Math.PI);
    sliders.power.value = String(Math.min(+sol.speed.toFixed(2), MAX_SPEED));
    refreshLabels();
    drawPreviewPaths(computePreviewPaths(sol)); // the exact predicted line — proves the ball follows it
    status.textContent = 'Demonstrating the shot… (aim yourself to take over)';
    armTrickAuto(index);
  } else {
    setAim(lastAngle ? (lastAngle * 180) / Math.PI : 0);
    status.textContent = 'Line up your shot, then Play.';
    refreshHumanPreview();
  }
}

// Resolve a trick shot rules-free (table cushions + the level's cue-rails), then play it back through
// the same shot-cam + replay pipeline as a live shot. The goal is judged when it settles (onReplayEnd).
function playTrickShot(shot) {
  if (playing || !trick || !trick.level) return;
  clearPreview();
  const res = runTrickShot(trick.level, shot);
  trick.lastRes = res;
  trick.awaiting = true;
  timeline = res.timeline;
  planCache = buildPlanCache(timeline, R);
  endT = timeline.length ? timeline[timeline.length - 1].t : 0;
  lastAngle = shot.angle;
  lastPots = pottedObjectBalls(timeline);
  simT = 0; soundIdx = 0;
  playing = true;
  lastFrame = performance.now();
  status.textContent = '';
  beginShotCam(shot);
}

// Shot settled → judge the goal, show the verdict, and gate the Next button.
function onTrickShotEnd() {
  trick.awaiting = false;
  // Settle the balls to their TRUE final rest. The pot replay cuts ~0.9s after the drop (for pacing),
  // which can freeze the cue mid-roll; unlike a normal frame (which resyncs to the rules' resting
  // layout in onReplayEnd), Trick Shots has no rules pass, so snap to the timeline's final positions.
  if (timeline.length) applyState(replayState(timeline, planCache, endT), 0);
  const res = trick.lastRes;
  const passed = res && trick.level.goal(res);
  trick.passed = passed;
  const r = el('trick-result');
  if (passed) { r.textContent = '✓ Shot made!'; r.style.color = '#54c98a'; el('trick-next').disabled = false; status.textContent = 'Nice! Next ▶ for the next level.'; applause(0.85, collisionIntervals(timeline)); }
  else { r.textContent = '✗ Not this time — ↺ Retry.'; r.style.color = '#e08a6a'; status.textContent = 'Missed the goal. Retry, or Show me the solution.'; }
}

// Play a known winning stroke (the stored solution, or one searched on demand) as a demo.
function showTrickSolution() {
  if (!trick || !trick.level || playing) return;
  cancelTrickAuto();
  const sol = trick.solution || trick.level.solution || findSolution(trick.level);
  if (!sol) { status.textContent = 'No solution found to show.'; return; }
  resetHumanControls();
  setAim((sol.angle * 180) / Math.PI);
  sliders.power.value = String(Math.min(+sol.speed.toFixed(2), MAX_SPEED));
  refreshLabels();
  playTrickShot(sol);
}

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
  // AI ball-in-hand: slide the white from the default spot to the AI's chosen placement, then line up
  if (aiPlace && !playing) {
    const p = Math.min(1, (now - aiPlace.start) / aiPlace.dur);
    const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; // easeInOut
    const pos = { x: aiPlace.from.x + (aiPlace.to.x - aiPlace.from.x) * e, y: aiPlace.from.y + (aiPlace.to.y - aiPlace.from.y) * e };
    heldCuePos = pos;
    setCuePiecePos(pos);
    if (p >= 1) { const shot = aiPlace.shot; aiPlace = null; startAiLineup(shot); }
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
    if (p >= 1) { const shot = aiLineup.final; aiLineup = null; shotIsAi = true; playShot(shot); }
  }
  if (playing && timeline.length) {
    if (shotCam && !shotCam.struck && !replaying && !exhibition) {
      // cueing: hold the balls at the shot start, animate the cue, hold the player's view
      applyState(replayState(timeline, planCache, 0), 0);
      driveShotCamCueing(now);
    } else {
    // a replay warps time (slow-mo the pot, fast-forward the dead rolling); the live pass is 1×
    const simDt = dt * (replaying ? replayRate(simT) * (trick ? TRICK_REPLAY_SLOW : 1) : 1); // trick replays play slower
    simT += simDt;
    const activeEnd = replaying ? replayInfo.end : endT; // a replay cuts just after the pot
    let ended = false;
    if (simT >= activeEnd) { simT = activeEnd; ended = true; }
    // fire a knock for each collision event the playback time has now passed
    while (soundIdx + 1 < timeline.length && timeline[soundIdx + 1].t <= simT) {
      soundIdx += 1;
      const s = timeline[soundIdx];
      if (s.kind === 'pair' || s.kind === 'rail' || s.kind === 'jaw' || s.kind === 'frame' || s.kind === 'bed') knock(s.kind, s.intensity || 0);
      else if (s.kind === 'pocket' && s.hit) {
        const fin = timeline[timeline.length - 1].balls.find((x) => x.id === s.hit.id);
        if (fin && fin.pocketed && !fin.cleared) { // a genuine drop (not a rattle/rebound) → swing the net
          const b = s.balls.find((x) => x.id === s.hit.id);
          if (b) kickNet(pocketNets, b.pos.x, b.pos.y, b.vel.x, b.vel.y, Math.hypot(b.vel.x, b.vel.y));
          // the crowd cheers the MOMENT a scoring ball drops (once per shot). crowdReaction>0 already
          // means the shot scored. But when a cinematic pot REPLAY follows (human/trick shots), the
          // player watches THAT drop — so cheer on the replay's pot, not the quick live pass, or it
          // fires early and the replay plays silent. AI shots (no replay) cheer on the live drop.
          if (s.hit.id !== 'cue' && crowdReaction > 0 && !applauseFired) {
            const willReplay = replaysOn() && lastPots.length && (trick || !shotIsAi);
            if (replaying || !willReplay) {
              applause(crowdReaction, collisionIntervals(timeline));
              applauseFired = true; applauseStartMs = now;
            }
          }
        }
      }
    }
    const state = replayState(timeline, planCache, simT);
    applyState(state, simDt);
    if (replaying) driveReplayCamera(camera, replayInfo, state, dt, simT, P3);
    else if (exhibition) driveExhibitionCamera(dt);
    else if (shotCam) driveShotCamWatch(dt); // risen broadcast view as the shot runs
    if (ended) {
      playing = false;
      if (shotCam) endShotCam(); // hand the camera back to the orbit controls (target is already centre)
      if (exhibition) nextExhibitionStep(); // 147 montage → next pot (no replays/rules)
      else if (replaying) { pauseUntil = now + 800; pauseThen = 'handoff'; } // hold on the pot (badge up), then hand off
      else if (replaysOn() && lastPots.length && (trick || !shotIsAi)) { pauseUntil = now + 500; pauseThen = 'replay'; } // pot replay: human shots + trick shots, never the AI's
      else onReplayEnd();
    }
    }
  }
  // timed transitions: a 500 ms beat before a replay, an 800 ms hold on the pot after it
  if (pauseThen && now >= pauseUntil) {
    const then = pauseThen;
    pauseUntil = 0;
    pauseThen = null;
    if (then === 'replay') startReplay();
    else { endReplay(); onReplayEnd(); }
  }
  if (aimView()) {
    controls.enabled = true; // orbit/pan/zoom stays available at every phase of the shot...
    if (aimDeg !== lastAimDeg) aimReframe = true; // ...but changing your aim swings the view back behind the cue
    if (aimReframe) driveAimCam(dt); // auto over-the-shoulder framing (until you grab the camera)
    else controls.update(); // you've taken over — free to rotate/pan/zoom the table
  } else {
    aimReframe = true; // re-arm the over-the-shoulder framing for the next time aiming resumes
    aimCam.init = false;
    if (!replaying && !exhibition && !shotCam) { // don't fight the replay / exhibition / cueing camera
      // "Cue-ball view" while just watching (AI turn etc.): keep the orbit centred on the white.
      if (pinCue() && game) { const c = cueBallPos(); controls.target.lerp(P3(c.x, c.y, R), 0.25); }
      controls.enabled = true;
      controls.update();
    }
  }
  lastAimDeg = aimDeg;
  updateNets(pocketNets, now); // swing any pocket net that a ball has just dropped into
  // The crowd watches the SHOT: gaze at the speed-weighted centre of the moving balls (so it tracks the
  // cue's travel, then shifts to the object ball as it rolls to the pocket). Idle → the cue ball.
  {
    let gx = 0, gy = 0, gz = 0, gw = 0;
    for (const [id, m] of ballMeshes) {
      const p = m.grp.position;
      const prev = gazePrev.get(id);
      const sp = prev ? Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z) : 0;
      if (prev) { prev.x = p.x; prev.y = p.y; prev.z = p.z; } else gazePrev.set(id, { x: p.x, y: p.y, z: p.z });
      if (m.grp.visible && sp > 0.012) { gx += p.x * sp; gy += p.y * sp; gz += p.z * sp; gw += sp; }
    }
    let tx, ty, tz;
    if (gw > 1e-4) { tx = gx / gw; ty = gy / gw; tz = gz / gw; } // centre of the action
    else { const c = ballMeshes.get('cue'); if (c) ({ x: tx, y: ty, z: tz } = c.grp.position); }
    if (tx !== undefined) crowd.update(tx, ty, tz, now);
  }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

resize();
newFrameGame();
requestAnimationFrame(frame);

// Deep-link: ?tricky=true jumps straight into Trick Shots on the Leapfrog and auto-demos it. A
// ?tricky=<levelId> (e.g. guardrail) or ?tricky=<n> targets a specific level.
{
  const params = new URLSearchParams(location.search);
  const q = params.get('tricky');
  const frameToken = params.get('frame');
  const challengeToken = params.get('challenge');
  const game = params.get('game'); // ?game=<id> — deep-link from the compendium hub into a cue variant
  if (challengeToken) {
    try { startChallenge(challengeToken); } catch { status.textContent = 'That challenge link couldn’t be read.'; }
  } else if (frameToken) {
    try { startSharedReplay(decodeFrame(frameToken)); } catch { status.textContent = 'That share link couldn’t be read.'; }
  } else if (q) {
    const idx = q === 'true' ? TRICK_LEVELS.leapfrog : (TRICK_LEVELS[q] ?? (Number.isInteger(+q) ? +q : TRICK_LEVELS.leapfrog));
    el('game').value = 'trickshots';
    startTrickShots(idx);
  } else if (game && [...el('game').options].some((o) => o.value === game)) {
    // select the requested variant and run its change handler (which sets the variant / starts a frame)
    el('game').value = game;
    el('game').dispatchEvent(new Event('change'));
  }
}
