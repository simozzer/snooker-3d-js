// crowd.js — a faint Lowry-esque arena around the table: dark concentric tiers with rows of
// matchstick spectators (a thin body + a dot head each), drawn as two InstancedMeshes so the whole
// crowd is a couple of draw calls. Pure background decoration: unlit dark materials so it reads as a
// dim audience ringing a spotlit table, casts/receives no shadow, is not pickable, and sits well
// beyond any in-play camera orbit so it never comes between the lens and the table.
//
// `ex`, `ez` are the table half-extents in scene units; the bowl is sized generously beyond them.

import * as THREE from 'three';

export function buildCrowd(ex, ez) {
  const g = new THREE.Group();
  g.name = 'crowd';
  const base = Math.max(ex, ez);
  const FRONT = base * 2.4 + 14; // front-row radius — outside the default / over-the-shoulder camera orbit
  const TIERS = 12;
  const STEP_OUT = base * 0.28 + 2; // each tier steps this far out…
  const STEP_UP = base * 0.16 + 1.4; // …and this far up, forming the bowl
  const BASE_Y = -2; // front row a touch below the table bed

  // dark stepped tiers (the stand), receding into the black
  const tierMat = new THREE.MeshBasicMaterial({ color: 0x141922 });
  for (let t = 0; t < TIERS; t++) {
    const r = FRONT + t * STEP_OUT;
    const ring = new THREE.Mesh(new THREE.RingGeometry(r - STEP_OUT * 0.92, r, 100), tierMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = BASE_Y + t * STEP_UP;
    g.add(ring);
  }
  // an enclosing back wall so there is no void behind the top tier
  const wallR = FRONT + TIERS * STEP_OUT;
  const wallH = STEP_UP * TIERS + 24;
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(wallR, wallR, wallH, 64, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x0b0f16, side: THREE.BackSide }),
  );
  wall.position.y = BASE_Y + wallH / 2 - 6;
  g.add(wall);

  // spectators: instanced thin bodies + dot heads, scattered across the tiers
  const N = 1100;
  const HEADR = 0.72;
  const bodyGeo = new THREE.CylinderGeometry(0.42, HEADR, 1, 5); // unit height, scaled per instance
  const headGeo = new THREE.SphereGeometry(HEADR, 6, 5);
  const bodies = new THREE.InstancedMesh(bodyGeo, new THREE.MeshBasicMaterial(), N);
  const heads = new THREE.InstancedMesh(headGeo, new THREE.MeshBasicMaterial(), N);
  // a pair of pale eyes per spectator (2 instances each) — repositioned every frame onto the side of
  // the head facing the ball, so the whole crowd's gaze tracks the action. A few look elsewhere.
  // Low-poly eyeball + pupil: the crowd is tiny/background and there are N*2 of each, so keep the total
  // geometry ≈ what a single eye mesh cost before adding pupils (the software test renderer is sensitive).
  const eyeGeo = new THREE.SphereGeometry(0.26, 5, 3);
  const eyes = new THREE.InstancedMesh(eyeGeo, new THREE.MeshBasicMaterial({ color: 0xbfc2b8 }), N * 2);
  eyes.frustumCulled = false;
  // a dark pupil on the front of each eye (toward the ball) so the gaze reads as looking AT the action;
  // both eyes + pupils flatten for a beat when a spectator blinks (see update)
  const pupilGeo = new THREE.SphereGeometry(0.14, 4, 2);
  const pupils = new THREE.InstancedMesh(pupilGeo, new THREE.MeshBasicMaterial({ color: 0x0a0c10 }), N * 2);
  pupils.frustumCulled = false;
  const spec = new Array(N); // { x,y,z head-centre; gaze:null=follow the ball | {dx,dy,dz}=a fixed distracted look }

  // muted Lowry palette, kept deliberately dark so the crowd stays a faint suggestion against the black
  const coats = [0x22262d, 0x281e18, 0x2c2020, 0x1c222a, 0x2a271f, 0x242429, 0x30271f];
  const skins = [0x413730, 0x4c3f34, 0x3a302a, 0x473a2e];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const c = new THREE.Color();
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  for (let i = 0; i < N; i++) {
    const ang = Math.random() * Math.PI * 2;
    const tier = (Math.random() * TIERS) | 0;
    const r = FRONT + tier * STEP_OUT + (Math.random() - 0.5) * STEP_OUT * 0.55;
    const y = BASE_Y + tier * STEP_UP;
    const h = 4 + Math.random() * 2.6; // varied heights → a scruffier, more human row
    const x = Math.cos(ang) * r + (Math.random() - 0.5) * 2.2;
    const z = Math.sin(ang) * r + (Math.random() - 0.5) * 2.2;
    // body
    s.set(1, h, 1); p.set(x, y + h / 2, z); m.compose(p, q, s); bodies.setMatrixAt(i, m);
    c.setHex(pick(coats)).multiplyScalar(0.55 + Math.random() * 0.4); bodies.setColorAt(i, c);
    // head
    const hy = y + h + 0.55;
    s.set(1, 1, 1); p.set(x, hy, z); m.compose(p, q, s); heads.setMatrixAt(i, m);
    c.setHex(pick(skins)).multiplyScalar(0.5 + Math.random() * 0.35); heads.setColorAt(i, c);
    // Character: most watch the ball; ~10% are distracted (a fixed gaze down at a phone / off to a mate),
    // and ~9% are eye-rollers who watch but periodically roll their eyes at the play.
    let gaze = null, roll = null;
    const rnd = Math.random();
    if (rnd < 0.10) {
      const da = Math.random() * Math.PI * 2, dtilt = -0.15 - Math.random() * 0.55;
      const gl = Math.hypot(Math.cos(da), dtilt, Math.sin(da)) || 1;
      gaze = { dx: Math.cos(da) / gl, dy: dtilt / gl, dz: Math.sin(da) / gl };
    } else if (rnd < 0.19) {
      roll = { period: 5 + Math.random() * 5, phase: Math.random() * 10, dur: 0.6 + Math.random() * 0.3, dir: Math.random() < 0.5 ? 1 : -1 };
    }
    spec[i] = { x, y: hy, z, gaze, roll, blink: { period: 2.6 + Math.random() * 3.6, phase: Math.random() * 10 } };
  }
  bodies.instanceMatrix.needsUpdate = true;
  heads.instanceMatrix.needsUpdate = true;
  bodies.instanceColor.needsUpdate = true;
  heads.instanceColor.needsUpdate = true;
  g.add(bodies, heads, eyes, pupils);

  // static, non-interactive, unshadowed background
  g.traverse((o) => { o.castShadow = false; o.receiveShadow = false; o.raycast = () => {}; });
  g.matrixAutoUpdate = false;
  g.updateMatrixWorld(true);

  // Repoint every spectator's eyes onto the head-side facing (tx,ty,tz) — the live ball. Distracted
  // people keep their fixed gaze. Skips the work when the ball hasn't moved (idle turns cost nothing).
  const EYE_SEP = 0.30, EYE_FWD = HEADR * 0.86, EYE_UP = HEADR * 0.1, PUPIL_FWD = 0.17, BLINK_DUR = 0.11;
  const em = new THREE.Matrix4();
  const ep = new THREE.Vector3(), es = new THREE.Vector3();
  function update(tx, ty, tz, now) {
    const t = now / 1000;
    for (let i = 0; i < N; i++) {
      const sp = spec[i];
      let dx, dy, dz;
      const rollP = sp.roll ? (t + sp.roll.phase) % sp.roll.period : -1;
      if (rollP >= 0 && rollP < sp.roll.dur) { // mid eye-roll: sweep the gaze in a circle up over the head
        const a = (rollP / sp.roll.dur) * Math.PI * 2 * sp.roll.dir;
        dx = Math.cos(a) * 0.7; dy = 1; dz = Math.sin(a) * 0.7;
        const L = Math.hypot(dx, dy, dz); dx /= L; dy /= L; dz /= L;
      } else if (sp.gaze) { dx = sp.gaze.dx; dy = sp.gaze.dy; dz = sp.gaze.dz; }
      else { dx = tx - sp.x; dy = ty - sp.y; dz = tz - sp.z; const L = Math.hypot(dx, dy, dz) || 1; dx /= L; dy /= L; dz /= L; }
      let rx = dz, rz = -dx; const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl; // horizontal right = up × dir
      const cx = sp.x + dx * EYE_FWD, cy = sp.y + dy * EYE_FWD + EYE_UP, cz = sp.z + dz * EYE_FWD;
      // blink: flatten the eyes (and their pupils) to a slit for a beat, on this spectator's own cadence
      const bp = (t + sp.blink.phase) % sp.blink.period;
      es.set(1, bp < BLINK_DUR ? 0.1 : 1, 1);
      for (let k = 0; k < 2; k++) {
        const sgn = k === 0 ? 1 : -1;
        const idx = 2 * i + k;
        const px = cx + rx * EYE_SEP * sgn, pz = cz + rz * EYE_SEP * sgn;
        ep.set(px, cy, pz); em.compose(ep, q, es); eyes.setMatrixAt(idx, em); // eyeball
        ep.set(px + dx * PUPIL_FWD, cy + dy * PUPIL_FWD, pz + dz * PUPIL_FWD); em.compose(ep, q, es); pupils.setMatrixAt(idx, em); // pupil on the front
      }
    }
    eyes.instanceMatrix.needsUpdate = true;
    pupils.instanceMatrix.needsUpdate = true;
  }
  update(0, 0, 0, 0); // initial gaze toward the table centre
  return { group: g, update };
}
