// board-common.js — shared theme tokens + Canvas 2D helpers for the turn-based BOARD games
// (chess, draughts, backgammon). These games are a different world from the cue-physics engine:
// no simulation, no three.js — just a deterministic game module (src/board/*) driving a flat
// canvas. This file is the small toolkit every board view reuses so they look like one product:
// the same dark palette as render3d.html, crisp HiDPI rendering, and a couple of tween/AI helpers.

// Palette — lifted from render3d.html so the board games sit inside the same visual system.
export const THEME = {
  bg: '#12161b',
  panel: '#1b2229',
  text: '#e8e8e8',
  muted: '#8fa3b5',
  faint: '#6f8496',
  border: '#33404c',
  green: '#2e7d5b',
  gold: '#ffdf6b',
  red: '#e23b3b',
  // board squares (chess / draughts) — warm wood
  sqLight: '#e8d3a8',
  sqDark: '#9c6b3e',
  // interaction overlays
  selected: 'rgba(120, 205, 130, 0.55)',
  legal: 'rgba(120, 205, 130, 0.85)',
  lastMove: 'rgba(240, 205, 90, 0.38)',
  check: 'rgba(226, 59, 59, 0.62)',
  hint: 'rgba(95, 176, 224, 0.8)',
};

// Size a canvas to fill `box` at the device pixel ratio, returning the CSS pixel size + a ctx
// already scaled so all drawing is in CSS pixels. Board views call this on mount and resize.
export function fitCanvas(canvas, box, { square = true, max = Infinity } = {}) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const rect = box.getBoundingClientRect();
  let w = Math.max(1, Math.floor(rect.width));
  let h = Math.max(1, Math.floor(rect.height));
  if (square) { const s = Math.min(w, h, max); w = s; h = s; }
  else { w = Math.min(w, max); h = Math.min(h, max); }
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h, ctx, dpr };
}

// Map a pointer event to CSS-pixel coordinates inside the canvas (origin top-left).
export function pointerXY(canvas, ev) {
  const rect = canvas.getBoundingClientRect();
  const p = ev.touches ? ev.touches[0] : ev;
  return { x: p.clientX - rect.left, y: p.clientY - rect.top };
}

// Rounded-rect path helper (points/checkers, banners).
export function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// A tiny requestAnimationFrame loop that runs `tick(t)` until it returns false. Views use it for
// piece-slide / dice-roll animation; returns a stop() so the harness can cancel on destroy.
export function animate(tick) {
  let raf = 0, start = 0, stopped = false;
  const step = (now) => {
    if (stopped) return;
    if (!start) start = now;
    if (tick(now - start) !== false) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => { stopped = true; cancelAnimationFrame(raf); };
}

export const easeOut = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
export const easeIn = (t) => { const x = Math.min(1, Math.max(0, t)); return x * x; }; // gravity-ish accel

// Deliberate pacing around an AI move so it never feels instant: a "thinking" beat BEFORE the reply
// appears, and a settle beat AFTER it lands before control returns to the human. Shared by every
// board view so all games slow down the same way.
export const AI_PRE_MS = 500;
export const AI_POST_MS = 420;

// Run a (potentially heavy) synchronous AI search off the paint path: yields to the browser so the
// human's move renders first and a "thinking…" state can show, then invokes cb with the result.
// Not a worker (keeps these modules dependency-free), just a deferred call — depth budgets keep the
// engines well under a frame or two on modern hardware.
export function think(compute, cb, delay = 180) {
  setTimeout(() => { cb(compute()); }, delay);
}
