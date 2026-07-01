// vec2.js — immutable 2D vector ops on plain {x, y} objects.
// Pure functions, no allocation surprises, no class ceremony.

const EPS = 1e-12;

export const vec = (x = 0, y = 0) => ({ x, y });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a, s) => ({ x: a.x * s, y: a.y * s });
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const len2 = (a) => a.x * a.x + a.y * a.y;
export const len = (a) => Math.hypot(a.x, a.y);

export const normalize = (a) => {
  const l = len(a);
  return l < EPS ? vec(0, 0) : scale(a, 1 / l);
};

// Angle in radians -> unit (or scaled) vector. The striker "shot" comes in this form.
export const fromAngle = (rad, mag = 1) => ({ x: Math.cos(rad) * mag, y: Math.sin(rad) * mag });

// 90° CCW perpendicular — used for tangential/spin impulses in Phase 3.
export const perp = (a) => ({ x: -a.y, y: a.x });
