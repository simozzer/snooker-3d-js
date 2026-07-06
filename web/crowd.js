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
  const bodyGeo = new THREE.CylinderGeometry(0.42, 0.72, 1, 5); // unit height, scaled per instance
  const headGeo = new THREE.SphereGeometry(0.72, 6, 5);
  const bodies = new THREE.InstancedMesh(bodyGeo, new THREE.MeshBasicMaterial(), N);
  const heads = new THREE.InstancedMesh(headGeo, new THREE.MeshBasicMaterial(), N);

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
    s.set(1, 1, 1); p.set(x, y + h + 0.55, z); m.compose(p, q, s); heads.setMatrixAt(i, m);
    c.setHex(pick(skins)).multiplyScalar(0.5 + Math.random() * 0.35); heads.setColorAt(i, c);
  }
  bodies.instanceMatrix.needsUpdate = true;
  heads.instanceMatrix.needsUpdate = true;
  bodies.instanceColor.needsUpdate = true;
  heads.instanceColor.needsUpdate = true;
  g.add(bodies, heads);

  // static, non-interactive, unshadowed background
  g.traverse((o) => { o.castShadow = false; o.receiveShadow = false; o.raycast = () => {}; });
  g.matrixAutoUpdate = false;
  g.updateMatrixWorld(true);
  return g;
}
