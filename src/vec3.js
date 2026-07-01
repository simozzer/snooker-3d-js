// vec3.js — immutable 3D vector ops on plain {x, y, z} objects.
// Lifted mechanically from vec2.js (add/sub/scale/dot/len + cross); z is the table normal.
// Kept alongside vec2.js — the 2D game code still imports vec2; the physics core migrates here.

const EPS = 1e-12;

export const vec = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const len2 = (a) => a.x * a.x + a.y * a.y + a.z * a.z;
export const len = (a) => Math.hypot(a.x, a.y, a.z);

export const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

export const normalize = (a) => {
  const l = len(a);
  return l < EPS ? vec(0, 0, 0) : scale(a, 1 / l);
};
