// table.js — snooker table geometry. SI units (metres), long axis = x, origin at centre.
//
import { CUSHION_NOSE_DROP, JAW_RING, JAW_TUBE } from './snooker.js';
//
// Pockets model (pragmatic, the carrom approach): the four rails are treated as full
// axis-aligned cushions and each pocket is a capture CIRCLE; at every step the earliest of
// {cushion bounce, pocket capture} wins, so a ball heading into a pocket is swallowed before
// it can bounce. Corner pockets sit at the rail corners; middle pockets sit on the long rails.
//
// NOTE (faithful-geometry TODO): real pockets have angled JAWS that can rattle a ball back
// out. That needs general ball-vs-segment cushions (finite rails with gaps + diagonal jaw
// segments) and diagonal reflection in collisions.resolveWall. The circle-capture model below
// plays correctly (including middle pockets) but never rattles. Left as a documented
// enhancement so the rest of the game (rules, AI, UI) can be built and played now.

// Inner playing area: 11ft 8.5in × 5ft 10in.
export const TABLE = {
  width: 3.569,
  height: 1.778,
  // Pocket MOUTH radii — the width of the gap in the rail, flanked by the rounded jaws (Milestone
  // C2). These size the rail-gap cutouts and the jaw placement.
  cornerPocket: 0.1,
  middlePocket: 0.075,
  // Pocket THROAT (capture) radii — the smaller circle DEEP in the pocket a ball must reach to drop
  // (behind the jaws). Kept below the mouth so an off-centre ball clips a jaw and RATTLES rather
  // than being swallowed at the mouth; a well-aligned ball passes the jaws to the throat and pots.
  // Tuned so a dead-on pot drops and a ~3° off-line shot rattles out.
  cornerThroat: 0.065,
  middleThroat: 0.048,
  baulkFromCushion: 0.737, // baulk line distance from the baulk (−x) cushion face
  dRadius: 0.292, // radius of the "D"
  blackFromTopCushion: 0.324, // black spot distance from the top (+x) cushion face
};

export const HX = TABLE.width / 2;
export const HY = TABLE.height / 2;

// Memoised: the table geometry is constant, but bounds()/pockets() are called on every one of the
// ~thousands of simulations per AI move. Returning cached instances removes that allocation churn.
// (Callers treat both as read-only — verified — so sharing one instance is safe.)
let _bounds;
export const bounds = () => (_bounds ??= { minX: -HX, maxX: HX, minY: -HY, maxY: HY });

// Six pockets: 4 corners + 2 middles (on the long rails at x = 0). Each carries `radius` (the THROAT
// / capture circle used by detectPocket) and `mouth` (the wider rail-gap width used to place the
// rails' pocket cutouts and the jaws). radius < mouth so a ball must pass the jaws to be captured.
let _pockets;
export const pockets = () =>
  (_pockets ??= [
    { center: { x: -HX, y: -HY }, radius: TABLE.cornerThroat, mouth: TABLE.cornerPocket },
    { center: { x: HX, y: -HY }, radius: TABLE.cornerThroat, mouth: TABLE.cornerPocket },
    { center: { x: -HX, y: HY }, radius: TABLE.cornerThroat, mouth: TABLE.cornerPocket },
    { center: { x: HX, y: HY }, radius: TABLE.cornerThroat, mouth: TABLE.cornerPocket },
    { center: { x: 0, y: -HY }, radius: TABLE.middleThroat, mouth: TABLE.middlePocket },
    { center: { x: 0, y: HY }, radius: TABLE.middleThroat, mouth: TABLE.middlePocket },
  ]);

// Straight-rail CUSHION CYLINDERS (Milestone C). Each rail is a horizontal cylinder: its axis runs
// parallel to the rail at a fixed (perpendicular position, z-height), and the rail exists only over
// a finite along-axis span so POCKET MOUTHS are left as gaps (a ball aimed at a gap passes the rail
// plane into the pocket-mouth region instead of bouncing). Corner/jaw geometry (tori) is a later
// follow-up — near a pocket the rail simply stops (a small conservative gap), it is NOT modelled.
//
// Geometry (per rail): { axis: 'x'|'y' (direction the cylinder runs), perp, perpSign, z, rc, span }
//   perp     — the fixed coordinate of the axis in the perpendicular direction (the wall face)
//   perpSign — +1 if the playing area is on the −perp side of the rail (top/right), −1 otherwise
//   z        — axis height above the bed (below ball-centre R so a firm shot hops up over the nose)
//   rc       — cylinder radius, chosen so a bed-height ball's centre rebounds at |gap|=R (wall match)
//   span     — [lo, hi] extent along the axis direction where the rail exists (pocket gaps excluded)
//
// r_c solves (R + r_c)² = R² + drop²  with drop = R·noseDropFrac, so contact for a centre-height
// ball happens at perpendicular-plane distance R — the exact stop position of the flat-wall model.
//
// Rails are derived from the caller's BOUNDS (so an "open" table with far bounds yields far,
// effectively-absent rails), with a gap cut at each pocket that lies ON a rail. Pocket-mouth gaps
// are kept SMALLER than the pocket capture radius so the whole gap sits inside the capture circle:
// any ball reaching a gap is potted before it can slip past the rail end (no tunnelling out a
// corner). Corner/jaw tori are a later follow-up; this straight-rail treatment just guarantees the
// edge is either a rail bounce or a pocket capture.
function computeRailCylinders(R, bnds, pcks, noseDropFrac) {
  const drop = R * noseDropFrac;
  const rc = Math.sqrt(R * R + drop * drop) - R;
  const z = R - drop; // axis below ball centre → upward hop component
  const { minX, maxX, minY, maxY } = bnds;

  // Split an along-axis interval [lo,hi] at each pocket whose centre lies on this rail face,
  // removing a (pocketRadius − R)-wide gap around each such pocket's along-axis coordinate.
  const cut = (lo, hi, perpVal, perpKey, alongKey) => {
    const gaps = pcks
      .filter((p) => Math.abs(p.center[perpKey] - perpVal) < 1e-9)
      .map((p) => ({ c: p.center[alongKey], h: Math.max((p.mouth ?? p.radius) - R, 0) }))
      .sort((a, b) => a.c - b.c);
    const spans = [];
    let cursor = lo;
    for (const g of gaps) {
      const gLo = g.c - g.h;
      const gHi = g.c + g.h;
      if (gLo > cursor) spans.push([cursor, gLo]);
      cursor = Math.max(cursor, gHi);
    }
    if (cursor < hi) spans.push([cursor, hi]);
    return spans.filter(([a, b]) => b - a > 1e-6);
  };

  const out = [];
  const add = (axis, perp, perpSign, perpKey, alongKey, lo, hi) => {
    for (const span of cut(lo, hi, perp, perpKey, alongKey)) out.push({ axis, perp, perpSign, z, rc, span });
  };
  add('x', maxY, 1, 'y', 'x', minX, maxX); // top long rail (runs along x)
  add('x', minY, -1, 'y', 'x', minX, maxX); // bottom long rail
  add('y', maxX, 1, 'x', 'y', minY, maxY); // right short rail (runs along y)
  add('y', minX, -1, 'x', 'y', minY, maxY); // left short rail
  return out;
}

// Pocket JAWS (Milestone C2): the rounded rail-ends flanking each pocket mouth, one TORUS per
// jaw. Each straight-rail span endpoint that abuts a pocket gap is a jaw — a torus whose centre
// sits at that rail-face point at nose height (z = R − drop), lying in the horizontal plane with a
// VERTICAL symmetry axis, centre-circle radius Rring and tube radius rc. Its rounded nose curls
// around the mouth, so a ball entering the jaw can rattle (bounce off the post) or slip past into
// the pocket. Ball-vs-torus distance is non-polynomial → detected with roots.firstRoot.
//
//   jaw = { cx, cy, z, Rring, tube }   (torus centre + geometry; axis is +z)
//   distance(p) = sqrt( (hypot(p.x−cx, p.y−cy) − Rring)² + (p.z−z)² ),  contact at = R + tube
function computePocketJaws(R, bnds, pcks, noseDropFrac) {
  const drop = R * noseDropFrac;
  const z = R - drop;
  const Rring = JAW_RING * R;
  const tube = JAW_TUBE * R;
  const rails = railCylinders(R, bnds, pcks, noseDropFrac);
  // only place a jaw at a span end that actually abuts a POCKET (some ends are the table extremity
  // when bounds have no pocket there, e.g. an open test table) — keyed to dedupe shared corners.
  const nearPocket = (x, y) => pcks.some((p) => Math.hypot(x - p.center.x, y - p.center.y) < (p.mouth ?? p.radius) + 3 * R);
  const jaws = [];
  const seen = new Set();
  for (const rail of rails) {
    for (const end of rail.span) {
      const cx = rail.axis === 'x' ? end : rail.perp; // jaw sits exactly at the rail-end point
      const cy = rail.axis === 'x' ? rail.perp : end;
      if (!nearPocket(cx, cy)) continue;
      const key = `${cx.toFixed(4)},${cy.toFixed(4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      jaws.push({ cx, cy, z, Rring, tube });
    }
  }
  return jaws;
}

// railCylinders/pocketJaws depend only on (R, bounds, nose-drop) + the pocket layout — all fixed for
// a given table — yet the engine rebuilds them on EVERY simulate(). The AI runs hundreds of sims per
// decision, so memoise on a value key: identical geometry, only the redundant rebuild is skipped.
// Engine and renderer treat the result as read-only (never mutate it), so sharing the array is safe.
const _geomCache = new Map();
const geomKey = (tag, R, b, pk, nd) =>
  `${tag}|${R}|${b.minX},${b.minY},${b.maxX},${b.maxY}|${nd}|${pk.length}|${pk[0] ? `${pk[0].center.x},${pk[0].center.y}` : ''}`;
function memoGeom(tag, compute, R, b, pk, nd) {
  const k = geomKey(tag, R, b, pk, nd);
  let v = _geomCache.get(k);
  if (v === undefined) {
    if (_geomCache.size >= 16) _geomCache.clear(); // bounded — tables are few; this only trims churn
    v = compute(R, b, pk, nd);
    _geomCache.set(k, v);
  }
  return v;
}
export function railCylinders(R, bnds = bounds(), pcks = pockets(), noseDropFrac = CUSHION_NOSE_DROP) {
  return memoGeom('rail', computeRailCylinders, R, bnds, pcks, noseDropFrac);
}
export function pocketJaws(R, bnds = bounds(), pcks = pockets(), noseDropFrac = CUSHION_NOSE_DROP) {
  return memoGeom('jaw', computePocketJaws, R, bnds, pcks, noseDropFrac);
}

// Standard spot positions. Baulk is at −x; the D bulges toward baulk.
export const baulkX = () => -HX + TABLE.baulkFromCushion;
export const spots = () => {
  const bx = baulkX();
  return {
    yellow: { x: bx, y: -TABLE.dRadius }, // right end of the baulk line (player's view)
    green: { x: bx, y: TABLE.dRadius }, // left end
    brown: { x: bx, y: 0 }, // middle of the baulk line
    blue: { x: 0, y: 0 }, // centre spot
    pink: { x: HX / 2, y: 0 }, // midway between centre and the top cushion
    black: { x: HX - TABLE.blackFromTopCushion, y: 0 },
  };
};

// The "D": semicircle of radius dRadius centred on the brown spot, opening toward −x (baulk).
// A point (x,y) is in the D if it's on/behind the baulk line and within the radius.
export const dCentre = () => ({ x: baulkX(), y: 0 });
export function inD(x, y, ballR = 0) {
  const c = dCentre();
  const dx = x - c.x;
  const dy = y - c.y;
  return dx <= 1e-9 && dx * dx + dy * dy <= (TABLE.dRadius - ballR) * (TABLE.dRadius - ballR) && x >= -HX + ballR;
}
