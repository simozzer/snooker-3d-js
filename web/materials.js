// materials.js — procedural textures + shared materials for the 3D table (presentation only).
//
// Leaf module: pure THREE material/texture factories with no game/engine state. Extracted from
// render3d.js so the renderer file stays focused on scene wiring and play flow. makeStudioEnv takes
// the renderer (PMREM needs it); everything else is self-contained.

import * as THREE from 'three';

// Procedural studio environment: a bright overhead band on a cool room gradient, mapped as an
// equirectangular reflection and pre-filtered by PMREM. Cheap, self-contained (no HDR file), and it
// makes every metal/gloss surface read as lit by a real room.
export function makeStudioEnv(renderer) {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 256;
  const c = cv.getContext('2d');
  const grd = c.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0.0, '#3c4657'); // ceiling
  grd.addColorStop(0.40, '#9fb0c4');
  grd.addColorStop(0.50, '#ffffff'); // bright overhead band (the hall lights)
  grd.addColorStop(0.60, '#9fb0c4');
  grd.addColorStop(1.0, '#1c2128'); // floor
  c.fillStyle = grd; c.fillRect(0, 0, 512, 256);
  c.fillStyle = 'rgba(255,255,255,0.95)'; // a couple of soft light panels for glints
  for (const x of [90, 250, 400]) c.fillRect(x, 34, 60, 22);
  const tex = new THREE.CanvasTexture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(tex).texture;
  tex.dispose(); pmrem.dispose();
  return env;
}

// Woven baize: the cloth colour with fine per-texel luminance nap plus a matching bump, so the felt
// catches light like real baize instead of reading as flat plastic. Tiled tightly and cached per colour.
const _feltCache = new Map();
export function feltMaterial(hex) {
  if (_feltCache.has(hex)) return _feltCache.get(hex);
  const size = 256;
  const base = new THREE.Color(hex);
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const c = cv.getContext('2d');
  const img = c.createImageData(size, size);
  const bcv = document.createElement('canvas'); bcv.width = bcv.height = size;
  const bc = bcv.getContext('2d');
  const bimg = bc.createImageData(size, size);
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let i = 0; i < size * size; i++) {
    const n = (Math.random() - 0.5) * 0.12; // ±nap on luminance
    img.data[i * 4 + 0] = clamp((base.r + n) * 255);
    img.data[i * 4 + 1] = clamp((base.g + n) * 255);
    img.data[i * 4 + 2] = clamp((base.b + n) * 255);
    img.data[i * 4 + 3] = 255;
    const b = clamp(128 + (Math.random() - 0.5) * 90);
    bimg.data[i * 4] = bimg.data[i * 4 + 1] = bimg.data[i * 4 + 2] = b;
    bimg.data[i * 4 + 3] = 255;
  }
  c.putImageData(img, 0, 0); bc.putImageData(bimg, 0, 0);
  const map = new THREE.CanvasTexture(cv);
  map.wrapS = map.wrapT = THREE.RepeatWrapping; map.repeat.set(16, 8); map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 8;
  const bump = new THREE.CanvasTexture(bcv);
  bump.wrapS = bump.wrapT = THREE.RepeatWrapping; bump.repeat.set(32, 16);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, map, bumpMap: bump, bumpScale: 0.012, roughness: 0.97, metalness: 0 });
  _feltCache.set(hex, mat);
  return mat;
}

// Polished hardwood for the outer frame: a warm base with soft vertical grain streaks. Semi-glossy so
// it picks up the studio env (that sheen is what reads as "varnished wood").
export function woodMaterial(tone) {
  const size = 256;
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const c = cv.getContext('2d');
  c.fillStyle = tone; c.fillRect(0, 0, size, size);
  for (let i = 0; i < 240; i++) {
    const x = Math.random() * size;
    c.strokeStyle = `rgba(${20 + Math.random() * 34 | 0},${10 + Math.random() * 18 | 0},0,${(0.04 + Math.random() * 0.11).toFixed(3)})`;
    c.lineWidth = 0.5 + Math.random() * 1.6;
    c.beginPath();
    c.moveTo(x, 0);
    c.bezierCurveTo(x + (Math.random() - 0.5) * 18, size * 0.34, x + (Math.random() - 0.5) * 18, size * 0.68, x + (Math.random() - 0.5) * 10, size);
    c.stroke();
  }
  const map = new THREE.CanvasTexture(cv);
  map.wrapS = map.wrapT = THREE.RepeatWrapping; map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 8; map.repeat.set(4, 1);
  return new THREE.MeshStandardMaterial({ color: 0xffffff, map, roughness: 0.36, metalness: 0.05 });
}

export const woodMat = woodMaterial('#5a3a1e'); // dark polished hardwood, shared across tables
export const jawMat = new THREE.MeshStandardMaterial({ color: 0x241812, roughness: 0.55, metalness: 0.1 }); // dark leather pocket jaws
export const pocketMat = new THREE.MeshStandardMaterial({ color: 0x05070a, roughness: 1 });
export const netMat = new THREE.LineBasicMaterial({ color: 0x9a9a86, transparent: true, opacity: 0.72 });
// pocket mouth: a clean, faintly luminescent disc (unlit, so it reads as softly self-lit) over the
// green — a round glow rather than a black hole. depthWrite off so the net + resting balls show through.
export const mouthMat = new THREE.MeshBasicMaterial({ color: 0x3a5f6e, transparent: true, opacity: 0.5, depthWrite: false });
export const markMat = new THREE.LineBasicMaterial({ color: 0xdfeae0, transparent: true, opacity: 0.5 });
export const spotMat = new THREE.MeshBasicMaterial({ color: 0xdfeae0, transparent: true, opacity: 0.65 });
export const brassMat = new THREE.MeshStandardMaterial({ color: 0xc79a4b, metalness: 0.9, roughness: 0.28 }); // reflects the studio env
