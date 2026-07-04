// replaycam.js — the pot-replay cinematic camera (per-frame motion only).
//
// Presentation only, leaf: given the camera, the replay's framing/state object `rm` (built by
// startReplay in the renderer), the interpolated ball `state`, dt, the replay clock `simT`, and the
// physics→scene mapper `P3`, it drives the camera for one frame. Two treatments: a static framing with
// a slow push-in + gentle orbit (default), or the rare swivel that sweeps around the action chasing a
// ball. `rm` carries the eased camPos/camTgt across frames, so this stays stateless itself.

import * as THREE from 'three';

const HALF_TAN = Math.tan(((45 * Math.PI) / 180) / 2); // camera vertical half-FOV
const SWIVEL_EH = 0.87, SWIVEL_EV = 0.5; // cos/sin of the ~30° orbit elevation

// Frame the whole story: sit at the treatment's angle, far enough back that EVERY potted ball and the
// cue's line stay in view, with a slow push-in + gentle orbit for cinematic life. Static framing (only
// distance/orbit ease) → inherently smooth (no per-frame chase jitter); dt-based damping keeps it
// frame-rate independent.
export function driveReplayCamera(camera, rm, state, dt, simT, P3) {
  const p = Math.min(1, simT / rm.end); // replay progress 0→1
  if (rm.swivel) { driveSwivelCamera(camera, rm, state, dt, p, P3); return; }
  const fit = (rm.radius / HALF_TAN) * 1.25 + rm.radius; // distance that frames `radius` with margin
  const dist = fit * (1.32 - 0.3 * p); // slow push-in over the replay
  const ang = rm.orbit * p; // gentle orbit
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const d = rm.dir;
  const dir = new THREE.Vector3(d.x * c - d.z * s, d.y, d.x * s + d.z * c); // rotate `dir` about the Y axis
  const dPos = rm.center.clone().addScaledVector(dir, dist);
  const dTgt = rm.center;
  if (!rm.init) { rm.camPos.copy(dPos); rm.camTgt.copy(dTgt); rm.init = true; }
  else {
    const kP = 1 - Math.exp(-dt / 0.3); // exponential damping (frame-rate independent)
    const kT = 1 - Math.exp(-dt / 0.2);
    rm.camPos.lerp(dPos, kP);
    rm.camTgt.lerp(dTgt, kT);
  }
  camera.position.copy(rm.camPos);
  camera.lookAt(rm.camTgt);
}

// The rare swivel treatment: sweep a big arc around the vertical axis through the action while the look
// pans toward the ball we're chasing — dynamic angle changes, but always orbiting at the framing distance
// so every collision and final position stays in view (never the tight crop of a true follow-cam). The
// azimuth is driven by replay progress `p` (warped by replayRate), so it slows around the pot.
function driveSwivelCamera(camera, rm, state, dt, p, P3) {
  const fit = (rm.radius / HALF_TAN) * 1.5 + rm.radius; // wider margin than the static frame: the look is off-centre
  const f = state.get(rm.followId);
  const ball = f ? P3(f.pos.x, f.pos.y, f.pos.z) : rm.center.clone();
  const dTgt = rm.center.clone().lerp(ball, 0.35); // bias the look toward the chased ball, but keep the action framed
  const az = rm.swivelBase + rm.swivelDir * p * Math.PI * 1.7; // most of a full turn across the whole replay
  const dPos = new THREE.Vector3(
    rm.center.x + Math.cos(az) * fit * SWIVEL_EH,
    fit * SWIVEL_EV, // elevated above the table
    rm.center.z + Math.sin(az) * fit * SWIVEL_EH,
  );
  if (!rm.init) { rm.camPos.copy(dPos); rm.camTgt.copy(dTgt); rm.init = true; }
  else {
    const kP = 1 - Math.exp(-dt / 0.3);
    const kT = 1 - Math.exp(-dt / 0.2);
    rm.camPos.lerp(dPos, kP);
    rm.camTgt.lerp(dTgt, kT);
  }
  camera.position.copy(rm.camPos);
  camera.lookAt(rm.camTgt);
}
