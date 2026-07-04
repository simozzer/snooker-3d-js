// preview3d.js — the aim/trajectory preview: predicted ball paths drawn as scene polylines.
//
// Presentation only, and a leaf: it owns a Group of preview lines + their materials and knows how to
// turn an engine result into polylines and draw them. The renderer keeps the glue that decides WHAT to
// simulate (computePreviewPaths, which needs game/variant/trick) and passes results here. createPreview
// takes the scene and the physics→scene mapper P3 (stable); the per-call `R` (ball radius) is passed in
// because it changes with the variant. Shares the engine's own interpolation (replay.js), so the drawn
// line matches exactly what the real shot will do.

import * as THREE from 'three';
import { buildPlanCache, replayState } from './replay.js';

export function createPreview(scene, P3) {
  const group = new THREE.Group();
  scene.add(group);
  const cueLineMat = new THREE.LineBasicMaterial({ color: 0xf5f3ea, transparent: true, opacity: 0.9 });
  const objLineMat = new THREE.LineDashedMaterial({ color: 0xbcd3e6, transparent: true, opacity: 0.5, dashSize: 0.6, gapSize: 0.4 });

  function clear() {
    for (const c of group.children) c.geometry.dispose();
    group.clear();
  }

  // Sample every ball's predicted path from a capped sim into scene-space polylines. We subdivide each
  // inter-event interval so curved segments (spin swerve, flight arcs) read smoothly while the exact
  // event points stay as crisp corners; pocketed/off samples are dropped so a line stops at its pot.
  function sample(res, R) {
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

  function draw(paths) {
    clear();
    for (const [id, pts] of paths) {
      if (pts.length < 2) continue;
      const isCue = id === 'cue';
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), isCue ? cueLineMat : objLineMat);
      if (!isCue) line.computeLineDistances(); // required for the dashed material
      group.add(line);
    }
  }

  return { clear, sample, draw };
}
