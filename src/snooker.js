// snooker.js — physical constants for the snooker variant. SI units (metres, kg, seconds).
//
// The defining physical difference from carrom: a snooker ball ROLLS. A struck/collided
// ball first SLIDES (high kinetic friction, MU_SLIDE) while its contact patch slips, then
// — once the slip dies — ROLLS (low rolling resistance, MU_ROLL) to rest. Carrom conflates
// the two into a single deceleration; here they are separate regimes (see body.js
// twoPhasePlan). That two-phase split, plus the cue-tip spin it carries, is what produces
// follow / draw (screw) / swerve.

export const GRAVITY = 9.81;

// Tournament ball: ⌀52.5 mm, ~142 g. (Inertia of a uniform SPHERE is 2/5 m r², which sets
// the 7/2 slip-deceleration factor used in twoPhasePlan — not the disc's 1/2.)
export const BALL = { radius: 0.02625, mass: 0.142 };

// Cloth friction. Sliding is kinetic friction at the slipping contact (high); rolling is
// rolling resistance once the ball rolls without slipping (low). Tunable against real shots.
export const MU_SLIDE = 0.2;
export const MU_ROLL = 0.02; // napped snooker cloth is slower than slick pool felt

// Restitution / tangential friction at impulsive contacts.
export const BALL_RESTITUTION = 0.95; // ball–ball normal restitution (near-elastic)
export const BALL_FRICTION_T = 0.06; // ball–ball tangential ("cut-induced throw")
export const CUSHION_RESTITUTION = 0.8; // perpendicular bounce off a rail
export const CUSHION_FRICTION_T = 0.2; // cushion tangential (side-spin grip)
// Cushion cylinder geometry (Milestone C). Each straight rail is a horizontal cylinder whose axis
// runs parallel to the rail. The axis sits CUSHION_NOSE_DROP below ball-centre height (a real
// cushion nose is off ball-centre; here it is set below centre so a firm shot rides UP over the
// nose and HOPS — the vertical impulse falls out of the off-centre contact normal, not hand-code).
// The cylinder radius is then chosen (see table.railCylinders) so a BED-HEIGHT ball's centre
// rebounds at exactly |gap|=R — the same stop position as the old flat-wall model — making the
// cylinder reduce to the wall model for a flat shot within the small nose-angle tolerance. The
// drop is deliberately SMALL: the contact-normal tilt is asin(drop/(R+r_c)) ≈ drop rad, and the
// hop's vertical velocity ≈ tilt · (1+e) · closingSpeed. TUNED (Milestone D, tools/tune.mjs): 0.04
// puts a firm 6 m/s square cushion shot at a ~6 mm hop apex — a realistic few-mm cushion jump, not
// a centimetre leap — while a 45° bank keeps ~76 % of its speed and steepens ~3°. Never launches a
// ball off the table (a genuine leap needs the vertical velocity of an elevated cue strike).
export const CUSHION_NOSE_DROP = 0.04; // nose axis below ball centre, as a fraction of R

// Pocket jaws + FINITE cushion height (Milestone C2). The straight rail and its rounded jaw ends
// have a finite top: a ball whose CENTRE rises above R + CUSHION_RISE clears the cushion (below it,
// the rail/jaw contacts apply). CUSHION_RISE is set a little above the largest normal rail hop so a
// firm-shot hop still grazes the cushion, but a genuine jump (elevation shot) sails over it and
// leaves play. Real snooker cushions are taller, but the hops here are ~1 cm, so this keeps normal
// play unchanged while making a high leap actually clear.
export const CUSHION_RISE = 1.2; // cushion top above ball-centre height, in units of R
// Rounded jaw posts (the curved rail-ends flanking each pocket mouth), modelled as a TORUS whose
// centre-circle turns the cushion nose around the mouth. Ball-vs-torus distance is non-polynomial,
// so its first-contact is found with the sampled roots.firstRoot (the fallback it was reserved for).
// The centre-circle radius (JAW_RING) and tube radius (JAW_TUBE) are in units of R; the ball
// contacts the torus surface when its centre is at distance R + JAW_TUBE·R from the centre-circle,
// so the jaw's outer reach (where a passing ball first feels it) is about (JAW_RING+JAW_TUBE+1)·R
// from the jaw centre — sized so a ball skimming the mouth edge rattles but a dead-centre entry
// slips between the two jaws untouched.
// Kept small (Rring+tube ≈ 0.22 R) so a dead-centre ball still passes between the two jaws of the
// tight middle pocket (mouth clearance each side ≈ 0.34 R) while a ball skimming the mouth edge
// clips a jaw and rattles.
export const JAW_RING = 0.12; // torus centre-circle radius, in units of R (the nose curl)
export const JAW_TUBE = 0.1; // torus tube radius, in units of R (the rounded post thickness)
export const JAW_RESTITUTION = 0.55; // deadened (was 0.75): a ball heading in that clips a jaw loses
// more energy and drops rather than bouncing clear (fewer hangers), while an off-line ball still rattles out.
export const JAW_FRICTION_T = 0.2;
// Pocket capture is 3D-honest: a ball drops in only if its horizontal centre is within the capture
// radius AND it is at/below the lip height (not sailing over the mouth). LIP_RISE is the centre
// height below which the ball can fall into the mouth.
export const POCKET_LIP_RISE = 0.6; // lip height above ball centre, in units of R
// Capture is also SPEED/LINE-honest. A ball reaching a throat DROPS if it is slow (dribbles in) or its
// trajectory converges on the pocket (its line passes within sqrt(POCKET_DROP_R2) of the centre). If it
// is fast AND merely grazing (a rail-skimmer running past the mouth), it does NOT drop — it RATTLES:
// reflected off the pocket back into play (POCKET_REBOUND restitution). Because every throat-reaching
// ball is either dropped or rebounded (never passed through), no ball can tunnel the mouth gap.
export const POCKET_SLOW_DROP = 0.4; // m/s — below this a ball always drops
export const POCKET_DROP_R2 = (0.85 * BALL.radius) ** 2; // fast-ball line must pass this close to the centre to drop
export const POCKET_REBOUND = 0.6; // restitution of a too-fast rattle back off the pocket
export const BED_RESTITUTION = 0.5; // ball–bed (slate/cloth) normal restitution — a jumped ball
// loses most vertical energy per bounce, so a multi-bounce settles in a few events.
export const BED_FRICTION_T = 0.2; // ball–bed tangential grip — converts landing spin ↔ velocity
// (a backspun ball checks / draws back on landing) via the generic contact resolver.
// Speed below which a landed ball is treated as settled onto the bed (no more micro-bounces).
export const BED_REST_SPEED = 0.05; // m/s vertical closing speed

// Vertical-axis ("side"/English) spin decay on the cloth, as an angular deceleration
// dω_z/dt = SIDE_DECEL (rad/s²). Side spin doesn't translate the ball (its slip at the
// bottom contact is zero) — it only matters at cushion/ball contacts — but it bleeds off.
export const SIDE_DECEL = 10.0;

// Sphere inertia factor: I = INERTIA_FACTOR · m r².
export const INERTIA_FACTOR = 2 / 5;
// Slip decays (7/2)× faster than the centre under sliding friction: 1 + 1/INERTIA_FACTOR.
export const SLIP_FACTOR = 1 + 1 / INERTIA_FACTOR; // = 7/2 for a uniform sphere

// Cue-tip → spin gain. A tip offset of `vert` (vertical, −1..1) or `side` (horizontal, −1..1)
// imparts angular velocity SPIN_GAIN·offset·v/R. With SPIN_GAIN=2: offset ≈0.5 ⇒ natural roll
// (no slide), offset 0 ⇒ stun, offset 1 ⇒ strong follow, −1 ⇒ strong screw. Tunable.
export const SPIN_GAIN = 2.0;
export const MAX_SPEED = 8.0; // m/s at full cue power
