// table3d.js — the static 3D table: bed, cloth cushions, wooden frame, pocket jaws, nets, markings.
//
// Presentation only. The renderer passes a geometry `ctx` = { variant, S, R, B, HX, HY, topZ, P3 }
// (scene scale, ball radius, bounds, half-extents, cushion-top height, and the physics→scene mapper)
// so this module holds no game state. buildTable(ctx) returns { group, nets }; the renderer adds the
// group to the scene and keeps `nets` for the pocket-bag layout and the swing animation (kickNet/
// updateNets, which operate on that same nets array).

import * as THREE from 'three';
import { railCylinders, pocketJaws } from '../src/table.js';
import { feltMaterial, woodMat, jawMat, pocketMat, netMat, mouthMat, markMat, spotMat, brassMat } from './materials.js';

export const NET_DEPTH = 0.12; // bag depth (m)

// A small string basket: strands from the mouth ring taper to a narrow bottom. Local origin at the
// mouth (world y=0) so it swings when a ball drops in.
function buildNet(mouthR, { S }) {
  const N = 14;
  const D = NET_DEPTH;
  const rings = [{ y: -0.004, r: mouthR * 0.96 }, { y: -D * 0.4, r: mouthR * 0.8 }, { y: -D * 0.72, r: mouthR * 0.55 }, { y: -D, r: mouthR * 0.32 }];
  const node = (ri, i) => { const a = (i / N) * Math.PI * 2; return new THREE.Vector3(Math.cos(a) * rings[ri].r * S, rings[ri].y * S, Math.sin(a) * rings[ri].r * S); };
  const pts = [];
  for (let i = 0; i < N; i++) for (let ri = 0; ri < rings.length - 1; ri++) pts.push(node(ri, i), node(ri + 1, i)); // strands
  for (let ri = 1; ri < rings.length; ri++) for (let i = 0; i < N; i++) pts.push(node(ri, i), node(ri, (i + 1) % N)); // hoops
  return new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), netMat);
}

// The table bed outline (scene units) with each pocket mouth bitten inward — a simple closed polygon
// (no holes), so the openings cut cleanly through the slab. Walks the perimeter counterclockwise,
// arcing into the table around each pocket centre by its mouth radius; every arc bulges inward.
function bedShape({ variant, S, HX, HY }) {
  const pk = variant.pockets();
  // 0 for an absent pocket (e.g. a carrom board has no middle pockets) → that edge stays a straight line.
  const rAt = (x, y) => { const p = pk.find((q) => Math.abs(q.center.x - x) < 1e-6 && Math.abs(q.center.y - y) < 1e-6); return p ? (p.mouth ?? p.radius) * S : 0; };
  const [cbl, cbr, ctr, ctl, mb, mt] = [rAt(-HX, -HY), rAt(HX, -HY), rAt(HX, HY), rAt(-HX, HY), rAt(0, -HY), rAt(0, HY)];
  const x = HX * S;
  const y = HY * S;
  const P = Math.PI;
  const sh = new THREE.Shape();
  sh.moveTo(-x + cbl, -y);
  if (mb > 0) { sh.lineTo(-mb, -y); sh.absarc(0, -y, mb, P, 0, true); } // bottom-middle (skipped if none)
  sh.lineTo(x - cbr, -y);
  sh.absarc(x, -y, cbr, P, P / 2, true); // bottom-right corner
  sh.lineTo(x, y - ctr);
  sh.absarc(x, y, ctr, (3 * P) / 2, P, true); // top-right corner
  if (mt > 0) { sh.lineTo(mt, y); sh.absarc(0, y, mt, 0, -P, true); } // top-middle (skipped if none)
  sh.lineTo(-x + ctl, y);
  sh.absarc(-x, y, ctl, 0, -P / 2, true); // top-left corner
  sh.lineTo(-x, -y + cbl);
  sh.absarc(-x, -y, cbl, P / 2, 0, true); // bottom-left corner
  sh.closePath();
  return sh;
}

export function buildTable(ctx) {
  const { variant, S, R, B, HX, HY, topZ, P3 } = ctx;
  const g = new THREE.Group();
  const nets = []; // [{ cx, cy, grp, jig }] — string baskets that swing when a ball drops in
  const feltMat = feltMaterial(variant.cloth && variant.cloth.startsWith('#') ? variant.cloth : '#1f7a4d'); // per-table baize colour
  // bed: a thin slab whose OUTLINE is bitten inward at each pocket (a semicircle on the rails, a
  // quarter arc at each corner), so the pocket mouths are real openings cut through the cloth — the
  // green stops at the mouth circle instead of showing under it. Pockets sit on the boundary, so this
  // notched-outline (not boundary-crossing holes) triangulates cleanly with no leak past the border.
  const bed = new THREE.Mesh(new THREE.ExtrudeGeometry(bedShape(ctx), { depth: 0.02 * S, bevelEnabled: false }), feltMat);
  bed.rotation.x = Math.PI / 2; // shape (x,y) → world (x,z); top surface at y=0, slab extends down
  bed.receiveShadow = true;
  g.add(bed);

  // finite-height straight cushions, CLOTH-COVERED (same baize as the bed) like a real table: a box per
  // rail cylinder spanning its along-axis extent, sat on the bed and rising to the cushion top (topZ).
  // Its inner face marks where balls rebound. A slim chamfer strip along the inner-top edge gives the
  // cushion a nose that catches the light instead of a flat wall.
  const cushThick = 0.06;
  for (const rail of railCylinders(R, B, variant.pockets())) {
    const [lo, hi] = rail.span;
    const len = (hi - lo) * S;
    const thick = cushThick * S;
    const height = topZ * S;
    const box = new THREE.Mesh(new THREE.BoxGeometry(rail.axis === 'x' ? len : thick, height, rail.axis === 'x' ? thick : len), feltMat);
    const alongMid = (lo + hi) / 2;
    // sit the cushion just OUTSIDE the rebound line (perp), so its inner face is at the table edge
    const perpOut = rail.perp + Math.sign(rail.perp) * thick / (2 * S);
    const cx = rail.axis === 'x' ? alongMid : perpOut;
    const cy = rail.axis === 'x' ? perpOut : alongMid;
    box.position.copy(P3(cx, cy, topZ / 2));
    box.castShadow = true;
    box.receiveShadow = true;
    g.add(box);
  }

  // Outer WOODEN FRAME: a polished hardwood border ringing the cushions — the part you'd rest your hand
  // on and where the sight spots sit. Four boxes (top/bottom span the full width, left/right fit
  // between them) form a clean rectangle just OUTSIDE the cushions; the pocket openings stay inboard of
  // it, so no cutouts are needed. Small sight spots are inlaid along the top face.
  {
    const frameW = 0.14; // border width (m)
    const frameH = topZ * 1.45; // a touch taller than the cushions
    const innerX = HX + cushThick;
    const innerY = HY + cushThick; // frame starts where the cushions end
    const addBox = (w, d, cx, cy) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, frameH * S, d), woodMat);
      m.position.copy(P3(cx, cy, frameH / 2));
      m.castShadow = true; m.receiveShadow = true;
      g.add(m);
    };
    const outerX = innerX + frameW;
    addBox(outerX * 2 * S, frameW * S, 0, innerY + frameW / 2); // top
    addBox(outerX * 2 * S, frameW * S, 0, -(innerY + frameW / 2)); // bottom
    addBox(frameW * S, innerY * 2 * S, innerX + frameW / 2, 0); // right
    addBox(frameW * S, innerY * 2 * S, -(innerX + frameW / 2), 0); // left
    // sight spots: the classic mother-of-pearl dots, three along each long rail, on the frame top
    const dotMat = new THREE.MeshStandardMaterial({ color: 0xf3ecd8, roughness: 0.3, metalness: 0.1 });
    const dotY = frameH + 0.001;
    const railMidY = innerY + frameW / 2;
    for (const fx of [-HX / 2, 0, HX / 2]) {
      for (const sy of [railMidY, -railMidY]) {
        const dot = new THREE.Mesh(new THREE.CircleGeometry(0.012 * S, 16), dotMat);
        dot.rotation.x = -Math.PI / 2;
        dot.position.copy(P3(fx, sy, dotY));
        g.add(dot);
      }
    }
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
  for (const p of variant.pockets()) {
    const mouthR = p.mouth ?? p.radius;
    const floor = new THREE.Mesh(new THREE.CircleGeometry(mouthR * 1.2 * S, 24), pocketMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.copy(P3(p.center.x, p.center.y, -NET_DEPTH - 0.01));
    g.add(floor);
    const net = buildNet(mouthR, ctx); // pivots at the rim, so it swings when a ball drops in
    net.position.copy(P3(p.center.x, p.center.y, 0));
    g.add(net);
    // translucent circular mouth: makes the pocket read as a round hole (vs green cloth) without hiding the net
    const mouth = new THREE.Mesh(new THREE.CircleGeometry(mouthR * S, 28), mouthMat);
    mouth.rotation.x = -Math.PI / 2;
    mouth.position.copy(P3(p.center.x, p.center.y, 0.002));
    mouth.renderOrder = 1;
    g.add(mouth);
    // a brass plate ringing each pocket, sat on the rail tops — a wide arc whose gap faces into the
    // table (where the ball enters) so it hugs the rails around the back and sides of the mouth. The
    // arc is centred on the OUTWARD direction: for a corner that's the 45° bisector of the two rails
    // (Math.sign, NOT atan2 of the position — on this 2:1 rectangle the origin→corner diagonal is only
    // ~27°, which skewed the plate off the corner); for a middle it's the rail normal (±90°). Corners
    // wrap ~270° so the two ends run right down the cushion noses to the frame; middles stay a half-cap.
    const isCorner = Math.abs(p.center.x) > 1e-6 && Math.abs(p.center.y) > 1e-6;
    const arcLen = isCorner ? Math.PI * 1.5 : Math.PI * 0.82; // corner: near-full wrap, ends meeting the two rails
    const outward = Math.atan2(Math.sign(p.center.y), Math.sign(p.center.x));
    const arc = new THREE.Mesh(new THREE.TorusGeometry(mouthR * 1.02 * S, 0.013 * S, 10, 30, arcLen), brassMat);
    arc.rotation.x = Math.PI / 2; // flat; local angle θ → world (cosθ, sinθ) in the X–Z plane
    arc.castShadow = true;
    const bracket = new THREE.Group();
    bracket.add(arc);
    bracket.position.copy(P3(p.center.x, p.center.y, topZ * 0.9));
    bracket.rotation.y = arcLen / 2 - outward; // centre the arc outward, gap facing the table
    g.add(bracket);
    nets.push({ cx: p.center.x, cy: p.center.y, grp: net, jig: null });
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
  return { group: g, nets };
}

// A ball has just dropped into the pocket nearest (cx,cy) moving at (vx,vy): swing that net like a
// pendulum in the ball's direction, decaying over ~1.5 s. Amplitude scales with the drop speed.
export function kickNet(nets, cx, cy, vx, vy, speed) {
  let best = null;
  let bd = Infinity;
  for (const n of nets) { const d = Math.hypot(n.cx - cx, n.cy - cy); if (d < bd) { bd = d; best = n; } }
  if (!best) return;
  const dir = new THREE.Vector3(vx, 0, vy);
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
  const axis = new THREE.Vector3(0, 1, 0).cross(dir.normalize()).normalize(); // horizontal, ⟂ to impact
  best.jig = { t0: performance.now(), amp: Math.min(0.5, speed * 0.09), axis };
}

export function updateNets(nets, now) {
  for (const n of nets) {
    if (!n.jig) continue;
    const e = (now - n.jig.t0) / 1000;
    if (e > 1.5) { n.grp.quaternion.identity(); n.jig = null; continue; }
    n.grp.quaternion.setFromAxisAngle(n.jig.axis, n.jig.amp * Math.exp(-4 * e) * Math.cos(14 * e)); // damped swing
  }
}
