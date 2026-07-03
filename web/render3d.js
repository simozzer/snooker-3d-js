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
import { build147 } from '../src/exhibition.js';
import { getLevel, runTrickShot, findSolution, CURATED_COUNT } from '../src/trickshots.js';
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
const netMat = new THREE.LineBasicMaterial({ color: 0x9a9a86, transparent: true, opacity: 0.72 });
// pocket mouth: a clean, faintly luminescent disc (unlit, so it reads as softly self-lit) over the
// green — a round glow rather than a black hole. depthWrite off so the net + resting balls show through.
const mouthMat = new THREE.MeshBasicMaterial({ color: 0x3a5f6e, transparent: true, opacity: 0.5, depthWrite: false });
const markMat = new THREE.LineBasicMaterial({ color: 0xdfeae0, transparent: true, opacity: 0.5 });
const spotMat = new THREE.MeshBasicMaterial({ color: 0xdfeae0, transparent: true, opacity: 0.65 });
const brassMat = new THREE.MeshStandardMaterial({ color: 0xb5893a, metalness: 0.85, roughness: 0.34 });

function buildTable() {
  const g = new THREE.Group();
  // bed: a thin slab whose OUTLINE is bitten inward at each pocket (a semicircle on the rails, a
  // quarter arc at each corner), so the pocket mouths are real openings cut through the cloth — the
  // green stops at the mouth circle instead of showing under it. Pockets sit on the boundary, so this
  // notched-outline (not boundary-crossing holes) triangulates cleanly with no leak past the border.
  const bed = new THREE.Mesh(new THREE.ExtrudeGeometry(bedShape(), { depth: 0.02 * S, bevelEnabled: false }), cloth);
  bed.rotation.x = Math.PI / 2; // shape (x,y) → world (x,z); top surface at y=0, slab extends down
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

  // each pocket: a dark floor deep in the bag (so the recess reads from any angle) and a baggy string
  // net hung from the mouth. The mouth itself is the real hole in the bed, so the net shows from above.
  pocketNets = [];
  for (const p of variant.pockets()) {
    const mouthR = p.mouth ?? p.radius;
    const floor = new THREE.Mesh(new THREE.CircleGeometry(mouthR * 1.2 * S, 24), pocketMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.copy(P3(p.center.x, p.center.y, -NET_DEPTH - 0.01));
    g.add(floor);
    const net = buildNet(mouthR); // pivots at the rim, so it swings when a ball drops in
    net.position.copy(P3(p.center.x, p.center.y, 0));
    g.add(net);
    // translucent circular mouth: makes the pocket read as a round hole (vs green cloth) without hiding the net
    const mouth = new THREE.Mesh(new THREE.CircleGeometry(mouthR * S, 28), mouthMat);
    mouth.rotation.x = -Math.PI / 2;
    mouth.position.copy(P3(p.center.x, p.center.y, 0.002));
    mouth.renderOrder = 1;
    g.add(mouth);
    // a brass plate ringing each pocket, sat on the rail tops — a wide arc whose gap faces into the
    // table (where the ball enters) so it hugs the rails around the back and sides of the mouth
    const isCorner = Math.abs(p.center.x) > 1e-6 && Math.abs(p.center.y) > 1e-6;
    const arcLen = isCorner ? Math.PI * 0.6 : Math.PI * 0.82; // corner: a short cap whose ends run along the two rails
    const arc = new THREE.Mesh(new THREE.TorusGeometry(mouthR * 1.02 * S, 0.013 * S, 10, 30, arcLen), brassMat);
    arc.rotation.x = Math.PI / 2; // flat; local angle θ → world (cosθ, sinθ) in the X–Z plane
    arc.castShadow = true;
    const bracket = new THREE.Group();
    bracket.add(arc);
    bracket.position.copy(P3(p.center.x, p.center.y, topZ * 0.9));
    bracket.rotation.y = arcLen / 2 - Math.atan2(p.center.y, p.center.x); // centre the arc outward, gap facing the table
    g.add(bracket);
    pocketNets.push({ cx: p.center.x, cy: p.center.y, grp: net, jig: null });
  }

  // painted cloth markings (baulk line / D / spots for snooker; head string + spots for pool & 9-ball),
  // laid just above the bed. Each variant owns its own geometry via markings().
  if (variant.markings) {
    const mk = variant.markings();
    const MY = 0.004; // sit just above the bed to avoid z-fighting
    const polyline = (ptsPhys) => g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ptsPhys.map((p) => P3(p.x, p.y, MY))), markMat));
    for (const seg of mk.lines ?? []) polyline(seg);
    for (const arc of mk.arcs ?? []) {
      const pts = [];
      for (let i = 0; i <= 40; i++) { const a = arc.a0 + (arc.a1 - arc.a0) * (i / 40); pts.push({ x: arc.cx + Math.cos(a) * arc.r, y: arc.cy + Math.sin(a) * arc.r }); }
      polyline(pts);
    }
    for (const sp of mk.spots ?? []) {
      const dot = new THREE.Mesh(new THREE.CircleGeometry(0.011 * S, 14), spotMat);
      dot.rotation.x = -Math.PI / 2;
      dot.position.copy(P3(sp.x, sp.y, MY));
      g.add(dot);
    }
  }
  return g;
}
// A small string basket: strands from the mouth ring taper to a narrow bottom. Local origin at the
// mouth (world y=0) so it swings when a ball drops in.
const NET_DEPTH = 0.12; // bag depth (m)
function buildNet(mouthR) {
  const N = 14;
  const D = NET_DEPTH;
  const rings = [{ y: -0.004, r: mouthR * 0.96 }, { y: -D * 0.4, r: mouthR * 0.8 }, { y: -D * 0.72, r: mouthR * 0.55 }, { y: -D, r: mouthR * 0.32 }];
  const node = (ri, i) => { const a = (i / N) * Math.PI * 2; return new THREE.Vector3(Math.cos(a) * rings[ri].r * S, rings[ri].y * S, Math.sin(a) * rings[ri].r * S); };
  const pts = [];
  for (let i = 0; i < N; i++) for (let ri = 0; ri < rings.length - 1; ri++) pts.push(node(ri, i), node(ri + 1, i)); // strands
  for (let ri = 1; ri < rings.length; ri++) for (let i = 0; i < N; i++) pts.push(node(ri, i), node(ri, (i + 1) % N)); // hoops
  return new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), netMat);
}
const TABLE_W = () => B.maxX - B.minX;
const TABLE_H = () => B.maxY - B.minY;

// The table bed outline (scene units) with each pocket mouth bitten inward — a simple closed polygon
// (no holes), so the openings cut cleanly through the slab. Walks the perimeter counterclockwise,
// arcing into the table around each pocket centre by its mouth radius; every arc bulges inward.
function bedShape() {
  const pk = variant.pockets();
  const rAt = (x, y) => { const p = pk.find((q) => Math.abs(q.center.x - x) < 1e-6 && Math.abs(q.center.y - y) < 1e-6); return (p.mouth ?? p.radius) * S; };
  const [cbl, cbr, ctr, ctl, mb, mt] = [rAt(-HX, -HY), rAt(HX, -HY), rAt(HX, HY), rAt(-HX, HY), rAt(0, -HY), rAt(0, HY)];
  const x = HX * S;
  const y = HY * S;
  const P = Math.PI;
  const sh = new THREE.Shape();
  sh.moveTo(-x + cbl, -y);
  sh.lineTo(-mb, -y);
  sh.absarc(0, -y, mb, P, 0, true); // bottom-middle
  sh.lineTo(x - cbr, -y);
  sh.absarc(x, -y, cbr, P, P / 2, true); // bottom-right corner
  sh.lineTo(x, y - ctr);
  sh.absarc(x, y, ctr, (3 * P) / 2, P, true); // top-right corner
  sh.lineTo(mt, y);
  sh.absarc(0, y, mt, 0, -P, true); // top-middle
  sh.lineTo(-x + ctl, y);
  sh.absarc(-x, y, ctl, 0, -P / 2, true); // top-left corner
  sh.lineTo(-x, -y + cbl);
  sh.absarc(-x, -y, cbl, P / 2, 0, true); // bottom-left corner
  sh.closePath();
  return sh;
}
let pocketNets = []; // [{ cx, cy, grp, jig }] — string baskets that swing when a ball drops in
let tableGroup = null;

// A ball has just dropped into the pocket nearest (cx,cy) moving at (vx,vy): swing that net like a
// pendulum in the ball's direction, decaying over ~1.5 s. Amplitude scales with the drop speed.
function kickNet(cx, cy, vx, vy, speed) {
  let best = null;
  let bd = Infinity;
  for (const n of pocketNets) { const d = Math.hypot(n.cx - cx, n.cy - cy); if (d < bd) { bd = d; best = n; } }
  if (!best) return;
  const dir = new THREE.Vector3(vx, 0, vy);
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
  const axis = new THREE.Vector3(0, 1, 0).cross(dir.normalize()).normalize(); // horizontal, ⟂ to impact
  best.jig = { t0: performance.now(), amp: Math.min(0.5, speed * 0.09), axis };
}
function updateNets(now) {
  for (const n of pocketNets) {
    if (!n.jig) continue;
    const e = (now - n.jig.t0) / 1000;
    if (e > 1.5) { n.grp.quaternion.identity(); n.jig = null; continue; }
    n.grp.quaternion.setFromAxisAngle(n.jig.axis, n.jig.amp * Math.exp(-4 * e) * Math.cos(14 * e)); // damped swing
  }
}
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
let trick = null; // Trick Shots mode state: { index, level, awaiting, passed } — null when not in the mode
let aiRng = mulberry32(1);
let timeline = [];
let planCache = null;
let endT = 0;

// (the interpolation core lives in replay.js — pure, no three.js, headlessly tested for parity.)

// accumulate a rolling orientation per ball from spin so the surface spot visibly turns
const orient = new Map();
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
    if (s.pocketed) {
      if (s.cleared) { m.grp.visible = true; m.grp.position.copy(P3(s.pos.x, s.pos.y, s.pos.z)); continue; } // frozen where it left
      const b = bagPos.get(id) ?? { x: s.pos.x, y: s.pos.y, z: -0.05 };
      m.grp.visible = true;
      m.grp.position.copy(P3(b.x, b.y, b.z)); // resting in the bag
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
  'Every level shows an objective at the top — line up aim / power / spin / jump, then Play.',
  'Anything goes: all shots are legal and jump shots count. Some levels lay a cue stick on the table as a rail to bank off.',
  '↺ Retry resets the layout · “Show me” plays a winning solution · “Next ▶” unlocks once you make the shot.',
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
  endShotCam();
  pauseUntil = 0;
  pauseThen = null;
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
  shot = applyCueConstraints(shot); // a raised cue (over a ball / off a cushion) can't draw — enforce it
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
const replaysOn = () => el('replays').checked;

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

// Frame the whole story: sit at the treatment's angle, far enough back that EVERY potted ball and the
// cue's line stay in view, with a slow push-in + gentle orbit for cinematic life. Static framing (only
// distance/orbit ease) → inherently smooth (no per-frame chase jitter); dt-based damping keeps it
// frame-rate independent.
const HALF_TAN = Math.tan(((45 * Math.PI) / 180) / 2); // camera vertical half-FOV
function driveReplayCamera(state, dt) {
  const rm = replayInfo;
  const p = Math.min(1, simT / rm.end); // replay progress 0→1
  if (rm.swivel) { driveSwivelCamera(state, dt, p); return; }
  const fit = (rm.radius / HALF_TAN) * 1.25 + rm.radius; // distance that frames `radius` with margin
  const dist = fit * (1.32 - 0.3 * p); // slow push-in over the replay
  const ang = rm.orbit * p; // gentle orbit
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const d = rm.dir;
  const dir = new THREE.Vector3(d.x * c - d.z * s, d.y, d.x * s + d.z * c); // rotate `dir` about the Y axis
  const dPos = rm.center.clone().addScaledVector(dir, dist);
  const dTgt = rm.center;
  if (!rm.init) { rm.camPos.copy(dPos); rm.camTgt.copy(dTgt); rm.init = true; }
  else {
    const kP = 1 - Math.exp(-dt / 0.3); // exponential damping (frame-rate independent)
    const kT = 1 - Math.exp(-dt / 0.2);
    rm.camPos.lerp(dPos, kP);
    rm.camTgt.lerp(dTgt, kT);
  }
  camera.position.copy(rm.camPos);
  camera.lookAt(rm.camTgt);
}

// The rare swivel treatment: sweep a big arc around the vertical axis through the action while the look
// pans toward the ball we're chasing — dynamic angle changes, but always orbiting at the framing distance
// so every collision and final position stays in view (never the tight crop of a true follow-cam). The
// azimuth is driven by replay progress `p` (warped by replayRate), so it slows around the pot.
const SWIVEL_EH = 0.87, SWIVEL_EV = 0.5; // cos/sin of the ~30° orbit elevation
function driveSwivelCamera(state, dt, p) {
  const rm = replayInfo;
  const fit = (rm.radius / HALF_TAN) * 1.5 + rm.radius; // wider margin than the static frame: the look is off-centre
  const f = state.get(rm.followId);
  const ball = f ? P3(f.pos.x, f.pos.y, f.pos.z) : rm.center.clone();
  const dTgt = rm.center.clone().lerp(ball, 0.35); // bias the look toward the chased ball, but keep the action framed
  const az = rm.swivelBase + rm.swivelDir * p * Math.PI * 1.7; // most of a full turn across the whole replay
  const dPos = new THREE.Vector3(
    rm.center.x + Math.cos(az) * fit * SWIVEL_EH,
    fit * SWIVEL_EV, // elevated above the table
    rm.center.z + Math.sin(az) * fit * SWIVEL_EH,
  );
  if (!rm.init) { rm.camPos.copy(dPos); rm.camTgt.copy(dTgt); rm.init = true; }
  else {
    const kP = 1 - Math.exp(-dt / 0.3);
    const kT = 1 - Math.exp(-dt / 0.2);
    rm.camPos.lerp(dPos, kP);
    rm.camTgt.lerp(dTgt, kT);
  }
  camera.position.copy(rm.camPos);
  camera.lookAt(rm.camTgt);
}

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

// The human's shot from the sliders (aim/power/spin/elevation). Ball-in-hand uses the default D spot.
function humanShot() {
  if (playing) return;
  if (trick) { if (!trick.awaiting) playTrickShot(sliderShot()); return; }
  if (isAiTurn() || game.frame.frameOver) return;
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
  if (game.frame.frameOver) {
    status.textContent = game.frame.message;
    // Watch AI vs AI → rack a fresh frame automatically after a beat so it plays on indefinitely
    if (selfPlay() && !exhibition) setTimeout(() => { if (game.frame.frameOver && selfPlay() && !exhibition) newFrameGame(); }, 3000);
    return;
  }
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
  if (replaying || pauseThen === 'replay') { skipReplay(); ev.preventDefault(); return; } // any key skips a pot replay
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
el('rec147').addEventListener('click', () => { startExhibition(true); });

// --- Trick Shots mode ------------------------------------------------------------------------
// A solo, level-based challenge (src/trickshots.js): each level is a fixed layout + a machine-checkable
// goal, with NO game rules — every shot is legal, jump shots included. Curated famous shots come first
// (one uses a laid cue stick as a rail), then endless generated levels of rising difficulty. We reuse
// the human aim/power/spin/jump UI and the shot-cam + pot-replay; only the resolve path differs (the
// rules-free runTrickShot), and the goal is judged when the shot settles.
let trickSeed = 20260701; // varies generated layouts run to run (fixed here for reproducibility)
const trickRailGroup = new THREE.Group();
scene.add(trickRailGroup);

function setTrickUI(on) {
  el('trickpanel').style.display = on ? 'block' : 'none';
  for (const id of ['row-opponent', 'row-difficulty', 'newframe', 'rec147', 'scores']) { const e = el(id); if (e) e.style.display = on ? 'none' : ''; }
}

// Draw the level's cue-stick rails as thin cylinders lying on the bed (a real cue used as a rail).
function syncTrickRails(level) {
  for (const c of [...trickRailGroup.children]) { trickRailGroup.remove(c); c.geometry?.dispose?.(); }
  for (const r of level.rails ?? []) {
    const [lo, hi] = r.span;
    const len = (hi - lo) * S;
    const mid = ((lo + hi) / 2) * S;
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.008 * S, 0.013 * S, len, 14),
      new THREE.MeshStandardMaterial({ color: 0xcaa062, roughness: 0.5 }),
    );
    shaft.castShadow = true;
    const y = R * S * 0.9;
    if (r.axis === 'x') { shaft.rotation.z = Math.PI / 2; shaft.position.set(mid, y, r.perp * S); }
    else { shaft.rotation.x = Math.PI / 2; shaft.position.set(r.perp * S, y, mid); }
    trickRailGroup.add(shaft);
  }
}

function startTrickShots() {
  playing = false;
  endReplay();
  endShotCam();
  pauseThen = null; pauseUntil = 0;
  aiLineup = null;
  exhibition = null;
  trick = { index: 0, level: null, awaiting: false, passed: false };
  setTrickUI(true);
  updateRulesPanel();
  loadTrickLevel(0);
}

function exitTrickShots() {
  if (!trick) return;
  trick = null;
  setTrickUI(false);
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
  status.textContent = 'Line up your shot, then Play.';
  resetHumanControls();
  setAim(lastAngle ? (lastAngle * 180) / Math.PI : 0);
  refreshHumanPreview();
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
  const res = trick.lastRes;
  const passed = res && trick.level.goal(res);
  trick.passed = passed;
  const r = el('trick-result');
  if (passed) { r.textContent = '✓ Shot made!'; r.style.color = '#54c98a'; el('trick-next').disabled = false; status.textContent = 'Nice! Next ▶ for the next level.'; }
  else { r.textContent = '✗ Not this time — ↺ Retry.'; r.style.color = '#e08a6a'; status.textContent = 'Missed the goal. Retry, or Show me the solution.'; }
}

// Play a known winning stroke (the stored solution, or one searched on demand) as a demo.
function showTrickSolution() {
  if (!trick || !trick.level || playing) return;
  const sol = trick.level.solution || findSolution(trick.level);
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
    if (shotCam && !shotCam.struck && !replaying && !exhibition) {
      // cueing: hold the balls at the shot start, animate the cue, hold the player's view
      applyState(replayState(timeline, planCache, 0), 0);
      driveShotCamCueing(now);
    } else {
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
      else if (s.kind === 'pocket' && s.hit) {
        const fin = timeline[timeline.length - 1].balls.find((x) => x.id === s.hit.id);
        if (fin && fin.pocketed && !fin.cleared) { // a genuine drop (not a rattle/rebound) → swing the net
          const b = s.balls.find((x) => x.id === s.hit.id);
          if (b) kickNet(b.pos.x, b.pos.y, b.vel.x, b.vel.y, Math.hypot(b.vel.x, b.vel.y));
        }
      }
    }
    const state = replayState(timeline, planCache, simT);
    applyState(state, simDt);
    if (replaying) driveReplayCamera(state, dt);
    else if (exhibition) driveExhibitionCamera(dt);
    else if (shotCam) driveShotCamWatch(dt); // risen broadcast view as the shot runs
    if (ended) {
      playing = false;
      if (shotCam) endShotCam(); // hand the camera back to the orbit controls (target is already centre)
      if (exhibition) nextExhibitionStep(); // 147 montage → next pot (no replays/rules)
      else if (replaying) { pauseUntil = now + 800; pauseThen = 'handoff'; } // hold on the pot (badge up), then hand off
      else if (replaysOn() && lastPots.length) { pauseUntil = now + 500; pauseThen = 'replay'; } // a beat, then replay
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
  if (!replaying && !exhibition && !shotCam) controls.update(); // don't fight the replay / exhibition / cueing camera
  updateNets(now); // swing any pocket net that a ball has just dropped into
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

resize();
newFrameGame();
requestAnimationFrame(frame);
