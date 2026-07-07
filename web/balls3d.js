// balls3d.js — ball appearance for the 3D renderer (presentation only).
//
// Leaf module: pure builders that turn a variant + piece into a THREE mesh. Appearance is
// variant-driven — `colorOf` gives the ball's colour, `isStripe` marks a stripe (white ball + a
// coloured equatorial band), and `label` gives its number (a camera-facing decal). Snooker balls are
// plain coloured spheres with a spin spot; pool/9-ball balls are numbered. Each ball is an OUTER group
// (positioned) holding a number decal + an INNER "spinner" group (sphere/band/spot) that rotates to
// show spin — so the number stays put while the ball rolls. The renderer owns the ball registry and
// the animation; this file just constructs meshes. `R` = ball radius (m), `S` = scene scale.

import * as THREE from 'three';

const CUE_FALLBACK = '#f5f3ea';

function ballColor(piece, variant) {
  const isCue = piece.group === 'cue' || piece.id === 'cue';
  if (isCue) return new THREE.Color(variant.cueColor && variant.cueColor.startsWith('#') ? variant.cueColor : CUE_FALLBACK);
  return new THREE.Color(variant.colorOf ? variant.colorOf(piece) : '#cccccc');
}

// A camera-facing number decal (like a real pool ball's number circle), readable from any angle.
function numberSprite(text, R, S) {
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

// Build one ball's meshes. Returns { grp, spinner }: grp is positioned by the renderer each frame;
// spinner is rotated to show roll/spin.
export function makeBallMesh(piece, variant, R, S) {
  const grp = new THREE.Group(); // outer: positioned only
  const spinner = new THREE.Group(); // inner: rotates to show spin
  grp.add(spinner);
  const isCue = piece.group === 'cue' || piece.id === 'cue';
  const col = ballColor(piece, variant);
  // Carrom: pieces are flat DISCS resting on the board, not balls. Build a short cylinder lowered so it
  // sits on the bed (the group is positioned at ball-centre height R), with a slim darker rim on top.
  if (variant.discPieces) {
    const T = R * S * 0.44; // disc thickness
    const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.4 });
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(R * S, R * S, T, 24), mat);
    disc.position.y = T / 2 - R * S; // rest the disc's underside on the bed
    disc.castShadow = true; disc.receiveShadow = true;
    grp.add(disc);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R * S * 0.82, R * S * 0.09, 8, 20), new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.6, transparent: true, opacity: 0.25 }));
    rim.rotation.x = Math.PI / 2; rim.position.y = T - R * S + 0.001; // a faint inlaid ring on the top face
    grp.add(rim);
    return { grp, spinner, spot: null };
  }
  const stripe = variant.isStripe ? variant.isStripe(piece) : false;
  const base = stripe ? new THREE.Color(CUE_FALLBACK) : col; // a stripe = white ball + a coloured band
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(R * S, 28, 20), new THREE.MeshStandardMaterial({ color: base, roughness: 0.18 }));
  sphere.castShadow = true;
  spinner.add(sphere);
  if (stripe) {
    const band = new THREE.Mesh(new THREE.SphereGeometry(R * S * 1.003, 28, 12, 0, Math.PI * 2, Math.PI * 0.36, Math.PI * 0.28), new THREE.MeshStandardMaterial({ color: col, roughness: 0.18 }));
    spinner.add(band);
  }
  // number decal for numbered object balls only — never the cue. (Some layouts, e.g. Trick Shots, give
  // the cue piece an id but no group/number, so variant.label() would return "undefined"/"0" and stamp
  // that on the cue ball; guard on isCue and drop any stray "undefined".)
  const label = isCue ? '' : (variant.label ? variant.label(piece) : '');
  let spot = null;
  if (label && label !== 'undefined') {
    grp.add(numberSprite(label, R, S)); // numbered ball: a camera-facing decal (doesn't spin with the ball)
  } else {
    spot = new THREE.Mesh(new THREE.SphereGeometry(R * S * 0.28, 10, 8), new THREE.MeshStandardMaterial({ color: 0xffffff }));
    spot.position.set(0, R * S * 0.92, 0);
    spot.visible = false; // only shown while the ball is actually spinning (see the renderer's applyState)
    spinner.add(spot); // spin spot rolls with the ball
  }
  return { grp, spinner, spot };
}
